/**
 * THE CENTRAL CONTRACT.
 *
 * Every parser, ranker, and UI component in this project codes against the
 * types in this file. Treat changes here as breaking changes.
 *
 * Upstream: https://research.tamu.edu/wp-json/wp/v2/study?per_page=100
 *   - Returns all 86 records in a single page (X-WP-Total: 86, X-WP-TotalPages: 1).
 *   - Sends NO Access-Control-Allow-Origin, so the browser cannot fetch it.
 *     All upstream reads happen server-side at build time.
 *   - Frozen snapshot of all 86 records lives at fixtures/arv-snapshot.json
 *     and is the fixture for every unit test. Tests must not hit the network.
 */

// ---------------------------------------------------------------------------
// Raw upstream shapes
// ---------------------------------------------------------------------------

/** WordPress `{ rendered: string }` wrapper. Contents are HTML, not plain text. */
export interface WpRendered {
  rendered: string;
}

/**
 * WordPress ACF-style link object. In the current snapshot all 86 records have
 * `{ url: '' }` - i.e. it is present but always empty. Do not rely on it.
 */
export interface WpLinkObject {
  url: string;
  title?: string;
  target?: string;
}

/**
 * Meta bag on a study record.
 *
 * IMPORTANT - the real value types deviate from "everything is a string".
 * These were read off fixtures/arv-snapshot.json, not assumed:
 *
 *   aux_study_item_lifecycle     -> NUMBER (3 | 6 | 12), not a string.
 *   aux_is_internal              -> BOOLEAN, not a string.
 *   aux_study_item_expiration_date -> string, '' , or literal NULL
 *                                   (4 of 86 records are null, not '').
 *   aux_study_item_button_link_object -> object, not a string.
 *
 * The union types below are deliberately tolerant because WordPress will
 * serialize the same meta field differently depending on how it was written.
 * Normalize defensively; never assume `.trim()` is safe on these.
 *
 * Non-empty counts out of 86 in the current snapshot are noted per field.
 */
export interface RawStudyMeta {
  /** 77/86. Free text. Contains literal `<br>` and `<u>` tags. */
  aux_study_item_compensation: string;
  /** 83/86. Free text, e.g. "One-session study lasting about 2 hours". */
  aux_study_item_duration: string;
  /** 86/86. */
  aux_study_item_contact_email: string;
  /** 86/86. */
  aux_study_item_contact_name: string;
  /** 39/86. Formatting is inconsistent. */
  aux_study_item_contact_phone_number: string;
  /** 85/86. Often prefixed, e.g. "PI: Yue Du, PhD". */
  aux_study_item_pi_name: string;
  /** 86/86, e.g. "STUDY2025-1375". */
  aux_study_item_irb_number: string;
  /** 86/86. ISO-ish local datetime, e.g. "2026-05-15T11:40:33". No timezone. */
  aux_study_item_irb_approval_date: string;
  /** 86/86. Integer-as-string. Observed range includes minors: "2".."81". */
  aux_study_item_minimum_age: string;
  /**
   * 86/86. Integer-as-string. "100" and "125" are sentinels meaning
   * "no real upper bound" - see NO_MAX_AGE_SENTINEL.
   */
  aux_study_item_maximum_age: string;
  /** 16/86. ISO-ish local datetime, '' , or null. Frequently in the PAST. */
  aux_study_item_expiration_date: string | null;
  /** 16/86. ISO-ish local datetime or ''. */
  aux_study_item_recruitment_start_date: string | null;
  /**
   * 86/86. Posting duration in MONTHS (3 | 6 | 12). This is NOT a status
   * field and says nothing about whether the study is still recruiting.
   */
  aux_study_item_lifecycle: number | string;
  /** 86/86 present, but `url` is empty on all 86. */
  aux_study_item_button_link_object: WpLinkObject | null;
  /** 0/86 non-empty. Always ''. */
  aux_study_item_button_text: string;
  /** 86/86. Boolean in the payload. */
  aux_is_internal: boolean | string;
  /** WordPress block-editor cruft. Always ''. */
  footnotes?: string;
}

/** One record exactly as returned by /wp-json/wp/v2/study. */
export interface RawStudy {
  id: number;
  date: string;
  date_gmt: string;
  modified: string;
  modified_gmt: string;
  slug: string;
  /** Always "publish" in the snapshot - expiry is NOT reflected here. */
  status: string;
  /** Always "study". */
  type: string;
  /** Canonical public URL on research.tamu.edu. */
  link: string;
  guid: WpRendered;
  title: WpRendered;
  content: WpRendered;
  excerpt: WpRendered;
  template?: string;
  meta: RawStudyMeta;
  class_list?: string[];
  _links?: Record<string, unknown>;
  /** Taxonomy term IDs. Resolve against the matching term endpoints. */
  aux_study_category: number[];
  aux_study_location: number[];
  aux_study_session_type: number[];
  aux_study_topic: number[];
}

