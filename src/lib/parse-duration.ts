/**
 * Parser for `meta.aux_study_item_duration`.
 *
 * THE LOAD-BEARING DISTINCTION
 * ---------------------------
 * `totalHours*` is CONTACT TIME - hours the participant actually spends doing
 * the study. `spanWeeks` is CALENDAR TIME - how long the study is strung out
 * over. They are wildly different numbers and conflating them destroys the
 * whole point of the site:
 *
 *   "Approximately 6 weeks"            -> spanWeeks 6,  totalHours NULL
 *   "12.5 hours over a 3-week period"  -> spanWeeks 3,  totalHours 12.5
 *
 * A calendar span is NEVER converted into contact hours. When a string states
 * only a span, `totalHoursMin` / `totalHoursMax` stay `null`, which forces
 * `effectiveHourly` to null and drops the study into the "unknown rate"
 * bucket - the honest answer.
 *
 * The 86-record snapshot has 71 distinct duration strings and essentially no
 * shared grammar, so this parser is a small pipeline rather than one regex:
 *
 *   1. normalize()        - HTML -> text, dashes, fused tokens, number words
 *   2. extractMentions()  - every "<number(-number)> <unit>" as a typed span,
 *                           with adjacent range/compound merging
 *   3. one of five contact-time strategies, tried in priority order:
 *        explicit-total | leading-total | multiplied | summed | single
 *   4. sessionCount and spanWeeks, extracted independently
 *
 * Ambiguity policy: a plural item count multiplies a duration when the text
 * links the two, either distributively ("each", "per visit", "two 2-hour
 * sessions") or by plain juxtaposition - "<count> <visit noun> ... <duration>"
 * with nothing but linking words in between, as in "6 study days lasting up to
 * 7 hours". Juxtaposition is how the CTRAL/nutrition template writes a
 * per-visit figure, and reading it as a whole-study total understates those
 * studies by up to 4.9x (see `__audit__.md`, F1).
 *
 * Two hard brakes keep that from over-applying:
 *
 *   1. A stated TOTAL always wins over its own components, so
 *      "2 hours (in the form of two 1-hour visits)" stays 2 h, never 4 h.
 *   2. A count whose scope contains MORE THAN ONE duration is enumerating,
 *      not distributing: "Two visits: 3 hrs and 1.5 hrs" is 4.5 h, not 9 h.
 *
 * Where the duration text alone leaves the count genuinely open, the
 * compensation field on the same record often settles it arithmetically
 * ("$20 + 6 x $100 = $620" only closes at six study days). That cross-field
 * check is opt-in via `parseDurationWithCompensation`; `parseDuration` stays a
 * pure function of the duration string.
 */

import { stripHtml } from '@/lib/html.ts';
import type { Confidence, ParsedCompensation, ParsedDuration } from '@/types.ts';

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

const MINUTES_PER_HOUR = 60;
const DAYS_PER_WEEK = 7;
/** 365.25 / 12 / 7. Used only for calendar spans, never for contact hours. */
const WEEKS_PER_MONTH = 4.348;
const WEEKS_PER_YEAR = 52.179;

/** Nothing in this dataset is a plausible five-figure time commitment. */
const MAX_PLAUSIBLE_HOURS = 2000;
const MAX_PLAUSIBLE_WEEKS = 520;
const MAX_PLAUSIBLE_SESSIONS = 500;

type TimeUnit = 'minutes' | 'hours';
type CalendarUnit = 'days' | 'weeks' | 'months' | 'years';
type Unit = TimeUnit | CalendarUnit;

/**
 * One "<number> <unit>" (or "<number>-<number> <unit>") occurrence.
 *
 * `min`/`max` are already canonical: HOURS for `kind: 'time'`, WEEKS for
 * `kind: 'calendar'`. Keeping the canonical value on the mention is what lets
 * mixed-unit ranges like "30 minutes - 2 hours" merge by plain arithmetic.
 */
interface Mention {
  kind: 'time' | 'calendar';
  min: number;
  max: number;
  unit: Unit;
  /** Index into the normalized string, for context-window lookups. */
  start: number;
  end: number;
}

function unitOf(token: string): Unit | null {
  if (/^(?:hours?|hrs?)$/.test(token)) return 'hours';
  if (/^(?:minutes?|mins?)$/.test(token)) return 'minutes';
  if (/^(?:days?)$/.test(token)) return 'days';
  if (/^(?:weeks?|wks?)$/.test(token)) return 'weeks';
  if (/^(?:months?)$/.test(token)) return 'months';
  if (/^(?:years?)$/.test(token)) return 'years';
  return null;
}

function toCanonical(value: number, unit: Unit): number {
  switch (unit) {
    case 'minutes':
      return value / MINUTES_PER_HOUR;
    case 'hours':
      return value;
    case 'days':
      return value / DAYS_PER_WEEK;
    case 'weeks':
      return value;
    case 'months':
      return value * WEEKS_PER_MONTH;
    case 'years':
      return value * WEEKS_PER_YEAR;
  }
}

