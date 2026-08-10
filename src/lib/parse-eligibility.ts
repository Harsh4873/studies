/**
 * ELIGIBILITY PARSING AND MATCHING.
 *
 * NOT MEDICAL ADVICE. Nothing in this module is a clinical judgement, a
 * diagnosis, or a statement about anyone's health. `parseEligibility` is a
 * best-effort reading of free-text recruitment copy written by dozens of
 * different labs, and `checkEligibility` is a *filtering hint* only. The
 * study team is always the final authority on who may enrol. Every verdict
 * this module produces should be presented to the user as "worth a look" or
 * "probably not a match", never as "you qualify" or "you are excluded".
 *
 * Design rule that drives every decision below: a false "you're eligible" is
 * worse than a false "check with the lab". Where the source language is
 * ambiguous the boolean stays `false` and an explanatory string is pushed into
 * `flags` so the UI can surface the uncertainty instead of silently resolving
 * it.
 *
 * ---------------------------------------------------------------------------
 * Why the parser is context-sensitive rather than a keyword bag
 * ---------------------------------------------------------------------------
 * A naive keyword scan over the 86-record snapshot is wrong on at least four
 * counts, all verified against fixtures/arv-snapshot.json:
 *
 *  1. REQUIRED conditions look identical to EXCLUDED ones.
 *       id 4630 "Investigating Behavior Change Methods for the Management of
 *       Hypertension" - hypertension is the *inclusion* criterion.
 *       id 9821 "MAMA: Managing Anxiety, Mood, and Alcohol During Pregnancy"
 *       and id 4620 "Mom Brain Study (Maternal Brain Reorganization)" -
 *       pregnancy is *required*, not excluded.
 *     So condition-gating is resolved first and suppresses the matching
 *     exclusion flag.
 *
 *  2. Negated requirements read like requirements.
 *       id 9815: "Fasting prior to screening is not required."
 *     The only occurrence of "fasting" in the whole corpus is a negation.
 *
 *  3. An exclusion can imply the opposite requirement.
 *       ids 11321 / 8876: "Exclusion criteria include left-handedness"
 *     means right-handed is required, even though "right-handed" never
 *     appears.
 *
 *  4. An exclusion cue can sit hundreds of characters before the keyword.
 *       id 12775: "...have not had any of the following conditions ... within
 *       the last 6 months: acute cardiac event, seizures, stroke, ..."
 *     Hence the wide look-behind window when classifying a mention.
 *
 * Additionally, `pacemaker` alone does NOT mean MRI (id 6969 excludes
 * pacemakers because an eye-tracking camera is magnet-mounted; id 6950 is a
 * vaping/attention study). `requiresMriSafe` therefore needs an actual imaging
 * modality or a specifically magnetic contraindication; a lone implanted-device
 * screen becomes a flag instead.
 */

import { stripHtml } from '@/lib/html.ts';
import { NO_MAX_AGE_SENTINEL } from '@/types.ts';
import type {
  EligibilityStatus,
  EligibilityVerdict,
  ParsedEligibility,
  RawStudy,
  SexRestriction,
  UserProfile,
} from '@/types.ts';

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

/** Site chrome that wraps every `content.rendered` and carries no criteria. */
const LEADING_NAV_RE = /^\s*Home\s+Aggie\s+Research\s+Volunteers\s*/i;
const ON_THIS_PAGE_RE =
  /On This Page(?:\s+(?:Overview|Duration|Compensation|Location|IRB Info))+/gi;
const TRAILING_IRB_RE = /\bIRB Info\s+IRB Number:[\s\S]*$/i;

