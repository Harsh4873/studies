/**
 * Tests for parseEligibility + checkEligibility.
 *
 * Two things are under test and they have different failure modes.
 *
 * `parseEligibility` reads free text written by dozens of labs. Every
 * assertion about a boolean below is anchored to a REAL record in
 * fixtures/arv-snapshot.json, and every positive case is paired with a
 * negative case drawn from text that a naive keyword scan would get wrong -
 * "hypertension" as an inclusion criterion, "pregnancy" as a requirement,
 * "pacemaker" with no scanner in sight. A keyword bag passes the positives and
 * fails the negatives, which is the point.
 *
 * `checkEligibility` is a safety device. The contract in src/types.ts says
 * 'unknown' must never collapse into 'ineligible' and, more importantly, an
 * unanswered question must never be resolved into 'eligible'. That property is
 * tested exhaustively over all 86 records, not just on examples.
 *
 * Fixture facts used as expectations (verified against the snapshot itself in
 * the "corpus invariants" block, so a fixture refresh fails loudly rather than
 * silently weakening the suite):
 *   86 records, 79 distinct IRB numbers, `status` "publish" on all 86.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkEligibility, parseEligibility } from '@/lib/parse-eligibility.ts';
import { NO_MAX_AGE_SENTINEL } from '@/types.ts';
import type { ParsedEligibility, RawStudy, UserProfile } from '@/types.ts';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url));

const RECORDS = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as RawStudy[];
const BY_ID = new Map<number, RawStudy>(RECORDS.map((r) => [r.id, r]));

/** Throws rather than returning undefined, so a fixture change fails at the assertion site. */
function record(id: number): RawStudy {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`fixture record ${id} is missing - refresh the expectations`);
  return found;
}

/** parseEligibility of a fixture record, memoized so 86-record sweeps stay cheap. */
const parsedCache = new Map<number, ParsedEligibility>();
function parsed(id: number): ParsedEligibility {
  let hit = parsedCache.get(id);
  if (hit === undefined) {
    hit = parseEligibility(record(id));
    parsedCache.set(id, hit);
  }
  return hit;
}

const ALL_PARSED: { id: number; e: ParsedEligibility }[] = RECORDS.map((r) => ({
  id: r.id,
  e: parseEligibility(r),
}));

// ---------------------------------------------------------------------------
// Synthetic record builder, for cases the corpus does not contain
// ---------------------------------------------------------------------------

/**
 * A minimal RawStudy. Only the fields parseEligibility reads are populated;
 * everything else is the shape upstream actually sends so that a future
 * defensive read does not fall off a cliff.
 */
