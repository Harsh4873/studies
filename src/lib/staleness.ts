/**
 * STALENESS: how much to trust that a listing is still live.
 *
 * The upstream API keeps serving records long after they have expired. In the
 * 86-record snapshot, `status` is `"publish"` on every single record, yet
 * `meta.aux_study_item_expiration_date` holds dates such as 2025-01-02,
 * 2025-04-02 and 2025-10-02 - all in the past. Rendering those as live
 * listings sends people to email addresses nobody is reading any more. This
 * module is the check that catches that.
 *
 * Only 16 of 86 records carry an expiration date at all, so the fallback
 * signal is `meta.aux_study_item_irb_approval_date`, which is present on all
 * 86. IRB approval age is a proxy, not a guarantee - a two-year-old approval
 * may still be actively recruiting - hence 'stale' rather than 'expired'.
 *
 * `now` is always an injected parameter with a `new Date()` default so callers
 * and tests are deterministic.
 *
 * Buckets:
 *   'expired' - an expiration date exists and it is in the past.
 *   'stale'   - no expiration date and IRB approval is more than 18 months old
 *               (or the approval date is missing/unparseable, which we treat
 *               as the pessimistic case).
 *   'aging'   - IRB approval is 9 to 18 months old.
 *   'fresh'   - IRB approval is less than 9 months old.
 *
 * One refinement over the bare rules: a listing with an expiration date in the
 * FUTURE is an affirmative statement from the study team that it is still
 * live, so it is never downgraded past 'aging' no matter how old the IRB
 * approval is.
 */

import type { RawStudy, Staleness, StudyRecord } from '@/types.ts';

/** Months of IRB-approval age at which a listing stops being 'fresh'. */
export const AGING_AFTER_MONTHS = 9;

/** Months of IRB-approval age at which a listing becomes 'stale'. */
export const STALE_AFTER_MONTHS = 18;

/** Minimal shape `computeStaleness` needs when neither a RawStudy nor a StudyRecord is to hand. */
export interface StalenessInput {
  expirationDate?: string | null;
  irbApprovalDate?: string | null;
}

export interface StalenessResult {
  /** An expiration date exists and it is strictly before `now`. */
  isExpired: boolean;
  staleness: Staleness;
}

/** Anything this module can read dates out of. */
export type StalenessSource = RawStudy | StudyRecord | StalenessInput;

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const ISO_LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
const US_SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function toUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const date = new Date(ms);
  // Reject rollovers such as 2025-02-31.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/**
 * Parse the date shapes upstream actually sends.
 *
 * `aux_study_item_expiration_date` and `aux_study_item_irb_approval_date` are
 * naive local datetimes with no timezone ("2026-01-28T00:00:00"). They are
 * read as UTC so results never depend on the machine's timezone. Upstream also
 * sends `''` and literal `null` on some records, so this must be null-safe
 * rather than assuming a string - `.trim()` on the raw value would throw.
 *
 * Returns null for anything unparseable, never an Invalid Date.
 */
export function parseStudyDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (!s) return null;

  const iso = ISO_LOCAL_RE.exec(s);
  if (iso?.[1] !== undefined && iso[2] !== undefined && iso[3] !== undefined) {
    // An explicit offset or trailing Z means the string is already absolute.
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return toUtc(
      Number.parseInt(iso[1], 10),
      Number.parseInt(iso[2], 10),
      Number.parseInt(iso[3], 10),
      iso[4] === undefined ? 0 : Number.parseInt(iso[4], 10),
      iso[5] === undefined ? 0 : Number.parseInt(iso[5], 10),
      iso[6] === undefined ? 0 : Number.parseInt(iso[6], 10),
    );
  }

  const us = US_SLASH_RE.exec(s);
  if (us?.[1] !== undefined && us[2] !== undefined && us[3] !== undefined) {
    return toUtc(
      Number.parseInt(us[3], 10),
      Number.parseInt(us[1], 10),
      Number.parseInt(us[2], 10),
    );
  }

  return null;
}

/**
 * Elapsed calendar months between two instants, as a fraction.
 *
 * Calendar months rather than a fixed 30-day approximation, so "9 months"
 * means the same thing in February as in July. The fractional part is the
 * position within the current month, which keeps the 9- and 18-month bucket
 * edges from jittering by a day or two.
 *
 * Negative when `later` precedes `earlier` (a future-dated IRB approval).
 */