function kindOf(unit: Unit): 'time' | 'calendar' {
  return unit === 'minutes' || unit === 'hours' ? 'time' : 'calendar';
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Nouns that denote a discrete participation event. Deliberately excludes a
 * bare "day": "28 days" is a calendar span, not 28 sessions.
 */
const SESSION_NOUN =
  '(?:visits?|sessions?|appointments?|study\\s+days?|lab\\s+visits?|interviews?|scans?|workshops?|interventions?|assessments?|phases?|parts?|meetings?|classes?)';

/** Unit words that must not appear between a count and its noun - see countRegex(). */
const UNIT_WORD = '(?:minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|years?)';

/**
 * "<count> [up to 2 non-unit words] <session noun>", e.g. "12 treatment
 * sessions", "1 screening visit".
 *
 * The unit-word exclusion is baked into the pattern rather than checked
 * afterwards, and that placement matters: in "2 hours 8 interventions" a
 * post-hoc filter would match "2 hours 8 interventions", reject it, and leave
 * the regex cursor past "8 interventions" - losing the count entirely. The
 * inline lookahead makes the engine backtrack and find "8 interventions".
 */
function countRegex(): RegExp {
  return new RegExp(`(\\d+)\\s+((?:(?!${UNIT_WORD}\\b)\\w+\\s+){0,2}?)${SESSION_NOUN}\\b`, 'g');
}

/**
 * Phrases asserting that a number covers the WHOLE study rather than one part
 * of it. A clause carrying one of these makes its duration authoritative.
 */
const TOTAL_CUE_RE =
  /\b(?:total|totaling|in all|altogether|combined|entire (?:study|session|experiment|protocol)|whole study|study (?:involvement|participation)|(?:overall|cumulative) (?:time|duration)|participation is|completing this[^.;]{0,60}?takes)\b/;

/**
 * Cues that the text just gave a whole-study figure and is about to break it
 * down into parts - so the parts must NOT be added to it.
 */
const BREAKDOWN_CUE_RE =
  /^[\s,:-]*(?:\(|across|split|divided|spread|broken|consisting of|comprised of|composed of|made up of|in the form of|in (?:\d+|a|two|three) [a-z]* ?(?:visits?|sessions?|parts?)|over \d+ (?:visits?|sessions?))/;

/** Distributive markers: the duration applies to EACH item, so it multiplies. */
const DISTRIBUTIVE_RE = new RegExp(`\\b(?:each|per|every|apiece)\\s+(?:\\w+\\s+){0,2}?${SESSION_NOUN}\\b`);
const EACH_SUFFIX_RE = /^[\s,)]*(?:each|apiece|per\s+\w+)\b/;
/** Bare "each"/"every" a few words in front of the duration: "each about 2 hours". */
const BARE_EACH_RE = /\b(?:each|every|apiece)\b[^.;]{0,20}$/;
/** Any distributive wording at all, used only as a confidence safety net. */
const ANY_DISTRIBUTIVE_RE = /\b(?:each|per|every|apiece)\b/;

/**
 * "each appointment (0, 1, 4, 7, and 14)" - a distributive noun followed by a
 * parenthesised list of timepoints. The list IS the enumeration of the visits,
 * so its length is the count, even though no digit precedes the noun.
 *
 * Deliberately narrow: at least three bare integers in one parenthesis,
 * attached directly to `each|every|per <visit noun>`.
 */
const ENUMERATED_TIMEPOINTS_RE = new RegExp(
  `\\b(?:each|every|per)\\s+(?:\\w+\\s+){0,2}?${SESSION_NOUN}\\s*\\(\\s*(\\d+(?:\\s*,\\s*(?:and\\s+)?\\d+){2,})\\s*\\)`,
);

/**
 * Words permitted between a visit count and the duration it distributes over.
 *
 * The list is closed on purpose. "6 study days lasting up to 7 hours" links;
 * "2 visits and 3 hours of online questionnaires" does not, because "and"
 * introduces a second, separate commitment rather than describing the first.
 */
const LINK_WORD =
  '(?:lasting|lasts|last|for|of|at|about|approximately|approx|around|roughly|up|to|each|per|taking|takes|take|which|that|will|is|are|be|expected|estimated|requiring|requires|require|maximum|minimum|max|min|anticipated|a|an|the)';

/** Punctuation that may sit between a count and its duration. Never `.` or `;`. */
const LINK_PUNCT = '[\\s,:()\\[\\]-]';

const LINK_GAP_RE = new RegExp(`^${LINK_PUNCT}*(?:${LINK_WORD}\\b${LINK_PUNCT}*)*$`);

/** Longest gap that still reads as "this duration belongs to that count". */
const MAX_LINK_GAP_CHARS = 45;

/**
 * Ongoing, unquantified participation: "several minutes each day for nine
 * days". There is real time here and no way to total it, so any figure the
 * parser can produce covers only part of the commitment.
 *
 * Note "several MINUTES/HOURS", not "several weeks" - a vague calendar span is
 * already handled correctly by keeping contact hours null.
 */
const UNQUANTIFIED_ONGOING_RE =
  /\b(?:several|a few|few|some|varying|numerous|multiple)\s+(?:minutes?|mins?|hours?|hrs?)\b[^.;]{0,60}?\b(?:each|every|per)\s+(?:day|week|morning|evening|night|session|visit)\b/;

const NUMBER_WORDS: Record<string, number> = {
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
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

// ---------------------------------------------------------------------------
// 1. Normalization
// ---------------------------------------------------------------------------

/**
 * Flatten the raw meta value into a lowercase string that the regex layer can
 * trust.
 *
 * `<br>` is turned into a semicolon BEFORE `stripHtml` runs. stripHtml maps it
 * to a space, which is right for prose but loses the clause boundary that
 * "Visit 1: 1.5 hours<br>Visit 2: 1 hour" depends on - and clause boundaries
 * are how compound merging avoids reading that as "1.5 hours 1 hour".
 */
function normalize(input: string): string {
  const withBoundaries = input
    .replace(/<\s*br\s*\/?\s*>/gi, ' ; ')
    .replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, ' ; ');

  let text = stripHtml(withBoundaries).toLowerCase();

  // Every dash variant becomes a plain hyphen so one range regex covers them.
  text = text.replace(/[‐‑‒–—―−]/g, '-');
  // "~30minutes" - the tilde carries no information the parser needs.
  text = text.replace(/~/g, ' ');

  // Fixture has "2 hours8 Interventions": a unit word fused to the next count.
  text = text.replace(/\b(hours?|hrs?|minutes?|mins?|weeks?|days?|months?|years?)(\d)/g, '$1 $2');
  // "30minutes", "2hrs", "1.5-2hr" - digit fused to its own unit word.
  text = text.replace(/(\d)(?=(?:hour|hr|minute|min|week|wk|day|month|year)s?\b)/g, '$1 ');

  // Fractional idioms, before the generic "a <unit>" rule.
  text = text
    .replace(/\bhalf an hour\b/g, '30 minutes')
    .replace(/\b(?:an? |one )?(hour|week|month|day|year) and a half\b/g, '1.5 $1s')
    .replace(/\bone and a half (hours?|weeks?|months?|days?|years?)\b/g, '1.5 $1');

  // "an hour" / "a month" -> "1 hour" / "1 month". Only directly before a unit,
  // so "a 6 week timeframe" and "a maximum of 4 visits" are left alone.
  text = text.replace(/\ban?\s+(hour|hr|minute|min|week|day|month|year)s?\b/g, '1 $1');

  // Number words -> digits ("two-hour", "Two total visits", "three-part study").
  text = text.replace(/\b([a-z]+)\b/g, (word) => {
    const value = NUMBER_WORDS[word];
    return value === undefined ? word : String(value);
  });

  // "2-hour", "2-weeks", "1-session" -> space, so the hyphen only ever means
  // "range" by the time extractMentions() runs.
  text = text.replace(
    new RegExp(`(\\d(?:\\.\\d+)?)\\s*-\\s*(?=(?:hour|hr|minute|min|week|wk|day|month|year)|${SESSION_NOUN})`, 'g'),
    '$1 ',
  );

  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 2. Mention extraction
// ---------------------------------------------------------------------------

const MENTION_RE =
  /(\d+(?:\.\d+)?)\s*(?:(?:-|to|through)\s*(\d+(?:\.\d+)?)\s*)?(hours?|hrs?|minutes?|mins?|weeks?|wks?|days?|months?|years?)\b/g;

/** Gap text that turns two adjacent mentions into a single range. */
const RANGE_GAP_RE = /^\s*(?:-|to|through|up to)\s*$/;
/** Gap text that turns "1 hour" + "15 minutes" into one 1.25-hour mention. */
const COMPOUND_GAP_RE = /^\s*(?:and\s+)?$/;

function extractMentions(text: string): Mention[] {
  const found: Mention[] = [];

  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(text); m !== null; m = MENTION_RE.exec(text)) {
    const unit = unitOf(m[3] ?? '');
    if (unit === null) continue;

    const low = Number.parseFloat(m[1] ?? '');
    if (!Number.isFinite(low)) continue;
    const highRaw = m[2] === undefined ? low : Number.parseFloat(m[2]);
    const high = Number.isFinite(highRaw) ? highRaw : low;

    found.push({
      kind: kindOf(unit),
      min: toCanonical(Math.min(low, high), unit),
      max: toCanonical(Math.max(low, high), unit),
      unit,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  return mergeMentions(text, found);
}

/**
 * Fold split-across-units ranges and compounds into single mentions.
 *
 *   "45 minutes to 1 hour"   -> one mention, 0.75-1 h   (range: mixed units)
 *   "1 hour 15 minutes"      -> one mention, 1.25 h     (compound: additive)
 *
 * Without this, "1 hour 15 minutes" would later be summed as 1.25 h twice over
 * (or, worse, "75 minutes (1 hour 15 minutes)" would come out as 2.5 h).
 */
function mergeMentions(text: string, mentions: Mention[]): Mention[] {
  const merged: Mention[] = [];

  for (const current of mentions) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined) {
      const gap = text.slice(prev.end, current.start);

      if (prev.kind === current.kind && RANGE_GAP_RE.test(gap) && prev.min === prev.max) {
        merged[merged.length - 1] = {
          ...prev,
          min: Math.min(prev.min, current.min),
          max: Math.max(prev.max, current.max),
          end: current.end,
        };
        continue;
      }

      if (prev.unit === 'hours' && current.unit === 'minutes' && COMPOUND_GAP_RE.test(gap)) {
        merged[merged.length - 1] = {
          ...prev,
          min: prev.min + current.min,
          max: prev.max + current.max,
          end: current.end,
        };
        continue;
      }
    }

    merged.push(current);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function before(text: string, index: number, chars: number): string {
  return text.slice(Math.max(0, index - chars), index);
}

function after(text: string, index: number, chars: number): string {
  return text.slice(index, Math.min(text.length, index + chars));
}

/** The sentence/clause a character index falls inside. Split on `.` and `;`. */
function clauseAt(text: string, index: number): string {
  let start = 0;
  let end = text.length;

  for (let i = index; i >= 0; i--) {
    const ch = text[i];
    if (ch === '.' || ch === ';') {
      start = i + 1;
      break;
    }
  }
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (ch === '.' || ch === ';') {
      end = i;
      break;
    }
  }

  return text.slice(start, end);
}

/**
 * Nearest "<count> <noun>" before `index`, e.g. the 12 in
 * "12 treatment sessions (1.5 hours each)".
 *
 * Rejects a match whose filler words contain a unit, which is what stops
 * "3-month appointments" from being read as three appointments and
 * "2 week intervention" as two interventions.
 */
/** One "<count> <visit noun>" occurrence, with its position in the text. */
interface CountMention {
  value: number;
  start: number;
  end: number;
}

/**
 * Every "<count> <visit noun>" in the text, in order.
 *
 * Shared by `extractSessionCount` (which sums them) and the juxtaposition
 * multiplier (which needs to know where each one sits and what falls inside
 * its scope), so the two can never disagree about what a count is.
 */
function extractCounts(text: string): CountMention[] {
  const out: CountMention[] = [];
  const re = countRegex();

  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const value = Number.parseInt(m[1] ?? '', 10);
    if (!Number.isFinite(value) || value < 1) continue;
    out.push({ value, start: m.index, end: m.index + m[0].length });
  }

  return out;
}

function countBefore(text: string, index: number, windowChars: number): number | null {
  const window = before(text, index, windowChars);
  const re = countRegex();

  let best: number | null = null;
  for (let m = re.exec(window); m !== null; m = re.exec(window)) {
    const value = Number.parseInt(m[1] ?? '', 10);
    if (Number.isFinite(value) && value >= 1 && value <= MAX_PLAUSIBLE_SESSIONS) best = value;
  }

  return best;
}

// ---------------------------------------------------------------------------
// 3. Contact-time strategies
// ---------------------------------------------------------------------------

type Strategy =
  | 'explicit-total'
  | 'leading-total'
  | 'multiplied'
  | 'summed'
  | 'single'
  | 'ongoing'
  | 'none';

interface HoursResult {
  min: number | null;
  max: number | null;
  strategy: Strategy;
  /** Set when the text stated a plural count the parser refused to apply. */
  ambiguous: boolean;
  /** Counts actually applied as multipliers, in text order. */
  appliedCounts: number[];
  /**
   * Counts that sat next to a duration but were NOT applied because the text
   * did not link them clearly enough. These are the ones cross-field evidence
   * is allowed to license; counts refused for enumerating (see
   * `juxtaposedCount`) never appear here.
   */
  declinedCounts: number[];
}

/** Where a multiplier came from. Drives confidence and corroboration. */
type MultiplierSource = 'none' | 'explicit' | 'attributive' | 'enumerated' | 'juxtaposed' | 'licensed';

interface Multiplier {
  factor: number;
  /** True when a plural count sits next to the duration and was not applied. */
  ambiguous: boolean;
  source: MultiplierSource;
  /** A count that was available but declined, and could be licensed later. */
  declined: number | null;
}

interface HoursContext {
  text: string;
  counts: CountMention[];
  timeMentions: Mention[];
  documentCount: number | null;
  /**
   * A visit count corroborated by another field. It only ever unlocks a
   * multiplication this parser already found and declined; it can never
   * introduce a count the duration text does not contain.
   */
  licensedCount: number | null;
}

/**
 * The count that governs a duration by plain juxtaposition, if any.
 *
 * "6 study days lasting up to 7 hours" states a count and a per-unit duration
 * next to each other with nothing but linking words between them. That is a
 * distributive reading even though the source never says "each".
 *
 * Returns `null` when there is no such count. Returns `{ linked: false }` when
 * a count is nearby but must NOT be applied - either the words between them
 * are not linking words, or the count's scope holds more than one duration and
 * is therefore enumerating its parts rather than distributing over them.
 */
function juxtaposedCount(ctx: HoursContext, mention: Mention): { value: number; linked: boolean } | null {
  let index = -1;
  for (let i = 0; i < ctx.counts.length; i++) {
    const candidate = ctx.counts[i];
    if (candidate !== undefined && candidate.end <= mention.start) index = i;
    else break;
  }
  if (index < 0) return null;

  const count = ctx.counts[index];
  if (count === undefined) return null;
  if (count.value < 2 || count.value > MAX_PLAUSIBLE_SESSIONS) return null;

  // "Two visits: 3 hrs and 1.5 hrs" - the count's scope holds one duration per
  // visit, all of them spelled out. Multiplying would count each one twice.
  const next = ctx.counts[index + 1];
  const scopeEnd = next === undefined ? ctx.text.length : next.start;
  const inScope = ctx.timeMentions.filter((m) => m.start >= count.end && m.start < scopeEnd);
  if (inScope.length > 1) return { value: count.value, linked: false };

  const gap = ctx.text.slice(count.end, mention.start);
  if (gap.length > MAX_LINK_GAP_CHARS || !LINK_GAP_RE.test(gap)) {
    return { value: count.value, linked: false };
  }

  return { value: count.value, linked: true };
}

/** Length of a parenthesised timepoint list attached to "each <visit noun>". */
function enumeratedCount(text: string, mention: Mention): number | null {
  const clause = clauseAt(text, mention.start);
  const match = ENUMERATED_TIMEPOINTS_RE.exec(clause);
  if (match === null) return null;

  const list = match[1];
  if (list === undefined) return null;

  const items = list.match(/\d+/g);
  if (items === null) return null;

  return items.length >= 2 && items.length <= MAX_PLAUSIBLE_SESSIONS ? items.length : null;
}

/**
 * How many times a duration should be counted.
 *
 * Multiplies on:
 *   - "12 treatment sessions (1.5 hours each)"  -> suffix "each"    -> x12
 *   - "Two visits, each about 2 hours"          -> prefix "each"    -> x2
 *   - "Two separate two-hour sessions"          -> attributive form -> x2
 *   - "each appointment (0, 1, 4, 7, and 14)"   -> enumerated list  -> x5
 *   - "6 study days lasting up to 7 hours"      -> juxtaposition    -> x6
 *
 * A count is still refused when the gap between it and the duration is not
 * pure linking words, or when its scope enumerates several durations. Those
 * refusals set `ambiguous` and are reported as `declined` so cross-field
 * evidence can reconsider them.
 */
function multiplierFor(ctx: HoursContext, mention: Mention): Multiplier {
  const { text, documentCount } = ctx;
  const suffix = after(text, mention.end, 40);
  const prefix = before(text, mention.start, 60);
  // "within 3 weeks of each other" is not distributive.
  const prefixNoIdiom = prefix.replace(/each other/g, '');

  const explicitDistributive =
    EACH_SUFFIX_RE.test(suffix) || DISTRIBUTIVE_RE.test(prefixNoIdiom) || BARE_EACH_RE.test(prefixNoIdiom);

  if (explicitDistributive) {
    const enumerated = enumeratedCount(text, mention);
    const count = enumerated ?? countBefore(text, mention.start, 120) ?? documentCount;
    if (count !== null && count > 1) {
      return { factor: count, ambiguous: false, source: enumerated === null ? 'explicit' : 'enumerated', declined: null };
    }
    return { factor: 1, ambiguous: false, source: 'none', declined: null };
  }

  // Attributive: "<count> [adj] <duration> <noun>", as in "two separate
  // two-hour sessions". The count and the noun straddle the duration, so the
  // noun must sit IMMEDIATELY after it - allowing filler words here would read
  // "4 study visits ~14 hours all visits must be completed" as 4 x 14 hours.
  const nounFollows = new RegExp(`^[\\s,]*${SESSION_NOUN}\\b`).test(suffix);
  const attributiveCount = /(\d+)\s+(?:\w+\s+){0,2}$/.exec(prefix);
  if (nounFollows && attributiveCount !== null) {
    const count = Number.parseInt(attributiveCount[1] ?? '', 10);
    if (Number.isFinite(count) && count > 1 && count <= MAX_PLAUSIBLE_SESSIONS) {
      return { factor: count, ambiguous: false, source: 'attributive', declined: null };
    }
  }

  // "each appointment (0, 1, 4, 7, and 14) ... lasting approximately 1 hour" -
  // the distributive marker is too far from the duration for the prefix window
  // to see it, but the parenthesised list names the visits outright.
  const enumerated = enumeratedCount(text, mention);
  if (enumerated !== null && enumerated > 1) {
    return { factor: enumerated, ambiguous: false, source: 'enumerated', declined: null };
  }

  const adjacent = juxtaposedCount(ctx, mention);
  if (adjacent !== null && adjacent.linked) {
    return { factor: adjacent.value, ambiguous: false, source: 'juxtaposed', declined: null };
  }
  if (adjacent !== null && ctx.licensedCount !== null && ctx.licensedCount === adjacent.value) {
    return { factor: adjacent.value, ambiguous: false, source: 'licensed', declined: null };
  }

  const nearbyCount = countBefore(text, mention.start, 45);
  const ambiguous = nearbyCount !== null && nearbyCount > 1;
  return { factor: 1, ambiguous, source: 'none', declined: adjacent === null ? null : adjacent.value };
}

function computeHours(ctx: HoursContext): HoursResult {
  const { text, timeMentions, documentCount } = ctx;
  if (timeMentions.length === 0) {
    return { min: null, max: null, strategy: 'none', ambiguous: false, appliedCounts: [], declinedCounts: [] };
  }

  // --- Strategy 1: an explicit whole-study total wins outright. -------------
  // A trailing "total" is checked before a clause-level cue, and the order is
  // load-bearing: in "over 2 visits, each visit lasting about 3 hours (6 hours
  // total)" the whole string is one clause, so a clause-first search would
  // return the per-visit 3 instead of the stated 6.
  for (const mention of timeMentions) {
    if (/^[\s,)]*(?:hours?|hrs?)?\s*(?:in )?total\b/.test(after(text, mention.end, 20))) {
      return {
        min: mention.min,
        max: mention.max,
        strategy: 'explicit-total',
        ambiguous: false,
        appliedCounts: [],
        declinedCounts: [],
      };
    }
  }
  for (const mention of timeMentions) {
    if (TOTAL_CUE_RE.test(clauseAt(text, mention.start))) {
      return {
        min: mention.min,
        max: mention.max,
        strategy: 'explicit-total',
        ambiguous: false,
        appliedCounts: [],
        declinedCounts: [],
      };
    }
  }

  // --- Strategy 2: a leading figure followed by its own breakdown. ----------
  // "3.5 hours (in two visits; Visit 1: 2 hrs, Visit 2: 1.5 hrs)" - summing the
  // parts here would double-count the 3.5 that already covers them. This is
  // also what keeps "2 hours (in the form of two 1-hour visits)" at 2 h: where
  // a total and its components are both present, the total wins.
  const first = timeMentions[0];
  if (first !== undefined && timeMentions.length >= 2 && first.start <= 40) {
    if (BREAKDOWN_CUE_RE.test(after(text, first.end, 30))) {
      return {
        min: first.min,
        max: first.max,
        strategy: 'leading-total',
        ambiguous: false,
        appliedCounts: [],
        declinedCounts: [],
      };
    }
  }

  // --- Unquantified ongoing collection: no honest total exists. -------------
  // "several minutes each day for nine days" alongside two timed sessions.
  // Summing only the timed parts reports a fraction of the commitment as if it
  // were the whole of it, which is how #8872 came to sit at $105/hr on a
  // denominator that omitted nine days of the study. Checked AFTER the total
  // strategies so a stated whole-study figure still wins.
  if (UNQUANTIFIED_ONGOING_RE.test(text)) {
    return { min: null, max: null, strategy: 'ongoing', ambiguous: true, appliedCounts: [], declinedCounts: [] };
  }

  // --- Strategies 3-5: multiply each mention, then add them together. -------
  let min = 0;
  let max = 0;
  let anyMultiplied = false;
  let ambiguous = false;
  let counted = 0;
  const appliedCounts: number[] = [];
  const declinedCounts: number[] = [];

  for (const mention of timeMentions) {
    // "...60 minutes, except for session four, which will take 75 minutes"
    // - an exception restates part of the whole, it does not add to it.
    if (/\bexcept\b/.test(before(text, mention.start, 70))) continue;

    const multiplier = multiplierFor(ctx, mention);
    if (multiplier.factor > 1) {
      anyMultiplied = true;
      appliedCounts.push(multiplier.factor);
    }
    if (multiplier.declined !== null) declinedCounts.push(multiplier.declined);
    if (multiplier.ambiguous) ambiguous = true;
    counted += 1;

    min += mention.min * multiplier.factor;
    max += mention.max * multiplier.factor;
  }

  // "Two visits: 3 hrs and 1.5 hrs" - one duration per visit, all of them
  // enumerated. The plural count is accounted for, so it is not ambiguous.
  if (documentCount !== null && counted === documentCount) ambiguous = false;

  // The text says "each"/"per" somewhere but nothing was multiplied, so a
  // per-item figure is being reported as if it were the whole commitment.
  if (!anyMultiplied && ANY_DISTRIBUTIVE_RE.test(text.replace(/each other/g, ''))) ambiguous = true;

  if (min <= 0 && max <= 0) {
    return { min: null, max: null, strategy: 'none', ambiguous, appliedCounts, declinedCounts };
  }

  const strategy: Strategy =
    timeMentions.length === 1 ? (anyMultiplied ? 'multiplied' : 'single') : anyMultiplied ? 'multiplied' : 'summed';

  return { min, max, strategy, ambiguous, appliedCounts, declinedCounts };
}

// ---------------------------------------------------------------------------
// sessionCount
// ---------------------------------------------------------------------------

/**
 * Number of separate visits/sessions.
 *
 * Two sources, in order: explicit counts ("1 screening visit", "4 study
 * visits" -> 5, since those are distinct groups), else ordinal labels
 * ("Visit 1:", "Visit 2:", "Visit 3:" -> 3).
 */
function extractSessionCount(text: string, counts: readonly CountMention[]): number | null {
  if (counts.length > 0) {
    const total = counts.reduce((sum, c) => sum + c.value, 0);
    return total >= 1 && total <= MAX_PLAUSIBLE_SESSIONS ? total : null;
  }

  // "two separate two-hour sessions": the duration sits between the count and
  // its noun, so the primary pattern (which forbids unit words in the filler)
  // cannot see it.
  const attributive = new RegExp(
    `(\\d+)\\s+(?:\\w+\\s+){0,2}?\\d+(?:\\.\\d+)?\\s*(?:hours?|hrs?|minutes?|mins?)\\s+${SESSION_NOUN}\\b`,
  ).exec(text);
  if (attributive !== null) {
    const value = Number.parseInt(attributive[1] ?? '', 10);
    if (Number.isFinite(value) && value >= 1 && value <= MAX_PLAUSIBLE_SESSIONS) return value;
  }

  const labels = new Set<string>();
  const labelRe = /\b(visit|session|phase|appointment|part)\s*(\d+)\s*[:)]/g;
  for (let m = labelRe.exec(text); m !== null; m = labelRe.exec(text)) {
    labels.add(`${m[1]}${m[2]}`);
  }
  if (labels.size > 0) return labels.size;

  return null;
}

