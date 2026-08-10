/**
 * Parser for `meta.aux_study_item_compensation`.
 *
 * The upstream field is free text typed by 86 different research coordinators.
 * There is no schema, no currency field, and no separation between money you
 * are guaranteed and money you might win. Every regex below exists because a
 * real string in fixtures/arv-snapshot.json needs it; the comment on each one
 * quotes the string it was written for. If you relax a pattern, re-check it
 * against the quoted example first.
 *
 * Three invariants drive the whole design:
 *
 *   1. RAFFLE MONEY IS NOT GUARANTEED MONEY. "a drawing for one of four $50
 *      Amazon gift cards" must never rank above a guaranteed $20. Raffle
 *      amounts are routed to `raffleMax` and are excluded from every
 *      guaranteed computation, including totals.
 *
 *      1b. NEITHER IS PERFORMANCE-CONTINGENT MONEY. The mirror image of the
 *      raffle rule. "an opportunity to earn an additional $5 during each lab
 *      visit for task-related reward" is money you might earn by performing
 *      well; it is no more guaranteed than a drawing prize, and it is excluded
 *      from `guaranteedMin/Max` for exactly the same reason - INCLUDING when a
 *      stated ceiling silently folds it in ("Up to $20" on a study that
 *      guarantees $10). A COMPLETION bonus is deliberately treated the other
 *      way: "a $100 bonus for completing all three visits" is paid to everyone
 *      who finishes, so it belongs in guaranteed pay and in `completionBonus`.
 *      The test is whether the money turns on ATTENDANCE (guaranteed) or on
 *      PERFORMANCE / luck (not guaranteed).
 *
 *   2. A STATED TOTAL BEATS A COMPUTED ONE. "$20 for the first session, $35
 *      for the second, $30 for the third, and $45 for the fourth ... The total
 *      compensation for completing all four sessions is $120" sums to $130 but
 *      states $120. Summing double-counts breakdowns ("$225.00 (Baseline - $50;
 *      3-month - $75; 6 month - $100)" would become $450), so a stated total
 *      always wins and summing is a last resort that lowers confidence.
 *
 *   3. UNKNOWN IS NOT ZERO. When the text states a per-visit rate but never
 *      says how many visits ("$30 per visit"), the ceiling is `null`, not a
 *      guess. Only "None"/empty text and raffle-only text produce zeros.
 *
 * Pure function: no I/O, no network, no Date, no module state.
 */

import { stripHtml } from '@/lib/html.ts';
import type { Confidence, CurrencyKind, ParsedCompensation } from '@/types.ts';

// ---------------------------------------------------------------------------
// Money tokenization
// ---------------------------------------------------------------------------

/**
 * Every way an amount is written in the real data, as one alternation so a
 * single left-to-right scan can never double-count the same digits.
 *
 * 1. RANGE      "$15-25/hour", "($40-50 total)"        -> two capture groups
 * 2. PLAIN      "$400.00", "$ 60" (stray space), "$0.50"
 * 3. REVERSED   "20$ "  - one record types the sigil after the number. The
 *               `(?!\s*\d)` guard is load-bearing: without it, "one of 5 $100
 *               gift cards" would read the "5 $" as a $5 payout.
 * 4. BARE       "60 gift card to Amazon AND entered into a raffle..." - the
 *               dollar sign is simply missing, so a number immediately
 *               followed by a currency noun counts as money. The lookbehind
 *               keeps it from re-reading digits already consumed above, and
 *               requiring the noun keeps "the first 400 participants",
 *               "12 therapy sessions" and "3 follow up assessments" out.
 */
const MONEY_RE = new RegExp(
  [
    // 1. range
    '\\$\\s*(\\d[\\d,]*(?:\\.\\d+)?)(?:\\s*[-–—]\\s*\\$?|\\s+to\\s+\\$)\\s*(\\d[\\d,]*(?:\\.\\d+)?)',
    // 2. plain
    '\\$\\s*(\\d[\\d,]*(?:\\.\\d+)?)',
    // 3. reversed "20$"
    '(?<![$\\d.])(\\d[\\d,]*(?:\\.\\d+)?)\\s*\\$(?!\\s*\\d)',
    // 4. bare number + currency noun
    '(?<![$\\d.])(\\d[\\d,]*(?:\\.\\d+)?)\\s+(?=(?:dollars?|gift\\s?cards?|amazon)\\b)',
  ].join('|'),
  'gi',
);

/**
 * Does an hourly unit follow the amount? Covers "$25/hr", "$20/ hr" (stray
 * space after the slash), "$25 per hour", "$15-25/hour", "$17.5/hr" and the
 * parenthetical "($17.14 / hour)".
 *
 * Deliberately does NOT match "$200/study day completed" - a per-day rate is
 * not a per-hour rate, and treating it as one would invent an hourly figure
 * the coordinator never stated.
 */
const HOURLY_SUFFIX_RE = /^\s*(?:\/|\bper\b|\ban\b)\s*(?:hr|hour)s?\b/i;

/** One monetary amount found in the text, with everything needed to classify it. */
interface MoneyToken {
  /** Low end. Equals `high` unless the source wrote a range. */
  low: number;
  /** High end of a range; equals `low` for a scalar amount. */
  high: number;
  /** Offset of the first character of the match in the stripped text. */
  start: number;
  /** Offset one past the last character of the match. */
  end: number;
  /** True when an hourly unit immediately follows ("$25/hr"). */
  hourly: boolean;
  /** True when the amount sits inside a raffle/drawing clause. */
  raffle: boolean;
  /**
   * True when the amount sits inside a performance-contingent clause - money
   * that has to be EARNED rather than money you get for showing up. Mutually
   * exclusive with `raffle` (raffle wins when a clause is both).
   */
  contingent: boolean;
}

