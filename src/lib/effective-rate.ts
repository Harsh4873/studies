/**
 * The headline ranking key: guaranteed USD per hour of participant time.
 *
 * THE CENTRAL RULE
 * ----------------
 * `null` means UNKNOWN and nothing else. It is never 0, never Infinity, never
 * NaN. "We could not work out what this pays per hour" and "this pays nothing"
 * are different claims about the world, and collapsing them either buries a
 * study that pays well or advertises one that pays nothing. Every guard in
 * this file exists to keep those two apart:
 *
 *   unknown pay          -> null  (sorts into the "unknown rate" bucket)
 *   unknown hours        -> null  ("6 weeks" is a calendar span, not hours)
 *   raffle-only          -> null  (a lottery ticket is not an hourly wage)
 *   zero hours           -> null  (division by zero would give Infinity)
 *   a genuine $0 study   -> 0     (a known fact - credit-only, say)
 *
 * The $0 case is the one place a zero is legitimate, and only because the
 * compensation parser asserted it: `guaranteedMax: 0` is a measurement,
 * `guaranteedMax: null` is the absence of one.
 */

import type { Confidence, ParsedCompensation, ParsedDuration } from '@/types.ts';

/** A study whose rate can be ranked. `StudyRecord` satisfies this. */
export interface RankableStudy {
  effectiveHourly: number | null;
}

export type SortDirection = 'desc' | 'asc';

/** How the UI labels a rate. `'unknown'` is a bucket, not a bad rate. */
export type RateBucket = 'unknown' | 'low' | 'ok' | 'good' | 'great';

/**
 * Bucket boundaries in USD/hour, chosen for student research participation
 * near a US university rather than for salaried work:
 *
 *   low   <  $10   below what a campus job or minimum-wage shift pays
 *                  (federal minimum is $7.25), so the study costs the
 *                  participant money in opportunity terms
 *   ok    $10-$20  comparable to typical hourly student employment
 *   good  $20-$40  clearly beats a campus job; worth rearranging a day for
 *   great >= $40   unusually well paid - MRI, clinical, or long protocols
 *
 * Boundaries are inclusive-lower / exclusive-upper: exactly $20.00 is 'good'.
 */
export const RATE_BUCKET_THRESHOLDS = {
  /** Below this is 'low'. */
  ok: 10,
  /** At or above this is 'good'. */
  good: 20,
  /** At or above this is 'great'. */
  great: 40,
} as const;

/** Cents. Anything finer is noise given how approximate the inputs are. */
const RATE_DECIMALS = 2;

/**
 * `ParsedDuration` stores hours rounded to 4 decimals, which is lossy for
 * every duration that is not a whole number of minutes' worth of hours:
 * 20 minutes becomes 0.3333, and `$20 / 0.3333` is $60.01 rather than the
 * exact $60.00. A page whose entire pitch is arithmetic honesty must not show
 * a rate that is provably a cent off (see `__audit__.md`, F16).
 *
 * Duration text states whole minutes, so a stored value that is within a
 * hundredth of a minute of an integer IS that integer, and dividing by the
 * exact fraction restores the true rate. Anything further off - a genuinely
 * odd figure - is left exactly as measured.
 */
const MINUTES_PER_HOUR = 60;
const MINUTE_SNAP_TOLERANCE = 0.01;

function exactHours(hours: number): number {
  const minutes = hours * MINUTES_PER_HOUR;
  const whole = Math.round(minutes);
  if (whole <= 0) return hours;
  return Math.abs(minutes - whole) <= MINUTE_SNAP_TOLERANCE ? whole / MINUTES_PER_HOUR : hours;
}

