/**
 * Last-resort compensation recovery from `content.rendered`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The pipeline reads `meta.aux_study_item_compensation` and nothing else. Nine
 * of the 86 records leave that field blank, and three of those nine state real,
 * itemised participant pay in the body of the listing instead:
 *
 *   #4607 (LEAP)  "Each family will receive $420 for participation in all six
 *                  visits, which are prorated at $80 ... $60 ..."   -> $420
 *   #8402         "Parents schedule a 75-minute appointment and receive a $15
 *                  Amazon e-gift card."                             -> $15 (1.25h -> $12/hr)
 *   #10128        the coordinator pasted "Prepaid movie ticket (Cinemark)"
 *                  into the DURATION field.                         -> non-cash perk
 *
 * All three render as "Pay unclear". See `__audit__.md`, F3.
 *
 * THE STANCE
 * ----------
 * Extracting nothing is much better than extracting a wrong number. A blank
 * compensation field costs the reader one study they might have wanted; an
 * invented figure costs them a wasted trip, which is the exact failure this
 * site exists to prevent. So every rule below is a filter, never a guess:
 *
 *   1. FALLBACK ONLY. Nothing here runs when the compensation meta field
 *      yielded any money signal at all. A parsed meta value always wins.
 *   2. NO NEW MONEY PARSING. The candidate sentence is handed to
 *      `parseCompensation`, the same function the meta field goes through, so
 *      the raffle rule, the stated-total rule and the unknown-is-not-zero rule
 *      all apply unchanged. This module only decides WHICH TEXT to parse.
 *   3. PROVENANCE IS VISIBLE. Anything recovered here is capped at
 *      `confidence: 'medium'` and carries a note saying where it came from, so
 *      the card renders the caveat and `/api/studies.json` carries it too.
 *   4. LOW-CONFIDENCE PARSES ARE DISCARDED. If `parseCompensation` is not sure
 *      about a sentence lifted out of prose, neither are we.
 *   5. DISAGREEMENT IS AMBIGUITY. If two sentences in the same body state
 *      different amounts, nothing is extracted.
 *
 * Pure functions: no I/O, no network, no Date, no module state.
 */

import { stripHtml } from '@/lib/html.ts';
import { parseCompensation } from '@/lib/parse-compensation.ts';
import type { Confidence, ParsedCompensation, ParsedDuration } from '@/types.ts';

// ---------------------------------------------------------------------------
// Notes surfaced to the reader
// ---------------------------------------------------------------------------

/** Provenance note attached to every figure recovered from the body text. */
export const CONTENT_PROVENANCE_NOTE =
  'pay extracted from study description, not the compensation field';

/** Provenance note when the duration field turned out to hold a perk. */
export const PERK_IN_DURATION_NOTE_PREFIX =
  'a non-cash perk is stated in the duration field, not the compensation field';

/** Provenance note when the duration field holds cash wording we did not use. */
export const CASH_IN_DURATION_NOTE_PREFIX =
  'the duration field contains compensation text, not a time commitment';

/** Longest quoted excerpt we will put inside a note. */
const NOTE_QUOTE_MAX = 120;

// ---------------------------------------------------------------------------
// De-chroming `content.rendered`
// ---------------------------------------------------------------------------

/**
 * Every `content.rendered` is a full rendered page: breadcrumb nav, a repeated
 * title, a contact block, the prose, then labelled sections and an "On This
 * Page" list. `parse-eligibility.ts` already strips the same chrome; the
 * patterns are duplicated rather than shared because the two modules want
 * different things out of the result and neither owns the other's regexes.
 */
const LEADING_NAV_RE = /^\s*Home\s+Aggie\s+Research\s+Volunteers\s*/i;
const ON_THIS_PAGE_RE = /On This Page(?:\s+(?:Overview|Duration|Compensation|Location|IRB Info))+/gi;
const TRAILING_IRB_RE = /\bIRB\s+Info\s+IRB\s+Number:[\s\S]*$/i;

/**
 * Section labels rendered inline in the flattened text. They are hard sentence
 * boundaries: without them, #4607's pay sentence (which has no full stop after
 * its final list item) runs straight into
 * "Location Bryan-College Station ... IRB Number: ...".
 *
 * Over-splitting is safe here - the worst case is that a candidate sentence is
 * cut short and rejected for lack of a compensation cue, i.e. we extract
 * nothing, which is the failure mode this module prefers.
 */
const SECTION_LABEL_RE =
  /\s+(?=(?:Overview|Duration|Compensation|Location|Contact|Study PI|IRB Info|IRB Number|On This Page)\b)/g;

/**
 * Rendered HTML body -> flat prose with the page furniture removed. Section
 * boundaries survive as newlines; everything else is single-spaced.
 */