/** A term from /wp-json/wp/v2/aux_study_{topic,category,location,session_type}. */
export interface TaxonomyTerm {
  id: number;
  name: string;
  slug: string;
  taxonomy: string;
  count: number;
  description?: string;
}

/** Resolved term-id -> term lookups, one map per taxonomy. */
export interface TaxonomyMaps {
  category: Record<number, TaxonomyTerm>;
  location: Record<number, TaxonomyTerm>;
  sessionType: Record<number, TaxonomyTerm>;
  topic: Record<number, TaxonomyTerm>;
}

// ---------------------------------------------------------------------------
// Parsed sub-structures
// ---------------------------------------------------------------------------

/** How much confidence the parser has that it read the free text correctly. */
export type Confidence = 'high' | 'medium' | 'low';

/** What the participant actually receives. */
export type CurrencyKind = 'cash' | 'giftcard' | 'credit' | 'mixed' | 'unknown';

/**
 * Result of parsing `meta.aux_study_item_compensation`, which is unstructured
 * free text. Examples in the wild:
 *   "Up to $30 <br>Paid as Amazon gift card"
 *   "Each interview: $20<br>Each survey: $20<br>Smartphone-based data collection: maximum $100"
 *   raffle-only text with no guaranteed payout at all
 *
 * Guaranteed vs raffle must stay separate: raffle value is expected value at
 * best and must never be folded into guaranteed pay for ranking.
 */
export interface ParsedCompensation {
  /** Guaranteed floor in USD across the whole study. */
  guaranteedMin: number | null;
  /** Guaranteed ceiling in USD across the whole study. */
  guaranteedMax: number | null;
  /** Largest single raffle/drawing prize in USD. Not guaranteed money. */
  raffleMax: number | null;
  /** True when the ONLY compensation is a raffle entry. */
  raffleOnly: boolean;
  /** True when the source text states a rate per hour rather than a total. */
  isHourlyRate: boolean;
  /** Stated hourly rate floor, only when isHourlyRate. Not a derived value. */
  hourlyMin: number | null;
  /** Stated hourly rate ceiling, only when isHourlyRate. */
  hourlyMax: number | null;
  currencyKind: CurrencyKind;
  /** USD per visit/session when stated per-visit. */
  perVisit: number | null;
  /** Number of paid visits/sessions when stated. */
  visitCount: number | null;
  /** Extra paid only on full completion. */
  completionBonus: number | null;
  /** Non-monetary perks: parking, meals, free scan images, etc. */
  hasNonCashPerk: boolean;
  /** SONA / course credit offered as an alternative to money. */
  sonaCreditOption: boolean;
  /** Original meta string, before HTML stripping. Always preserved. */
  raw: string;
  confidence: Confidence;
  /** Human-readable parser notes; surfaced in the UI on low confidence. */
  notes: string[];
}

/** Result of parsing `meta.aux_study_item_duration` free text. */
export interface ParsedDuration {
  /** Total participant time commitment in hours, floor. */
  totalHoursMin: number | null;
  /** Total participant time commitment in hours, ceiling. */
  totalHoursMax: number | null;
  /** Number of separate sessions/visits. */
  sessionCount: number | null;
  /** Calendar span the study runs over, in weeks (distinct from hours spent). */
  spanWeeks: number | null;
  raw: string;
  confidence: Confidence;
}

export type SexRestriction = 'male' | 'female' | null;

/**
 * Screening criteria, derived from the age meta fields plus keyword extraction
 * over title/content. Every boolean is "the study requires/excludes this",
 * so `false` means "not detected", NOT "explicitly allowed".
 */
export interface ParsedEligibility {
  minAge: number;
  /** null means no real upper bound (see NO_MAX_AGE_SENTINEL). */
  maxAge: number | null;
  requiresRightHanded: boolean;
  requiresMriSafe: boolean;
  requiresFasting: boolean;
  excludesCardiovascular: boolean;
  excludesPregnancy: boolean;
  excludesSeizure: boolean;
  excludesNeurological: boolean;
  /** e.g. "Type 2 diabetes", "ADHD". null when open to healthy volunteers. */
  requiresSpecificCondition: string | null;
  /** Study needs a parent-child pair, not a lone adult. */
  requiresParentOrChild: boolean;
  sexRestriction: SexRestriction;
  /** Free-form extra criteria for display. */
  flags: string[];
}

// ---------------------------------------------------------------------------
// Normalized record
// ---------------------------------------------------------------------------