/** A finite, non-negative number - i.e. a usable measurement. */
function isUsable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A finite number strictly greater than zero - i.e. a usable divisor. */
function isPositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// ---------------------------------------------------------------------------
// SCOPE RECONCILIATION (audit F2)
//
// THE SECOND CENTRAL RULE: the numerator and the denominator must describe the
// SAME AMOUNT OF STUDY before they are divided.
//
// Both source fields are free text written by different people, and either can
// be written per-visit or whole-study with no marker distinguishing them:
//
//   #12766  "$50 per laboratory visit; $10 ... $10 ..."   <- ONE visit's pay
//           "2 hours (in the form of two 1-hour visits)"  <- BOTH visits' hours
//           $70 / 2 h = $35/hr, when the study pays $120 / 2 h = $60/hr.
//
//   #4618   "up to $225 over 3 visits (1 visit a year)"   <- ALL visits' pay
//           "Visits last around 3-3.5 hours"              <- ONE visit's hours
//           $225 / 3.5 h = $64.29/hr, when it is $225 / 10.5 h = $21.43/hr.
//
// The same defect, once in each direction: the first buries a good study, the
// second sends a reader on a wasted three-year commitment. Dividing mismatched
// scopes does not produce an approximate rate, it produces a meaningless one,
// so where the two cannot be reconciled the answer is `null` - the study drops
// into the "rate unknown" bucket carrying its total, which is honest - rather
// than a confident number that is out by the visit count.
//
// Reconciling needs a visit count. `ParsedCompensation.visitCount` and
// `ParsedDuration.sessionCount` each supply one; when both do and they
// DISAGREE, that disagreement is real information about the listing and is not
// resolved by guessing. The count that yields the LOWER rate is taken and the
// result is marked low-confidence: overstating costs the reader a wasted trip,
// understating costs them a study they might have taken.
// ---------------------------------------------------------------------------

/** Which scope the two operands were read as, and how they were reconciled. */
export type RateBasis =
  /** The listing states a rate per hour; no reconciliation needed. */
  | 'stated-hourly'
  /** Both operands already describe the whole study. The common case. */
  | 'whole-study'
  /** Per-visit pay multiplied up to the whole study before dividing. */
  | 'per-visit-pay-scaled'
  /** Per-session hours multiplied up to the whole study before dividing. */
  | 'per-session-hours-scaled'
  /** Both operands describe one visit, so their ratio is already the rate. */
  | 'single-visit'
  /** Scopes differ and no count reconciles them. `rate` is null. */
  | 'unreconciled'
  /** Pay or hours unknown before scope ever came into it. `rate` is null. */
  | 'unknown';

export interface ReconciledRate {
  /** USD per hour, or null. Same value `computeEffectiveHourly` returns. */
  rate: number | null;
  basis: RateBasis;
  /** The count used to bring the two operands onto one scope, if any. */
  visitCount: number | null;
  /**
   * Guaranteed pay for the WHOLE study, which is what `ParsedCompensation`
   * documents `guaranteedMin/Max` to mean. Differs from the parsed value only
   * on `per-visit-pay-scaled`, where the compensation parser could only see
   * one visit's worth. null when unknown.
   */
  guaranteedTotal: number | null;
  /**
   * Confidence in the RECONCILIATION, not in either parse. 'low' means the two
   * fields disagreed about how many visits there are and the conservative
   * reading was taken.
   */
  confidence: Confidence;
  notes: string[];
}

/**
 * A count beyond this is not a visit count that anyone wrote down on purpose -
 * it is a headcount, a participant target, or a parse accident (see
 * `__audit__.md`, R3: "20 participants per session" reads as 20 sessions).
 * Multiplying by it would bury a study as thoroughly as under-counting inflates
 * one, so an implausible count reconciles nothing.
 */
const MAX_RECONCILABLE_VISITS = 60;

function usableCount(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_RECONCILABLE_VISITS;
}