export function dechromeContent(contentHtml: string | null | undefined): string {
  const flat = stripHtml(contentHtml);
  if (flat === '') return '';

  return flat
    .replace(LEADING_NAV_RE, '')
    .replace(ON_THIS_PAGE_RE, ' ')
    .replace(TRAILING_IRB_RE, ' ')
    .replace(SECTION_LABEL_RE, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/**
 * Split on section boundaries first, then on sentence-final punctuation - but
 * only when the next token looks like the start of a new sentence. Keeps
 * "(i.e., Cinemark prepaid ticket)" and "$17.14" intact; tolerates the odd
 * break after "Ph.D." because a stray split can only make this module more
 * conservative.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split('\n')) {
    for (const piece of block.split(/(?<=[.!?])\s+(?=["'“(\[$A-Z0-9])/)) {
      const trimmed = piece.trim().replace(/(?:\s*[.;:,])+$/, '').trim();
      if (trimmed !== '') out.push(trimmed);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Is there an amount of money in here at all? Deliberately looser than
 * `parse-compensation`'s tokenizer (this is only a pre-filter) but still
 * requires a currency sigil or an explicit currency noun, so "the first 400
 * participants" and "4th-8th grade" are not money.
 */
const MONEY_PROBE_RE = /\$\s*\d|\d\s*\$|\b\d[\d,]*(?:\.\d+)?\s+(?:dollars?|gift\s?cards?)\b/i;

/**
 * Words that mean "this money changes hands with the participant". Without one
 * of these a sentence containing a dollar sign is not a pay statement.
 */
const COMPENSATION_CUE_RE =
  /\b(?:compensat\w+|receives?|received|receiving|reimburs\w+|paid|payment|pays?|stipend|honorari\w+|gift\s*cards?|e-?gift|gift\s+certificates?|voucher|incentives?|remunerat\w+|thank[-\s]?you|will\s+be\s+given|are\s+given|is\s+given|(?:are|is)\s+sent|earn(?:s|ed)?)\b/i;

/**
 * ...and it has to be the PARTICIPANT who gets it. "The lab receives $2m" is
 * not pay; "each family will receive $420" is.
 */
const PARTICIPANT_CUE_RE =
  /\b(?:you|your|participants?|parents?|caregivers?|guardians?|famil(?:y|ies)|volunteers?|subjects?|students?|children|child|respondents?|interviewees?|couples?|dyads?|each\s+\w+)\b/i;

/**
 * Money that exists in the listing but is emphatically not participant pay.
 * Grant/sponsor money, equipment prices and billing language all appear in
 * research prose and would otherwise be read as a payout.
 *
 * `reimburse`, `stipend` and "valued at" are NOT here on purpose - all three
 * are ordinary participant-compensation words ("gift card valued at $20").
 */
const NOT_PARTICIPANT_PAY_RE =
  /\b(?:grant(?:s|ed)?\b|grant\s+number|award\s+(?:number|no\.?)|funded\s+by|funding\s+from|funding\s+source|sponsor(?:ed|ship|s)?\b|budget|NIH|NSF|USDA|NIMH|DARPA|foundation|tuition|payroll|salar(?:y|ies)|invoice|bill(?:ed|ing)|co-?pay|insurance|deductible|out-of-pocket\s+cost|costs?\s+(?:of|about|approximately|around|\$)|price\s+of|retail\s+(?:price|value)|purchase\s+price|market\s+value)\b/i;

/**
 * A stated total followed by its own breakdown. `parse-compensation` invariant
 * 2 says a stated total beats a computed one, but it only recognises the
 * restatement in the shapes the meta field uses (parentheses, "total is").
 * #4607's body writes it as prose:
 *
 *   "$420 for participation in all six visits, which are prorated at $80 ...
 *    $40 ... $90 ... $50 ... $100 ... $60"
 *
 * Handing the whole sentence over yields $840 - the total plus its own parts.
 * Cutting at the marker leaves "Each family will receive $420 for
 * participation in all six visits", which parses to exactly $420. This is
 * clause selection, not money arithmetic: the discarded tail is never parsed.
 */
const BREAKDOWN_MARKER_RES: readonly RegExp[] = [
  /[,;:]?\s*(?:which\s+(?:are|is)\s+|and\s+(?:are|is)\s+)?(?:prorated|pro-rated|broken\s+down|itemized|itemised|distributed|allocated|apportioned|paid\s+out|disbursed|split|divided)\s+(?:at|as|into|across|over|among|amongst|between|by)\b/i,
  /[,;:]?\s*(?:broken\s+down\s+)?as\s+follows\b/i,
  /[,;:]?\s*(?:distributed|paid)\s+as\s+follows\b/i,
];

/** Candidates longer than this are prose, not a pay statement. */
const MAX_CANDIDATE_LENGTH = 400;

function trimRestatedBreakdown(sentence: string): string {
  let cut = sentence.length;
  for (const re of BREAKDOWN_MARKER_RES) {
    const match = re.exec(sentence);
    if (match !== null && match.index < cut) cut = match.index;
  }
  if (cut === sentence.length) return sentence;

  const head = sentence.slice(0, cut).trim().replace(/[,;:]$/, '').trim();
  // Only honour the cut if the total actually survives it.
  return MONEY_PROBE_RE.test(head) ? head : sentence;
}

/** Sentences that could plausibly state what the participant is paid. */
export function compensationSentences(contentHtml: string | null | undefined): string[] {
  const text = dechromeContent(contentHtml);
  if (text === '') return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of splitSentences(text)) {
    if (!MONEY_PROBE_RE.test(raw)) continue;
    if (!COMPENSATION_CUE_RE.test(raw)) continue;
    if (!PARTICIPANT_CUE_RE.test(raw)) continue;
    if (NOT_PARTICIPANT_PAY_RE.test(raw)) continue;

    const candidate = trimRestatedBreakdown(raw);
    if (candidate.length > MAX_CANDIDATE_LENGTH) continue;
    if (!MONEY_PROBE_RE.test(candidate)) continue;
    if (seen.has(candidate)) continue;

    seen.add(candidate);
    out.push(candidate);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Money-signal predicate
// ---------------------------------------------------------------------------

/**
 * True when a parse found no money of any kind - no guaranteed floor or
 * ceiling, no raffle prize, no stated hourly rate. This is the ONLY state in
 * which the content fallback is allowed to run, and in the current snapshot it
 * is true for exactly the nine records whose compensation meta field is blank.
 */
export function hasNoMoneySignal(comp: ParsedCompensation | null | undefined): boolean {
  if (comp === null || comp === undefined) return true;
  return (
    comp.guaranteedMin === null &&
    comp.guaranteedMax === null &&
    comp.raffleMax === null &&
    comp.hourlyMin === null &&
    comp.hourlyMax === null &&
    !comp.raffleOnly
  );
}

/** Everything about a parse that has to agree before we trust two sentences. */
function moneyFingerprint(comp: ParsedCompensation): string {
  return JSON.stringify([
    comp.guaranteedMin,
    comp.guaranteedMax,
    comp.raffleMax,
    comp.raffleOnly,
    comp.isHourlyRate,
    comp.hourlyMin,
    comp.hourlyMax,
  ]);
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Never let a recovered figure claim more confidence than 'medium'. */
function capConfidence(c: Confidence): Confidence {
  return CONFIDENCE_RANK[c] > CONFIDENCE_RANK.medium ? 'medium' : c;
}

// ---------------------------------------------------------------------------
// Content fallback
// ---------------------------------------------------------------------------

/**
 * Recover compensation from the study body, or `null` when nothing can be read
 * safely.
 *
 * The returned value is a normal `ParsedCompensation` produced by
 * `parseCompensation`, with three edits: `raw` is the sentence that was
 * actually parsed (so `compensation.raw` still explains every number on the
 * card and in the API), `confidence` is capped at `'medium'`, and the
 * provenance note leads the note list.
 */
export function extractCompensationFromContent(
  contentHtml: string | null | undefined,
): ParsedCompensation | null {
  const candidates = compensationSentences(contentHtml);
  if (candidates.length === 0) return null;

  const parsed: ParsedCompensation[] = [];
  for (const sentence of candidates) {
    const comp = parseCompensation(sentence);
    // Nothing to take, or the parser itself is unsure: leave it alone.
    if (hasNoMoneySignal(comp)) continue;
    if (comp.confidence === 'low') continue;
    parsed.push(comp);
  }

  if (parsed.length === 0) return null;

  // Two sentences stating different amounts is ambiguity, not information.
  const fingerprints = new Set(parsed.map(moneyFingerprint));
  if (fingerprints.size > 1) return null;

  const best = parsed[0] as ParsedCompensation;

  return {
    ...best,
    confidence: capConfidence(best.confidence),
    notes: [CONTENT_PROVENANCE_NOTE, ...best.notes],
  };
}

// ---------------------------------------------------------------------------
// Compensation text misfiled in the duration field
// ---------------------------------------------------------------------------

/** Any word that would make this string a genuine time commitment. */
const TIME_WORD_RE =
  /\b(?:second|minute|min|hour|hr|day|daily|week|weekly|month|monthly|year|yearly|session|visit|appointment|meeting|interview|survey|scan|semester|night|weekend|ongoing|duration)\w*\b/i;

/** Perk vocabulary. Only consulted once the string is known to state no time. */
const PERK_RE =
  /\b(?:gift\s*cards?|e-?gift|gift\s+certificates?|gifts?|vouchers?|coupons?|pre-?paid|tickets?|meals?|lunch|dinner|breakfast|snacks?|refreshments?|parking|t-?shirts?|swag|prizes?|raffle|drawing|compensat\w+|payment|paid|stipend|incentives?)\b/i;

export interface MisplacedDurationText {
  /** True when the perk is non-cash, so it belongs in `hasNonCashPerk`. */
  isNonCash: boolean;
  /** Reader-facing note, quoting the offending field verbatim. */
  note: string;
}

function quote(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const body = flat.length > NOTE_QUOTE_MAX ? `${flat.slice(0, NOTE_QUOTE_MAX - 1)}…` : flat;
  return `"${body}"`;
}

/**
 * Detect a duration field that actually holds compensation text.
 *
 * #10128's `aux_study_item_duration` is `"Prepaid movie ticket (Cinemark)"`.
 * `parseDuration` correctly reads no hours out of it, but the perk is then
 * lost entirely and the study shows neither pay nor duration.
 *
 * The guards are deliberately strict, because a false positive here would put
 * a perk badge on a study that offers none:
 *
 *   1. the duration parse must have produced NOTHING - no hours, no session
 *      count, no calendar span; and
 *   2. the text must contain no time vocabulary whatsoever; and
 *   3. it must read as a perk.
 *
 * In the current snapshot exactly one record clears all three.
 */
export function detectMisplacedDurationText(
  durationField: string,
  duration: ParsedDuration | null | undefined,
): MisplacedDurationText | null {
  const text = (durationField ?? '').trim();
  if (text === '') return null;

  if (duration !== null && duration !== undefined) {
    const parsedSomething =
      duration.totalHoursMin !== null ||
      duration.totalHoursMax !== null ||
      duration.sessionCount !== null ||
      duration.spanWeeks !== null;
    if (parsedSomething) return null;
  }

  if (TIME_WORD_RE.test(text)) return null;
  if (!PERK_RE.test(text)) return null;

  // Cash in the duration field is flagged but never converted into a payout -
  // guessing the scope of a stray number is exactly the mistake this module
  // exists to avoid.
  if (MONEY_PROBE_RE.test(text)) {
    return { isNonCash: false, note: `${CASH_IN_DURATION_NOTE_PREFIX}: ${quote(text)}` };
  }

  return { isNonCash: true, note: `${PERK_IN_DURATION_NOTE_PREFIX}: ${quote(text)}` };
}

// ---------------------------------------------------------------------------
// The one call `normalize.ts` makes
// ---------------------------------------------------------------------------

export interface ContentFallbackInput {
  /** Result of running `parseCompensation` over the compensation meta field. */
  compensation: ParsedCompensation;
  /** Result of running `parseDuration` over the duration meta field. */
  duration: ParsedDuration;
  /** The raw duration meta string, before parsing. */
  durationField: string;
  /** `content.rendered`, still HTML. */
  contentHtml: string;
}

/**
 * Apply both fallbacks and return the compensation to use.
 *
 * Never mutates its input and never overrides a compensation field that
 * parsed: `extractCompensationFromContent` is consulted only when the meta
 * field produced no money signal at all.
 */
export function applyContentFallbacks(input: ContentFallbackInput): ParsedCompensation {
  const { compensation, duration, durationField, contentHtml } = input;

  let result = compensation;

  if (hasNoMoneySignal(compensation)) {
    const recovered = extractCompensationFromContent(contentHtml);
    if (recovered !== null) {
      // `raw` becomes the sentence that was actually parsed, so every number
      // on the card still has its source text next to it. When the meta field
      // was non-empty but moneyless, that text would otherwise vanish from the
      // page, so it is preserved as a note instead. (All nine moneyless
      // records in the current snapshot have a blank field, so this branch is
      // future-proofing rather than live behaviour.)
      const displaced = compensation.raw.trim();
      const displacedNote =
        displaced === '' ? [] : [`the compensation field states no amount: ${quote(displaced)}`];

      result = {
        ...recovered,
        // Perks and credit options read off the meta field are worth keeping
        // if the meta parse found them even without an amount.
        hasNonCashPerk: recovered.hasNonCashPerk || compensation.hasNonCashPerk,
        sonaCreditOption: recovered.sonaCreditOption || compensation.sonaCreditOption,
        notes: [...recovered.notes, ...displacedNote],
      };
    }
  }

  const misplaced = detectMisplacedDurationText(durationField, duration);
  if (misplaced !== null) {
    result = {
      ...result,
      hasNonCashPerk: result.hasNonCashPerk || misplaced.isNonCash,
      notes: [...result.notes, misplaced.note],
    };
  }

  return result;
}