// ---------------------------------------------------------------------------
// spanWeeks
// ---------------------------------------------------------------------------

/**
 * Widest calendar figure in the text, in weeks.
 *
 * The maximum is the right pick because a study states its outer envelope
 * alongside inner milestones ("...within a 6 week timeframe" next to "3 study
 * days"). Contact-time units are excluded by construction: only mentions whose
 * unit is a calendar unit ever reach here.
 */
function extractSpanWeeks(mentions: Mention[]): number | null {
  let widest: number | null = null;

  for (const mention of mentions) {
    if (mention.kind !== 'calendar') continue;
    if (!Number.isFinite(mention.max) || mention.max <= 0) continue;
    if (mention.max > MAX_PLAUSIBLE_WEEKS) continue;
    if (widest === null || mention.max > widest) widest = mention.max;
  }

  return widest === null ? null : roundTo(widest, 2);
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

function scoreConfidence(
  text: string,
  hours: HoursResult,
  mentionCount: number,
  spanWeeks: number | null,
): Confidence {
  if (hours.strategy === 'none') {
    // Nothing to parse at all vs. a clean calendar-only string. The latter is
    // read correctly; it simply carries no contact time.
    return spanWeeks === null ? 'low' : 'medium';
  }

  if (hours.ambiguous) return 'low';

  // "Visits last around 1.5 hours" - a per-visit figure with no visit count.
  // Reporting 1.5 h is a floor, not the total, so it must be flagged.
  if (
    hours.strategy === 'single' &&
    /\b(?:visits|sessions|appointments)\b/.test(text) &&
    !/\b\d+\s+(?:\w+\s+){0,2}?(?:visits?|sessions?|appointments?)\b/.test(text)
  ) {
    return 'low';
  }

  switch (hours.strategy) {
    case 'explicit-total':
    case 'leading-total':
      return 'high';
    case 'single':
      return mentionCount <= 2 ? 'high' : 'medium';
    case 'multiplied':
      return 'medium';
    case 'summed':
      return mentionCount >= 5 ? 'low' : 'medium';
    default:
      return 'low';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function emptyResult(raw: string): ParsedDuration {
  return {
    totalHoursMin: null,
    totalHoursMax: null,
    sessionCount: null,
    spanWeeks: null,
    raw,
    confidence: 'low',
  };
}

/**
 * Parse a free-text duration string into structured contact time, session
 * count and calendar span.
 *
 * Contract highlights:
 *   - `totalHours*` is null unless the text states actual participant time.
 *     A calendar span alone never produces hours.
 *   - `totalHoursMin <= totalHoursMax` always; both are set or both are null.
 *   - Zero-hour and implausible readings collapse to null rather than to 0,
 *     because 0 would be read downstream as "free labour" instead of
 *     "unknown".
 *   - `raw` preserves the original input verbatim, HTML and all.
 *
 * @example
 * parseDuration('45-60 minutes')
 *   // { totalHoursMin: 0.75, totalHoursMax: 1, sessionCount: null,
 *   //   spanWeeks: null, confidence: 'high' }
 * parseDuration('Approximately 6 weeks')
 *   // { totalHoursMin: null, totalHoursMax: null, spanWeeks: 6, ... }
 * parseDuration('Two visits, each about 2 hours, completed within two weeks.')
 *   // { totalHoursMin: 4, totalHoursMax: 4, sessionCount: 2, spanWeeks: 2 }
 */
export function parseDuration(raw: string): ParsedDuration {
  return parseDurationInternal(raw, null).duration;
}

/** `parseDuration` plus the evidence a cross-field check needs. */
interface InternalResult {
  duration: ParsedDuration;
  /** Counts the parser multiplied by. */
  appliedCounts: number[];
  /** Counts it found next to a duration and declined to apply. */
  declinedCounts: number[];
  /** True when a multiplication was inferred rather than stated with "each". */
  inferred: boolean;
}

function parseDurationInternal(raw: string, licensedCount: number | null): InternalResult {
  const original = typeof raw === 'string' ? raw : '';
  const text = normalize(original);
  if (text === '') {
    return { duration: emptyResult(original), appliedCounts: [], declinedCounts: [], inferred: false };
  }

  const mentions = extractMentions(text);
  const counts = extractCounts(text);
  const sessionCount = extractSessionCount(text, counts);
  const spanWeeks = extractSpanWeeks(mentions);
  const hours = computeHours({
    text,
    counts,
    timeMentions: mentions.filter((m) => m.kind === 'time'),
    documentCount: sessionCount,
    licensedCount,
  });

  let totalHoursMin: number | null = null;
  let totalHoursMax: number | null = null;

  if (hours.min !== null && hours.max !== null) {
    const low = Math.min(hours.min, hours.max);
    const high = Math.max(hours.min, hours.max);
    // A parsed 0 means the regexes latched onto something meaningless; a
    // five-figure hour count means they latched onto a phone number. Both are
    // "unknown", and unknown must stay null.
    if (high > 0 && high <= MAX_PLAUSIBLE_HOURS) {
      totalHoursMin = roundTo(low, 4);
      totalHoursMax = roundTo(high, 4);
    }
  }

  const confidence =
    totalHoursMax === null && hours.strategy !== 'none'
      ? 'low'
      : scoreConfidence(text, hours, mentions.length, spanWeeks);

  return {
    duration: {
      totalHoursMin,
      totalHoursMax,
      sessionCount,
      spanWeeks,
      raw: original,
      confidence,
    },
    appliedCounts: hours.appliedCounts,
    declinedCounts: hours.declinedCounts,
    inferred: hours.strategy === 'multiplied',
  };
}

// ---------------------------------------------------------------------------
// Cross-field corroboration
// ---------------------------------------------------------------------------

/**
 * The slice of `ParsedCompensation` this module reads.
 *
 * Declared structurally, and only `import type` is used, so `parse-duration`
 * never depends on `parse-compensation` at runtime - there is no import cycle
 * for a bundler or for Node to resolve.
 */
export type CompensationEvidence = Readonly<
  Partial<Pick<ParsedCompensation, 'guaranteedMin' | 'guaranteedMax' | 'perVisit' | 'visitCount' | 'completionBonus'>>
>;

/**
 * How many paid visits the compensation text implies, or null.
 *
 * Two routes, strongest first:
 *
 *   1. A stated count - "$125 for each study visit (3)" -> 3.
 *   2. Arithmetic closure - #9815 states a $620 total and $100 per study
 *      visit, and 620 = 20 + 6 x 100. Only six study days makes the listing's
 *      own numbers add up, which is exactly the evidence the duration string
 *      is missing.
 *
 * A completion bonus is removed before dividing, because it is paid once
 * rather than per visit.
 */
export function impliedVisitCount(comp: CompensationEvidence | null | undefined): number | null {
  if (comp === null || comp === undefined) return null;

  const stated = comp.visitCount;
  if (typeof stated === 'number' && Number.isInteger(stated) && stated >= 1 && stated <= MAX_PLAUSIBLE_SESSIONS) {
    return stated;
  }

  const perVisit = comp.perVisit;
  const total = typeof comp.guaranteedMax === 'number' ? comp.guaranteedMax : comp.guaranteedMin;
  if (typeof perVisit !== 'number' || !Number.isFinite(perVisit) || perVisit <= 0) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;

  const bonus = typeof comp.completionBonus === 'number' && Number.isFinite(comp.completionBonus) ? comp.completionBonus : 0;
  const payable = total - bonus;
  if (payable < perVisit) return null;

  const n = Math.floor(payable / perVisit);
  return n >= 1 && n <= MAX_PLAUSIBLE_SESSIONS ? n : null;
}

/**
 * `parseDuration`, with the compensation field as a second witness.
 *
 * The duration text is still the only source of hours. Compensation can do
 * exactly two things, both of them narrow:
 *
 *   - LICENSE a multiplication this parser already found in the duration text
 *     and declined for want of clear linking words.
 *   - MOVE CONFIDENCE, up when the two fields agree on the visit count and
 *     down when an inferred multiplication contradicts a count the
 *     compensation text states outright.
 *
 * It can never invent a count that the duration string does not contain, so a
 * bad compensation parse cannot manufacture hours out of nothing.
 *
 * @example
 * // "1 screening visit (~3 hours) 3 study visit (~6 hours)" with
 * // "$50 for the screening visit and $125 for each study visit (3)":
 * parseDurationWithCompensation(duration, comp).confidence // 'high', 21 h
 */
export function parseDurationWithCompensation(
  raw: string,
  comp: CompensationEvidence | null | undefined,
): ParsedDuration {
  const first = parseDurationInternal(raw, null);
  const implied = impliedVisitCount(comp);
  if (implied === null || implied < 2) return first.duration;

  if (first.declinedCounts.includes(implied)) {
    const licensed = parseDurationInternal(raw, implied);
    if (licensed.appliedCounts.includes(implied)) {
      return { ...licensed.duration, confidence: raiseConfidence(licensed.duration.confidence) };
    }
    return first.duration;
  }

  if (first.appliedCounts.includes(implied)) {
    return { ...first.duration, confidence: raiseConfidence(first.duration.confidence) };
  }

  // The compensation states a visit count outright and it is not the count the
  // duration text was multiplied by. One of the two fields is wrong; say so.
  const statedCount = comp?.visitCount;
  if (first.inferred && typeof statedCount === 'number' && first.appliedCounts.length > 0) {
    return { ...first.duration, confidence: 'low' };
  }

  return first.duration;
}

/** One step up the ladder. 'high' is the ceiling. */
function raiseConfidence(current: Confidence): Confidence {
  return current === 'low' ? 'medium' : 'high';
}