/**
 * True when the pay figure is ONE VISIT's rather than the whole study's.
 *
 * This is the shape `parse-compensation.ts` emits for "$30 per visit" and
 * "$50 per laboratory visit; $10 ...; $10 ..." - a per-visit rate with no
 * stated count, where it sets the floor to one visit's worth and leaves the
 * ceiling null with the note "value is a floor for one visit".
 *
 * Both conditions are load-bearing, and both are arithmetic rather than an
 * inference about which branch of a sibling parser ran:
 *
 *   NO CEILING. A record that states a whole-study total has one. #9815's
 *   "$100 for each study visit ... up to a total of $620" also carries
 *   `perVisit: 100`, but its $620 is already whole-study and scaling it would
 *   re-break the F1 fix. `guaranteedMax === null` is the parser saying it
 *   could not close the study out.
 *
 *   THE FLOOR HOLDS AT MOST ONE VISIT. `perVisit <= floor < 2 x perVisit`
 *   means the figure covers one visit plus, at most, some one-off extras. A
 *   floor that already contains two visits' pay is a whole-study sum however
 *   it was arrived at, and multiplying it again would overstate the study -
 *   the direction that costs a reader a wasted trip.
 */
function payIsPerVisit(comp: ParsedCompensation): boolean {
  return (
    isPositive(comp.perVisit) &&
    !isUsable(comp.guaranteedMax) &&
    isUsable(comp.guaranteedMin) &&
    comp.guaranteedMin >= comp.perVisit &&
    comp.guaranteedMin < comp.perVisit * 2
  );
}

/**
 * Words that promise the hours figure already covers the whole study. A string
 * containing one of these is never read as per-session, however it phrases the
 * visits afterwards: #4626 says "Total participation is approximately 17.5
 * hours" and then goes on to describe "three 2-2.5 hour laboratory visits".
 */
const WHOLE_STUDY_HOURS_RE =
  /\btotals?\b|\btotall?ing\b|\baltogether\b|\bcombined\b|\boverall\b|\bin all\b|\bacross\b|\bcumulative\b|\ball (?:visits|sessions|appointments)\b|\bentire\b/i;

/**
 * A plural visit noun as the SUBJECT of a duration verb - "Visits last around
 * 3-3.5 hours" - or an explicit distributive marker. Either says the figure is
 * one visit's, and the string states no count for the parser to have
 * multiplied by.
 */
const PER_SESSION_HOURS_RES: readonly RegExp[] = [
  /\b(?:visits?|sessions?|appointments?|meetings?|scans?|interviews?)\s+(?:\w+\s+){0,2}?(?:last|lasts|take|takes|run|runs|require|requires)\b/i,
  /\b(?:each|every|per)\s+(?:visit|session|appointment|meeting|scan|interview|study day)\b/i,
];

/**
 * True when `totalHoursMax` is ONE session's hours, not the study's.
 *
 * `sessionCount !== null` is a hard veto: when `parse-duration.ts` found a
 * count it has already done the multiplication (or deliberately declined to,
 * because the string stated a total), so its figure is whole-study by
 * construction. That veto is what protects the F1 fixes - #9815's 44 h,
 * #4611's 58 h, #4613's 27 h, #8458's 21 h are all counted records and none of
 * them can be scaled a second time.
 */
function hoursArePerSession(dur: ParsedDuration): boolean {
  if (dur.sessionCount !== null) return false;
  const raw = typeof dur.raw === 'string' ? dur.raw : '';
  if (raw === '' || WHOLE_STUDY_HOURS_RE.test(raw)) return false;
  return PER_SESSION_HOURS_RES.some((re) => re.test(raw));
}

/**
 * Pick the count to reconcile with. `prefer` is the direction that UNDERSTATES
 * the rate: fewer visits when scaling pay up, more visits when scaling hours
 * up. Only consulted when the two fields disagree.
 */
function pickCount(
  a: number | null,
  b: number | null,
  prefer: 'fewer' | 'more',
): { count: number | null; disputed: boolean } {
  const ok = [a, b].filter(usableCount);
  if (ok.length === 0) return { count: null, disputed: false };
  const first = ok[0] as number;
  if (ok.length === 1 || ok[0] === ok[1]) return { count: first, disputed: false };
  const second = ok[1] as number;
  return {
    count: prefer === 'fewer' ? Math.min(first, second) : Math.max(first, second),
    disputed: true,
  };
}