/** "1,000" -> 1000. Rounded to cents so float noise never reaches the UI. */
function toNumber(s: string): number {
  return round2(parseFloat(s.replace(/,/g, '')));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Raffle detection
// ---------------------------------------------------------------------------

/**
 * Phrases that open a "you might win this" clause. Each is present verbatim in
 * the snapshot:
 *
 *   "entered into a drawing for one of three $10 Amazon gift cards"
 *   "entered into a raffle for one of two $50 Amazon gift card"
 *   "three entries for a drawing to win one of five $50 Amazon gift cards"
 *   "entered into a prize drawing with a chance to win one of the ten $100..."
 *   "five participants will be randomly selected to receive a $200 gift card"
 *   "five participants will be randomly chosen without replacement"
 *   "eligible to receive 1 of 5 $100 gift cards"
 *
 * The "one of N" alternative carries its own weight: the subject-pool clause
 * "be eligible to receive 1 of 5 $100 gift cards" never says "drawing", yet
 * only 5 of the pool get paid. Requiring a NUMBER after "one of" keeps
 * "during one of the computerized tasks" from being mistaken for a prize.
 *
 * "chance to win" is included on purpose: even where it describes a
 * performance bonus rather than a literal raffle ("a chance to win up to an
 * additional $5 in cash during one of the computerized tasks"), the money is
 * still not guaranteed, which is exactly the distinction this field exists to
 * protect.
 */
const RAFFLE_TRIGGER_RE =
  /\b(?:raffle|drawing|sweepstakes|lottery|entered\s+into|enter\s+(?:a|the|into)\s+(?:drawing|raffle)|entries\s+for|entry\s+for|chance\s+to\s+win|randomly\s+(?:selected|chosen|drawn)|prize|(?:one|1)\s+of\s+(?:the\s+)?(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)/gi;

/**
 * Phrases that open a "you might EARN this" clause - the non-lottery half of
 * money that is not guaranteed. Each is present verbatim in the snapshot:
 *
 *   "Each participant will have an opportunity to earn an additional $5 during
 *    each lab visit for task-related reward."                        (#11899)
 *   "Participants who complete a reward-based Doors task will receive up to an
 *    additional $8.00."                                              (#4632)
 *
 * (#4615's "For some experiments, additional bonuses may be earned during the
 * study" is deliberately NOT matched here - see the "bare will/can earn" note
 * below. It carries no dollar figure, and the unpriced-bonus note at the end
 * of `parseCompensation` is what surfaces it.)
 *
 * Deliberately NARROW. Three constructions that look similar are excluded on
 * purpose because the money behind them IS guaranteed to anyone who finishes:
 *
 *   - "a $100 bonus Visa debit card for completing all three visits" (#9821)
 *   - "a completion bonus of $500 for completing all visits"         (#11321)
 *   - "an additional $20 for completing both sessions"               (#6995)
 *
 * A bare "reward" is also excluded: "the post-study questionnaire and EEG in
 * lab session completion will reward the participant $45 in cash" (#6745) is
 * ordinary attendance pay, and matching it would strip $45 out of a real
 * guaranteed total.
 *
 * A bare "will/can/may earn" is excluded for exactly the same reason, and the
 * omission is load-bearing rather than an oversight (audit R1). An earlier
 * revision matched `(?:may|might|can|could|will)\s+(?:be\s+)?earn(?:ed)?`,
 * which is the single most ordinary way this corpus states ATTENDANCE pay:
 *
 *   - "You can earn up to $300 in compensation."                     (#5945)
 *   - "Participants will earn $30 for completing the survey."
 *
 * Because the exclusion span runs to the end of the sentence, that alternation
 * swallowed the whole payment and produced `guaranteed 0/0`, which `RateBadge`
 * renders as literally "Unpaid". It also made the answer depend on nothing but
 * word order and inflection - "Payment is $60, which will be earned on
 * completion" kept its $60 only because the amount happened to precede the
 * trigger. Zeroing out a real $200 study is a strictly worse failure than the
 * 2x overstatement the alternation was added to fix (#11899), and #11899 is
 * caught by "opportunity to earn" regardless. Only the four explicitly
 * conditional openers survive: something must grant the OPPORTUNITY to earn,
 * not merely describe earning as the mechanism of payment.
 */
const CONTINGENT_TRIGGER_RE =
  /\b(?:(?:opportunity|chance|eligible|able)\s+to\s+earn|reward[-\s]based|task[-\s]related\s+reward|(?:depending|based)\s+on\s+(?:their\s+|task\s+)?(?:performance|accuracy))/gi;

/** Sentence terminator used to bound a raffle clause. */
const SENTENCE_END_RE = /[.!?](?:\s|$)/g;

/** Half-open [start, end) character ranges that describe raffle money. */
type Span = [number, number];

/**
 * A raffle clause runs from its trigger word to the end of the sentence that
 * contains it. Sentence-level granularity would be too coarse: in
 * "you will receive one $10 Amazon gift card and three entries for a drawing
 * to win one of five $50 Amazon gift cards" the guaranteed $10 and the raffled
 * $50 share a sentence, and only the trigger's offset separates them.
 */
function findRaffleSpans(text: string): Span[] {
  return findTriggeredSpans(text, RAFFLE_TRIGGER_RE);
}

/**
 * Same clause geometry as `findRaffleSpans`, for contingent ("must be earned")
 * money. Kept as one helper so the two exclusions can never drift apart.
 */
function findContingentSpans(text: string): Span[] {
  return findTriggeredSpans(text, CONTINGENT_TRIGGER_RE);
}

function findTriggeredSpans(text: string, trigger: RegExp): Span[] {
  const spans: Span[] = [];
  trigger.lastIndex = 0;

  for (let m = trigger.exec(text); m !== null; m = trigger.exec(text)) {
    const start = m.index;

    SENTENCE_END_RE.lastIndex = start;
    const stop = SENTENCE_END_RE.exec(text);
    spans.push([start, stop === null ? text.length : stop.index + 1]);
  }

  return spans;
}

/** Text covered by any of the spans, joined - used only for note wording. */
function spanText(text: string, spans: Span[]): string {
  return spans.map(([a, b]) => text.slice(a, b)).join(' ');
}

function inSpans(index: number, spans: Span[]): boolean {
  return spans.some(([a, b]) => index >= a && index < b);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(text: string, raffleSpans: Span[], contingentSpans: Span[]): MoneyToken[] {
  const tokens: MoneyToken[] = [];
  MONEY_RE.lastIndex = 0;

  for (let m = MONEY_RE.exec(text); m !== null; m = MONEY_RE.exec(text)) {
    const rangeLo = m[1];
    const rangeHi = m[2];
    const scalar = m[3] ?? m[4] ?? m[5];

    let low: number;
    let high: number;

    if (rangeLo !== undefined && rangeHi !== undefined) {
      low = toNumber(rangeLo);
      high = toNumber(rangeHi);
      if (high < low) [low, high] = [high, low];
    } else if (scalar !== undefined) {
      low = toNumber(scalar);
      high = low;
    } else {
      continue;
    }

    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;

    const start = m.index;
    const end = start + m[0].length;
    const raffle = inSpans(start, raffleSpans);

    tokens.push({
      low,
      high,
      start,
      end,
      hourly: HOURLY_SUFFIX_RE.test(text.slice(end, end + 16)),
      raffle,
      // Raffle wins ties: "a chance to win up to an additional $5 ... during
      // one of the computerized tasks" is both, and `raffleMax` is the field
      // the UI already renders under a "not guaranteed" treatment.
      contingent: !raffle && inSpans(start, contingentSpans),
    });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Total detection
// ---------------------------------------------------------------------------

/**
 * The word "total" appears BEFORE the amount:
 *   "Total $425 compensation" | "totally $1000" | "up to a total of $620"
 *   "for a possible total of $550" | "The total compensation for completing
 *    all four sessions is $120"
 *
 * The character class excludes `.` `$` `;` `)` so the search cannot jump a
 * sentence boundary, hop over a nearer amount, or escape a parenthetical. That
 * last exclusion is what stops "($50 total) with a chance to win up to an
 * additional $5" from binding "total" to the $5 that follows it.
 *
 * The 70-character gap is sized by the longest real separation: "The total
 * compensation for the entire two-session participation will be $80" puts 62
 * characters between the keyword and the amount. Undersizing it here silently
 * dropped that record's stated total and fell through to summing, which by
 * coincidence produced exactly $200 - the raffle prize. Wrong answers that
 * look plausible are the reason the gap is measured rather than guessed.
 */
const TOTAL_BEFORE_RE = /\btotal(?:s|ly)?\b[^.$;)]{0,70}$/i;

/**
 * The word "total" appears AFTER the amount:
 *   "($100 total)" | "($40-50 total)" | "($50 total)" | "(total $60)"
 */
const TOTAL_AFTER_RE = /^[^.$;(]{0,15}\btotal\b/i;

/**
 * Ceiling phrasing: the amount is an upper bound, so the floor stays unknown.
 *   "Up to $30 Paid as Amazon gift card" | "up to $820" | "Up to $560"
 *   "compensated up to $225 over 3 visits" | "a possible total of $550"
 *   "This would add up to a possible $165 in cash"
 *
 * "maximum" is intentionally NOT a ceiling trigger. In "Each interview: $20
 * Each survey: $20 Smartphone-based data collection: maximum $100" the
 * "maximum" caps one component, not the study, and treating $100 as the study
 * ceiling would understate a study worth at least $140.
 */
const CEILING_BEFORE_RE = /\b(?:up\s+to|as\s+much\s+as|possible)\b[^.$;)]{0,28}$/i;

/**
 * "up to an additional $5", "an additional $8.00" - an add-on, never the
 * study total. Without this guard the Bryan-College Station record's bonus
 * clauses would masquerade as ceilings.
 */
const ADDITIONAL_RE = /\badditional\b/i;

interface TotalCandidate {
  low: number;
  high: number;
  /** True when phrased as a ceiling, which leaves the guaranteed floor unknown. */
  ceiling: boolean;
  /** The token the total was read from, so its components can be identified. */
  token: MoneyToken;
}

function findTotals(text: string, tokens: MoneyToken[]): TotalCandidate[] {
  const out: TotalCandidate[] = [];

  for (const t of tokens) {
    // Raffle prizes, contingent bonuses and hourly rates are never the study
    // total. ("up to $10 total" in #6745 caps the task-bonus, not the study.)
    if (t.raffle || t.contingent || t.hourly) continue;

    const before = text.slice(Math.max(0, t.start - 100), t.start);
    const after = text.slice(t.end, t.end + 20);

    const firm = TOTAL_BEFORE_RE.test(before) || TOTAL_AFTER_RE.test(after);
    const ceiling = CEILING_BEFORE_RE.test(before) && !ADDITIONAL_RE.test(before.slice(-30));

    if (firm || ceiling) out.push({ low: t.low, high: t.high, ceiling, token: t });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Structured pay shapes
// ---------------------------------------------------------------------------

/**
 * Per-visit / per-session rate.
 *   P1 "$50 per visit" | "$30 per visit" | "$5 per lab visit"
 *      "$20 per session" | "$50 per laboratory visit"
 *   P2 "$125 for each study visit (3)" | "$100 for each study visit completed"
 *      "a $150 Visa debit card for each study visit"
 *      "$25 in cash for each EEG laboratory visit"
 *      "$50 for each visit to the imaging center"
 *
 * P2's `[^.$]` gaps stop the match from crossing into the next amount, so in
 * "$20 for the screening visit and $100 for each study visit" only the $100
 * binds to "for each".
 */
const PER_VISIT_RES: RegExp[] = [
  /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(?:per|\/)\s*(?:\w+\s+){0,2}?(?:visit|session|appointment|interview|survey)\b/gi,
  /\$\s*(\d[\d,]*(?:\.\d+)?)[^.$]{0,32}?\bfor\s+(?:each|every)\b[^.$]{0,28}?\b(?:visit|session|appointment|day)\b/gi,
];

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * How many paid visits there are.
 *   "for 2 visits" | "over 3 visits (1 visit a year)"
 *   "for completing all four sessions" | "completing all three visits"
 *   "complete ALL THREE study sessions" (filler word between count and noun)
 *   "for completing both sessions" -> 2
 *   "$125 for each study visit (3)" - the count hides in a bare parenthetical
 *
 * Only these anchored shapes are accepted. A bare "N sessions" pattern would
 * misfire on "12 therapy sessions across 6 weeks", which describes therapy
 * delivered, not paid visits.
 */
const VISIT_COUNT_RES: RegExp[] = [
  /\b(?:for|over|across)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:\w+\s+){0,2}?(?:visits|sessions|appointments|days)\b/i,
  /\ball\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:\w+\s+){0,2}?(?:visits|sessions|appointments|days)\b/i,
  /\beach\s+(?:\w+\s+){0,2}?(?:visit|session|appointment)\s*\((\d+)\)/i,
];

/** "completing both sessions" / "both visits" -> a count of 2. */
const BOTH_RE = /\bboth\s+(?:\w+\s+){0,2}?(?:visits|sessions|appointments)\b/i;

/**
 * Money paid only for finishing everything.
 *   "a completion bonus of $500 for completing all visits"
 *   "a $100 bonus Visa debit card for completing all three visits"
 *   "an additional $20 for completing both sessions (total $60)"
 *   "a $5 weekly bonus payment if they have 90% completion on the surveys"
 */
const COMPLETION_BONUS_RES: RegExp[] = [
  /\bcompletion\s+bonus\s+of\s+\$\s*(\d[\d,]*(?:\.\d+)?)/gi,
  /\$\s*(\d[\d,]*(?:\.\d+)?)[^.$]{0,40}?\bbonus\b[^.$]{0,60}?\bcomplet/gi,
  /\badditional\s+\$\s*(\d[\d,]*(?:\.\d+)?)[^.$]{0,30}?\bfor\s+completing\b/gi,
];

// ---------------------------------------------------------------------------
// Currency kind, perks, credit
// ---------------------------------------------------------------------------

/**
 * "Amazon gift card", "$10 Amazon e-gift card", "$30 e-gift card".
 * The trailing `s?` matters: "one of four $50 Amazon gift cards" is plural,
 * and `\bgift\s?card\b` would fail on it because the word boundary lands
 * against the "s".
 */
const GIFTCARD_RE = /\b(?:gift\s?cards?|e-?gift|amazon)\b/i;

/** "$25 in cash for each EEG laboratory visit", "$150 Visa debit card". */
const CASH_RE = /\b(?:in\s+cash|cash\b|visa\s+debit|debit\s+card|by\s+check)\b/i;

/**
 * Course credit as an alternative to money.
 *   "1 SONA credit can be granted"
 *   "the option to select course credit compensation via SONA"
 *   "recruited through the Psychology Subject Pool ... will receive research
 *    credit (2)"
 *   "they will receive 0.5 credits for every 30 minutes of participation"
 */
const CREDIT_RE = /\b(?:sona|course\s+credit|research\s+credit|subject\s+pool|credits?)\b/i;

/**
 * Things of value that are not money and not a gift card.
 *   "Bluetooth enabled blood pressure cuff and weight scale"
 *   "Bluetooth-enabled glucometer, and weight scale"
 *   "up to $20 worth of a Blue Baker lunch"
 *   "asked to wear an Oura ring ... they will be able to keep the ring"
 *
 * "mileage compensation" is excluded on purpose: it is money, and one record
 * mentions it only to say it is NOT offered.
 */
const PERK_RE =
  /\b(?:blood\s+pressure\s+cuff|weight\s+scale|glucometer|blue\s+baker|lunch|meals?\b|free\s+parking|parking\s+(?:is\s+)?provided|keep\s+the\s+ring|oura\s+ring)\b/i;

/** After stripping HTML and punctuation, these mean "nothing is offered". */
const NO_PAY_RE = /^(?:none|no|n\/?a|nil|nothing|unpaid|no\s+compensation|not\s+applicable|0)$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Confidence only ever moves downward; the worst signal seen wins. */
function worse(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a;
}

/** Empty result skeleton, so every early return produces a complete object. */
function emptyResult(raw: string): ParsedCompensation {
  return {
    guaranteedMin: null,
    guaranteedMax: null,
    raffleMax: null,
    raffleOnly: false,
    isHourlyRate: false,
    hourlyMin: null,
    hourlyMax: null,
    currencyKind: 'unknown',
    perVisit: null,
    visitCount: null,
    completionBonus: null,
    hasNonCashPerk: false,
    sonaCreditOption: false,
    raw,
    confidence: 'high',
    notes: [],
  };
}

/** Run a global regex and collect capture group 1 as numbers. */
function collectAmounts(re: RegExp, text: string, skip: (index: number) => boolean): number[] {
  const out: number[] = [];
  re.lastIndex = 0;

  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (skip(m.index)) continue;
    const g = m[1];
    if (g === undefined) continue;
    const v = toNumber(g);
    if (Number.isFinite(v)) out.push(v);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse a raw `aux_study_item_compensation` value into structured pay data.
 *
 * `raw` is preserved verbatim on the result so the UI can always fall back to
 * showing exactly what the coordinator wrote.
 */
export function parseCompensation(raw: string): ParsedCompensation {
  const source = typeof raw === 'string' ? raw : '';
  const result = emptyResult(source);

  // HTML first. Meta values carry literal "<br>" between pay clauses
  // ("Each interview: $20<br>Each survey: $20") and "<u>" for emphasis
  // ("complete <u>ALL THREE</u> study sessions"). stripHtml turns <br> into a
  // space so digits cannot fuse onto the next word, and decodes entities such
  // as the "&amp;" in "Texas A&amp;M".
  const text = stripHtml(source);

  // --- Nothing offered -----------------------------------------------------
  // Three records say "None" (one with a trailing NBSP). Saying "None" is a
  // claim: the study pays nothing, and 0 is the honest parse.
  if (NO_PAY_RE.test(text.replace(/[.\s]+$/, ''))) {
    result.guaranteedMin = 0;
    result.guaranteedMax = 0;
    result.raffleMax = 0;
    result.confidence = 'high';
    result.notes = ['no compensation offered'];
    return result;
  }

  // --- Nothing STATED ------------------------------------------------------
  // A blank meta field is not a claim of any kind - the coordinator left it
  // empty. Reporting 0 here reads downstream as "this study is unpaid", which
  // is an assertion the listing never made, and effectiveHourly then computes
  // a confident $0.00/hr for any such study that does state its hours.
  // types.ts is explicit: "unknown" and "unpaid" are different claims and
  // unknown pay must never be coerced to 0. So leave the amounts null and let
  // the UI's "Pay unclear" path handle it.
  if (text === '') {
    result.confidence = 'low';
    result.notes = ['no compensation stated in the listing'];
    return result;
  }

  const notes: string[] = [];
  let confidence: Confidence = 'high';

  const raffleSpans = findRaffleSpans(text);
  const contingentSpans = findContingentSpans(text);
  const tokens = tokenize(text, raffleSpans, contingentSpans);
  /**
   * Structured-shape scans (per-visit rate, completion bonus) must skip both
   * kinds of not-guaranteed money. Without the contingent half, "$5 during
   * each lab visit" would be read as a second per-visit rate.
   */
  const isExcludedIndex = (i: number): boolean =>
    inSpans(i, raffleSpans) || inSpans(i, contingentSpans);

  // --- Hourly rates --------------------------------------------------------
  // Stated rates only. `hourlyMin`/`hourlyMax` are never derived from a total
  // divided by a duration - that is the ranker's job, not the parser's.
  const hourlyTokens = tokens.filter((t) => t.hourly && !t.raffle);
  if (hourlyTokens.length > 0) {
    const lows = hourlyTokens.map((t) => t.low);
    const highs = hourlyTokens.map((t) => t.high);
    result.isHourlyRate = true;
    result.hourlyMin = round2(Math.min(...lows));
    result.hourlyMax = round2(Math.max(...highs));

    if (result.hourlyMin !== result.hourlyMax) {
      // "$15-25/hour" and the multi-visit ladder
      // "Visit 1: $17.50/hr; Visit 2: $20/hr; Visit 3: $22.50/hr".
      confidence = worse(confidence, 'medium');
      notes.push(`hourly rate given as a range: $${result.hourlyMin}-$${result.hourlyMax}/hr`);
    }
    if (hourlyTokens.length > 2) {
      // The SONA record lists a different rate per group and per visit.
      confidence = worse(confidence, 'low');
      notes.push(`${hourlyTokens.length} different hourly rates stated; rate depends on group/visit`);
    }
  }

  // --- Raffle prizes -------------------------------------------------------
  // The largest single prize, never a sum: "one of five $50 Amazon gift cards"
  // is worth $50 to a winner, not $250.
  const raffleTokens = tokens.filter((t) => t.raffle);
  if (raffleTokens.length > 0) {
    result.raffleMax = round2(Math.max(...raffleTokens.map((t) => t.high)));
    // "with a chance to win up to an additional $5 in cash during one of the
    // computerized tasks" (#6745/#4626/#4624) is a task-performance bonus that
    // happens to be worded like a lottery. Excluding it from guaranteed pay is
    // right either way, but calling it a drawing prize is not, so say so.
    const looksLikeTask = /\b(?:tasks?|performance|accuracy)\b/i.test(spanText(text, raffleSpans));
    notes.push(
      looksLikeTask
        ? `up to $${result.raffleMax} is contingent on task performance ("chance to win"), not a drawing prize, and is not guaranteed money`
        : `raffle/drawing prize up to $${result.raffleMax} is not guaranteed money`,
    );
  }

  // --- Performance-contingent money ----------------------------------------
  // Invariant 1b. Held separately from `guaranteedTokens` below and never
  // summed into a total.
  const contingentTokens = tokens.filter((t) => t.contingent && !t.hourly);

  // --- Structured shapes ---------------------------------------------------
  const perVisitCandidates = PER_VISIT_RES.flatMap((re) =>
    collectAmounts(re, text, isExcludedIndex),
  ).filter((v) => !hourlyTokens.some((t) => t.low === v || t.high === v));

  if (perVisitCandidates.length > 0) {
    // Highest stated per-visit rate; the ladder record ("$50 for the screening
    // visit and $125 for each study visit (3)") pays the screening rate once
    // and the study rate repeatedly, so the study rate is the meaningful one.
    result.perVisit = round2(Math.max(...perVisitCandidates));
  }

  for (const re of VISIT_COUNT_RES) {
    const m = re.exec(text);
    const g = m?.[1];
    if (g === undefined) continue;
    const n = /^\d+$/.test(g) ? parseInt(g, 10) : (WORD_NUMBERS[g.toLowerCase()] ?? NaN);
    if (Number.isFinite(n) && n > 0) {
      result.visitCount = n;
      break;
    }
  }
  if (result.visitCount === null && BOTH_RE.test(text)) result.visitCount = 2;

  const bonuses = COMPLETION_BONUS_RES.flatMap((re) => collectAmounts(re, text, isExcludedIndex));
  if (bonuses.length > 0) result.completionBonus = round2(Math.max(...bonuses));

  // --- Guaranteed money ----------------------------------------------------
  /**
   * Drop restatements before any arithmetic. Coordinators often name an amount
   * and then refer back to it with a definite article:
   *   "you will receive one $10 Amazon gift card ... You will receive the $10
   *    Amazon gift card for completing the first session"
   * That is one $10 payment described twice; summing it yields $20 and
   * overstates the study by 100%. The rule is deliberately narrow - the value
   * must already have been seen AND the mention must be introduced by "the".
   */
  const guaranteedTokens = tokens.filter((t, i, all) => {
    if (t.raffle || t.contingent || t.hourly) return false;
    const earlier = all
      .slice(0, i)
      .some((p) => !p.raffle && !p.contingent && !p.hourly && p.low === t.low && p.high === t.high);
    if (!earlier) return true;
    const isRestatement = /\bthe\s+$/i.test(text.slice(Math.max(0, t.start - 6), t.start));
    if (isRestatement) notes.push(`ignored a repeated mention of $${t.high} ("the $${t.high}...")`);
    return !isRestatement;
  });
  const totals = findTotals(text, tokens);

  // Rule 2: a stated total beats a computed one. Take the LARGEST stated
  // total, because sub-totals coexist with grand totals in the same string
  // ("$25 in cash for each EEG laboratory visit ($50 total) ... This would add
  // up to a possible $165 in cash"): $50 is a component, $165 is the study.
  let chosenTotal: TotalCandidate | null = null;
  for (const c of totals) {
    if (chosenTotal === null || c.high > chosenTotal.high) chosenTotal = c;
  }

  /**
   * Leading grand total with a parenthesised breakdown, no "total" keyword:
   *   "$225.00 (Baseline appointments - $50; 3-month appointments - $75;
   *    6 month appointments - $100)"   -> 225, corroborated by 50+75+100
   *   "$ 60 ($17.14 / hour)"           -> 60, the parenthetical is a rate
   * Requires the amount to open the string AND be followed by "(" so that
   * "$50 per laboratory visit; $10 for parent questionnaires; $10 for child
   * questionnaires" (which must be summed to $70) is not caught. The "$ 60"
   * record has no other guaranteed amount at all - its parenthetical is the
   * hourly rate - so a lone leading amount still qualifies.
   */
  const first = guaranteedTokens[0];
  let leadingTotal: number | null = null;
  if (chosenTotal === null && first !== undefined && first.start <= 2) {
    const rest = guaranteedTokens.slice(1);
    const restSum = round2(rest.reduce((a, t) => a + t.high, 0));
    if (/^\s*\(/.test(text.slice(first.end)) && first.high >= restSum * 0.95) {
      leadingTotal = first.high;
      if (Math.abs(first.high - restSum) < 0.01) {
        notes.push(`stated total $${leadingTotal} matches its itemised breakdown`);
      }
    }
  }

  /**
   * Alternatives, not additions: "Choice of up to $20 worth of a Blue Baker
   * lunch OR a $20 Amazon gift card" pays $20, not $40. Only applied when an
   * "or" sits BETWEEN two amounts, so "traveling 50 miles or more" (where the
   * "or" follows the only amount) does not trigger it.
   */
  const orStraddles =
    guaranteedTokens.length > 1 &&
    [...text.matchAll(/\bor\b/gi)].some((m) => {
      const firstTok = guaranteedTokens[0];
      const lastTok = guaranteedTokens[guaranteedTokens.length - 1];
      return firstTok !== undefined && lastTok !== undefined && m.index > firstTok.start && m.index < lastTok.start;
    });

  if (chosenTotal !== null) {
    let totalHigh = round2(chosenTotal.high);
    let totalLow = round2(chosenTotal.low);

    /**
     * Invariant 1b applied to the headline number. A stated total can quietly
     * bundle contingent money into the figure a reader ranks on. #11899:
     * "Up to $20: Participants are compensated $5 per lab visit ... an
     * opportunity to earn an additional $5 during each lab visit for
     * task-related reward." $20 is only reachable by winning the bonus at
     * every visit. Guaranteed is $10, so ranking $20 doubles the rate.
     *
     * Two ways to take the contingent money back out, both arithmetic rather
     * than guessed:
     *
     *  (a) DECOMPOSE - guaranteed $G and contingent $C are each stated
     *      per-occasion and the total T divides exactly by (G + C). Then the
     *      occasion count is T/(G+C), which the text never states outright,
     *      and the guaranteed ceiling is n x G. #11899: 20/(5+5) = 2 visits,
     *      guaranteed 2 x $5 = $10, contingent $10.
     *
     *  (b) SUBTRACT - no per-occasion reading, but T is larger than the
     *      guaranteed components alone can explain, so the contingent amounts
     *      are inside T. Remove them.
     *
     * If neither closes, the total stands but confidence drops and the note
     * says plainly that part of it must be earned. Never silently.
     */
    if (contingentTokens.length > 0) {
      const perOccasion = contingentTokens
        .filter((t) => /\b(?:each|every|per)\b/i.test(text.slice(t.end, t.end + 40)))
        .map((t) => t.high);
      const contingentPerOccasion = perOccasion.length > 0 ? Math.max(...perOccasion) : null;
      const contingentSum = round2(contingentTokens.reduce((a, t) => a + t.high, 0));
      const components = guaranteedTokens.filter((t) => t !== chosenTotal?.token);
      const explained = round2(components.reduce((a, t) => a + t.high, 0));

      const perBoth =
        result.perVisit !== null && contingentPerOccasion !== null
          ? round2(result.perVisit + contingentPerOccasion)
          : null;
      const n = perBoth !== null && perBoth > 0 ? totalHigh / perBoth : NaN;

      if (result.perVisit !== null && contingentPerOccasion !== null && Number.isInteger(n) && n >= 1 && n <= 24) {
        const guaranteed = round2(n * result.perVisit);
        const contingent = round2(n * contingentPerOccasion);
        notes.push(
          `the advertised $${totalHigh} assumes ${n} visit(s) paying $${result.perVisit} guaranteed plus $${contingentPerOccasion} that must be earned; guaranteed pay is $${guaranteed} and the remaining $${contingent} is contingent on task performance`,
        );
        totalHigh = guaranteed;
        totalLow = Math.min(totalLow, guaranteed);
        if (result.visitCount === null) result.visitCount = n;
        confidence = worse(confidence, 'medium');
      } else if (contingentSum > 0 && totalHigh - contingentSum > 0 && totalHigh > explained) {
        notes.push(
          `the advertised $${totalHigh} includes $${contingentSum} that must be earned; guaranteed pay is $${round2(totalHigh - contingentSum)}`,
        );
        totalHigh = round2(totalHigh - contingentSum);
        totalLow = Math.min(totalLow, totalHigh);
        confidence = worse(confidence, 'medium');
      } else {
        notes.push(
          `part of the stated $${totalHigh} is contingent on task performance and is not guaranteed`,
        );
        confidence = worse(confidence, 'low');
      }
    }

    result.guaranteedMax = totalHigh;
    // A ceiling ("up to $820", "a possible total of $550") says nothing about
    // the floor - a participant who withdraws early gets less. Rule 3.
    result.guaranteedMin = chosenTotal.ceiling ? null : round2(totalLow);
    if (chosenTotal.ceiling) {
      notes.push('amount is phrased as a ceiling ("up to"); guaranteed floor unknown');
    }

    /**
     * The listing disagreeing with itself is a fact about the listing, not a
     * parser failure, so it is surfaced rather than swallowed. #8338 itemises
     * "$20 ... $35 ... $30 ... $45" (= $130) and then states "The total
     * compensation for completing all four sessions is $120". Rule 2 still
     * takes the stated total; the reader is now told why the arithmetic in
     * front of them does not add up.
     *
     * Narrow on purpose - it fires only when the listing enumerates exactly as
     * many one-off amounts as the visit count it states. That is what makes
     * the components a genuine itemisation of the total rather than a rate
     * ("$125 for each study visit (3)" -> $425, where 50 + 125 != 425 is not a
     * contradiction) or an alternative payout path ("...can only receive $30
     * for their first participation" in #8331).
     */
    const parts = guaranteedTokens.filter((t) => t !== chosenTotal?.token);
    if (
      !chosenTotal.ceiling &&
      !result.isHourlyRate &&
      result.perVisit === null &&
      result.visitCount !== null &&
      parts.length >= 2 &&
      parts.length === result.visitCount
    ) {
      const partsSum = round2(parts.reduce((a, t) => a + t.high, 0));
      if (Math.abs(partsSum - result.guaranteedMax) >= 0.01) {
        notes.push(
          `the listing contradicts itself: its ${parts.length} itemised amounts sum to $${partsSum} but it states a total of $${result.guaranteedMax}; the stated total is used`,
        );
        confidence = worse(confidence, 'medium');
      }
    }

    if (text.length > 250) {
      confidence = worse(confidence, 'medium');
      notes.push('stated total taken from a long prose description; other amounts were ignored');
    }
  } else if (leadingTotal !== null) {
    result.guaranteedMin = leadingTotal;
    result.guaranteedMax = leadingTotal;
  } else if (result.isHourlyRate) {
    // Rule 3: an hourly rate with no stated total does not imply a total,
    // because the number of hours lives in the duration field (or nowhere).
    result.guaranteedMin = null;
    result.guaranteedMax = null;
    notes.push('hourly rate only; study total depends on session length');
    const extras = guaranteedTokens.length;
    if (extras > 0) {
      confidence = worse(confidence, 'low');
      notes.push(`${extras} non-hourly amount(s) present but not summed into a total`);
    }
  } else if (guaranteedTokens.length === 0) {
    if (raffleTokens.length > 0) {
      // Rule 1 taken to its conclusion: the only money on offer is a lottery
      // ticket, so guaranteed pay is genuinely zero, not unknown.
      result.raffleOnly = true;
      result.guaranteedMin = 0;
      result.guaranteedMax = 0;
      notes.push('compensation is a raffle entry only; no guaranteed payment');
    } else if (contingentTokens.length > 0) {
      /**
       * Invariant 1b at its limit: every amount in the text has to be earned.
       * Unlike the raffle-only case above, this is NOT a measured zero (audit
       * R2). A raffle entry is a complete description of the offer - the
       * guaranteed component of a lottery ticket really is $0. "You may earn
       * up to $X for accuracy" describes an unmeasured floor: some
       * participants earn nothing, some earn $X, and the listing does not say
       * what the worst case is. `effective-rate.ts`'s contract is explicit
       * that "guaranteedMax: 0 is a measurement, guaranteedMax: null is the
       * absence of one", and 0 here asserts a claim the listing never made -
       * it would be ranked as a confident $0.00/hr, bucketed `low`, badged
       * "Unpaid", and (because 0 is not null) it would suppress the
       * content-body fallback that might find the real figure.
       */
      result.guaranteedMin = null;
      result.guaranteedMax = null;
      confidence = worse(confidence, 'low');
      notes.push('every stated amount is contingent on performance; no guaranteed payment');
    } else {
      confidence = worse(confidence, 'low');
      notes.push('no dollar amount found in the compensation text');
    }
  } else if (
    result.perVisit !== null &&
    result.visitCount === null &&
    guaranteedTokens.length >= 1
  ) {
    // "$30 per visit" / "$50 for each visit to the imaging center" /
    // "$50 per laboratory visit; $10 for parent questionnaires; $10 for child
    // questionnaires": one visit is certain, more are possible. Floor known,
    // ceiling genuinely unknown.
    result.guaranteedMin = round2(guaranteedTokens.reduce((a, t) => a + t.low, 0));
    result.guaranteedMax = null;
    confidence = worse(confidence, 'medium');
    notes.push('per-visit rate stated without a visit count; value is a floor for one visit');
  } else if (orStraddles) {
    result.guaranteedMin = round2(Math.min(...guaranteedTokens.map((t) => t.low)));
    result.guaranteedMax = round2(Math.max(...guaranteedTokens.map((t) => t.high)));
    confidence = worse(confidence, 'medium');
    notes.push('alternative options offered; took the best single option rather than summing');
  } else if (guaranteedTokens.length === 1) {
    // The clean case: "$400.00", "$45", "20$", "Amazon gift card worth $50".
    const only = guaranteedTokens[0];
    if (only !== undefined) {
      result.guaranteedMin = round2(only.low);
      result.guaranteedMax = round2(only.high);
      if (only.low !== only.high) {
        confidence = worse(confidence, 'medium');
        notes.push('amount given as a range');
      }
    }
  } else {
    // Last resort (Rule 2): no stated total, so sum the parts.
    //   "First Phase: $10 Second Phase: $20" -> $30
    //   "Session 1: ... $5.00. Session 2: ... $10.00." -> $15
    //   "Each interview: $20 Each survey: $20 Smartphone-based data
    //    collection: maximum $100" -> $140
    const sumLow = round2(guaranteedTokens.reduce((a, t) => a + t.low, 0));
    const sumHigh = round2(guaranteedTokens.reduce((a, t) => a + t.high, 0));
    result.guaranteedMin = sumLow;
    result.guaranteedMax = sumHigh;
    confidence = worse(confidence, 'medium');
    notes.push(`no stated total; summed ${guaranteedTokens.length} amounts found in the text`);

    // A component capped with "maximum"/"up to" makes the sum an estimate of
    // the ceiling rather than a firm figure.
    if (/\b(?:maximum|max\.?|up\s+to)\b/i.test(text)) {
      confidence = worse(confidence, 'low');
      notes.push('one or more components are capped ("maximum"/"up to"); the sum is an estimate');
    }
    if (text.length > 300) confidence = worse(confidence, 'low');
  }

  /**
   * Contingent money that never touched a stated total still has to be
   * visible, or the reader sees a number on the card with no idea that a
   * larger one was advertised. #4632: "Participants who complete a
   * reward-based Doors task will receive up to an additional $8.00" on top of
   * an hourly rate. `notes[]` is the only place to put it until
   * `ParsedCompensation` grows a `contingentMax` field - see the handoff note
   * in the audit follow-up; `completionBonus` is deliberately NOT reused,
   * because a completion bonus is paid to everyone who finishes and this is
   * not.
   */
  if (contingentTokens.length > 0 && chosenTotal === null) {
    const contingentMax = round2(Math.max(...contingentTokens.map((t) => t.high)));
    notes.push(
      `up to $${contingentMax} more is contingent on task performance and is excluded from guaranteed pay`,
    );
  }

  // An unpriced bonus means the stated figures are not the whole story:
  // "$10/hour. For some experiments, additional bonuses may be earned during
  // the study." and "a $10 referral bonus for each friend ... they refer".
  if (/\bbonus(?:es)?\b/i.test(text) && result.completionBonus === null) {
    confidence = worse(confidence, 'medium');
    notes.push('an unquantified bonus is mentioned; actual pay may exceed the parsed amount');
  }

  // --- Non-monetary and credit options ------------------------------------
  result.hasNonCashPerk = PERK_RE.test(text);
  result.sonaCreditOption = CREDIT_RE.test(text);

  if (result.hasNonCashPerk) notes.push('includes a non-cash perk');
  if (result.sonaCreditOption) notes.push('course credit (SONA) offered as an option');

  // --- Currency kind -------------------------------------------------------
  const hasMoney =
    result.isHourlyRate ||
    guaranteedTokens.length > 0 ||
    raffleTokens.length > 0 ||
    chosenTotal !== null;

  const giftcard = GIFTCARD_RE.test(text);
  const cash = CASH_RE.test(text);

  result.currencyKind = pickCurrency({
    hasMoney,
    giftcard,
    cash,
    credit: result.sonaCreditOption,
    perk: result.hasNonCashPerk,
  });

  // --- Sanity checks -------------------------------------------------------
  // Never let a null/NaN or an inverted range escape into the ranker.
  if (
    result.guaranteedMin !== null &&
    result.guaranteedMax !== null &&
    result.guaranteedMin > result.guaranteedMax
  ) {
    [result.guaranteedMin, result.guaranteedMax] = [result.guaranteedMax, result.guaranteedMin];
  }

  // Long unstructured prose is the classic low-confidence case, even when a
  // number was extracted: there is usually a clause the parser did not model.
  if (text.length > 400) {
    confidence = worse(confidence, 'low');
    notes.push('long free-text description; parsed values may miss clauses');
  }

  result.confidence = confidence;
  result.notes = notes;
  return result;
}

/**
 * currencyKind precedence:
 *   - no money at all but credit mentioned -> 'credit'
 *   - money plus credit, or money plus a physical perk, or gift card plus
 *     cash in the same record -> 'mixed'
 *   - otherwise the single detected instrument, or 'unknown' for a bare
 *     amount like "$400.00" that names no instrument at all.
 */
function pickCurrency(opts: {
  hasMoney: boolean;
  giftcard: boolean;
  cash: boolean;
  credit: boolean;
  perk: boolean;
}): CurrencyKind {
  const { hasMoney, giftcard, cash, credit, perk } = opts;

  if (!hasMoney) return credit ? 'credit' : 'unknown';
  if (credit) return 'mixed';
  if (perk) return 'mixed';
  if (giftcard && cash) return 'mixed';
  if (giftcard) return 'giftcard';
  if (cash) return 'cash';
  return 'unknown';
}