/**
 * How much to trust that a listing is still live.
 *
 * Upstream keeps serving records long past their expiration date - observed
 * expirations include 2025-01-02 and 2025-04-02 while status is still
 * "publish". Expired listings must be visually separated in the UI, never
 * shown as if they were live.
 */
export type Staleness = 'fresh' | 'aging' | 'stale' | 'expired';

/** A fully normalized study. This is what the UI renders and ranks. */
export interface StudyRecord {
  /** Upstream numeric post ID, as a string, so it can key maps and diffs. */
  id: string;
  slug: string;
  /** HTML stripped and entities decoded. */
  title: string;
  /** Short plain-text blurb derived from the excerpt. */
  summary: string;
  /** Canonical research.tamu.edu URL (RawStudy.link). */
  url: string;
  piName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  irbNumber: string | null;
  /** ISO 8601. */
  irbApprovalDate: string | null;
  /** ISO 8601, or null when upstream sent '' or null. */
  expirationDate: string | null;
  /** ISO 8601, or null. */
  recruitmentStartDate: string | null;
  /** Posting duration in months (3 | 6 | 12). Not a status. */
  lifecycleMonths: number | null;
  /** ISO 8601, from `date_gmt`. */
  postedDate: string;
  /** ISO 8601, from `modified_gmt`. */
  modifiedDate: string;

  categoryIds: number[];
  locationIds: number[];
  sessionTypeIds: number[];
  topicIds: number[];

  compensation: ParsedCompensation;
  duration: ParsedDuration;
  eligibility: ParsedEligibility;

  /**
   * THE RANKING KEY: guaranteed USD per hour of participant time.
   *
   * null whenever it cannot be computed honestly - unknown pay, unknown
   * duration, or raffle-only compensation. null must sort last and must never
   * be coerced to 0, because "unknown" and "unpaid" are different claims.
   */
  effectiveHourly: number | null;

  /** expirationDate exists and is in the past. */
  isExpired: boolean;
  staleness: Staleness;
  /** Display chips: "MRI", "one session", "gift card", ... */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Eligibility matching
// ---------------------------------------------------------------------------

export type Sex = 'male' | 'female' | 'other';

/**
 * Self-reported filter input. Every field is nullable and defaults to null,
 * meaning "not answered" - which must be treated as unknown, never as a
 * negative. Held client-side only; never persisted or transmitted.
 */
export interface UserProfile {
  age: number | null;
  rightHanded: boolean | null;
  mriSafe: boolean | null;
  hasCardiovascularCondition: boolean | null;
  isPregnant: boolean | null;
  hasSeizureHistory: boolean | null;
  sex: Sex | null;
  willingToFast: boolean | null;
  isTamuStudent: boolean | null;
}

export type EligibilityStatus = 'eligible' | 'ineligible' | 'unknown';

/**
 * Three-state on purpose. 'unknown' means a required criterion was not
 * answered or could not be parsed. Never collapse 'unknown' into
 * 'ineligible' - that silently hides studies the user may well qualify for.
 * `eligible` is true only when status === 'eligible'.
 */
export interface EligibilityVerdict {
  eligible: boolean;
  status: EligibilityStatus;
  /** Plain-English explanation for every criterion that drove the verdict. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Build artifacts
// ---------------------------------------------------------------------------

/** What `npm run fetch:data` produces and the site builds from. */
export interface Snapshot {
  /** ISO 8601 timestamp of the fetch. */
  fetchedAt: string;
  /** X-WP-Total header value. Compare against studies.length to spot truncation. */
  totalFromHeader: number;
  studies: StudyRecord[];
}

/** Field-level delta between two snapshots. Ids are StudyRecord.id strings. */
export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: { id: string; fields: string[] }[];
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Upstream collection endpoint. per_page=100 returns all 86 in one page. */
export const STUDY_API_URL = 'https://research.tamu.edu/wp-json/wp/v2/study';

/** Taxonomy endpoints, keyed to match TaxonomyMaps. */
export const TAXONOMY_ENDPOINTS = {
  category: 'https://research.tamu.edu/wp-json/wp/v2/aux_study_category',
  location: 'https://research.tamu.edu/wp-json/wp/v2/aux_study_location',
  sessionType: 'https://research.tamu.edu/wp-json/wp/v2/aux_study_session_type',
  topic: 'https://research.tamu.edu/wp-json/wp/v2/aux_study_topic',
} as const;

/**
 * A stated maximum age at or above this is a data-entry sentinel for
 * "no upper limit", not a real cutoff. 25 of 86 records use 18-100 and
 * others use 18-125. Parsers must map these to `maxAge: null`.
 */
export const NO_MAX_AGE_SENTINEL = 100;

/** Valid values of `meta.aux_study_item_lifecycle` (posting months). */
export const LIFECYCLE_MONTHS = [3, 6, 12] as const;