const UNKNOWN: ReconciledRate = {
  rate: null,
  basis: 'unknown',
  visitCount: null,
  guaranteedTotal: null,
  confidence: 'high',
  notes: [],
};

/**
 * The full answer: the rate, the scope it was computed on, the whole-study
 * total that scope implies, and whether the two fields agreed.
 *
 * Order of preference:
 *   1. A rate the listing STATES per hour (`isHourlyRate`). Preferred over
 *      arithmetic because it is the study's own claim, and because a stated
 *      rate stays right even when the duration text is unparseable. A stated
 *      rate is per-hour on both sides by definition, so scope cannot bite it.
 *   2. Guaranteed pay over committed hours, ONCE both have been brought onto
 *      the same scope.
 *
 * Ceilings on both sides is a deliberate pairing: it answers "if this study
 * goes the way it is advertised, what does it pay per hour", and it keeps the
 * numerator and denominator describing the same scenario. Mixing
 * `guaranteedMax` with `totalHoursMin` would systematically overstate every
 * study that quotes a range.
 *
 * Raffle money is never included. `raffleMax` is an expected value at best,
 * and a raffle-only study has no guaranteed pay to divide at all.
 */
export function reconcileEffectiveHourly(
  comp: ParsedCompensation | null | undefined,
  dur: ParsedDuration | null | undefined,
): ReconciledRate {
  if (comp === null || comp === undefined || dur === null || dur === undefined) return UNKNOWN;

  // 1. A stated hourly rate needs no duration at all.
  if (comp.isHourlyRate) {
    const stated = isPositive(comp.hourlyMax) ? comp.hourlyMax : comp.hourlyMin;
    if (isPositive(stated)) {
      return { ...UNKNOWN, rate: roundRate(stated), basis: 'stated-hourly' };
    }
    // Flagged hourly but carrying no number: fall through rather than guess.
  }

  // 2. Raffle-only compensation is not guaranteed pay, so there is no rate.
  if (comp.raffleOnly) return UNKNOWN;

  // Prefer the ceiling; fall back to the floor when only one bound parsed.
  const pay = isUsable(comp.guaranteedMax) ? comp.guaranteedMax : comp.guaranteedMin;
  if (!isUsable(pay)) return UNKNOWN;

  const statedHours = isPositive(dur.totalHoursMax) ? dur.totalHoursMax : dur.totalHoursMin;
  // Zero or unknown hours: null, never Infinity. A calendar-only duration
  // ("Approximately 6 weeks") lands here, which is exactly right - a six-week
  // span says nothing about how many hours are spent.
  if (!isPositive(statedHours)) return { ...UNKNOWN, guaranteedTotal: pay };

  const hoursPer = exactHours(statedHours);
  const perVisitPay = payIsPerVisit(comp);
  const perSessionHours = hoursArePerSession(dur);

  let numerator = pay;
  let denominator = hoursPer;
  let basis: RateBasis = 'whole-study';
  let count: number | null = null;
  let disputed = false;
  /** Guaranteed pay for the whole study on the scope finally settled on. */
  let total: number | null = pay;
  const notes: string[] = [];

  if (perVisitPay && !perSessionHours) {
    // Pay is one visit's, hours are the study's. Scale the pay up.
    // Only the per-visit component repeats: #12766's "$50 per laboratory
    // visit; $10 parent questionnaires; $10 child questionnaires" is
    // 2 x $50 + $20 = $120, not 2 x $70.
    const picked = pickCount(comp.visitCount, dur.sessionCount, 'fewer');
    if (picked.count === null) {
      notes.push(
        'compensation is stated per visit and the duration covers the whole study, but neither field states how many visits there are; no honest rate can be computed',
      );
      return { ...UNKNOWN, basis: 'unreconciled', guaranteedTotal: null, notes };
    }
    const oneOff = Math.max(0, round2(pay - (comp.perVisit as number)));
    numerator = round2((comp.perVisit as number) * picked.count + oneOff);
    total = numerator;
    basis = 'per-visit-pay-scaled';
    count = picked.count;
    disputed = picked.disputed;
    notes.push(
      `pay is stated per visit ($${comp.perVisit as number}) and the duration covers all ${picked.count} visits; guaranteed pay for the whole study is $${numerator}`,
    );
  } else if (!perVisitPay && perSessionHours) {
    // Pay is the study's, hours are one visit's. Scale the hours up.
    const picked = pickCount(comp.visitCount, dur.sessionCount, 'more');
    if (picked.count === null) {
      notes.push(
        'the duration is stated per visit and the pay covers the whole study, but neither field states how many visits there are; no honest rate can be computed',
      );
      return { ...UNKNOWN, basis: 'unreconciled', guaranteedTotal: pay, notes };
    }
    denominator = hoursPer * picked.count;
    basis = 'per-session-hours-scaled';
    count = picked.count;
    disputed = picked.disputed;
    notes.push(
      `the stated ${statedHours} hours is one visit; the pay covers all ${picked.count} visits, so the rate is over ${round2(denominator)} hours`,
    );
  } else if (perVisitPay && perSessionHours) {
    // Both describe one visit, so their ratio is already the rate. A count, if
    // one exists, only matters for one-off extras that do not repeat.
    const picked = pickCount(comp.visitCount, dur.sessionCount, 'fewer');
    basis = 'single-visit';
    count = picked.count;
    disputed = picked.disputed;
    if (picked.count === null) {
      numerator = comp.perVisit as number;
      // One visit's pay over one visit's hours is the right RATE, but it says
      // nothing about the study total - the listing never states how many
      // visits there are. #4620: "$50 for each visit" / "Visits last around
      // 1.5 hours" is $33.33/hr for an unknown number of $50 visits.
      total = null;
      notes.push(
        'pay and duration are both stated per visit, so the rate is honest, but neither field states how many visits there are, so the study total is unknown',
      );
    } else {
      const oneOff = Math.max(0, round2(pay - (comp.perVisit as number)));
      numerator = round2((comp.perVisit as number) * picked.count + oneOff);
      denominator = hoursPer * picked.count;
      total = numerator;
    }
  }

  if (!isPositive(denominator)) return { ...UNKNOWN, guaranteedTotal: total, notes };

  const rate = numerator / denominator;
  if (!Number.isFinite(rate) || rate < 0) return { ...UNKNOWN, guaranteedTotal: total, notes };

  if (disputed) {
    notes.push(
      `the compensation text says ${String(comp.visitCount)} visit(s) and the duration text says ${String(dur.sessionCount)}; the reading that pays LESS per hour was used`,
    );
  }

  return {
    rate: roundRate(rate),
    basis,
    visitCount: count,
    guaranteedTotal: total,
    confidence: disputed ? 'low' : 'high',
    notes,
  };
}