function makeRecord(opts: {
  title?: string;
  excerpt?: string;
  content?: string;
  minAge?: unknown;
  maxAge?: unknown;
}): RawStudy {
  return {
    id: 999_999,
    date: '2026-01-01T00:00:00',
    date_gmt: '2026-01-01T00:00:00',
    modified: '2026-01-01T00:00:00',
    modified_gmt: '2026-01-01T00:00:00',
    slug: 'synthetic',
    status: 'publish',
    type: 'study',
    link: 'https://research.tamu.edu/study/synthetic/',
    guid: { rendered: '' },
    title: { rendered: opts.title ?? 'Synthetic Study' },
    content: { rendered: opts.content ?? '' },
    excerpt: { rendered: opts.excerpt ?? '' },
    meta: {
      aux_study_item_compensation: '',
      aux_study_item_duration: '',
      aux_study_item_contact_email: '',
      aux_study_item_contact_name: '',
      aux_study_item_contact_phone_number: '',
      aux_study_item_pi_name: '',
      aux_study_item_irb_number: 'STUDY2026-9999',
      aux_study_item_irb_approval_date: '2026-01-01T00:00:00',
      aux_study_item_minimum_age: (opts.minAge ?? '18') as string,
      aux_study_item_maximum_age: (opts.maxAge ?? '100') as string,
      aux_study_item_expiration_date: null,
      aux_study_item_recruitment_start_date: null,
      aux_study_item_lifecycle: 6,
      aux_study_item_button_link_object: { url: '' },
      aux_study_item_button_text: '',
      aux_is_internal: false,
    },
    aux_study_category: [],
    aux_study_location: [],
    aux_study_session_type: [],
    aux_study_topic: [],
  };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Every question unanswered. The default state of the UI form. */
const NULL_PROFILE: UserProfile = {
  age: null,
  rightHanded: null,
  mriSafe: null,
  hasCardiovascularCondition: null,
  isPregnant: null,
  hasSeizureHistory: null,
  sex: null,
  willingToFast: null,
  isTamuStudent: null,
};

/**
 * The real site owner, as specified: 24, handedness NOT answered, HAS a
 * cardiovascular condition (high blood pressure), not pregnant, no seizure
 * history. Everything else deliberately left unanswered - that is what a
 * partly-filled form looks like, and it is where the conservative-on-unknown
 * behaviour has to hold.
 */
const OWNER: UserProfile = {
  ...NULL_PROFILE,
  age: 24,
  hasCardiovascularCondition: true,
  isPregnant: false,
  hasSeizureHistory: false,
};

/** A helper for the parsed side of checkEligibility, so cases stay readable. */
function eligibilityOf(overrides: Partial<ParsedEligibility> = {}): ParsedEligibility {
  return {
    minAge: 18,
    maxAge: null,
    requiresRightHanded: false,
    requiresMriSafe: false,
    requiresFasting: false,
    excludesCardiovascular: false,
    excludesPregnancy: false,
    excludesSeizure: false,
    excludesNeurological: false,
    requiresSpecificCondition: null,
    requiresParentOrChild: false,
    sexRestriction: null,
    flags: [],
    ...overrides,
  };
}

const FRAMING =
  'This is a filtering hint based on the wording of the listing, not medical advice. The study team makes the final call.';

// ===========================================================================
// 1. Fixture sanity - if these fail, every expectation below is suspect
// ===========================================================================

describe('fixture preconditions', () => {
  it('is the frozen 86-record snapshot', () => {
    expect(RECORDS).toHaveLength(86);
    expect(new Set(RECORDS.map((r) => r.id)).size).toBe(86);
  });

  it('has every record still marked "publish" upstream', () => {
    // The reason the staleness module exists. Asserted here too because an
    // eligibility expectation drawn from an unpublished record would be junk.
    expect(RECORDS.every((r) => r.status === 'publish')).toBe(true);
  });
});

// ===========================================================================
// 2. Age fields and the no-upper-bound sentinels
// ===========================================================================

describe('parseEligibility - age range', () => {
  it('maps the 100 sentinel to maxAge null', () => {
    // id 12764 "Practicing Gender Neutral Pronouns": minimum_age "18", maximum_age "100".
    expect(record(12764).meta.aux_study_item_maximum_age).toBe('100');
    expect(parsed(12764).minAge).toBe(18);
    expect(parsed(12764).maxAge).toBeNull();
  });

  it('maps the 125 sentinel to maxAge null', () => {
    // ids 4636 "Lived Environments and Pain" and 4630 both use "125".
    expect(record(4636).meta.aux_study_item_maximum_age).toBe('125');
    expect(parsed(4636).maxAge).toBeNull();
    expect(record(4630).meta.aux_study_item_maximum_age).toBe('125');
    expect(parsed(4630).maxAge).toBeNull();
  });

  it('keeps a real upper bound that happens to be large', () => {
    // id 4613 caps at 95 and id 8408 at 81 - both real cutoffs, not sentinels.
    expect(parsed(4613).maxAge).toBe(95);
    expect(parsed(8408).maxAge).toBe(81);
    // id 8458 caps at 90.
    expect(parsed(8458).maxAge).toBe(90);
  });

  it('keeps ordinary ranges verbatim', () => {
    expect(parsed(12780)).toMatchObject({ minAge: 18, maxAge: 65 });
    expect(parsed(8406)).toMatchObject({ minAge: 18, maxAge: 30 });
    expect(parsed(9815)).toMatchObject({ minAge: 60, maxAge: 80 });
    expect(parsed(10351)).toMatchObject({ minAge: 18, maxAge: 29 });
  });

  it('keeps minor and infant ranges rather than clamping to 18', () => {
    // id 4618 "Emotional Development in Mothers and their Infants": 1-2 years.
    expect(parsed(4618)).toMatchObject({ minAge: 1, maxAge: 2 });
    // id 12766 "Aperiodic Slope and MRI": 6-10.
    expect(parsed(12766)).toMatchObject({ minAge: 6, maxAge: 10 });
    // id 10128 adolescents: 14-18.
    expect(parsed(10128)).toMatchObject({ minAge: 14, maxAge: 18 });
  });

  it('treats minAge 0 as a stated 0, not as missing', () => {
    // id 4607 "Learning, Emotions, and Parenting (LEAP)": minimum_age "0".
    expect(record(4607).meta.aux_study_item_minimum_age).toBe('0');
    expect(parsed(4607).minAge).toBe(0);
    expect(parsed(4607).flags).not.toContain('minimum age not stated upstream - assumed 0');
  });

  it.each([
    [98, 98],
    [99, 99],
    [NO_MAX_AGE_SENTINEL, null],
    [101, null],
    [125, null],
    [200, null],
  ])('maximum_age "%s" -> maxAge %s (sentinel boundary is >= %i)', (raw, expected) => {
    expect(parseEligibility(makeRecord({ maxAge: String(raw) })).maxAge).toBe(expected);
  });

  it('flags a missing maximum age instead of inventing one', () => {
    const e = parseEligibility(makeRecord({ maxAge: '' }));
    expect(e.maxAge).toBeNull();
    expect(e.flags).toContain('maximum age not stated upstream');
  });

  it('flags a missing minimum age and falls back to 0', () => {
    const e = parseEligibility(makeRecord({ minAge: 'unknown' }));
    expect(e.minAge).toBe(0);
    expect(e.flags).toContain('minimum age not stated upstream - assumed 0');
  });

  it('refuses to invent a range when upstream inverts it', () => {
    const e = parseEligibility(makeRecord({ minAge: '65', maxAge: '30' }));
    expect(e.minAge).toBe(65);
    expect(e.maxAge).toBeNull();
    expect(e.flags.some((f) => /age range is inverted/i.test(f))).toBe(true);
  });

  it('across the whole corpus, maxAge is null exactly when upstream stated >= 100', () => {
    for (const { id, e } of ALL_PARSED) {
      const stated = Number.parseInt(record(id).meta.aux_study_item_maximum_age, 10);
      if (Number.isFinite(stated) && stated >= NO_MAX_AGE_SENTINEL) {
        expect(e.maxAge, `record ${id} stated ${stated}`).toBeNull();
      } else {
        expect(e.maxAge, `record ${id} stated ${stated}`).toBe(stated);
      }
    }
  });

  it('never returns a maxAge below the minAge', () => {
    for (const { id, e } of ALL_PARSED) {
      if (e.maxAge !== null) expect(e.maxAge, `record ${id}`).toBeGreaterThanOrEqual(e.minAge);
    }
  });
});

// ===========================================================================
// 3. Exclusion booleans - positive and negative, both from real text
// ===========================================================================

describe('parseEligibility - excludesCardiovascular', () => {
  it.each([
    // id 12775: exclusion cue "have not had any of the following conditions"
    // sits ~190 chars before "acute cardiac event".
    [12775, 'gallotannins: "...have not had any of the following conditions...: acute cardiac event, seizures, stroke..."'],
    // id 8331: "5) do not have uncontrolled coronary heart disease, stroke, thyroid diseases, hypohidrosis, dementia"
    [8331, 'heat-risk study: "do not have uncontrolled coronary heart disease"'],
    // id 6995 spaceflight analog: "- I have history of cardiovascular disease"
    [6995, 'spaceflight analog: answer NO to "I have history of cardiovascular disease"'],
    // id 4613: "Exclusion criteria: ... heart disease, kidney disease, liver disease"
    [4613, 'sarcopenia study: "Exclusion criteria:" ~150 chars before "heart disease"'],
    // id 6950: "5. You do not have a cardiac device, cardiac pacemaker, ..."
    [6950, 'vaping study: "You do not have a cardiac device, cardiac pacemaker"'],
    // id 4615: same protocol family as 6950.
    [4615, 'smoking study: cardiac-device screen'],
  ])('detects the exclusion in record %i (%s)', (id) => {
    expect(parsed(id).excludesCardiovascular).toBe(true);
    expect(parsed(id).flags).toContain('excludes cardiovascular conditions');
  });

  it('does NOT fire when hypertension is the inclusion criterion (id 4630)', () => {
    // "Investigating Behavior Change Methods for the Management of Hypertension".
    // A keyword bag marks this excludesCardiovascular and hides the study from
    // exactly the people it recruits.
    expect(record(4630).title.rendered).toMatch(/Management of Hypertension/i);
    expect(parsed(4630).excludesCardiovascular).toBe(false);
    expect(parsed(4630).requiresSpecificCondition).toBe('diagnosed hypertension');
    expect(parsed(4630).flags).toContain('condition-gated: diagnosed hypertension');
  });

  it('does NOT fire on a study that never mentions the heart (id 11901)', () => {
    // "Green Campus and Health" - a 20-30 minute Qualtrics survey.
    expect(parsed(11901).excludesCardiovascular).toBe(false);
  });
});

describe('parseEligibility - excludesPregnancy', () => {
  it.each([
    // id 11315: "There will be no pregnant women involved."
    [11315, 'Dial Smith: "There will be no pregnant women involved."'],
    // id 12775: "...pregnancy or lactation, hepatitis B or C, HIV..." under a far-upstream cue.
    [12775, 'gallotannins: "pregnancy or lactation" inside a long not-had list'],
    // id 8408: "Any persons who are pregnant or expect they might be pregnant"
    [8408, 'MRS study: "Any persons who are pregnant or expect they might be pregnant"'],
    [8399, 'TBI MRS study: same exclusion block'],
    [11896, 'frontal-limbic TMS/MRI study'],
    [7660, 'Neural Mechanisms of Affective Attention'],
  ])('detects the exclusion in record %i (%s)', (id) => {
    expect(parsed(id).excludesPregnancy).toBe(true);
    expect(parsed(id).flags).toContain('excludes pregnancy / lactation');
  });

  it.each([
    // id 9821 "MAMA: Managing Anxiety, Mood, and Alcohol During Pregnancy"
    [9821],
    // id 4620 "Mom Brain Study (Maternal Brain Reorganization...)"
    [4620],
  ])('does NOT fire when pregnancy is REQUIRED (id %i)', (id) => {
    expect(parsed(id).excludesPregnancy).toBe(false);
    expect(parsed(id).requiresSpecificCondition).toBe('currently pregnant or expecting');
  });

  it('downgrades an unclear pregnancy mention to a flag rather than an exclusion (id 6995)', () => {
    expect(parsed(6995).excludesPregnancy).toBe(false);
    expect(parsed(6995).flags).toContain(
      'pregnancy is mentioned but not clearly a criterion - confirm with the study team',
    );
  });
});

describe('parseEligibility - excludesSeizure', () => {
  it.each([
    // id 9028: "Exclusion criteria include a history of epilepsy, severe motion sickness"
    [9028, 'Intelligent Spatial User Interface: "Exclusion criteria include a history of epilepsy"'],
    [8908, 'the duplicate posting of the same protocol'],
    // id 6750: "cannot have photosensitive epilepsy"
    [6750, 'Measuring Distraction: "cannot have photosensitive epilepsy"'],
    // id 6969: "...verify ... that they have no photosensitive epilepsy or have a pacemaker"
    [6969, 'cognitive flexibility: "no photosensitive epilepsy"'],
    // id 6745: "Exclusion: - report past or current symptoms of ... or epilepsy"
    [6745, 'DRIP: "Exclusion: ... bipolar disorder, psychotic spectrum disorders, or epilepsy"'],
    [4624, 'TAPAS: same exclusion block'],
    // id 12775: "seizures" inside the long not-had list.
    [12775, 'gallotannins: "acute cardiac event, seizures, stroke"'],
  ])('detects the exclusion in record %i (%s)', (id) => {
    expect(parsed(id).excludesSeizure).toBe(true);
    expect(parsed(id).flags).toContain('excludes seizure or epilepsy history');
  });

  it('does NOT fire on a study that never mentions seizures (id 12764)', () => {
    expect(parsed(12764).excludesSeizure).toBe(false);
  });

  it('downgrades an unclear seizure mention to a flag (ids 8408, 8338, 6995)', () => {
    for (const id of [8408, 8338, 6995]) {
      expect(parsed(id).excludesSeizure, `record ${id}`).toBe(false);
      expect(parsed(id).flags).toContain(
        'seizure or epilepsy history is mentioned but not clearly a criterion - confirm with the study team',
      );
    }
  });
});

describe('parseEligibility - excludesNeurological', () => {
  it.each([
    // id 12766: "Children have no known neurological conditions."
    [12766, 'Aperiodic Slope and MRI: "Children have no known neurological conditions."'],
    // id 8399: TBI is in the TITLE but excluded in the body - title-based
    // suppression would be exactly wrong here.
    [8399, 'TBI MRS study: "You do not have a history of traumatic brain injury"'],
    [12780, 'web-based motor learning study'],
    [6995, 'spaceflight analog: "I have significant lifetime history of ... neurological"'],
    [8331, 'heat-risk study: "do not have ... stroke, ... dementia"'],
    [8408, 'MRS study'],
  ])('detects the exclusion in record %i (%s)', (id) => {
    expect(parsed(id).excludesNeurological).toBe(true);
    expect(parsed(id).flags).toContain('excludes neurological conditions');
  });

  it('keeps TBI-in-the-title from suppressing the body-level exclusion (id 8399)', () => {
    expect(record(8399).title.rendered).toMatch(/Traumatic Brain Injury \(TBI\)/i);
    expect(parsed(8399).excludesNeurological).toBe(true);
    expect(parsed(8399).requiresSpecificCondition).toBeNull();
  });

  it('does NOT fire when a neurological disease is merely the study topic (id 5436)', () => {
    // "The human cerebellum: a novel target for cognitive & motor interventions
    // in aging & Alzheimer's Disease" - it also recruits cognitively normal adults.
    expect(parsed(5436).excludesNeurological).toBe(false);
    expect(parsed(5436).flags).toContain(
      'neurological history is mentioned but not clearly a criterion - confirm with the study team',
    );
  });

  it('does NOT fire on a study that never mentions neurology (id 11901)', () => {
    expect(parsed(11901).excludesNeurological).toBe(false);
  });
});

// ===========================================================================
// 4. Requirement booleans
// ===========================================================================

describe('parseEligibility - requiresMriSafe', () => {
  it.each([
    // id 12766: "Children have none of the following contraindications for MRI"
    [12766, 'Aperiodic Slope and MRI'],
    // id 8408: "Any persons with MR contra-indications (as per Human Imaging
    // Facility MR Safety Screening)"
    [8408, 'Magnetic Resonance Spectroscopy'],
    [8399, 'Magnetic Resonance Spectroscopy (TBI)'],
    [8406, 'Brain Connectivity and Behavior'],
    [4620, 'Mom Brain Study - neuroimaging'],
    [11321, 'menopause brain-networks study: "brain imaging environment"'],
    [5436, 'cerebellum study'],
  ])('detects a real imaging modality in record %i (%s)', (id) => {
    expect(parsed(id).requiresMriSafe).toBe(true);
    expect(parsed(id).flags).toContain('MRI / magnet safety screening');
  });

  it('does NOT treat a lone pacemaker screen as MRI (id 6969, eye tracking)', () => {
    // "Participants who have a pacemaker will be excluded because the eye
    // tracking camera is mounted with a magnet" - no scanner anywhere.
    expect(parsed(6969).requiresMriSafe).toBe(false);
    expect(parsed(6969).flags).toContain('implanted medical device screening required (no MRI mentioned)');
  });

  it('does NOT treat a cardiac-device screen as MRI (id 6950, vaping/attention)', () => {
    // "You do not have a cardiac device, cardiac pacemaker, implanted electronic
    // medical device, implantable cardioverter-defibrillators"
    expect(parsed(6950).requiresMriSafe).toBe(false);
    expect(parsed(6950).flags).toContain('implanted medical device screening required (no MRI mentioned)');
  });

  it('does NOT fire on an online survey (id 11901)', () => {
    expect(parsed(11901).requiresMriSafe).toBe(false);
    expect(parsed(11901).flags).toEqual([]);
  });
});

describe('parseEligibility - requiresRightHanded', () => {
  it('detects a direct inclusion criterion (id 8406)', () => {
    // "Inclusion criteria: ages 18-30, right-handed, and fluent in English"
    expect(parsed(8406).requiresRightHanded).toBe(true);
    expect(parsed(8406).flags).toContain('must be right-handed');
  });

  it('detects "right handed" written without the hyphen (id 8874)', () => {
    // "Participants in this study will be right handed English-speaking adult
    // females between the ages of 18 and 35."
    expect(parsed(8874).requiresRightHanded).toBe(true);
  });

  it.each([[11321], [8876]])(
    'infers the requirement from an exclusion of left-handedness (id %i)',
    (id) => {
      // "Exclusion criteria include left-handedness and any factor that is a
      // contraindication for the brain imaging environment." The phrase
      // "right-handed" never appears in these records.
      expect(parsed(id).requiresRightHanded).toBe(true);
      expect(parsed(id).flags).toContain('must be right-handed');
    },
  );

  it('does NOT fire on a study that never mentions handedness (id 11901)', () => {
    expect(parsed(11901).requiresRightHanded).toBe(false);
  });

  it('does NOT fire when handedness itself is the excluded trait', () => {
    const e = parseEligibility(
      makeRecord({ content: 'Exclusion criteria include right-handedness; we are recruiting left-handers.' }),
    );
    expect(e.requiresRightHanded).toBe(false);
  });
});

describe('parseEligibility - requiresFasting', () => {
  it.each([
    // id 9815: "The subject will be asked to arrive in the fasted state on study days."
    [9815, 'Prandial Metabolic Phenotype'],
    // id 8458: "Study visits: Arrive fasted in the morning"
    [8458, '(pre)frail older adults'],
    // id 4611: "we ask you to come in the morning fasted"
    [4611, 'macronutrient-intake biomarkers'],
  ])('detects a real fasting requirement in record %i (%s)', (id) => {
    expect(parsed(id).requiresFasting).toBe(true);
    expect(parsed(id).flags).toContain('fasting required before a visit');
  });

  it('does NOT fire on the negated sentence alone (id 9815 in isolation)', () => {
    // "Fasting prior to screening is not required." The negation TRAILS the
    // keyword, so a look-behind-only parser reads it as a requirement.
    const e = parseEligibility(
      makeRecord({ content: 'Fasting prior to screening is not required. Visits last up to 2 hours.' }),
    );
    expect(e.requiresFasting).toBe(false);
    expect(e.flags).toContain('study text mentions fasting only to say it is NOT required');
  });

  it('still requires fasting when a separate sentence asks for it (id 9815 in full)', () => {
    // Both sentences are present in the real record; the affirmative one wins,
    // and the "not required" flag must NOT be emitted alongside it.
    expect(parsed(9815).requiresFasting).toBe(true);
    expect(parsed(9815).flags).not.toContain('study text mentions fasting only to say it is NOT required');
  });

  it('does NOT fire on a study that never mentions food (id 12764)', () => {
    expect(parsed(12764).requiresFasting).toBe(false);
  });
});

describe('parseEligibility - sexRestriction', () => {
  it.each([
    // id 8874: "adult females between the ages of 18 and 35"
    [8874, 'estrogen/TMS study: "adult females between the ages of 18 and 35"'],
    // ids 11321 / 8876: menopause in the title.
    [11321, 'menopause in the title'],
    [8876, 'menopause in the title (duplicate posting)'],
    // ids 9821 / 4620: pregnancy required => de-facto female.
    [9821, 'pregnancy is the inclusion criterion'],
    [4620, 'first-time mothers'],
  ])('restricts record %i to female (%s)', (id) => {
    expect(parsed(id).sexRestriction).toBe('female');
    expect(parsed(id).flags).toContain('open to female participants only');
  });

  it('does NOT restrict on "male or female" boilerplate (id 6987)', () => {
    // "generally healthy male or female 18-30 year olds, BMI 18.5-30"
    expect(parsed(6987).sexRestriction).toBeNull();
  });

  it('does NOT restrict on questionnaire content mentioning men and women (id 10351)', () => {
    // "...statements about men and women" is the content of the survey items.
    expect(parsed(10351).sexRestriction).toBeNull();
  });

  it('does NOT restrict on "no pregnant women" (id 11315)', () => {
    // Bare "women" here is part of an EXCLUSION, not a restriction.
    expect(parsed(11315).sexRestriction).toBeNull();
    expect(parsed(11315).excludesPregnancy).toBe(true);
  });

  it('downgrades a body-only female hint to a flag (id 5945)', () => {
    // "must be menstruating regularly" appears in the body of a study that
    // otherwise recruits "healthy people and ... people with PTSD".
    expect(parsed(5945).sexRestriction).toBeNull();
    expect(parsed(5945).flags).toContain(
      'study lists female-specific criteria - confirm with the study team',
    );
  });

  it('leaves no record restricted to male in this corpus', () => {
    expect(ALL_PARSED.filter(({ e }) => e.sexRestriction === 'male')).toEqual([]);
  });
});

describe('parseEligibility - requiresParentOrChild', () => {
  it.each([
    [12766, 'children 6-10 with parents'],
    [8903, "children's reading biomarkers, ages 7-11"],
    [8411, 'duplicate posting of the same protocol'],
    [8402, "Children's Achievement Behaviors, ages 9-13"],
    [4618, 'Mothers and their Infants, ages 1-2'],
    [4607, 'Learning, Emotions, and Parenting (LEAP)'],
  ])('detects the pairing requirement in record %i (%s)', (id) => {
    expect(parsed(id).requiresParentOrChild).toBe(true);
  });

  it('does NOT fire on an adult-only study that merely discusses children (id 6942)', () => {
    // "COVID-19 Kids: Socio-emotional and Cognitive Development" - the topic is
    // children, but a flag is raised rather than a hard requirement.
    expect(parsed(6942).requiresParentOrChild).toBe(false);
    expect(parsed(6942).flags).toContain(
      'study text is about children - confirm who actually participates',
    );
  });

  it('does NOT fire on an adult survey (id 11901)', () => {
    expect(parsed(11901).requiresParentOrChild).toBe(false);
  });
});

describe('parseEligibility - requiresSpecificCondition', () => {
  /** Exact expected label per record, so a rule reorder is caught. */
  const EXPECTED: [number, string][] = [
    [11077, 'chronic pain'],
    [9957, 'chronic low back pain'],
    [9953, 'chronic low back pain'],
    [9821, 'currently pregnant or expecting'],
    [8882, 'formally diagnosed ADHD'],
    [8458, 'sarcopenia or frailty'],
    [8333, 'chronic knee pain or knee osteoarthritis'],
    [7003, 'chronic knee pain or knee osteoarthritis'],
    [6953, 'diagnosed diabetes'],
    [6950, 'current e-cigarette / vape use'],
    [6745, 'elevated depressive symptoms'],
    [4630, 'diagnosed hypertension'],
    [4626, 'trauma exposure history'],
    [4624, 'trauma exposure history'],
    [4620, 'currently pregnant or expecting'],
    [4615, 'current e-cigarette / vape use'],
    [4613, 'sarcopenia or frailty'],
    [4611, 'BMI 25-35'],
    [4593, 'PTSD with co-occurring alcohol use'],
  ];

  it.each(EXPECTED)('record %i is gated on "%s"', (id, label) => {
    expect(parsed(id).requiresSpecificCondition).toBe(label);
    expect(parsed(id).flags.some((f) => f.startsWith('condition-gated:') || f.startsWith('BMI '))).toBe(true);
  });

  it('gates exactly those records and no others', () => {
    const actual = ALL_PARSED.filter(({ e }) => e.requiresSpecificCondition !== null).map(({ id }) => id);
    expect(actual.sort((a, b) => a - b)).toEqual(EXPECTED.map(([id]) => id).sort((a, b) => a - b));
  });

  it('does NOT gate a healthy-comparison-arm study (id 5945)', () => {
    // "...in healthy people and in people with PTSD" - a healthy volunteer can
    // still take part, so this is a flag, not a gate.
    expect(parsed(5945).requiresSpecificCondition).toBeNull();
    expect(parsed(5945).flags.some((f) => /enrol both healthy volunteers and people with/i.test(f))).toBe(true);
  });

  it('does NOT gate a "with and without" study (id 6944)', () => {
    // "conducted in older adults with and without chronic diseases and frailty"
    expect(parsed(6944).requiresSpecificCondition).toBeNull();
  });

  it('does not treat a healthy BMI window as a condition (id 6987)', () => {
    // "BMI 18.5-30" is a healthy range, not a clinical gate; id 4611's 25-35 is.
    expect(parsed(6987).requiresSpecificCondition).toBeNull();
    expect(parsed(6987).flags).toContain('BMI 18.5-30 required');
  });
});

// ===========================================================================
// 5. Corpus-wide counts - one assertion that locks the whole parse
// ===========================================================================

describe('parseEligibility - corpus invariants', () => {
  it('produces the expected number of hits per boolean across all 86 records', () => {
    const count = (pick: (e: ParsedEligibility) => boolean): number =>
      ALL_PARSED.filter(({ e }) => pick(e)).length;

    expect({
      requiresMriSafe: count((e) => e.requiresMriSafe),
      excludesNeurological: count((e) => e.excludesNeurological),
      excludesPregnancy: count((e) => e.excludesPregnancy),
      excludesSeizure: count((e) => e.excludesSeizure),
      excludesCardiovascular: count((e) => e.excludesCardiovascular),
      requiresRightHanded: count((e) => e.requiresRightHanded),
      requiresParentOrChild: count((e) => e.requiresParentOrChild),
      requiresFasting: count((e) => e.requiresFasting),
      female: count((e) => e.sexRestriction === 'female'),
      male: count((e) => e.sexRestriction === 'male'),
      conditionGated: count((e) => e.requiresSpecificCondition !== null),
    }).toEqual({
      requiresMriSafe: 14,
      excludesNeurological: 14,
      excludesPregnancy: 12,
      excludesSeizure: 11,
      excludesCardiovascular: 7,
      requiresRightHanded: 7,
      requiresParentOrChild: 6,
      requiresFasting: 3,
      female: 5,
      male: 0,
      conditionGated: 19,
    });
  });

  it('never throws and always returns the full contract shape', () => {
    for (const raw of RECORDS) {
      const e = parseEligibility(raw);
      expect(typeof e.minAge, `record ${raw.id}`).toBe('number');
      expect(e.maxAge === null || typeof e.maxAge === 'number').toBe(true);
      expect(Array.isArray(e.flags)).toBe(true);
      expect(new Set(e.flags).size, `record ${raw.id} has duplicate flags`).toBe(e.flags.length);
    }
  });

  it('survives a completely empty record without throwing', () => {
    const e = parseEligibility({ meta: {} } as unknown as RawStudy);
    expect(e.minAge).toBe(0);
    expect(e.maxAge).toBeNull();
    expect(e.requiresMriSafe).toBe(false);
  });

  it('a condition-gated pregnancy study never also reports excludesPregnancy', () => {
    for (const { id, e } of ALL_PARSED) {
      if (e.requiresSpecificCondition === 'currently pregnant or expecting') {
        expect(e.excludesPregnancy, `record ${id}`).toBe(false);
      }
    }
  });
});

// ===========================================================================
// 6. checkEligibility - the owner profile, as specified
// ===========================================================================

describe('checkEligibility - the site owner (24, handedness unanswered, high blood pressure)', () => {
  it('marks the spaceflight study INELIGIBLE and names the blood-pressure conflict', () => {
    // id 6995 "Validation of a new analog for neurovestibular challenges
    // associated with spaceflight" - "I have history of cardiovascular disease".
    const verdict = checkEligibility(parsed(6995), OWNER);

    expect(verdict.status).toBe('ineligible');
    expect(verdict.eligible).toBe(false);

    const cardioReason = verdict.reasons.find((r) => /cardiovascular/i.test(r) && /your profile/i.test(r));
    expect(cardioReason, 'no reason named the cardiovascular conflict').toBeDefined();
    // The reason must actually say "blood pressure", not just "cardiovascular" -
    // the owner declared high blood pressure and needs to recognise themselves
    // in the explanation.
    expect(cardioReason).toMatch(/blood pressure/i);
    expect(cardioReason).toBe(
      'This study screens out cardiovascular conditions and your profile lists one, such as heart disease or high blood pressure.',
    );
  });

  it('marks a plain online survey ELIGIBLE', () => {
    // id 11901 "Green Campus and Health": a 20-30 minute Qualtrics questionnaire,
    // $10 Amazon e-gift card, ages 18+, no screening criteria of any kind.
    expect(parsed(11901).flags).toEqual([]);
    const verdict = checkEligibility(parsed(11901), OWNER);

    expect(verdict.status).toBe('eligible');
    expect(verdict.eligible).toBe(true);
    expect(verdict.reasons).toEqual([
      "Your age (24) is inside the study's 18 and over range.",
      FRAMING,
    ]);
  });

  it('marks a second plain online study ELIGIBLE (id 12764, "Online Only")', () => {
    const verdict = checkEligibility(parsed(12764), OWNER);
    expect(verdict.status).toBe('eligible');
  });

  it('returns UNKNOWN - not eligible - when the study needs handedness the profile has not given', () => {
    // id 8406 "Brain Connectivity and Behavior": "Inclusion criteria: ages
    // 18-30, right-handed, and fluent in English".
    expect(parsed(8406).requiresRightHanded).toBe(true);
    const verdict = checkEligibility(parsed(8406), OWNER);

    expect(verdict.status).toBe('unknown');
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain(
      'This study requires right-handed participants and your profile does not say.',
    );
  });

  it('isolates handedness as the ONLY unresolved criterion once MRI safety is answered', () => {
    // Same record, but the profile now answers the MRI question. The verdict
    // must still be 'unknown', driven by handedness alone.
    const verdict = checkEligibility(parsed(8406), { ...OWNER, mriSafe: true });

    expect(verdict.status).toBe('unknown');
    expect(verdict.reasons).toEqual([
      "Your age (24) is inside the study's 18-30 range.",
      'This study requires right-handed participants and your profile does not say.',
      'This study uses MRI or magnetic equipment; your profile says you can be scanned safely, but the lab will still run its own safety screen.',
      FRAMING,
    ]);
  });

  it('flips to ELIGIBLE only once handedness is actually answered', () => {
    const verdict = checkEligibility(parsed(8406), { ...OWNER, mriSafe: true, rightHanded: true });
    expect(verdict.status).toBe('eligible');
    expect(verdict.reasons).toContain(
      'This study requires right-handed participants, which matches your profile.',
    );
  });

  it('flips to INELIGIBLE when handedness is answered the other way', () => {
    const verdict = checkEligibility(parsed(8406), { ...OWNER, mriSafe: true, rightHanded: false });
    expect(verdict.status).toBe('ineligible');
    expect(verdict.reasons).toContain(
      'This study requires right-handed participants and your profile says you are not right-handed.',
    );
  });

  it('is out of the age range for the 60-80 metabolic study (id 9815)', () => {
    const verdict = checkEligibility(parsed(9815), OWNER);
    expect(verdict.status).toBe('ineligible');
    expect(verdict.reasons[0]).toBe(
      'This study enrols ages 60-80 and your profile says you are 24, which is below the minimum.',
    );
  });

  it('always ends the reasons with the not-medical-advice framing line', () => {
    for (const raw of RECORDS) {
      const verdict = checkEligibility(parseEligibility(raw), OWNER);
      expect(verdict.reasons.at(-1), `record ${raw.id}`).toBe(FRAMING);
    }
  });

  it('produces the expected verdict spread over the whole corpus', () => {
    const tally = { eligible: 0, ineligible: 0, unknown: 0 };
    for (const raw of RECORDS) tally[checkEligibility(parseEligibility(raw), OWNER).status] += 1;
    expect(tally).toEqual({ eligible: 36, ineligible: 22, unknown: 28 });
  });
});

// ===========================================================================
// 7. Conservative-on-unknown: the safety property, tested hard
// ===========================================================================

describe('checkEligibility - conservative on unknown (safety property)', () => {
  it('never returns "ineligible" for a completely unanswered profile, on any of the 86 records', () => {
    const offenders = RECORDS.filter(
      (r) => checkEligibility(parseEligibility(r), NULL_PROFILE).status === 'ineligible',
    ).map((r) => r.id);
    expect(offenders).toEqual([]);
  });

  it('never returns "eligible" for a completely unanswered profile either', () => {
    // Silence is not consent in the other direction. Every record in this
    // corpus states at least a minimum age, so every verdict is 'unknown'.
    const offenders = RECORDS.filter(
      (r) => checkEligibility(parseEligibility(r), NULL_PROFILE).status === 'eligible',
    ).map((r) => r.id);
    expect(offenders).toEqual([]);
  });

  it.each([
    // The matching UserProfile field is left null in every case.
    ['requiresRightHanded (profile.rightHanded)', eligibilityOf({ requiresRightHanded: true })],
    ['requiresMriSafe (profile.mriSafe)', eligibilityOf({ requiresMriSafe: true })],
    ['requiresFasting (profile.willingToFast)', eligibilityOf({ requiresFasting: true })],
    ['excludesCardiovascular (profile.hasCardiovascularCondition)', eligibilityOf({ excludesCardiovascular: true })],
    ['excludesPregnancy (profile.isPregnant)', eligibilityOf({ excludesPregnancy: true })],
    ['excludesSeizure (profile.hasSeizureHistory)', eligibilityOf({ excludesSeizure: true })],
  ])('%s unanswered is "unknown", never "eligible"', (_name, e) => {
    const verdict = checkEligibility(e, { ...NULL_PROFILE, age: 24 });
    expect(verdict.status).toBe('unknown');
    expect(verdict.eligible).toBe(false);
  });

  it.each([
    ['requiresRightHanded', eligibilityOf({ requiresRightHanded: true }), { rightHanded: false }],
    ['requiresMriSafe', eligibilityOf({ requiresMriSafe: true }), { mriSafe: false }],
    ['requiresFasting', eligibilityOf({ requiresFasting: true }), { willingToFast: false }],
    ['excludesCardiovascular', eligibilityOf({ excludesCardiovascular: true }), { hasCardiovascularCondition: true }],
    ['excludesPregnancy', eligibilityOf({ excludesPregnancy: true }), { isPregnant: true }],
    ['excludesSeizure', eligibilityOf({ excludesSeizure: true }), { hasSeizureHistory: true }],
  ])('%s with a declared conflict is a hard "ineligible"', (_name, e, patch) => {
    const verdict = checkEligibility(e, { ...NULL_PROFILE, age: 24, ...patch });
    expect(verdict.status).toBe('ineligible');
    expect(verdict.eligible).toBe(false);
  });

  it('treats MRI safety as a hard conflict, not a soft note (documented superset of the brief)', () => {
    const verdict = checkEligibility(eligibilityOf({ requiresMriSafe: true }), {
      ...NULL_PROFILE,
      age: 24,
      mriSafe: false,
    });
    expect(verdict.status).toBe('ineligible');
    expect(verdict.reasons).toContain(
      'This study uses MRI or magnetic equipment and your profile says you are not able to be scanned safely.',
    );
  });

  it('treats fasting as a hard conflict', () => {
    const verdict = checkEligibility(eligibilityOf({ requiresFasting: true }), {
      ...NULL_PROFILE,
      age: 24,
      willingToFast: false,
    });
    expect(verdict.status).toBe('ineligible');
  });

  it('a hard conflict outranks any number of unknowns', () => {
    const verdict = checkEligibility(
      eligibilityOf({
        requiresRightHanded: true,
        requiresMriSafe: true,
        requiresFasting: true,
        excludesCardiovascular: true,
      }),
      { ...NULL_PROFILE, age: 24, hasCardiovascularCondition: true },
    );
    expect(verdict.status).toBe('ineligible');
  });

  it('`eligible` is true if and only if status is "eligible"', () => {
    for (const raw of RECORDS) {
      for (const profile of [NULL_PROFILE, OWNER, { ...OWNER, mriSafe: true, rightHanded: true }]) {
        const v = checkEligibility(parseEligibility(raw), profile);
        expect(v.eligible, `record ${raw.id}`).toBe(v.status === 'eligible');
      }
    }
  });

  it('turns every "confirm with the study team" flag into an unknown', () => {
    const e = eligibilityOf({ flags: ['pregnancy is mentioned but not clearly a criterion - confirm with the study team'] });
    const verdict = checkEligibility(e, { ...NULL_PROFILE, age: 24 });
    expect(verdict.status).toBe('unknown');
    expect(verdict.reasons).toContain(
      'The listing is ambiguous: pregnancy is mentioned but not clearly a criterion.',
    );
  });
});

// ===========================================================================
// 8. checkEligibility - age boundaries
// ===========================================================================

describe('checkEligibility - age boundaries', () => {
  const range = eligibilityOf({ minAge: 18, maxAge: 30 });

  it.each([
    [17, 'ineligible'],
    [18, 'eligible'],
    [19, 'eligible'],
    [29, 'eligible'],
    [30, 'eligible'],
    [31, 'ineligible'],
  ])('age %i against an 18-30 study is %s (both ends inclusive)', (age, expected) => {
    expect(checkEligibility(range, { ...NULL_PROFILE, age }).status).toBe(expected);
  });

  it('names the direction of the age failure', () => {
    expect(checkEligibility(range, { ...NULL_PROFILE, age: 17 }).reasons[0]).toBe(
      'This study enrols ages 18-30 and your profile says you are 17, which is below the minimum.',
    );
    expect(checkEligibility(range, { ...NULL_PROFILE, age: 31 }).reasons[0]).toBe(
      'This study enrols ages 18-30 and your profile says you are 31, which is above the maximum.',
    );
  });

  it('an open-ended upper bound never fails on age', () => {
    const open = eligibilityOf({ minAge: 18, maxAge: null });
    for (const age of [18, 45, 99, 120]) {
      expect(checkEligibility(open, { ...NULL_PROFILE, age }).status, `age ${age}`).toBe('eligible');
    }
  });

  it('a minAge-0, maxAge-null study does not ask for an age at all', () => {
    const verdict = checkEligibility(eligibilityOf({ minAge: 0, maxAge: null }), NULL_PROFILE);
    expect(verdict.status).toBe('eligible');
    expect(verdict.reasons).toEqual([FRAMING]);
  });

  it('an unanswered age against a real range is unknown, not ineligible', () => {
    const verdict = checkEligibility(range, NULL_PROFILE);
    expect(verdict.status).toBe('unknown');
    expect(verdict.reasons).toContain('This study enrols ages 18-30. Add your age to check whether you fit.');
  });

  it('an unreadable age is unknown rather than a silent pass', () => {
    const verdict = checkEligibility(range, { ...NULL_PROFILE, age: Number.NaN });
    expect(verdict.status).toBe('unknown');
  });
});

// ===========================================================================
// 9. checkEligibility - sex restriction
// ===========================================================================

describe('checkEligibility - sex restriction', () => {
  const femaleOnly = eligibilityOf({ sexRestriction: 'female' });

  it('matches a female profile', () => {
    expect(checkEligibility(femaleOnly, { ...NULL_PROFILE, age: 24, sex: 'female' }).status).toBe('eligible');
  });

  it('conflicts with a male profile', () => {
    const v = checkEligibility(femaleOnly, { ...NULL_PROFILE, age: 24, sex: 'male' });
    expect(v.status).toBe('ineligible');
    expect(v.reasons).toContain('This study enrols female participants only and your profile says male.');
  });

  it('is unknown, not ineligible, for "other"', () => {
    const v = checkEligibility(femaleOnly, { ...NULL_PROFILE, age: 24, sex: 'other' });
    expect(v.status).toBe('unknown');
  });

  it('is unknown when sex is unanswered', () => {
    expect(checkEligibility(femaleOnly, { ...NULL_PROFILE, age: 24 }).status).toBe('unknown');
  });
});

// ===========================================================================
// 10. checkEligibility - criteria the profile cannot answer
// ===========================================================================

describe('checkEligibility - unanswerable criteria', () => {
  it('a condition-gated study is unknown even for a fully answered profile', () => {
    const v = checkEligibility(eligibilityOf({ requiresSpecificCondition: 'diagnosed diabetes' }), {
      age: 24,
      rightHanded: true,
      mriSafe: true,
      hasCardiovascularCondition: false,
      isPregnant: false,
      hasSeizureHistory: false,
      sex: 'male',
      willingToFast: true,
      isTamuStudent: true,
    });
    expect(v.status).toBe('unknown');
    expect(v.reasons.some((r) => /only enrols people with diagnosed diabetes/i.test(r))).toBe(true);
  });

  it('a parent-and-child study is unknown for a lone adult', () => {
    const v = checkEligibility(eligibilityOf({ requiresParentOrChild: true }), { ...NULL_PROFILE, age: 34 });
    expect(v.status).toBe('unknown');
    expect(v.reasons).toContain(
      'This study needs a parent and child taking part together, not a lone adult volunteer.',
    );
  });

  it('a non-students-only study conflicts with a declared TAMU student', () => {
    const v = checkEligibility(eligibilityOf({ flags: ['non-students only'] }), {
      ...NULL_PROFILE,
      age: 24,
      isTamuStudent: true,
    });
    expect(v.status).toBe('ineligible');
  });

  it('a non-students-only study is unknown when studenthood is unanswered', () => {
    const v = checkEligibility(eligibilityOf({ flags: ['non-students only'] }), { ...NULL_PROFILE, age: 24 });
    expect(v.status).toBe('unknown');
  });

  /**
   * DOCUMENTS CURRENT BEHAVIOUR - see the findings note.
   *
   * `excludesNeurological` has no matching UserProfile field, so it is emitted
   * as an informational reason and does NOT hold the verdict at 'unknown'.
   * `requiresSpecificCondition` is equally unanswerable and DOES force
   * 'unknown'. The two unanswerable criteria are therefore treated
   * differently, and the neurological one can produce "eligible" for someone
   * the study would screen out. Locked in here so the choice is a decision
   * rather than an accident; flip the expectation if the behaviour changes.
   */
  it('excludesNeurological alone still yields "eligible" (asymmetry with requiresSpecificCondition)', () => {
    const v = checkEligibility(eligibilityOf({ excludesNeurological: true }), { ...NULL_PROFILE, age: 24 });
    expect(v.status).toBe('eligible');
    expect(v.reasons).toContain(
      'This study screens out neurological conditions such as stroke or traumatic brain injury. The profile does not cover this, so the study team will check.',
    );

    // Same shape of criterion, opposite handling:
    expect(
      checkEligibility(eligibilityOf({ requiresSpecificCondition: 'diagnosed diabetes' }), {
        ...NULL_PROFILE,
        age: 24,
      }).status,
    ).toBe('unknown');
  });

  it('real record 12780 is reported "eligible" to the owner despite excluding neurological conditions', () => {
    // The concrete consequence of the asymmetry above, on real data.
    expect(parsed(12780).excludesNeurological).toBe(true);
    expect(checkEligibility(parsed(12780), OWNER).status).toBe('eligible');
  });
});