/** Normalize typographic characters so one regex spelling is enough. */
function normalizeText(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface StudyText {
  /** Title only. Titles are the strongest signal that a study *targets* a condition. */
  title: string;
  /** Title + excerpt + de-chromed content. */
  all: string;
}

function buildStudyText(record: RawStudy): StudyText {
  const title = normalizeText(stripHtml(record.title?.rendered));
  const excerpt = normalizeText(stripHtml(record.excerpt?.rendered));

  const content = normalizeText(
    stripHtml(record.content?.rendered)
      .replace(LEADING_NAV_RE, '')
      .replace(ON_THIS_PAGE_RE, ' ')
      .replace(TRAILING_IRB_RE, ' '),
  );

  return { title, all: [title, excerpt, content].filter(Boolean).join(' . ') };
}

// ---------------------------------------------------------------------------
// Mention classification
// ---------------------------------------------------------------------------

/**
 * How far back to look for the phrase that turns a condition name into an
 * exclusion. 260 chars is tuned to the real corpus: id 12775 puts "have not
 * had any of the following conditions" ~190 chars before "acute cardiac
 * event", and id 4613 puts "Exclusion criteria:" ~150 chars before "heart
 * disease".
 */
const EXCLUSION_LOOKBEHIND = 260;
const EXCLUSION_LOOKAHEAD = 70;

/**
 * Phrases that mark the surrounding clause as a screen-out. Deliberately
 * broad: over-detecting an exclusion is the safe direction, because a
 * required-condition match (resolved earlier) always wins over it.
 */
const EXCLUSION_CUE_RE =
  /(?:\bexclusion\b|\bexclude[sd]?\b|\bexcluding\b|\bineligible\b|\bnot eligible\b|contraindicat|\bscreen(?:ed|ing)? (?:for|out)\b|\bsafety (?:measures|screening)\b|\bdo(?:es)? not have\b|\bdon't have\b|\bhave not had\b|\bhas not had\b|\bno (?:known |current |prior |past |self-reported )*history\b|\bwithout (?:any )?(?:known |prior )?(?:history|metal|conditions?)\b|\bfree of\b|\bmust not\b|\bcannot\b|\bcan not\b|\bmay not\b|\bshould not\b|\bwill not\b|\bthere will be no\b|\bare not\b|\bis not\b|\bno minors\b|\brefrain from\b|\babsence of\b|\bnone of the following\b|\bno known\b|\bnot involve\b)/i;

interface MentionScan {
  /** The keyword appears at all. */
  found: boolean;
  /** At least one occurrence sits inside an exclusion clause. */
  excluded: boolean;
  /** Up to three distinct matched substrings, for flag text. */
  samples: string[];
}

function scanMentions(text: string, pattern: RegExp): MentionScan {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const out: MentionScan = { found: false, excluded: false, samples: [] };

  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      m = re.exec(text);
      continue;
    }

    out.found = true;
    const sample = m[0].toLowerCase();
    if (out.samples.length < 3 && !out.samples.includes(sample)) out.samples.push(sample);

    const start = Math.max(0, m.index - EXCLUSION_LOOKBEHIND);
    const end = Math.min(text.length, m.index + m[0].length + EXCLUSION_LOOKAHEAD);
    if (EXCLUSION_CUE_RE.test(text.slice(start, end))) out.excluded = true;

    m = re.exec(text);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Keyword tables
// ---------------------------------------------------------------------------

/** An actual imaging/magnet modality - the only thing that justifies "MRI". */
const MRI_MODALITY_RE =
  /\b(?:f?MRI\b|MR image|MR contra-indications?|magnetic resonance|neuroimaging|brain (?:scan|scanner|scanning|imaging)|scanner bed|imaging environment|MRI (?:scan|machine|technician|safety))/gi;

/** Contraindications that are specifically about magnets/metal. */
const MRI_MAGNETIC_RE =
  /\b(?:metal(?:lic)? (?:implants?|objects?|paraphernalia)|metal in (?:your|the) body|metal implanted|ferromagnetic|non-removable piercings?)\b/gi;

/** Device/space screens that are common to MRI but also to non-MRI studies. */
const IMPLANTED_DEVICE_RE =
  /\b(?:pacemakers?|implanted (?:medical|electronic)[a-z ]*devices?|implanted cardioverter|cardioverter-?defibrillators?|neurostimulator|cochlear implants?|medication infusion pump)\b/gi;

const CLAUSTROPHOBIA_RE = /\b(?:claustrophobi\w*|enclosed spaces?)\b/gi;

const FASTING_RE =
  /\b(?:fasting|fasted|overnight fast|do not eat|abstain from (?:food|eating)|refrain from eating|nothing to eat|no food)\b/gi;

/** Negations that appear AFTER the fasting keyword, e.g. id 9815. */
const FASTING_NEGATION_RE = /\b(?:is not required|not required|not necessary|no fasting|not need to fast|do(?:es)? not require)\b/i;

const CARDIO_RE =
  /\b(?:cardiovascular|heart disease|heart attack|heart surgery|heart condition|acute cardiac|cardiac (?:event|device|pacemakers?|condition)|coronary|hypertension|hypertensive|high blood pressure|uncontrolled blood pressure|blood pressure not controlled)\b/gi;

const PREGNANCY_RE = /\b(?:pregnan\w*|lactating|lactation|breast-?feeding|nursing mothers?)\b/gi;

const SEIZURE_RE = /\b(?:seizures?|epilep\w*)\b/gi;

const NEURO_RE =
  /\b(?:neurologic(?:al)? (?:disorders?|impairments?|diseases?|conditions?|illness)|neurologic disease|neurodegenerative|traumatic brain injur\w*|\bTBI\b|strokes?|dementia|alzheimer'?s?|parkinson'?s?|multiple sclerosis|concussions?|head trauma|neurosurgery)\b/gi;

const RIGHT_HAND_RE = /\bright[- ]?hand(?:ed|edness)?\b/gi;
const LEFT_HAND_RE = /\bleft[- ]?hand(?:ed|edness)?\b/gi;

/** Explicitly mixed-sex language; suppresses any sex restriction. */
const BOTH_SEXES_RE =
  /\b(?:males? (?:or|and|\/) females?|females? (?:or|and|\/) males?|men (?:and|or) women|women (?:and|or) men|any (?:sex|gender)|regardless of (?:sex|gender)|biological sex)\b/i;

const FEMALE_ONLY_RES: RegExp[] = [
  /\b(?:females?|women|woman|girls?)\s+only\b/i,
  /\bonly\s+(?:females?|women)\b/i,
  /\b(?:adult\s+)?females?\s+(?:between|aged|ages|participants|volunteers|subjects)\b/i,
  /\bfemale\s+participants\b/i,
  /\b(?:must|will)\s+be\s+(?:a\s+)?(?:female|woman)\b/i,
  /\bself-identif\w*\s+as\s+(?:female|women|a woman)\b/i,
];

const MALE_ONLY_RES: RegExp[] = [
  /\b(?:males?|men|boys?)\s+only\b/i,
  /\bonly\s+(?:males?|men)\b/i,
  /\b(?:adult\s+)?males?\s+(?:between|aged|ages|participants|volunteers|subjects)\b/i,
  /\bmale\s+participants\b/i,
  /\b(?:must|will)\s+be\s+(?:a\s+)?(?:male|man)\b/i,
];

/** Female-specific criteria that are suggestive but not conclusive (id 5945). */
const FEMALE_HINT_RE =
  /\b(?:menstruating regularly|menstrual cycles?|menopaus\w*|perimenopaus\w*|estrogen|hormonal contracepti\w*)\b/i;

const PARENT_CHILD_RE =
  /\b(?:parent[- ]child|parent(?:s)? and (?:their )?child(?:ren)?|child(?:ren)? and \d+ parent|caregivers? and (?:their )?child(?:ren)?|primary caregiver and their child|families with|family will (?:play|participate|receive)|parent or legal guardian|mothers? and their infants?|your child\b|parents? will (?:complete|participate|be asked))/i;

const CHILD_TOPIC_RE =
  /\b(?:children|child|preschool\w*|kindergarten\w*|adolescents?|infants?|toddlers?|minors)\b/gi;

// ---------------------------------------------------------------------------
// Condition gating
// ---------------------------------------------------------------------------

/**
 * Which exclusion booleans a required condition must suppress. A study that
 * recruits *for* hypertension cannot also be said to exclude cardiovascular
 * conditions.
 */
type ExclusionKey = 'cardiovascular' | 'pregnancy' | 'seizure' | 'neurological';

interface ConditionRule {
  label: string;
  /** Matched against the title only. */
  title?: RegExp;
  /** Matched against title + excerpt + content. */
  body?: RegExp;
  suppress?: ExclusionKey[];
}

/**
 * Ordered highest-confidence first; the first match wins for
 * `requiresSpecificCondition`, but every match contributes a flag.
 *
 * Each entry is anchored to at least one real record in the snapshot, noted in
 * the comment, so this table can be re-validated when the data changes.
 */
const CONDITION_RULES: ConditionRule[] = [
  {
    // ids 9821 ("...During Pregnancy"), 4620 ("Maternal Brain Reorganization")
    label: 'currently pregnant or expecting',
    title: /\b(?:pregnancy|pregnant|maternal|prenatal|perinatal|postpartum)\b/i,
    body: /\b(?:first[- ]time mothers|your (?:first )?pregnancy|throughout your pregnancy|across pregnancy|during pregnancy)\b/i,
    suppress: ['pregnancy'],
  },
  {
    // id 4630 "Investigating Behavior Change Methods for the Management of Hypertension"
    label: 'diagnosed hypertension',
    title: /\bhypertension\b/i,
    suppress: ['cardiovascular'],
  },
  {
    // id 6953 "...Management of Diabetes"
    label: 'diagnosed diabetes',
    title: /\bdiabetes\b/i,
  },
  {
    // id 9953 "Eligibility criteria: a) Chronic Low Back Pain"
    label: 'chronic low back pain',
    body: /\bchronic low back pain\b|\bCLBP\b/i,
  },
  {
    // ids 8333, 7003 "Experience chronic knee pain and/or have knee osteoarthritis"
    label: 'chronic knee pain or knee osteoarthritis',
    body: /\b(?:knee osteoarthritis|chronic knee pain|knee pain)\b/i,
  },
  {
    // ids 9957 "Exploring the Experience of Chronic Pain", 11077 PaCT
    label: 'chronic pain',
    title: /\bchronic pain\b/i,
    body: /\b(?:experienced?|experiencing|have|having|with|living with|report(?:ing)?) chronic pain\b/i,
  },
  {
    // id 8882 "You are formally diagnosed with ADHD"
    label: 'formally diagnosed ADHD',
    body: /\b(?:formally )?diagnosed (?:with )?ADHD\b|\bindividuals diagnosed with ADHD\b/i,
  },
  {
    // ids 6950, 4615 "used an electronic nicotine delivery system ... most days"
    label: 'current e-cigarette / vape use',
    body: /\bused? an electronic nicotine delivery system\b[\s\S]{0,160}?\b(?:multiple times per day|most days|regularly)\b/i,
  },
  {
    // id 7003 "you must be a U.S Veteran and 18 Years or Older"
    label: 'U.S. Veteran status',
    body: /\b(?:must be a U\.?S\.? Veteran|U\.?S\.? Veteran and 18|veterans with)\b/i,
  },
  {
    // id 4593 "...Alcohol Use Disorder and Co-Occurring PTSD"
    label: 'PTSD with co-occurring alcohol use',
    title: /\balcohol use disorder\b/i,
  },
  {
    // Requires PTSD as an inclusion criterion. Deliberately NOT keyed on the
    // title: id 5945 is "...a new model of PTSD pathophysiology" but recruits
    // healthy volunteers *or* people with PTSD, so it is not condition-gated.
    label: 'PTSD or post-traumatic stress symptoms',
    body: /\b(?:individuals|adults|participants|people|subjects) with (?:PTSD|post-?traumatic stress)\b/i,
  },
  {
    // ids 4626 TRiADS, 4624 TAPAS "trauma exposed individuals"
    label: 'trauma exposure history',
    title: /\btraumatic stress\b/i,
    body: /\b(?:trauma[- ]exposed individuals|history of trauma exposure)\b/i,
  },
  {
    // id 6745 DRIP "sample will comprise ... subjects with elevated depression"
    label: 'elevated depressive symptoms',
    body: /\b(?:elevated depression|elevated depressive symptoms|history of STBs)\b/i,
  },
  {
    // ids 4613 "Sarcopenic Older Adults", 8458 "(pre)frail older adults"
    label: 'sarcopenia or frailty',
    title: /\b(?:sarcopeni\w*|frail\w*)\b/i,
  },
];

/**
 * Studies that recruit a healthy-comparison arm alongside a clinical arm are
 * NOT condition-gated - a healthy volunteer can still take part.
 *
 *   id 5945: "...interactions between brain, circuits and stress hormones in
 *             healthy people and in people with PTSD"
 *   id 6944: "conducted in older adults with and without chronic diseases"
 *
 * When this fires, a body-only condition match is downgraded to a flag. A
 * title match still wins, because a title such as "Management of Hypertension"
 * is unambiguous about who the study is for.
 */
const HEALTHY_CONTROL_ARM_RE =
  /\b(?:healthy\s+(?:people|adults|individuals|participants|volunteers|controls?|subjects)\b[^.]{0,100}?\b(?:and|or)\b[^.]{0,80}?\bwith\b|\bwith and without\b|\bwith\b[^.]{0,60}?\band\s+healthy\s+(?:controls?|volunteers|participants|adults|comparison)\b)/i;

/** e.g. "BMI between 25 and 35 (inclusive)" - id 4611. */
const BMI_RANGE_RE =
  /\bBMI[^.]{0,30}?(\d{2}(?:\.\d)?)\s*(?:-|to|and)\s*(\d{2}(?:\.\d)?)/i;

// ---------------------------------------------------------------------------
// Misc criteria that become flags
// ---------------------------------------------------------------------------

interface FlagRule {
  re: RegExp;
  flag: string;
}

const EXTRA_FLAG_RULES: FlagRule[] = [
  { re: /\b(?:fluent in English|English[- ]speaking|speak English|read English|communicate in English)\b/i, flag: 'English fluency required' },
  { re: /\b(?:normal or corrected(?:-to-normal)?|corrected-to-normal)\b/i, flag: 'normal or corrected-to-normal vision required' },
  { re: /\bnormal color vision\b/i, flag: 'normal colour vision required' },
  { re: /\b(?:SONA|subject pool|psychology subject pool)\b/i, flag: 'SONA / subject-pool participation offered' },
  { re: /\bnon-?student\b/i, flag: 'non-students only' },
  { re: /\b(?:able to walk|can walk|ability to walk|walk on campus)\b/i, flag: 'must be able to walk unaided' },
  { re: /\b(?:currently employed as|employed in the|workers? in the)\b/i, flag: 'occupational criterion - see study description' },
  { re: /\b(?:blood draws?|venipuncture|intravenous|IV catheter|blood samples?)\b/i, flag: 'involves blood draws' },
  { re: /\b(?:transcranial magnetic stimulation|\bTMS\b|theta burst stimulation|brain stimulation|galvanic vestibular)\b/i, flag: 'involves non-invasive brain stimulation' },
  { re: /\ballerg\w*\b/i, flag: 'allergy screening applies' },
];

// ---------------------------------------------------------------------------
// Age helpers
// ---------------------------------------------------------------------------

function parseAgeField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;

  const m = /-?\d+/.exec(value);
  if (!m) return null;

  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// parseEligibility
// ---------------------------------------------------------------------------

/**
 * Read screening criteria off a raw upstream record.
 *
 * Booleans are "the study requires/excludes this". `false` therefore means
 * "not detected", never "explicitly allowed" - see `ParsedEligibility`.
 */
export function parseEligibility(record: RawStudy): ParsedEligibility {
  const { title, all } = buildStudyText(record);
  const meta = record?.meta;

  const flags: string[] = [];
  const seen = new Set<string>();
  const addFlag = (f: string): void => {
    if (!f || seen.has(f)) return;
    seen.add(f);
    flags.push(f);
  };

  // -- Ages ----------------------------------------------------------------
  const rawMin = parseAgeField(meta?.aux_study_item_minimum_age);
  const rawMax = parseAgeField(meta?.aux_study_item_maximum_age);

  const minAge = rawMin !== null && rawMin >= 0 ? rawMin : 0;
  if (rawMin === null) addFlag('minimum age not stated upstream - assumed 0');

  let maxAge: number | null = null;
  if (rawMax !== null && rawMax < NO_MAX_AGE_SENTINEL) {
    maxAge = rawMax;
  } else if (rawMax === null) {
    addFlag('maximum age not stated upstream');
  }
  if (maxAge !== null && maxAge < minAge) {
    // Data-entry inversion; refuse to invent a range.
    addFlag(`upstream age range is inverted (${minAge}-${maxAge}) - confirm with the study team`);
    maxAge = null;
  }

  // -- Condition gating (must run before the exclusion booleans) -----------
  let requiresSpecificCondition: string | null = null;
  const suppressed = new Set<ExclusionKey>();

  const hasHealthyControlArm = HEALTHY_CONTROL_ARM_RE.test(all);

  for (const rule of CONDITION_RULES) {
    const titleHit = rule.title !== undefined && rule.title.test(title);
    const bodyHit = rule.body !== undefined && rule.body.test(all);
    if (!titleHit && !bodyHit) continue;

    if (!titleHit && hasHealthyControlArm) {
      // Clinical arm plus healthy-comparison arm: not a gate.
      addFlag(
        `study appears to enrol both healthy volunteers and people with ${rule.label} - confirm with the study team`,
      );
      continue;
    }

    if (requiresSpecificCondition === null) requiresSpecificCondition = rule.label;
    addFlag(`condition-gated: ${rule.label}`);
    for (const key of rule.suppress ?? []) suppressed.add(key);
  }

  const bmi = BMI_RANGE_RE.exec(all);
  if (bmi?.[1] !== undefined && bmi[2] !== undefined) {
    addFlag(`BMI ${bmi[1]}-${bmi[2]} required`);
    const lo = Number.parseFloat(bmi[1]);
    if (Number.isFinite(lo) && lo >= 25 && requiresSpecificCondition === null) {
      requiresSpecificCondition = `BMI ${bmi[1]}-${bmi[2]}`;
    }
  }

  // -- Handedness ----------------------------------------------------------
  const rightHand = scanMentions(all, RIGHT_HAND_RE);
  const leftHand = scanMentions(all, LEFT_HAND_RE);
  // "Exclusion criteria include left-handedness" (ids 11321, 8876) is a
  // right-handed requirement stated backwards.
  const requiresRightHanded = (rightHand.found && !rightHand.excluded) || leftHand.excluded;
  if (requiresRightHanded) addFlag('must be right-handed');
  else if (rightHand.found) {
    addFlag('handedness is mentioned but the requirement is unclear - confirm with the study team');
  }

  // -- MRI / magnet safety -------------------------------------------------
  const modality = scanMentions(all, MRI_MODALITY_RE);
  const magnetic = scanMentions(all, MRI_MAGNETIC_RE);
  const device = scanMentions(all, IMPLANTED_DEVICE_RE);
  const claustro = scanMentions(all, CLAUSTROPHOBIA_RE);

  const requiresMriSafe = modality.found || magnetic.found;
  if (requiresMriSafe) {
    addFlag('MRI / magnet safety screening');
  } else if (device.found) {
    // id 6950 (vaping + eye tracking), id 6969 (magnet-mounted eye camera):
    // an implanted-device screen with no imaging modality anywhere.
    addFlag('implanted medical device screening required (no MRI mentioned)');
  }
  if (claustro.found && !requiresMriSafe) addFlag('must be comfortable in enclosed spaces');

  // -- Fasting -------------------------------------------------------------
  let requiresFasting = false;
  let fastingNegated = false;
  {
    const re = new RegExp(FASTING_RE.source, FASTING_RE.flags);
    let m: RegExpExecArray | null = re.exec(all);
    while (m !== null) {
      const after = all.slice(m.index, Math.min(all.length, m.index + m[0].length + 90));
      if (FASTING_NEGATION_RE.test(after)) fastingNegated = true;
      else requiresFasting = true;
      m = re.exec(all);
    }
  }
  if (requiresFasting) addFlag('fasting required before a visit');
  else if (fastingNegated) addFlag('study text mentions fasting only to say it is NOT required');

  // -- Exclusions ----------------------------------------------------------
  const cardio = scanMentions(all, CARDIO_RE);
  const pregnancy = scanMentions(all, PREGNANCY_RE);
  const seizure = scanMentions(all, SEIZURE_RE);
  const neuro = scanMentions(all, NEURO_RE);

  const excludesCardiovascular = cardio.excluded && !suppressed.has('cardiovascular');
  const excludesPregnancy = pregnancy.excluded && !suppressed.has('pregnancy');
  const excludesSeizure = seizure.excluded && !suppressed.has('seizure');
  const excludesNeurological = neuro.excluded && !suppressed.has('neurological');

  if (excludesCardiovascular) addFlag('excludes cardiovascular conditions');
  if (excludesPregnancy) addFlag('excludes pregnancy / lactation');
  if (excludesSeizure) addFlag('excludes seizure or epilepsy history');
  if (excludesNeurological) addFlag('excludes neurological conditions');

  // Mentioned but not clearly a screen-out and not clearly required: say so
  // rather than guessing. (id 5436 discusses Alzheimer's disease as the study
  // topic while also recruiting cognitively normal adults.)
  const ambiguous: Array<[MentionScan, boolean, string]> = [
    [cardio, excludesCardiovascular || suppressed.has('cardiovascular'), 'cardiovascular health'],
    [pregnancy, excludesPregnancy || suppressed.has('pregnancy'), 'pregnancy'],
    [seizure, excludesSeizure || suppressed.has('seizure'), 'seizure or epilepsy history'],
    [neuro, excludesNeurological || suppressed.has('neurological'), 'neurological history'],
  ];
  for (const [scan, resolved, topic] of ambiguous) {
    if (scan.found && !resolved) {
      addFlag(`${topic} is mentioned but not clearly a criterion - confirm with the study team`);
    }
  }

  // -- Parent / child ------------------------------------------------------
  const childOnly = maxAge !== null && maxAge < 18;
  const pairLanguage = PARENT_CHILD_RE.test(all);
  const requiresParentOrChild = childOnly || pairLanguage;

  if (childOnly) addFlag('enrols children only - a parent or guardian must consent');
  else if (pairLanguage) addFlag('requires a parent and child participating together');

  if (minAge < 18 && !childOnly) {
    addFlag('enrols minors - parental consent required for under-18s');
  }
  if (!requiresParentOrChild) {
    const childMentions = all.match(CHILD_TOPIC_RE)?.length ?? 0;
    if (childMentions >= 3) {
      addFlag('study text is about children - confirm who actually participates');
    }
  }

  // -- Sex restriction -----------------------------------------------------
  let sexRestriction: SexRestriction = null;
  if (!BOTH_SEXES_RE.test(all)) {
    const femaleOnly = FEMALE_ONLY_RES.some((re) => re.test(all));
    const maleOnly = MALE_ONLY_RES.some((re) => re.test(all));

    if (femaleOnly && !maleOnly) sexRestriction = 'female';
    else if (maleOnly && !femaleOnly) sexRestriction = 'male';

    // Pregnancy as an inclusion criterion is a de-facto female restriction.
    if (sexRestriction === null && suppressed.has('pregnancy')) sexRestriction = 'female';

    // Menopause / menstrual-cycle criteria in the TITLE are conclusive; in the
    // body they are suggestive only (id 5945 recruits "people" but adds a
    // menstrual-cycle criterion), so those become a flag instead.
    if (sexRestriction === null && FEMALE_HINT_RE.test(title)) sexRestriction = 'female';
    else if (sexRestriction === null && FEMALE_HINT_RE.test(all)) {
      addFlag('study lists female-specific criteria - confirm with the study team');
    }
  }
  if (sexRestriction === 'female') addFlag('open to female participants only');
  if (sexRestriction === 'male') addFlag('open to male participants only');

  // -- Remaining descriptive flags ----------------------------------------
  for (const { re, flag } of EXTRA_FLAG_RULES) {
    if (re.test(all)) addFlag(flag);
  }

  return {
    minAge,
    maxAge,
    requiresRightHanded,
    requiresMriSafe,
    requiresFasting,
    excludesCardiovascular,
    excludesPregnancy,
    excludesSeizure,
    excludesNeurological,
    requiresSpecificCondition,
    requiresParentOrChild,
    sexRestriction,
    flags,
  };
}

// ---------------------------------------------------------------------------
// checkEligibility
// ---------------------------------------------------------------------------

const SEX_LABEL: Record<'male' | 'female', string> = { male: 'male', female: 'female' };

function ageRangeText(parsed: ParsedEligibility): string {
  return parsed.maxAge === null ? `${parsed.minAge} and over` : `${parsed.minAge}-${parsed.maxAge}`;
}

/** Flags whose wording implies the study recruits through the TAMU subject pool. */
const STUDENT_FLAG_RE = /SONA \/ subject-pool/i;
const NON_STUDENT_FLAG_RE = /non-students only/i;

/**
 * Compare parsed criteria against a self-reported profile.
 *
 * THIS IS A FILTERING HINT, NOT MEDICAL OR LEGAL ADVICE, AND NOT A DECISION.
 * The study team decides who may enrol.
 *
 * Three-state on purpose:
 *   'ineligible' - a hard, participation-blocking conflict was found.
 *   'unknown'    - the study cares about something the profile did not answer,
 *                  or something this parser could not verify.
 *   'eligible'   - no conflict and nothing unanswered that the study cares
 *                  about. Still only a hint.
 *
 * HARD CONFLICTS are: age out of range, handedness mismatch, explicit sex
 * restriction mismatch, cardiovascular exclusion vs a declared cardiovascular
 * condition, pregnancy exclusion vs declared pregnancy, and seizure exclusion
 * vs declared seizure history.
 *
 * Two additions to that list, made deliberately and noted here because they
 * are a superset of the original spec: MRI-safety and fasting. A participant
 * who has declared they are not MRI-safe cannot be shown "eligible" for a
 * scanner study - that is precisely the false-positive this module exists to
 * prevent - and a participant who has declared they will not fast cannot
 * complete a fasting protocol. Both are participation-blocking, so both are
 * treated as hard conflicts.
 *
 * Unanswered fields are ALWAYS 'unknown', never 'ineligible'.
 */
export function checkEligibility(
  parsed: ParsedEligibility,
  profile: UserProfile,
): EligibilityVerdict {
  const reasons: string[] = [];
  let hardConflict = false;
  let unresolved = false;

  const conflict = (reason: string): void => {
    hardConflict = true;
    reasons.push(reason);
  };
  const unknown = (reason: string): void => {
    unresolved = true;
    reasons.push(reason);
  };

  // -- Age -----------------------------------------------------------------
  const range = ageRangeText(parsed);
  if (profile.age === null) {
    if (parsed.minAge > 0 || parsed.maxAge !== null) {
      unknown(`This study enrols ages ${range}. Add your age to check whether you fit.`);
    }
  } else if (!Number.isFinite(profile.age)) {
    unknown(`Your age could not be read, so the ${range} age range was not checked.`);
  } else if (profile.age < parsed.minAge) {
    conflict(
      `This study enrols ages ${range} and your profile says you are ${profile.age}, which is below the minimum.`,
    );
  } else if (parsed.maxAge !== null && profile.age > parsed.maxAge) {
    conflict(
      `This study enrols ages ${range} and your profile says you are ${profile.age}, which is above the maximum.`,
    );
  } else {
    reasons.push(`Your age (${profile.age}) is inside the study's ${range} range.`);
  }

  // -- Handedness ----------------------------------------------------------
  if (parsed.requiresRightHanded) {
    if (profile.rightHanded === null) {
      unknown('This study requires right-handed participants and your profile does not say.');
    } else if (!profile.rightHanded) {
      conflict(
        'This study requires right-handed participants and your profile says you are not right-handed.',
      );
    } else {
      reasons.push('This study requires right-handed participants, which matches your profile.');
    }
  }

  // -- MRI safety ----------------------------------------------------------
  if (parsed.requiresMriSafe) {
    if (profile.mriSafe === null) {
      unknown(
        'This study uses MRI or magnetic equipment and your profile does not say whether you can be scanned safely.',
      );
    } else if (!profile.mriSafe) {
      conflict(
        'This study uses MRI or magnetic equipment and your profile says you are not able to be scanned safely.',
      );
    } else {
      reasons.push(
        'This study uses MRI or magnetic equipment; your profile says you can be scanned safely, but the lab will still run its own safety screen.',
      );
    }
  }

  // -- Fasting -------------------------------------------------------------
  if (parsed.requiresFasting) {
    if (profile.willingToFast === null) {
      unknown('This study requires fasting and your profile does not say whether you are willing to fast.');
    } else if (!profile.willingToFast) {
      conflict('This study requires fasting and your profile says you are not willing to fast.');
    } else {
      reasons.push('This study requires fasting, which you said you are willing to do.');
    }
  }

  // -- Sex restriction -----------------------------------------------------
  if (parsed.sexRestriction !== null) {
    const wanted = SEX_LABEL[parsed.sexRestriction];
    if (profile.sex === null) {
      unknown(`This study enrols ${wanted} participants only and your profile does not say.`);
    } else if (profile.sex === 'other') {
      unknown(
        `This study enrols ${wanted} participants only; your profile says "other", so the study team will need to confirm.`,
      );
    } else if (profile.sex !== parsed.sexRestriction) {
      conflict(
        `This study enrols ${wanted} participants only and your profile says ${SEX_LABEL[profile.sex]}.`,
      );
    } else {
      reasons.push(`This study enrols ${wanted} participants only, which matches your profile.`);
    }
  }

  // -- Cardiovascular ------------------------------------------------------
  if (parsed.excludesCardiovascular) {
    if (profile.hasCardiovascularCondition === null) {
      unknown(
        'This study screens out cardiovascular conditions (for example heart disease or high blood pressure) and your profile does not say.',
      );
    } else if (profile.hasCardiovascularCondition) {
      conflict(
        'This study screens out cardiovascular conditions and your profile lists one, such as heart disease or high blood pressure.',
      );
    } else {
      reasons.push(
        'This study screens out cardiovascular conditions; your profile does not list one.',
      );
    }
  }

  // -- Pregnancy -----------------------------------------------------------
  if (parsed.excludesPregnancy) {
    if (profile.isPregnant === null) {
      unknown('This study screens out people who are pregnant or lactating and your profile does not say.');
    } else if (profile.isPregnant) {
      conflict('This study screens out people who are pregnant and your profile says you are pregnant.');
    } else {
      reasons.push('This study screens out pregnancy; your profile says you are not pregnant.');
    }
  }

  // -- Seizure -------------------------------------------------------------
  if (parsed.excludesSeizure) {
    if (profile.hasSeizureHistory === null) {
      unknown('This study screens out seizure or epilepsy history and your profile does not say.');
    } else if (profile.hasSeizureHistory) {
      conflict(
        'This study screens out seizure or epilepsy history and your profile lists a history of seizures.',
      );
    } else {
      reasons.push(
        'This study screens out seizure or epilepsy history; your profile does not list one.',
      );
    }
  }

  // -- Criteria the profile cannot answer ---------------------------------
  if (parsed.excludesNeurological) {
    reasons.push(
      'This study screens out neurological conditions such as stroke or traumatic brain injury. The profile does not cover this, so the study team will check.',
    );
  }

  if (parsed.requiresSpecificCondition !== null) {
    unknown(
      `This study only enrols people with ${parsed.requiresSpecificCondition}, which the profile cannot confirm.`,
    );
  }

  if (parsed.requiresParentOrChild) {
    unknown(
      'This study needs a parent and child taking part together, not a lone adult volunteer.',
    );
  }

  // -- Student / subject-pool criteria ------------------------------------
  const wantsStudent = parsed.flags.some((f) => STUDENT_FLAG_RE.test(f));
  const wantsNonStudent = parsed.flags.some((f) => NON_STUDENT_FLAG_RE.test(f));

  if (wantsNonStudent) {
    if (profile.isTamuStudent === null) {
      unknown('This study enrols non-students only and your profile does not say whether you are a TAMU student.');
    } else if (profile.isTamuStudent) {
      conflict('This study enrols non-students only and your profile says you are a TAMU student.');
    }
  } else if (wantsStudent && profile.isTamuStudent === false) {
    reasons.push(
      'This study recruits partly through the TAMU subject pool; non-students may still be able to take part for cash.',
    );
  }

  // -- Unparsed criteria ---------------------------------------------------
  const cautionFlags = parsed.flags.filter((f) => /confirm with the study team/i.test(f));
  for (const f of cautionFlags) {
    unknown(`The listing is ambiguous: ${f.replace(/ - confirm with the study team$/i, '')}.`);
  }

  const status: EligibilityStatus = hardConflict
    ? 'ineligible'
    : unresolved
      ? 'unknown'
      : 'eligible';

  reasons.push(
    'This is a filtering hint based on the wording of the listing, not medical advice. The study team makes the final call.',
  );

  return { eligible: status === 'eligible', status, reasons };
}