/**
 * Guaranteed USD per hour, or null when it cannot be computed honestly.
 *
 * Thin wrapper over `reconcileEffectiveHourly`, which carries the reasoning.
 */
export function computeEffectiveHourly(
  comp: ParsedCompensation | null | undefined,
  dur: ParsedDuration | null | undefined,
): number | null {
  return reconcileEffectiveHourly(comp, dur).rate;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRate(value: number): number {
  const factor = 10 ** RATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Label a rate for display and filtering.
 *
 * `null`, NaN, Infinity and negative rates all return `'unknown'` - the UI
 * must show them as unrated rather than as a bad deal, since none of them is
 * evidence about pay.
 */
export function rateBucket(n: number | null): RateBucket {
  if (n === null || typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'unknown';
  if (n < RATE_BUCKET_THRESHOLDS.ok) return 'low';
  if (n < RATE_BUCKET_THRESHOLDS.good) return 'ok';
  if (n < RATE_BUCKET_THRESHOLDS.great) return 'good';
  return 'great';
}

/** True when a rate is a real, rankable measurement. */
export function isKnownRate(n: number | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Comparator for two effective-hourly values.
 *
 * Unknown rates are pushed to the end for BOTH directions - ascending by rate
 * still means "worst known rate first, unrated last". Sorting unknowns to the
 * top on an ascending sort would present unrated studies as the cheapest,
 * which is a claim the data does not support.
 */
export function compareByEffectiveHourly(
  a: number | null,
  b: number | null,
  direction: SortDirection = 'desc',
): number {
  const aKnown = isKnownRate(a);
  const bKnown = isKnownRate(b);

  if (!aKnown && !bKnown) return 0;
  if (!aKnown) return 1;
  if (!bKnown) return -1;

  return direction === 'asc' ? a - b : b - a;
}

/**
 * Order studies by `effectiveHourly`, best-paying first by default, with
 * every unknown rate sunk to the end regardless of direction.
 *
 * Returns a new array; the input is not mutated. Ties and the unknown block
 * keep their original relative order (`Array.prototype.sort` is stable), so a
 * caller can pre-sort by date and have that survive as the tie-break.
 */
export function sortStudies<T extends RankableStudy>(
  studies: readonly T[],
  direction: SortDirection = 'desc',
): T[] {
  return [...studies].sort((a, b) => compareByEffectiveHourly(a.effectiveHourly, b.effectiveHourly, direction));
}

// ---------------------------------------------------------------------------
// THE UNRATED BUCKET (audit F11)
//
// A study with no computable rate is not a cheap study, so it is shown in its
// own section below the ranked board - correct, and settled. What was NOT
// settled is the order WITHIN that section. Ordering it by posting date alone
// put #11321 - $1,000 guaranteed, the largest payout in the entire corpus -
// FOURTH among the unknowns, below two studies that state no pay at all.
//
// Inside a bucket where the rate is unknown by definition, the only fact the
// reader can act on is the money: guaranteed total, largest first. Studies
// that state no pay at all sort last, for the same reason a null rate sorts
// last on the main board - "we do not know" is not "nothing". Ties keep the
// newest posting first, which is the ordering this bucket used to have and is
// still the right tie-break between two studies offering the same money.
// ---------------------------------------------------------------------------

/** The subset of `StudyRecord` this ordering reads. `StudyRecord` satisfies it. */
export interface UnratedStudy {
  compensation: Pick<ParsedCompensation, 'guaranteedMin' | 'guaranteedMax'>;
  postedDate: string;
}

/**
 * Guaranteed pay for the whole study, or null when the listing states none.
 *
 * The ceiling is preferred over the floor for the same reason the rate uses
 * it: it answers "if this goes the way it is advertised, what does it pay".
 */
export function guaranteedTotal(study: UnratedStudy): number | null {
  const comp = study.compensation;
  if (comp === null || comp === undefined) return null;
  if (isUsable(comp.guaranteedMax)) return comp.guaranteedMax;
  if (isUsable(comp.guaranteedMin)) return comp.guaranteedMin;
  return null;
}

/** Guaranteed total descending, no-stated-pay last, newest first on a tie. */
export function compareUnrated(a: UnratedStudy, b: UnratedStudy): number {
  const pa = guaranteedTotal(a);
  const pb = guaranteedTotal(b);

  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pb - pa;
  }

  const ta = Date.parse(a.postedDate ?? '');
  const tb = Date.parse(b.postedDate ?? '');
  const va = Number.isNaN(ta) ? Number.NEGATIVE_INFINITY : ta;
  const vb = Number.isNaN(tb) ? Number.NEGATIVE_INFINITY : tb;
  return vb - va;
}

/**
 * Order the "rate could not be calculated" block: most guaranteed money first.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortUnrated<T extends UnratedStudy>(studies: readonly T[]): T[] {
  return [...studies].sort(compareUnrated);
}
