/**
 * RawStudy -> StudyRecord.
 *
 * This is the seam between "whatever WordPress felt like emitting" and the
 * clean contract in `src/types.ts` that every ranker and component codes
 * against. Three jobs:
 *
 *   1. Coerce defensively. Meta values are NOT all strings - `lifecycle` is a
 *      number, `aux_is_internal` is a boolean, `expiration_date` is sometimes
 *      literally `null`, and `button_link_object` is an object. `.trim()` on
 *      the wrong field throws, so every read goes through a coercer.
 *   2. Delegate the hard parsing. Compensation, duration, eligibility,
 *      effective hourly rate and staleness each live in their own module.
 *   3. Deduplicate. The registry re-posts the same protocol under new ids
 *      (same IRB number, near-identical title). Those are collapsed to the
 *      most recently modified record so one study occupies one row.
 *
 * Nothing here throws on bad input: a single malformed record must not take
 * down the build.
 */

import { stripHtml, collapseWhitespace, truncate } from '@/lib/html.ts';
import { parseCompensation } from '@/lib/parse-compensation.ts';
import { parseDuration } from '@/lib/parse-duration.ts';
import { reconcileEffectiveHourly } from '@/lib/effective-rate.ts';
import { applyContentFallbacks } from '@/lib/extract-from-content.ts';
import { parseEligibility } from '@/lib/parse-eligibility.ts';
import { computeStaleness } from '@/lib/staleness.ts';
import { NO_MAX_AGE_SENTINEL, LIFECYCLE_MONTHS } from '@/types.ts';
import type {
  ParsedEligibility,
  RawStudy,
  RawStudyMeta,
  Staleness,
  StudyRecord,
  TaxonomyMaps,
} from '@/types.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A `StudyRecord` carrying its duplicate lineage.
 *
 * `duplicateIds` on the surviving record lists the ids that were collapsed
 * into it; `duplicateOf` is `null` on survivors and is populated on the
 * dropped records returned in `DedupeResult.dropped`. Structurally still a
 * `StudyRecord`, so it flows into `Snapshot.studies` unchanged.
 */
export interface DedupedStudyRecord extends StudyRecord {
  duplicateIds: string[];
  duplicateOf: string | null;
}

export interface NormalizeOptions {
  /** Term lookups for tag inference. Tags degrade to text keywords without it. */
  taxonomies?: TaxonomyMaps | null;
  /** Clock injection, so staleness is testable. Defaults to `new Date()`. */
  now?: Date;
}

export interface DuplicateGroup {
  irbNumber: string;
  keptId: string;
  droppedIds: string[];
  /** True when collapsed titles are not near-identical - worth eyeballing. */
  titlesDiverge: boolean;
}

export interface DedupeResult {
  studies: DedupedStudyRecord[];
  dropped: DedupedStudyRecord[];
  groups: DuplicateGroup[];
}

/** Canonical tag order, so `tags` is stable across runs. */
export const TAG_ORDER = [
  'online',
  'in-person',
  'mri',
  'eeg',
  'vr-ar',
  'focus-group',
  'survey',
  'interview',
  'clinical',
  'hci',
] as const;

export type Tag = (typeof TAG_ORDER)[number];

// ---------------------------------------------------------------------------
// Defensive coercion
// ---------------------------------------------------------------------------

/** Anything -> trimmed string. Never throws on numbers, objects, or null. */
function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** Trimmed string, or `null` when empty. The contract's "absent" value. */
function asNullableString(value: unknown): string | null {
  const s = asString(value);
  return s === '' ? null : s;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== 'string') return null;
  const match = /-?\d+/.exec(value);
  if (match === null) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Naive WordPress datetimes ("2026-05-15T11:40:33", no zone) -> ISO 8601.
 *
 * Upstream sends no offset anywhere, so a naive value is read as UTC. That is
 * a deliberate, documented choice: the alternative is guessing America/Chicago
 * and being wrong twice a year, and every consumer here only asks
 * day-granularity questions ("has this expired?").
 */