export function monthsBetween(earlier: Date, later: Date): number {
  const sign = later.getTime() >= earlier.getTime() ? 1 : -1;
  const a = sign === 1 ? earlier : later;
  const b = sign === 1 ? later : earlier;

  let whole = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());

  // Anniversary of `a` in b's month.
  const anniversary = new Date(
    Date.UTC(
      b.getUTCFullYear(),
      b.getUTCMonth(),
      1,
      a.getUTCHours(),
      a.getUTCMinutes(),
      a.getUTCSeconds(),
    ),
  );
  const daysInAnniversaryMonth = new Date(
    Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0),
  ).getUTCDate();
  anniversary.setUTCDate(Math.min(a.getUTCDate(), daysInAnniversaryMonth));

  if (b.getTime() < anniversary.getTime()) {
    whole -= 1;
    const prevDays = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate();
    const prevAnniversary = new Date(anniversary.getTime());
    prevAnniversary.setUTCMonth(anniversary.getUTCMonth() - 1);
    prevAnniversary.setUTCDate(Math.min(a.getUTCDate(), prevDays));
    const spanMs = anniversary.getTime() - prevAnniversary.getTime();
    const fraction = spanMs > 0 ? (b.getTime() - prevAnniversary.getTime()) / spanMs : 0;
    return sign * (whole + fraction);
  }

  const nextDays = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 2, 0)).getUTCDate();
  const nextAnniversary = new Date(anniversary.getTime());
  nextAnniversary.setUTCMonth(anniversary.getUTCMonth() + 1);
  nextAnniversary.setUTCDate(Math.min(a.getUTCDate(), nextDays));
  const spanMs = nextAnniversary.getTime() - anniversary.getTime();
  const fraction = spanMs > 0 ? (b.getTime() - anniversary.getTime()) / spanMs : 0;

  return sign * (whole + fraction);
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function isRawStudy(value: StalenessSource): value is RawStudy {
  return typeof (value as RawStudy).meta === 'object' && (value as RawStudy).meta !== null;
}

interface ExtractedDates {
  expiration: Date | null;
  irbApproval: Date | null;
}

/**
 * Pull the two dates out of whichever shape the caller passed. Raw upstream
 * records are read from `meta`; already-normalized records and plain inputs
 * are read from their top-level fields.
 */
function extractDates(source: StalenessSource): ExtractedDates {
  if (isRawStudy(source)) {
    const meta = source.meta;
    return {
      expiration: parseStudyDate(meta.aux_study_item_expiration_date),
      irbApproval: parseStudyDate(meta.aux_study_item_irb_approval_date),
    };
  }

  const record = source as StudyRecord | StalenessInput;
  return {
    expiration: parseStudyDate(record.expirationDate),
    irbApproval: parseStudyDate(record.irbApprovalDate),
  };
}

// ---------------------------------------------------------------------------
// computeStaleness
// ---------------------------------------------------------------------------

/**
 * Classify how trustworthy a listing's "still recruiting" claim is.
 *
 * Accepts a `RawStudy` (reads `meta.aux_study_item_*`), a `StudyRecord`, or a
 * bare `{ expirationDate, irbApprovalDate }`.
 *
 * `now` defaults to the current time; pass it explicitly in tests and at build
 * time so a snapshot is reproducible.
 */
export function computeStaleness(
  source: StalenessSource,
  now: Date = new Date(),
): StalenessResult {
  const { expiration, irbApproval } = extractDates(source);
  const reference = Number.isNaN(now.getTime()) ? new Date() : now;

  // An expiration date in the past is decisive - this is the case the API
  // itself does not report, since `status` stays "publish" forever.
  const isExpired = expiration !== null && expiration.getTime() < reference.getTime();
  if (isExpired) return { isExpired: true, staleness: 'expired' };

  // No IRB approval date to reason from: assume the worst rather than
  // presenting an unverifiable listing as fresh.
  if (irbApproval === null) {
    return { isExpired: false, staleness: expiration !== null ? 'aging' : 'stale' };
  }

  const ageMonths = monthsBetween(irbApproval, reference);

  let staleness: Staleness;
  if (ageMonths < AGING_AFTER_MONTHS) staleness = 'fresh';
  else if (ageMonths <= STALE_AFTER_MONTHS) staleness = 'aging';
  else staleness = 'stale';

  // A future expiration date is an explicit "still live until" from the study
  // team, so an old IRB approval alone does not make it stale.
  if (staleness === 'stale' && expiration !== null) staleness = 'aging';

  return { isExpired: false, staleness };
}