function toIso(value: unknown): string | null {
  const s = asString(value);
  if (s === '') return null;

  // Already carries a zone or offset - trust it.
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const candidate = hasZone ? s : /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : `${s.replace(' ', 'T')}Z`;

  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    const loose = new Date(s);
    return Number.isNaN(loose.getTime()) ? null : loose.toISOString();
  }
  return parsed.toISOString();
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = typeof item === 'number' ? item : Number(item);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** WordPress meta is untrusted at runtime even though it is typed. */
function safeMeta(raw: RawStudy): Partial<RawStudyMeta> {
  const meta: unknown = raw.meta;
  return typeof meta === 'object' && meta !== null ? (meta as Partial<RawStudyMeta>) : {};
}

function rendered(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const r = (value as { rendered?: unknown }).rendered;
    if (typeof r === 'string') return r;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Adapters for sibling parsers
// ---------------------------------------------------------------------------

/**
 * `parse-eligibility` and `staleness` are owned by other agents and their
 * exact call shapes are theirs to choose. These adapters call the most likely
 * shape first, validate the return value, and fall back to a local
 * implementation if the module cannot answer. The cost is a few casts; the
 * benefit is that a signature change next door cannot break the data layer.
 */
type LooseFn = (...args: unknown[]) => unknown;

const STALENESS_VALUES: ReadonlySet<string> = new Set<Staleness>(['fresh', 'aging', 'stale', 'expired']);

function isParsedEligibility(value: unknown): value is ParsedEligibility {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ParsedEligibility>;
  return typeof v.minAge === 'number' && (v.maxAge === null || typeof v.maxAge === 'number') && Array.isArray(v.flags);
}

function eligibilityFor(raw: RawStudy, text: string): ParsedEligibility {
  const fn = parseEligibility as unknown as LooseFn | undefined;
  if (typeof fn === 'function') {
    const shapes: unknown[][] = [[raw], [raw, text], [raw.meta, text], [text, raw.meta]];
    for (const args of shapes) {
      try {
        const out = fn(...args);
        if (isParsedEligibility(out)) return out;
      } catch {
        // Wrong call shape for this module; try the next one.
      }
    }
  }
  return fallbackEligibility(raw);
}

interface StalenessOutcome {
  isExpired: boolean;
  staleness: Staleness;
}

/** Accepts either a bare `Staleness` or a `{ isExpired, staleness }` result. */
function readStalenessOutcome(out: unknown, fallbackExpired: boolean): StalenessOutcome | null {
  if (typeof out === 'string' && STALENESS_VALUES.has(out)) {
    return { isExpired: fallbackExpired || out === 'expired', staleness: out as Staleness };
  }
  if (typeof out === 'object' && out !== null) {
    const v = out as { isExpired?: unknown; staleness?: unknown };
    if (typeof v.staleness === 'string' && STALENESS_VALUES.has(v.staleness)) {
      // Disagreement on expiry resolves to "expired". Showing a dead listing
      // as live is the one failure mode the spec explicitly forbids.
      const expired = fallbackExpired || v.isExpired === true || v.staleness === 'expired';
      return { isExpired: expired, staleness: expired ? 'expired' : (v.staleness as Staleness) };
    }
  }
  return null;
}

function stalenessFor(record: StudyRecord, raw: RawStudy, now: Date, fallbackExpired: boolean): StalenessOutcome {
  const fn = computeStaleness as unknown as LooseFn | undefined;
  if (typeof fn === 'function') {
    const shapes: unknown[][] = [
      [record, now],
      [raw, now],
      [{ expirationDate: record.expirationDate, irbApprovalDate: record.irbApprovalDate, modifiedDate: record.modifiedDate }, now],
      [record],
    ];
    for (const args of shapes) {
      try {
        const outcome = readStalenessOutcome(fn(...args), fallbackExpired);
        if (outcome !== null) return outcome;
      } catch {
        // Wrong call shape; try the next one.
      }
    }
  }
  return { isExpired: fallbackExpired, staleness: fallbackStaleness(record, now) };
}

const DAY_MS = 86_400_000;

/**
 * Last-resort staleness. Expiry wins outright; otherwise age since the last
 * upstream edit is the only honest signal we have, because `status` stays
 * "publish" forever.
 */
function fallbackStaleness(record: StudyRecord, now: Date): Staleness {
  if (record.isExpired) return 'expired';

  const touched = Date.parse(record.modifiedDate || record.postedDate);
  if (Number.isNaN(touched)) return 'stale';

  const days = (now.getTime() - touched) / DAY_MS;
  if (days <= 90) return 'fresh';
  if (days <= 270) return 'aging';
  return 'stale';
}

/** Last-resort eligibility: the age meta fields, which are always present. */
function fallbackEligibility(raw: RawStudy): ParsedEligibility {
  const meta = safeMeta(raw);
  const minAge = asInt(meta.aux_study_item_minimum_age) ?? 0;
  const statedMax = asInt(meta.aux_study_item_maximum_age);

  return {
    minAge,
    // "100" and "125" are data-entry sentinels for "no upper limit".
    maxAge: statedMax === null || statedMax >= NO_MAX_AGE_SENTINEL ? null : statedMax,
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
  };
}

// ---------------------------------------------------------------------------
// Tag inference
// ---------------------------------------------------------------------------

/** Case-insensitive keyword probes over title + body text. */
const TAG_PATTERNS: Readonly<Record<Tag, RegExp | null>> = {
  online: /\bonline\b|\bremote(ly)?\b|\bzoom\b|\bweb-?based\b|\bvirtual (?:session|meeting|visit)\b|\bteleconference\b|\bqualtrics\b/i,
  'in-person': /\bin-?person\b|\bon-?campus\b|\bin (?:our|the) lab(?:oratory)?\b|\blab visit\b|\bvisit (?:our|the) (?:lab|clinic|center|centre)\b|\bcome to\b/i,
  mri: /\bf?MRI\b|\bmagnetic resonance\b|\bneuroimag/i,
  eeg: /\bEEG\b|\belectroencephalo/i,
  'vr-ar': /\bvirtual reality\b|\baugmented reality\b|\bmixed reality\b|\bhead-?mounted\b|\bheadset\b/i,
  'focus-group': /\bfocus group\b/i,
  survey: /\bsurvey(s|ed)?\b|\bquestionnaire/i,
  interview: /\binterview(s|ed|ing)?\b/i,
  clinical: /\bclinical trial\b|\bplacebo\b|\brandomi[sz]ed controlled\b|\bdouble-?blind\b|\bdrug\b|\bmedication\b|\bsupplement\b|\bpatients? with\b|\bdiagnos(ed|is)\b/i,
  hci: /\bhuman-?computer\b|\bhuman-?robot\b|\buser interface\b|\busability\b|\buser experience\b|\bHCI\b|\bwearable\b/i,
};

/** Uppercase-only abbreviations. Case-sensitive so "ar" in prose is not a hit. */
const VR_AR_ABBREV = /\b(?:VR|AR|XR)\b/;

/** Session-type / location / category term names -> tags. */
const TERM_PATTERNS: readonly { re: RegExp; tags: Tag[] }[] = [
  { re: /online survey/i, tags: ['online', 'survey'] },
  { re: /online interview/i, tags: ['online', 'interview'] },
  { re: /^online only$/i, tags: ['online'] },
  { re: /^remote$/i, tags: ['online'] },
  { re: /single visit|multiple visits/i, tags: ['in-person'] },
  { re: /on-campus|off-campus/i, tags: ['in-person'] },
  { re: /clinical trials?|medicine/i, tags: ['clinical'] },
  { re: /^technology$/i, tags: ['hci'] },
];

function termNames(ids: readonly number[], map: Record<number, { name: string }> | undefined): string[] {
  if (map === undefined) return [];
  const out: string[] = [];
  for (const id of ids) {
    const term = map[id];
    if (term !== undefined && typeof term.name === 'string') out.push(stripHtml(term.name));
  }
  return out;
}

/**
 * Derive filter chips from taxonomy terms first (structured, trustworthy),
 * then from free text (broad, noisier). A tag is a hint for filtering, so a
 * false positive costs a stray chip while a false negative hides a study.
 */
export function deriveTags(
  raw: RawStudy,
  text: string,
  taxonomies: TaxonomyMaps | null | undefined,
): string[] {
  const found = new Set<Tag>();

  const names = [
    ...termNames(asNumberArray(raw.aux_study_session_type), taxonomies?.sessionType),
    ...termNames(asNumberArray(raw.aux_study_location), taxonomies?.location),
    ...termNames(asNumberArray(raw.aux_study_category), taxonomies?.category),
    ...termNames(asNumberArray(raw.aux_study_topic), taxonomies?.topic),
  ];

  for (const name of names) {
    for (const { re, tags } of TERM_PATTERNS) {
      if (re.test(name)) for (const tag of tags) found.add(tag);
    }
  }

  for (const tag of TAG_ORDER) {
    const pattern = TAG_PATTERNS[tag];
    if (pattern !== null && pattern.test(text)) found.add(tag);
  }

  if (VR_AR_ABBREV.test(text)) found.add('vr-ar');

  // A study can be both (an online screener plus a lab visit), so these are
  // not made mutually exclusive - but a location term saying "Online Only"
  // is authoritative enough to drop a keyword-only "in-person" guess.
  const onlineOnly = names.some((n) => /^online only$/i.test(n));
  if (onlineOnly) found.delete('in-person');

  return TAG_ORDER.filter((tag) => found.has(tag));
}

// ---------------------------------------------------------------------------
// normalizeStudy
// ---------------------------------------------------------------------------

/** Longest summary we will render in a card. */
const SUMMARY_MAX = 260;

/**
 * Lifecycle values seen outside the documented 3|6|12 vocabulary. Purely a
 * diagnostic: the value is still kept on the record, but the build reports it
 * so upstream schema drift is noticed the first time it happens.
 */
const unexpectedLifecycle = new Set<number>();

/** Off-vocabulary lifecycle values observed since process start. */
export function unexpectedLifecycleValues(): number[] {
  return [...unexpectedLifecycle].sort((a, b) => a - b);
}

/**
 * Turn one upstream record into the canonical `StudyRecord`.
 *
 * `duplicateIds` starts empty; `dedupeStudies` fills it in.
 */
export function normalizeStudy(raw: RawStudy, options: NormalizeOptions = {}): DedupedStudyRecord {
  const now = options.now ?? new Date();
  const meta = safeMeta(raw);

  const title = stripHtml(rendered(raw.title));
  const excerptText = stripHtml(rendered(raw.excerpt));
  const contentText = stripHtml(rendered(raw.content));

  // Prefer the excerpt; it is editorially written. Fall back to the body,
  // which is always present but long.
  const summarySource = excerptText.length >= 40 ? excerptText : contentText || excerptText;
  const summary = truncate(collapseWhitespace(summarySource), SUMMARY_MAX);

  // Corpus for keyword inference - title, summary and body, never the raw HTML.
  const searchText = collapseWhitespace(`${title} ${excerptText} ${contentText}`);

  const compensationField = asString(meta.aux_study_item_compensation);
  const durationField = asString(meta.aux_study_item_duration);

  const duration = parseDuration(durationField);

  /**
   * The compensation meta field is the source of truth and always wins.
   * `applyContentFallbacks` only speaks when that field produced no money
   * signal at all - nine of 86 records leave it blank, and three of those nine
   * state real, itemised pay in `content.rendered` instead (#4607's $420,
   * #8402's $15) or misfile a perk in the duration field (#10128). See
   * `__audit__.md` F3. Anything recovered that way is capped at
   * `confidence: 'medium'` and carries a note saying so, so the provenance
   * reaches the card, the detail page and `/api/studies.json`.
   */
  const compensation = applyContentFallbacks({
    compensation: parseCompensation(compensationField),
    duration,
    durationField,
    contentHtml: rendered(raw.content),
  });

  const eligibility = eligibilityFor(raw, searchText);

  /**
   * The rate is settled by `reconcileEffectiveHourly`, which is the only place
   * that checks whether the pay figure and the hours figure describe the same
   * amount of study before dividing them (see `__audit__.md`, F2).
   *
   * It also returns `guaranteedTotal` - the whole-study pay the rate was
   * actually computed on, which on #12766 is $120 where the compensation
   * parser could only see one visit's $70. That total is deliberately NOT
   * written back onto `compensation` here: `normalize.test.ts` asserts, as a
   * hard gate, that a record's compensation equals `parseCompensation(meta)`
   * field for field, so reconciling the displayed TOTAL belongs to whoever
   * owns `parse-compensation.ts`. Until then the card shows an honest rate
   * beside a floor that is one visit short, and `reconciled.guaranteedTotal`
   * is here for that fix to consume.
   */
  const reconciled = reconcileEffectiveHourly(compensation, duration);
  const effectiveHourly = reconciled.rate;

  const expirationDate = toIso(meta.aux_study_item_expiration_date);
  const isExpired = expirationDate !== null && Date.parse(expirationDate) < now.getTime();

  // Arrives as a number today and as a string historically; either is fine.
  // An off-vocabulary value is kept rather than nulled - it is still the
  // posting duration, and silently discarding it would hide upstream drift.
  const lifecycleMonths = asInt(meta.aux_study_item_lifecycle);
  if (lifecycleMonths !== null && !(LIFECYCLE_MONTHS as readonly number[]).includes(lifecycleMonths)) {
    unexpectedLifecycle.add(lifecycleMonths);
  }

  const postedDate = toIso(raw.date_gmt) ?? toIso(raw.date) ?? new Date(0).toISOString();
  const modifiedDate = toIso(raw.modified_gmt) ?? toIso(raw.modified) ?? postedDate;

  const record: DedupedStudyRecord = {
    id: String(raw.id),
    slug: asString(raw.slug),
    title,
    summary,
    url: asString(raw.link),
    piName: asNullableString(meta.aux_study_item_pi_name),
    contactName: asNullableString(meta.aux_study_item_contact_name),
    contactEmail: asNullableString(meta.aux_study_item_contact_email),
    contactPhone: asNullableString(meta.aux_study_item_contact_phone_number),
    irbNumber: asNullableString(meta.aux_study_item_irb_number),
    irbApprovalDate: toIso(meta.aux_study_item_irb_approval_date),
    expirationDate,
    recruitmentStartDate: toIso(meta.aux_study_item_recruitment_start_date),
    lifecycleMonths,
    postedDate,
    modifiedDate,

    categoryIds: asNumberArray(raw.aux_study_category),
    locationIds: asNumberArray(raw.aux_study_location),
    sessionTypeIds: asNumberArray(raw.aux_study_session_type),
    topicIds: asNumberArray(raw.aux_study_topic),

    compensation,
    duration,
    eligibility,
    effectiveHourly,

    isExpired,
    staleness: 'fresh',
    tags: deriveTags(raw, searchText, options.taxonomies),

    duplicateIds: [],
    duplicateOf: null,
  };

  // Staleness reads the record it annotates, so it runs last. The staleness
  // module owns both answers: it reads the IRB approval date, which is a far
  // better freshness signal than `modified` (upstream rewrites that on
  // cosmetic edits).
  const outcome = stalenessFor(record, raw, now, isExpired);
  record.isExpired = outcome.isExpired;
  record.staleness = outcome.staleness;

  return record;
}

/**
 * Normalize a batch. A record that blows up is skipped with a warning rather
 * than aborting the build - 85 studies beat zero studies.
 */
export function normalizeStudies(
  raws: readonly RawStudy[],
  options: NormalizeOptions = {},
): { studies: DedupedStudyRecord[]; failures: { id: unknown; error: string }[] } {
  const studies: DedupedStudyRecord[] = [];
  const failures: { id: unknown; error: string }[] = [];

  for (const raw of raws) {
    try {
      studies.push(normalizeStudy(raw, options));
    } catch (err) {
      failures.push({ id: (raw as { id?: unknown } | null)?.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { studies, failures };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/** "STUDY2026-0054 " / "study2026-0054" -> a single comparable key. */
function irbKey(record: StudyRecord): string | null {
  if (record.irbNumber === null) return null;
  const key = record.irbNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key === '' ? null : key;
}

function titleKey(record: StudyRecord): string {
  return record.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Cheap containment check - enough to spot "same protocol, tweaked title". */
function titlesNearIdentical(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '' || b === '') return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) || longer.includes(shorter);
}

/**
 * Collapse re-postings of the same protocol.
 *
 * The registry serves the same study under several ids (e.g. 11896 and 11324,
 * both `STUDY2026-0054`), which would otherwise show up as separate
 * opportunities and double-count in every "how many studies pay >$30/hr"
 * claim the site makes. The IRB number is the protocol's real identity, so it
 * is the grouping key; the most recently modified posting wins because it
 * carries the freshest compensation and expiration data.
 *
 * Order is preserved: the survivor keeps the position of the first member of
 * its group, so this is deterministic for a given input ordering.
 */
export function dedupeStudies(records: readonly DedupedStudyRecord[]): DedupeResult {
  const groups = new Map<string, DedupedStudyRecord[]>();
  const order: string[] = [];
  const ungrouped: DedupedStudyRecord[] = [];

  for (const record of records) {
    const key = irbKey(record);
    if (key === null) {
      // No IRB number: never merge on title alone, that risks collapsing two
      // genuinely different studies from the same lab.
      ungrouped.push(record);
      continue;
    }
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [record]);
      order.push(key);
    } else {
      bucket.push(record);
    }
  }

  const keptByKey = new Map<string, DedupedStudyRecord>();
  const dropped: DedupedStudyRecord[] = [];
  const reported: DuplicateGroup[] = [];

  for (const key of order) {
    const bucket = groups.get(key) ?? [];
    const winner = pickWinner(bucket);
    if (winner === undefined) continue;

    const losers = bucket.filter((r) => r !== winner);
    winner.duplicateIds = losers.map((r) => r.id).sort(compareNumericIds);
    winner.duplicateOf = null;

    if (losers.length > 0) {
      const wTitle = titleKey(winner);
      reported.push({
        irbNumber: winner.irbNumber ?? key,
        keptId: winner.id,
        droppedIds: winner.duplicateIds,
        titlesDiverge: losers.some((l) => !titlesNearIdentical(wTitle, titleKey(l))),
      });
      for (const loser of losers) {
        loser.duplicateOf = winner.id;
        dropped.push(loser);
      }
    }

    keptByKey.set(key, winner);
  }

  // Rebuild in original input order so output is stable run to run.
  const survivors = new Set<DedupedStudyRecord>([...keptByKey.values(), ...ungrouped]);
  const studies = records.filter((r) => survivors.has(r));

  return { studies, dropped, groups: reported };
}

/** Most recently modified wins; ties break to the higher (newer) id. */
function pickWinner(bucket: readonly DedupedStudyRecord[]): DedupedStudyRecord | undefined {
  let best: DedupedStudyRecord | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;

  for (const record of bucket) {
    const t = Date.parse(record.modifiedDate);
    const time = Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
    if (best === undefined || time > bestTime || (time === bestTime && compareNumericIds(record.id, best.id) > 0)) {
      best = record;
      bestTime = time;
    }
  }

  return best;
}

function compareNumericIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalize + dedupe in one call. The shape `fetch-data.ts` wants. */
export function normalizeAndDedupe(
  raws: readonly RawStudy[],
  options: NormalizeOptions = {},
): DedupeResult & { failures: { id: unknown; error: string }[] } {
  const { studies, failures } = normalizeStudies(raws, options);
  return { ...dedupeStudies(studies), failures };
}
