/**
 * DURATION PARSER TEST SUITE
 * ==========================
 *
 * The site exists to answer one question honestly: what does this study pay per
 * hour of your time? Everything downstream of `parseDuration` inherits its
 * answer, so this suite is built around the one distinction that can silently
 * destroy the product:
 *
 *   CONTACT HOURS  - time the participant actually spends in the study
 *   CALENDAR SPAN  - how long the study is strung out over
 *
 * Read "Approximately 6 weeks" as 1008 hours and a $400 study becomes $0.40/hr.
 * See `THE HEADLINE CASE` below.
 *
 * Structure:
 *   1. fixture coverage    - the table below covers EVERY distinct
 *                            aux_study_item_duration value in the 86-record
 *                            snapshot, and fails loudly when upstream adds one.
 *   2. the table           - one explicit expectation per distinct value.
 *   3. contract invariants - properties that must hold for all 71 of them.
 *   4. THE HEADLINE CASE   - study 12775, asserted on its own.
 *   5. behaviour groups    - synthetic strings probing each parsing rule.
 *
 * Tests are hermetic: they read fixtures/arv-snapshot.json and never the network.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDuration } from '@/lib/parse-duration.ts';
import type { Confidence, ParsedDuration, RawStudy } from '@/types.ts';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url)), 'utf8'),
) as RawStudy[];

/** Distinct duration strings upstream sends, each mapped to the ids carrying it. */
function distinctDurations(): Map<string, number[]> {
  const byValue = new Map<string, number[]>();
  for (const study of fixture) {
    const value = study.meta.aux_study_item_duration;
    const ids = byValue.get(value);
    if (ids === undefined) byValue.set(value, [study.id]);
    else ids.push(study.id);
  }
  return byValue;
}

/** The shape of a duration string, for grouping the table by parsing rule. */
type Family =
  | 'bare-single'
  | 'range-same-unit'
  | 'range-mixed-unit'
  | 'compound'
  | 'compound+span'
  | 'total-then-breakdown'
  | 'explicit-total'
  | 'prose-total'
  | 'itemized-additive'
  | 'distributive'
  | 'ambiguous-count'
  | 'per-visit-no-count'
  | 'calendar-only'
  | 'contact-and-span'
  | 'empty'
  | 'junk';

interface DurationCase {
  /** Fixture record ids carrying this exact string. */
  ids: number[];
  family: Family;
  raw: string;
  /** [totalHoursMin, totalHoursMax] - CONTACT time, never calendar time. */
  hours: [number | null, number | null];
  sessionCount: number | null;
  /** CALENDAR span in weeks. Independent of `hours` in both directions. */
  spanWeeks: number | null;
  confidence: Confidence;
  /** Why this expectation is what it is, when that is not obvious. */
  note?: string;
}

/**
 * Every distinct `meta.aux_study_item_duration` in the snapshot: 71 values
 * across 86 records. Expectations are explicit, not derived from the parser.
 */
const CASES: DurationCase[] = [
  {
    ids: [12780],
    family: 'bare-single',
    raw: "One-session study lasting about 2 hours",
    hours: [2, 2],
    sessionCount: 1,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [12775],
    family: 'calendar-only',
    raw: "Approximately 6 weeks",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: 6,
    confidence: 'medium',
    note: "THE HEADLINE CASE. See the dedicated describe block below: 6 calendar weeks is not 1008 contact hours, so hours stay null.",
  },
  {
    ids: [12766],
    family: 'total-then-breakdown',
    raw: "2 hours (in the form of two 1-hour visits)",
    hours: [2, 2],
    sessionCount: 2,
    spanWeeks: null,
    confidence: 'high',
    note: "The parenthetical restates the 2 hours as two 1-hour visits. Summing would give 4.",
  },
  {
    ids: [12764, 11319, 11317],
    family: 'range-same-unit',
    raw: "45-60 minutes",
    hours: [0.75, 1],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [12762],
    family: 'range-same-unit',
    raw: "7-10 minutes ",
    hours: [0.1167, 0.1667],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "Trailing whitespace.",
  },
  {
    ids: [11901],
    family: 'range-same-unit',
    raw: "20-30 minutes",
    hours: [0.3333, 0.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [11899],
    family: 'total-then-breakdown',
    raw: "55 minutes across two lab visits (35 minutes for visit 1; 20 minutes for visit 2). ",
    hours: [0.9167, 0.9167],
    sessionCount: 2,
    spanWeeks: null,
    confidence: 'high',
    note: "55 min is the whole; the two bracketed visits (35 + 20) restate it, they do not add to it.",
  },
  {
    ids: [11896, 11324],
    family: 'explicit-total',
    raw: "3 visits, 5 hours total",
    hours: [5, 5],
    sessionCount: 3,
    spanWeeks: null,
    confidence: 'high',
    note: "Paired with \"$20/ hr\" this is the converse-of-the-headline case asserted in effective-rate.test.ts.",
  },
  {
    ids: [11321, 8876],
    family: 'calendar-only',
    raw: "Participants will complete 24 visits. These visits will be once per week over the course of 6 months. ",
    hours: [null, null],
    sessionCount: 24,
    spanWeeks: 26.09,
    confidence: 'medium',
    note: "24 visits over 6 months states cadence, never contact time. spanWeeks 26.09 = 6 * 4.348.",
  },
  {
    ids: [11315],
    family: 'bare-single',
    raw: "20 mins ",
    hours: [0.3333, 0.3333],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "\"mins\" abbreviation.",
  },
  {
    ids: [11077],
    family: 'bare-single',
    raw: "75 minutes ",
    hours: [1.25, 1.25],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [11075],
    family: 'compound+span',
    raw: "Completing this three-part study takes approximately 2 hours and 30 minutes over the course of 28 days. <br> <br>You will complete the first session that takes approximately 1 hour and 30 minutes. <br> <br>14 days after the first session, you will complete the second session that takes approximately 30 minutes. <br> <br>28 days after the first session, you will complete the third session that takes approximately 30 minutes.",
    hours: [2.5, 2.5],
    sessionCount: 3,
    spanWeeks: 4,
    confidence: 'high',
    note: "\"2 hours and 30 minutes\" merges to 2.5; the three per-session figures that follow are a breakdown, not an addition. 28 days = 4 weeks of calendar span.",
  },
  {
    ids: [11072],
    family: 'explicit-total',
    raw: "Workshops are between 1 hour to 3 hours duration across several weeks. Total time if participate in all, including focus group and interview, is approximately 18 hours.",
    hours: [18, 18],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "The 1-3 hour per-workshop range is superseded by the stated 18-hour total. \"several weeks\" carries no number, so spanWeeks stays null.",
  },
  {
    ids: [10351],
    family: 'bare-single',
    raw: "~30minutes",
    hours: [0.5, 0.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "Tilde plus digit fused to unit: \"~30minutes\".",
  },
  {
    ids: [10128],
    family: 'junk',
    raw: "Prepaid movie ticket (Cinemark)",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'low',
    note: "A compensation string sitting in the duration field. Nothing parses; everything is null and confidence is low.",
  },
  {
    ids: [10126, 7784],
    family: 'bare-single',
    raw: "30 minutes",
    hours: [0.5, 0.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [9959],
    family: 'range-same-unit',
    raw: "The entire session should take about 60–90 minutes.",
    hours: [1, 1.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "En dash, and \"entire session\" is a total cue.",
  },
  {
    ids: [9957, 4591],
    family: 'bare-single',
    raw: "1 hour",
    hours: [1, 1],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [9953],
    family: 'range-same-unit',
    raw: "1-1.5 Hours",
    hours: [1, 1.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "Mixed case unit.",
  },
  {
    ids: [9821],
    family: 'itemized-additive',
    raw: "Visit 1: 1.5 hours<br>Visit 2: 1 hour<br>Visit 3: 1.5 hours",
    hours: [4, 4],
    sessionCount: 3,
    spanWeeks: null,
    confidence: 'medium',
    note: "<br> is rewritten to a clause boundary before stripHtml, otherwise the three visits fuse into one mention.",
  },
  {
    ids: [9815],
    family: 'distributive',
    raw: "The study involves 1 screening visit lasting up to 2 hours followed by 6 study days lasting up to 7 hours that can be completed within 4 weeks.",
    hours: [44, 44],
    sessionCount: 7,
    spanWeeks: 4,
    confidence: 'medium',
    note: "FIXED (audit F1): 2 + 6 x 7 = 44. \"6 study days lasting up to 7 hours\" is a count juxtaposed with a per-visit duration, so the 7 hours distributes. The old 9 h read this study at $68.89/hr when it is $14.09/hr - see the F1 regression block below.",
  },
  {
    ids: [9028, 8908],
    family: 'range-same-unit',
    raw: "40–60 minutes",
    hours: [0.6667, 1],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "En dash.",
  },
  {
    ids: [8903, 8411],
    family: 'bare-single',
    raw: "2 hours",
    hours: [2, 2],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [8898, 6753],
    family: 'range-same-unit',
    raw: "Participants will need to spend about 20-30 minutes completing the survey.",
    hours: [0.3333, 0.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "Range embedded in prose.",
  },
  {
    ids: [8882],
    family: 'itemized-additive',
    raw: "Two visits: 3 hrs and 1.5 hrs",
    hours: [4.5, 4.5],
    sessionCount: 2,
    spanWeeks: null,
    confidence: 'medium',
    note: "Two visits, both enumerated, so the count is accounted for and 3 + 1.5 is the real total.",
  },
  {
    ids: [8874],
    family: 'distributive',
    raw: "Two visits, each about 2 hours, completed within two weeks.",
    hours: [4, 4],
    sessionCount: 2,
    spanWeeks: 2,
    confidence: 'medium',
    note: "\"each about 2 hours\" x 2 visits = 4 h contact, and separately 2 weeks of calendar span.",
  },
  {
    ids: [8872],
    family: 'itemized-additive',
    raw: "Each interview: 45 minutes to 1 hour<br>Each survey: 20 minutes<br>Smartphone-based data collection: several minutes each day for nine days",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: 1.29,
    confidence: 'low',
    note: "FIXED (audit F5): the string quantifies two of its three components and leaves the third (\"several minutes each day for nine days\") unquantified. Totalling only the two that parse produced 1.08-1.33 h, which - against a $140 numerator whose $100 buys the nine days of smartphone collection - ranked this study #2 on the whole board at $105/hr. An unquantified ongoing component now makes the total UNKNOWABLE, so hours are null and the study is unrankable. Nine days still becomes 1.29 weeks of span.",
  },
  {
    ids: [8458],
    family: 'distributive',
    raw: "This study will include 1 screening visit (~3 hours) 3 study visit (~6 hours). Participants are anticipated to finish all study visits within a 6 week timeframe.",
    hours: [21, 21],
    sessionCount: 4,
    spanWeeks: 6,
    confidence: 'medium',
    note: "FIXED (audit F1): 3 + 3 x 6 = 21. The old literal 3 + 6 = 9 shipped $47.22/hr for a study that pays $20.24/hr; the compensation string on the same record (\"$125 for each study visit (3). Total $425\") settles the count at three.",
  },
  {
    ids: [8420],
    family: 'distributive',
    raw: "Two total visits within 3 weeks of each other. Each visit will last about one hour.",
    hours: [2, 2],
    sessionCount: 2,
    spanWeeks: 3,
    confidence: 'medium',
    note: "\"within 3 weeks of each other\" must not be read as distributive - \"each other\" is stripped before the check.",
  },
  {
    ids: [8417],
    family: 'range-same-unit',
    raw: "Approximately 10-15 minutes",
    hours: [0.1667, 0.25],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [8408, 8399],
    family: 'bare-single',
    raw: "1.5 hrs",
    hours: [1.5, 1.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [8406],
    family: 'total-then-breakdown',
    raw: "3.5 hours (in two visits; Visit 1: 2 hrs, Visit 2: 1.5 hrs)",
    hours: [3.5, 3.5],
    sessionCount: 2,
    spanWeeks: null,
    confidence: 'high',
    note: "Leading 3.5 h followed by its own per-visit breakdown; summing would give 7.",
  },
  {
    ids: [8404],
    family: 'calendar-only',
    raw: "Approximately 3 weeks",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: 3,
    confidence: 'medium',
  },
  {
    ids: [8402],
    family: 'compound',
    raw: "75 minutes (1 hour 15 minutes)",
    hours: [1.25, 1.25],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "Parenthetical restatement of the same 75 minutes. Must not become 2.5 h.",
  },
  {
    ids: [8338],
    family: 'itemized-additive',
    raw: "This study will be conducted over four separate sessions on different days, spanning approximately a month and a half. Participation for each session is expected to last around 60 minutes, except for session four, which will take approximately 75 minutes.",
    hours: [4, 4],
    sessionCount: 4,
    spanWeeks: 6.52,
    confidence: 'medium',
    note: "The \"except for session four ... 75 minutes\" clause is skipped as a restatement, so the result is 4 x 60 min rather than 3 x 60 + 75 (4.25 h). \"a month and a half\" = 1.5 months = 6.52 weeks.",
  },
  {
    ids: [8333],
    family: 'calendar-only',
    raw: "One Month",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: 4.35,
    confidence: 'medium',
    note: "\"One Month\" - word number plus calendar unit, 4.348 weeks.",
  },
  {
    ids: [8331],
    family: 'range-same-unit',
    raw: "40-50 minutes",
    hours: [0.6667, 0.8333],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [7773],
    family: 'bare-single',
    raw: "One session lasting approximately two hours",
    hours: [2, 2],
    sessionCount: 1,
    spanWeeks: null,
    confidence: 'high',
    note: "Word number \"two hours\".",
  },
  {
    ids: [7660],
    family: 'itemized-additive',
    raw: "1 hr lab visit followed by a 1.5-2hr imaging session (scheduled on different days)",
    hours: [2.5, 3],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'medium',
    note: "\"1 hr lab visit\" must not be read as a session count of 1 with a unit word in the filler; \"1.5-2hr\" has the digit fused to the unit.",
  },
  {
    ids: [7003],
    family: 'distributive',
    raw: "1 Baseline Assessment 1 – 2 hours8 Interventions – 1 – 2 hours per Intervention (over the course of a 4 weeks)",
    hours: [9, 18],
    sessionCount: 9,
    spanWeeks: 4,
    confidence: 'medium',
    note: "\"2 hours8 Interventions\" - unit fused to the next count. 1-2 h baseline + 8 x (1-2 h) = 9-18 h.",
  },
  {
    ids: [6997, 6990, 4607],
    family: 'empty',
    raw: "",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'low',
    note: "Three records have an empty duration meta value.",
  },
  {
    ids: [6995],
    family: 'distributive',
    raw: "Two separate two-hour sessions conducted on separate days within one week",
    hours: [4, 4],
    sessionCount: 2,
    spanWeeks: 1,
    confidence: 'medium',
    note: "Attributive form: the count and the noun straddle the duration (\"two separate two-hour sessions\").",
  },
  {
    ids: [6987],
    family: 'distributive',
    raw: "30 minute pre-study and baseline appointment; 2 week intervention with three Neurotracker sessions at each appointment (0, 1, 4, 7, and 14), lasting approximately 1 hour. ",
    hours: [5.5, 5.5],
    sessionCount: 3,
    spanWeeks: 2,
    confidence: 'medium',
    note: "FIXED (audit F1): \"each appointment (0, 1, 4, 7, and 14)\" enumerates five appointments, so 0.5 + 5 x 1 = 5.5 h, not the old 0.5 + 1 = 1.5 h that shipped $40.00/hr. sessionCount stays 3 - it counts \"three Neurotracker sessions\", a different thing from the appointment count. DELIBERATE DEVIATION FROM THE AUDIT: the audit targets 5 h ($12.00/hr), read from content.rendered (\"two 30-minute appointments and four hour-long appointments\"), which folds the 30-minute baseline into the day-0 appointment. parseDuration never reads content.rendered; from the duration field alone 5.5 h is the honest read. The 0.5 h gap UNDERstates the rate ($10.91 vs $12.00) - the safe direction - and both readings put the study in the ok bucket and off the top 10.",
  },
  {
    ids: [6980],
    family: 'contact-and-span',
    raw: "12.5 hours over a 3-week period",
    hours: [12.5, 12.5],
    sessionCount: null,
    spanWeeks: 3,
    confidence: 'high',
    note: "Both stated: 12.5 contact hours AND a 3-week calendar span. The pair that proves spans and hours are tracked separately.",
  },
  {
    ids: [6978, 6976],
    family: 'range-same-unit',
    raw: "10-15 minutes",
    hours: [0.1667, 0.25],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [6974],
    family: 'range-same-unit',
    raw: "10-15 minutes ",
    hours: [0.1667, 0.25],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "Same as 6978/6976 but with a trailing space - a distinct raw value upstream.",
  },
  {
    ids: [6971],
    family: 'bare-single',
    raw: "15 minutes following arrival at the data collection site, either AGLS building or Zachry Building on the Texas A&amp;M College Station Campus",
    hours: [0.25, 0.25],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "Contains the \"&amp;\" entity from \"Texas A&amp;M\"; entity decoding must not disturb the leading 15 minutes.",
  },
  {
    ids: [6969],
    family: 'bare-single',
    raw: "1 hr",
    hours: [1, 1],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [6960, 6747],
    family: 'bare-single',
    raw: "60 minutes",
    hours: [1, 1],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [6956],
    family: 'range-same-unit',
    raw: "1-1.5hours",
    hours: [1, 1.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "No space anywhere: \"1-1.5hours\".",
  },
  {
    ids: [6953],
    family: 'calendar-only',
    raw: "30 days",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: 4.29,
    confidence: 'medium',
    note: "30 days = 4.29 weeks. Days are calendar units, never contact hours.",
  },
  {
    ids: [6950],
    family: 'itemized-additive',
    raw: "Session 1: 60 minutes Session 2: 60 minutes",
    hours: [2, 2],
    sessionCount: 2,
    spanWeeks: null,
    confidence: 'medium',
  },
  {
    ids: [6944],
    family: 'itemized-additive',
    raw: "Screening Visit (~2hrs), Metabolic Study Day (~4hrs), Functional Measurement Study Day (~4hrs)",
    hours: [10, 10],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'medium',
    note: "Three labelled visits with fused \"2hrs\"/\"4hrs\"; no numeric count, so sessionCount stays null.",
  },
  {
    ids: [6942],
    family: 'range-same-unit',
    raw: "1-1.5 hours",
    hours: [1, 1.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [6750],
    family: 'bare-single',
    raw: "One session lasting approximately an hour",
    hours: [1, 1],
    sessionCount: 1,
    spanWeeks: null,
    confidence: 'high',
    note: "\"an hour\" normalizes to 1 hour.",
  },
  {
    ids: [6745],
    family: 'prose-total',
    raw: "Total participation is approximately 12 hours. Your participation in this study today will consist of 1 2-2.5 hour laboratory visits in addition to the EMA portion at the end. The clinical interview will take 1-2.5 hours. The EEG appointment will take 2- 2.5 hours. The following EMA portion will require a time commitment of 5 hours over the course of 14 days (approx. 20 minutes per day).",
    hours: [12, 12],
    sessionCount: null,
    spanWeeks: 2,
    confidence: 'high',
    note: "Prose. The stated 12-hour total wins over every component figure in the paragraph; 14 days becomes 2 weeks of span.",
  },
  {
    ids: [5945],
    family: 'bare-single',
    raw: "12 hours",
    hours: [12, 12],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [5701],
    family: 'bare-single',
    raw: "One session, lasting approximately 4 hours",
    hours: [4, 4],
    sessionCount: 1,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [5436],
    family: 'explicit-total',
    raw: "The study will take place over 2 visits, each visit lasting about 3 hours (6 hours total)",
    hours: [6, 6],
    sessionCount: 2,
    spanWeeks: null,
    confidence: 'high',
    note: "A trailing \"(6 hours total)\" beats the distributive \"each visit lasting about 3 hours\" - order of strategies is load-bearing here.",
  },
  {
    ids: [4642],
    family: 'calendar-only',
    raw: "Total 6 months; 13 days total Pre-study appointment, baseline appointments, 3-month appointments and 6-month-appointments (3 days each totaling 9 days), 3 days to pick up supplements",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: 26.09,
    confidence: 'medium',
    note: "Every number in this string is a count of DAYS or MONTHS, never hours, so contact time is honestly unknown.",
  },
  {
    ids: [4636],
    family: 'range-same-unit',
    raw: "3-3.5 hr",
    hours: [3, 3.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
  },
  {
    ids: [4634],
    family: 'itemized-additive',
    raw: "First Phase: 30-45 minutes Second Phase: Approximately 1.5 hours",
    hours: [2, 2.25],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'medium',
    note: "30-45 min + 1.5 h = 2-2.25 h.",
  },
  {
    ids: [4632],
    family: 'prose-total',
    raw: "Duration of study involvement will range from three to 25 hours spanning anywhere from one day to two-weeks of participation. The time commitment for participating will depend on the study group to a which the participant belongs. A detailed breakdown of time requirements by group can be found below: Baseline control group: 3 hrs in-person, plus 1 hr online follow up assessment Inactive control group: 6 hrs in person, plus 1 hr online follow up assessment In-person intervention &amp; active control groups: 8 hrs in-person, 6 to 16 hours in between visits completing study activities, plus 1 hr online follow up assessment",
    hours: [3, 25],
    sessionCount: null,
    spanWeeks: 2,
    confidence: 'high',
    note: "\"three to 25 hours\" - word number, \"to\" range, and a \"study involvement\" total cue. The per-group breakdown that follows must not be added.",
  },
  {
    ids: [4630],
    family: 'calendar-only',
    raw: "270 days",
    hours: [null, null],
    sessionCount: null,
    spanWeeks: 38.57,
    confidence: 'medium',
    note: "270 days = 38.57 weeks.",
  },
  {
    ids: [4626, 4624],
    family: 'prose-total',
    raw: "Total participation is approximately 17.5 hours. Your participation in this study today will consist of three 2-2.5 hour laboratory visits in addition to the EMA portion in between the visits. The first clinical interview will take 1-2.5 hours. The first EEG appointment will take 2- 2.5 hours. The following EMA portion will require a time commitment of 10 hours over the course of 28 days (approx.. 20 minutes per day). The post-study appointment will take 2-2.5 hours.",
    hours: [17.5, 17.5],
    sessionCount: null,
    spanWeeks: 4,
    confidence: 'high',
    note: "The stated 17.5-hour total wins over the component figures; 28 days = 4 weeks.",
  },
  {
    ids: [4620],
    family: 'per-visit-no-count',
    raw: "Visits last around 1.5 hours",
    hours: [1.5, 1.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'low',
    note: "A per-visit figure with no visit count is a FLOOR, not a total, so confidence is low even though the number parses cleanly.",
  },
  {
    ids: [4618],
    family: 'per-visit-no-count',
    raw: "Visits last around 3-3.5 hours",
    hours: [3, 3.5],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'low',
    note: "Same shape as 4620 with a range.",
  },
  {
    ids: [4615],
    family: 'range-mixed-unit',
    raw: "30 minutes – 2 hours (depending on the specific experiment)",
    hours: [0.5, 2],
    sessionCount: null,
    spanWeeks: null,
    confidence: 'high',
    note: "En dash across units: 30 minutes to 2 hours.",
  },
  {
    ids: [4613],
    family: 'distributive',
    raw: "This study will include 1 screening visit (~3 hours) and a maximum of 4 study visits (~6 hours).",
    hours: [27, 27],
    sessionCount: 5,
    spanWeeks: null,
    confidence: 'medium',
    note: "FIXED (audit F1): 3 + 4 x 6 = 27. The old literal 3 + 6 = 9 shipped $46.67/hr for a study that pays $15.56/hr; the compensation ($20 screening + $100 per study visit, total $420) closes only at four study visits.",
  },
  {
    ids: [4611],
    family: 'contact-and-span',
    raw: "1 screening visit ~ 2hours 4 study visits ~14 hours All visits must be completed within 6 weeks",
    hours: [58, 58],
    sessionCount: 5,
    spanWeeks: 6,
    confidence: 'medium',
    note: "FIXED (audit F1): 2 + 4 x 14 = 58, plus a separate 6-week completion window. The old expectation asserted the opposite (\"must NOT multiply\") and shipped 16 h / $51.25/hr for a study that pays $14.14/hr. The compensation ($20 screening + $200/study day = $820) proves four study days, and $200 / 14 h = $14.29/hr independently confirms the 14-hours-each reading.",
  },
  {
    ids: [4593],
    family: 'distributive',
    raw: "Baseline assessment (3 hours) 12 treatment sessions (1.5 hours each) 3 follow up visits (2 hours each)",
    hours: [27, 27],
    sessionCount: 15,
    spanWeeks: null,
    confidence: 'medium',
    note: "3 + 12 x 1.5 + 3 x 2 = 27 h. The clearest distributive case in the fixture.",
  },];

// ---------------------------------------------------------------------------
// 1. Fixture coverage
// ---------------------------------------------------------------------------

describe('fixture coverage', () => {
  it('the snapshot still holds all 86 records', () => {
    expect(fixture).toHaveLength(86);
  });

  it('the table covers every distinct duration value in the fixture, and no others', () => {
    const inFixture = [...distinctDurations().keys()].sort();
    const inTable = CASES.map((c) => c.raw).sort();
    // A new upstream duration format must fail here rather than be parsed silently.
    expect(inTable).toEqual(inFixture);
    expect(CASES).toHaveLength(71);
  });

  it('maps each value to exactly the record ids that carry it', () => {
    const inFixture = distinctDurations();
    for (const c of CASES) {
      expect(inFixture.get(c.raw), `ids for ${JSON.stringify(c.raw)}`).toEqual(c.ids);
    }
  });

  it('accounts for all 86 records across the table', () => {
    expect(CASES.reduce((total, c) => total + c.ids.length, 0)).toBe(86);
  });

  it('has 3 records with an empty duration string', () => {
    expect(CASES.filter((c) => c.raw.trim() === '').flatMap((c) => c.ids)).toHaveLength(3);
  });

  // 73/9/4, not the former 74/8/4: record 8872 moved from "contact hours" to
  // "calendar-span-only" when its unquantified nine-day smartphone component
  // made the total unknowable (audit F5).
  it('yields contact hours for 73 records, calendar-span-only for 9, and nothing for 4', () => {
    let withHours = 0;
    let spanOnly = 0;
    let nothing = 0;
    for (const c of CASES) {
      if (c.hours[1] !== null) withHours += c.ids.length;
      else if (c.spanWeeks !== null) spanOnly += c.ids.length;
      else nothing += c.ids.length;
    }
    expect({ withHours, spanOnly, nothing }).toEqual({ withHours: 73, spanOnly: 9, nothing: 4 });
  });
});

// ---------------------------------------------------------------------------
// 2. The table
// ---------------------------------------------------------------------------

describe('parseDuration - every distinct fixture value', () => {
  for (const c of CASES) {
    const label = `[${c.family}] ${JSON.stringify(c.raw.length > 72 ? `${c.raw.slice(0, 72)}...` : c.raw)}`;
    it(label, () => {
      const got = parseDuration(c.raw);
      expect(
        {
          hours: [got.totalHoursMin, got.totalHoursMax],
          sessionCount: got.sessionCount,
          spanWeeks: got.spanWeeks,
          confidence: got.confidence,
        },
        c.note ?? `ids ${c.ids.join(', ')}`,
      ).toEqual({
        hours: c.hours,
        sessionCount: c.sessionCount,
        spanWeeks: c.spanWeeks,
        confidence: c.confidence,
      });
      // `raw` is the UI's fallback: it must survive verbatim, HTML and all.
      expect(got.raw).toBe(c.raw);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Contract invariants
// ---------------------------------------------------------------------------

describe('contract invariants across every fixture duration', () => {
  const parsedAll: { raw: string; parsed: ParsedDuration }[] = CASES.map((c) => ({
    raw: c.raw,
    parsed: parseDuration(c.raw),
  }));

  it('sets totalHoursMin and totalHoursMax together, or neither', () => {
    for (const { raw, parsed } of parsedAll) {
      expect(parsed.totalHoursMin === null, raw).toBe(parsed.totalHoursMax === null);
    }
  });

  it('never emits hours that are zero, negative, NaN or Infinite - unknown is null', () => {
    for (const { raw, parsed } of parsedAll) {
      for (const value of [parsed.totalHoursMin, parsed.totalHoursMax]) {
        if (value === null) continue;
        expect(Number.isFinite(value), raw).toBe(true);
        expect(value, raw).toBeGreaterThan(0);
      }
    }
  });

  it('keeps totalHoursMin <= totalHoursMax', () => {
    for (const { raw, parsed } of parsedAll) {
      if (parsed.totalHoursMin === null || parsed.totalHoursMax === null) continue;
      expect(parsed.totalHoursMin, raw).toBeLessThanOrEqual(parsed.totalHoursMax);
    }
  });

  it('emits a positive finite spanWeeks or null', () => {
    for (const { raw, parsed } of parsedAll) {
      if (parsed.spanWeeks === null) continue;
      expect(Number.isFinite(parsed.spanWeeks), raw).toBe(true);
      expect(parsed.spanWeeks, raw).toBeGreaterThan(0);
    }
  });

  it('emits a whole sessionCount of at least 1, or null', () => {
    for (const { raw, parsed } of parsedAll) {
      if (parsed.sessionCount === null) continue;
      expect(Number.isInteger(parsed.sessionCount), raw).toBe(true);
      expect(parsed.sessionCount, raw).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps every total commitment inside a plausible range for a study', () => {
    for (const { raw, parsed } of parsedAll) {
      if (parsed.totalHoursMax !== null) expect(parsed.totalHoursMax, raw).toBeLessThanOrEqual(2000);
      if (parsed.spanWeeks !== null) expect(parsed.spanWeeks, raw).toBeLessThanOrEqual(520);
    }
  });

  it('always reports one of the three confidence levels', () => {
    for (const { raw, parsed } of parsedAll) {
      expect(['high', 'medium', 'low'], raw).toContain(parsed.confidence);
    }
  });

  it('flags low confidence whenever hours could not be read at all from non-empty text', () => {
    // A string with no contact hours is only 'medium' when it is a clean
    // CALENDAR-ONLY string - "Approximately 6 weeks" states a span honestly and
    // completely, and the absence of hours is the source's, not the parser's.
    //
    // The old form of this test used `spanWeeks !== null` as the proxy for
    // "calendar-only". That proxy was WRONG, and record 8872 is the proof: its
    // string quantifies two components and leaves a third ("several minutes
    // each day for nine days") unquantified, so it has BOTH a span (1.29 w) and
    // contact time the parser cannot total. That is exactly a 'low' - the
    // string is about hours and the parser failed to read them - but the proxy
    // demanded 'medium'. Keying off the case family instead states the real
    // rule: span-without-hours is only confident when hours were never claimed.
    for (const c of CASES) {
      const parsed = parseDuration(c.raw);
      if (parsed.totalHoursMax !== null) continue;
      const expected = c.family === 'calendar-only' ? 'medium' : 'low';
      expect(parsed.confidence, c.raw).toBe(expected);
    }
  });

  it('is pure - parsing the same string twice gives the same answer', () => {
    for (const { raw, parsed } of parsedAll) {
      expect(parseDuration(raw)).toEqual(parsed);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE HEADLINE CASE
// ---------------------------------------------------------------------------

describe('THE HEADLINE CASE: study 12775, gallotannins x intestinal microbiome', () => {
  const study = fixture.find((s) => s.id === 12775);

  it('is still in the fixture with the string this whole site was built around', () => {
    expect(study).toBeDefined();
    expect(study?.meta.aux_study_item_compensation).toBe('$400.00');
    expect(study?.meta.aux_study_item_duration).toBe('Approximately 6 weeks');
  });

  /**
   * THIS IS THE BUG THE SITE EXISTS TO PREVENT.
   *
   * "Approximately 6 weeks" is a CALENDAR SPAN. It says how long the study runs
   * for, not how many hours the participant sits in a lab. A parser that treats
   * a span as contact time computes 6 * 7 * 24 = 1008 hours and reports
   *
   *     $400.00 / 1008 h = $0.40/hr
   *
   * which is a fabricated number: it would rank a $400 study below a $10 survey
   * and tell a student that the best-paying study on the board is worth 40
   * cents an hour. Even the gentler mistakes - 6 weeks of 40-hour weeks (240 h,
   * $1.67/hr) or 6 weeks of 8-hour days (336 h, $1.19/hr) - are inventions; the
   * listing simply never states contact time.
   *
   * The honest answer is "we do not know", represented as null all the way
   * through to the UI's "unknown rate" bucket. A visible "unknown" is a prompt
   * to email the coordinator. A confident $0.40/hr is a lie.
   */
  it('reports a 6-week calendar span with NO contact hours, so no hourly rate can be faked', () => {
    const parsed = parseDuration('Approximately 6 weeks');

    expect(parsed.spanWeeks).toBe(6);
    expect(parsed.totalHoursMin).toBeNull();
    expect(parsed.totalHoursMax).toBeNull();

    // The three numbers a naive parser would have produced, none of which may
    // ever appear as hours for this study.
    expect(parsed.totalHoursMax).not.toBe(1008); // 6 weeks of wall-clock time
    expect(parsed.totalHoursMax).not.toBe(336); // 6 weeks of 8-hour days
    expect(parsed.totalHoursMax).not.toBe(240); // 6 weeks of 40-hour weeks
    // ...and it is not silently zero either, which would divide to Infinity.
    expect(parsed.totalHoursMax).not.toBe(0);
  });

  it('parses the calendar span cleanly - the string is understood, it just has no hours in it', () => {
    // 'medium', not 'low': nothing failed here. The string was read correctly
    // and correctly found to contain no contact time.
    expect(parseDuration('Approximately 6 weeks').confidence).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// 5. Behaviour groups
// ---------------------------------------------------------------------------

describe('calendar spans never become contact hours', () => {
  const spanOnly: [string, number][] = [
    ['Approximately 6 weeks', 6],
    ['Approximately 3 weeks', 3],
    ['One Month', 4.35],
    ['30 days', 4.29],
    ['270 days', 38.57],
    ['2 years', 104.36],
    ['a 6 month program', 26.09],
  ];

  for (const [raw, weeks] of spanOnly) {
    it(`${JSON.stringify(raw)} -> spanWeeks ${weeks}, hours null`, () => {
      const parsed = parseDuration(raw);
      expect(parsed.spanWeeks).toBe(weeks);
      expect(parsed.totalHoursMax).toBeNull();
      expect(parsed.totalHoursMin).toBeNull();
    });
  }

  it('keeps hours and span independent when a listing states both', () => {
    // The pair that proves the two fields are genuinely separate axes.
    const both = parseDuration('12.5 hours over a 3-week period');
    expect(both.totalHoursMax).toBe(12.5);
    expect(both.spanWeeks).toBe(3);

    const spanOnlyCase = parseDuration('Approximately 6 weeks');
    expect(spanOnlyCase.totalHoursMax).toBeNull();
    expect(spanOnlyCase.spanWeeks).toBe(6);
  });

  it('does not let a weekly cadence imply contact time', () => {
    const parsed = parseDuration(
      'Participants will complete 24 visits. These visits will be once per week over the course of 6 months. ',
    );
    expect(parsed.sessionCount).toBe(24);
    expect(parsed.spanWeeks).toBeCloseTo(26.09, 2);
    // 24 visits of unstated length is unknown hours, not zero and not a guess.
    expect(parsed.totalHoursMax).toBeNull();
  });
});

describe('ranges', () => {
  it('reads a same-unit range as [min, max]', () => {
    expect(parseDuration('45-60 minutes')).toMatchObject({ totalHoursMin: 0.75, totalHoursMax: 1 });
    expect(parseDuration('1-1.5 Hours')).toMatchObject({ totalHoursMin: 1, totalHoursMax: 1.5 });
    expect(parseDuration('3-3.5 hr')).toMatchObject({ totalHoursMin: 3, totalHoursMax: 3.5 });
  });

  it('reads a range whose two halves use different units', () => {
    expect(parseDuration('30 minutes – 2 hours (depending on the specific experiment)')).toMatchObject({
      totalHoursMin: 0.5,
      totalHoursMax: 2,
    });
    expect(parseDuration('45 minutes to 1 hour')).toMatchObject({
      totalHoursMin: 0.75,
      totalHoursMax: 1,
    });
  });

  it('accepts every dash variant the fixture and its neighbours use', () => {
    // hyphen, non-breaking hyphen, en dash, em dash, minus sign
    for (const dash of ['-', '‑', '–', '—', '−']) {
      expect(parseDuration(`45${dash}60 minutes`), dash).toMatchObject({
        totalHoursMin: 0.75,
        totalHoursMax: 1,
      });
    }
  });

  it('reads a word-number range joined by "to"', () => {
    expect(parseDuration('three to 25 hours')).toMatchObject({ totalHoursMin: 3, totalHoursMax: 25 });
  });
});

describe('compounds and restatements are never double-counted', () => {
  it('adds an hours+minutes compound once', () => {
    expect(parseDuration('1 hour 15 minutes').totalHoursMax).toBe(1.25);
    expect(parseDuration('2 hours and 30 minutes').totalHoursMax).toBe(2.5);
  });

  it('does not double a parenthetical restatement of the same duration', () => {
    // 75 minutes IS 1 hour 15 minutes. Reading 2.5 h would halve the rate.
    expect(parseDuration('75 minutes (1 hour 15 minutes)').totalHoursMax).toBe(1.25);
    expect(parseDuration('2 hours (in the form of two 1-hour visits)').totalHoursMax).toBe(2);
  });

  it('does not add a per-visit breakdown to the total it breaks down', () => {
    expect(parseDuration('3.5 hours (in two visits; Visit 1: 2 hrs, Visit 2: 1.5 hrs)').totalHoursMax).toBe(3.5);
    expect(
      parseDuration('55 minutes across two lab visits (35 minutes for visit 1; 20 minutes for visit 2). ')
        .totalHoursMax,
    ).toBeCloseTo(0.9167, 4);
  });

  it('normalizes fractional idioms', () => {
    expect(parseDuration('half an hour').totalHoursMax).toBe(0.5);
    expect(parseDuration('an hour and a half').totalHoursMax).toBe(1.5);
    expect(parseDuration('one and a half hours').totalHoursMax).toBe(1.5);
  });
});

describe('explicit totals beat every component figure', () => {
  it('honours a trailing "total"', () => {
    expect(parseDuration('3 visits, 5 hours total').totalHoursMax).toBe(5);
    // The distributive "each visit lasting about 3 hours" would give 6 anyway,
    // but the stated total is what makes it authoritative rather than lucky.
    expect(
      parseDuration('The study will take place over 2 visits, each visit lasting about 3 hours (6 hours total)'),
    ).toMatchObject({ totalHoursMax: 6, confidence: 'high' });
  });

  it('honours a stated total buried in prose', () => {
    expect(
      parseDuration(
        'Workshops are between 1 hour to 3 hours duration across several weeks. Total time if participate in all, including focus group and interview, is approximately 18 hours.',
      ),
    ).toMatchObject({ totalHoursMax: 18, confidence: 'high' });
  });
});

describe('per-session counts multiply only on explicit distributive evidence', () => {
  it('multiplies on a trailing "each"', () => {
    expect(parseDuration('12 treatment sessions (1.5 hours each)').totalHoursMax).toBe(18);
    expect(
      parseDuration('Baseline assessment (3 hours) 12 treatment sessions (1.5 hours each) 3 follow up visits (2 hours each)')
        .totalHoursMax,
    ).toBe(27);
  });

  it('multiplies on a leading "each"', () => {
    expect(parseDuration('Two visits, each about 2 hours, completed within two weeks.')).toMatchObject({
      totalHoursMax: 4,
      sessionCount: 2,
      spanWeeks: 2,
    });
  });

  it('multiplies on the attributive form, where count and noun straddle the duration', () => {
    expect(parseDuration('Two separate two-hour sessions conducted on separate days within one week')).toMatchObject({
      totalHoursMax: 4,
      sessionCount: 2,
      spanWeeks: 1,
    });
    expect(parseDuration('Two 2-hour sessions within one week').totalHoursMax).toBe(4);
  });

  it('multiplies on "per <noun>"', () => {
    expect(
      parseDuration('1 Baseline Assessment 1 – 2 hours8 Interventions – 1 – 2 hours per Intervention (over the course of a 4 weeks)'),
    ).toMatchObject({ totalHoursMin: 9, totalHoursMax: 18 });
  });

  it('multiplies a count juxtaposed with a per-visit duration', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and that assertion was audit
    // finding F1 in miniature. "3 study visits (~6 hours)" was read as a
    // literal 6 h "because the source never said each", which sounds cautious
    // and is not: on the five real records carrying this template it inflated
    // the advertised rate by 2.3x to 4.9x, because the pay side of the listing
    // is for ALL the visits while the hours side was for one. Reading 6 h as
    // the whole commitment is not the humble choice, it is a claim - and it is
    // the claim that costs the reader a wasted trip.
    //
    // The rule now: when a count and a duration are juxtaposed with nothing
    // between them but linking words, the duration distributes over the count.
    expect(parseDuration('3 study visits (~6 hours)')).toMatchObject({
      totalHoursMax: 18,
      sessionCount: 3,
      confidence: 'medium',
    });
  });

  it('still refuses to multiply when the count is enumerating, restating, or unattached', () => {
    // The brakes on the rule above. Each of these has a count and a duration in
    // the same string, and in none of them does the duration distribute.

    // 1. ENUMERATION: the count's scope holds more than one duration, so the
    //    durations are the itemisation of the count, not a per-item figure.
    expect(parseDuration('Two visits: 3 hrs and 1.5 hrs')).toMatchObject({
      totalHoursMax: 4.5,
      sessionCount: 2,
    });

    // 2. RESTATEMENT: a stated total short-circuits first. The parenthetical
    //    breaks the 2 hours down, it does not add a second 2 hours. This is
    //    record 12766 - multiplying here would double a real study's hours.
    expect(parseDuration('2 hours (in the form of two 1-hour visits)')).toMatchObject({
      totalHoursMax: 2,
      sessionCount: 2,
    });

    // 3. UNATTACHED: the 3 hours belong to the questionnaires, not the visits.
    //    A clause boundary or an intervening noun blocks distribution.
    expect(parseDuration('2 visits and 3 hours of online questionnaires').totalHoursMax).toBe(3);

    // 4. EXPLICIT TOTAL: "total across" says the 6 hours already cover all 3.
    expect(parseDuration('6 hours total across 3 study visits').totalHoursMax).toBe(6);
  });

  it('does not read "within 3 weeks of each other" as distributive', () => {
    expect(
      parseDuration('Two total visits within 3 weeks of each other. Each visit will last about one hour.'),
    ).toMatchObject({ totalHoursMax: 2, sessionCount: 2, spanWeeks: 3 });
  });

  it('flags a per-visit figure quoted without a visit count', () => {
    // 1.5 hours is a FLOOR here, not the commitment: the study has an unstated
    // number of visits. Pay divided by 1.5 h would overstate the rate.
    expect(parseDuration('Visits last around 1.5 hours')).toMatchObject({
      totalHoursMax: 1.5,
      sessionCount: null,
      confidence: 'low',
    });
    expect(parseDuration('2 hours per visit').confidence).toBe('low');
  });
});

describe('itemized listings are summed', () => {
  it('sums clauses separated by <br>', () => {
    // <br> becomes a clause boundary before HTML stripping; without that the
    // three visits fuse into one mention and the total collapses.
    expect(parseDuration('Visit 1: 1.5 hours<br>Visit 2: 1 hour<br>Visit 3: 1.5 hours')).toMatchObject({
      totalHoursMax: 4,
      sessionCount: 3,
    });
  });

  it('sums clauses separated only by whitespace', () => {
    expect(parseDuration('Session 1: 60 minutes Session 2: 60 minutes')).toMatchObject({
      totalHoursMax: 2,
      sessionCount: 2,
    });
    expect(parseDuration('First Phase: 30-45 minutes Second Phase: Approximately 1.5 hours')).toMatchObject({
      totalHoursMin: 2,
      totalHoursMax: 2.25,
    });
  });

  it('sums a comma-separated list of named visits', () => {
    expect(
      parseDuration('Screening Visit (~2hrs), Metabolic Study Day (~4hrs), Functional Measurement Study Day (~4hrs)')
        .totalHoursMax,
    ).toBe(10);
  });
});

describe('messy-input hazards', () => {
  it('splits a unit fused to the following count', () => {
    // "2 hours8 Interventions" - upstream lost a line break.
    expect(parseDuration('1 - 2 hours8 Interventions').totalHoursMax).toBeGreaterThan(0);
    expect(parseDuration('2 hours8 Interventions').totalHoursMax).toBe(2);
  });

  it('splits a digit fused to its own unit', () => {
    expect(parseDuration('~30minutes').totalHoursMax).toBe(0.5);
    expect(parseDuration('1-1.5hours')).toMatchObject({ totalHoursMin: 1, totalHoursMax: 1.5 });
    expect(parseDuration('2hrs').totalHoursMax).toBe(2);
  });

  it('decodes HTML entities without disturbing the numbers around them', () => {
    expect(
      parseDuration(
        '15 minutes following arrival at the data collection site, either AGLS building or Zachry Building on the Texas A&amp;M College Station Campus',
      ).totalHoursMax,
    ).toBe(0.25);
  });

  it('strips block tags', () => {
    expect(parseDuration('<p>2 hours</p>').totalHoursMax).toBe(2);
  });

  it('is case-insensitive and handles abbreviations', () => {
    expect(parseDuration('THREE HOURS').totalHoursMax).toBe(3);
    expect(parseDuration('3 HRS').totalHoursMax).toBe(3);
    expect(parseDuration('90 min').totalHoursMax).toBe(1.5);
    expect(parseDuration('20 mins ').totalHoursMax).toBeCloseTo(0.3333, 4);
  });

  it('ignores trailing and leading whitespace differences in value, but preserves raw', () => {
    expect(parseDuration('10-15 minutes').totalHoursMax).toBe(parseDuration('10-15 minutes ').totalHoursMax);
    expect(parseDuration('10-15 minutes ').raw).toBe('10-15 minutes ');
  });

  it('treats a bare "h" as unrecognized rather than guessing hours', () => {
    // Not present in the fixture. Documented here so a future change to the
    // unit vocabulary is a deliberate decision rather than an accident.
    expect(parseDuration('1.5 h').totalHoursMax).toBeNull();
  });
});

describe('unparseable and degenerate input', () => {
  const nothing = {
    totalHoursMin: null,
    totalHoursMax: null,
    sessionCount: null,
    spanWeeks: null,
    confidence: 'low',
  };

  it('returns all-null, low confidence for an empty string', () => {
    expect(parseDuration('')).toMatchObject(nothing);
    expect(parseDuration('   ')).toMatchObject(nothing);
  });

  it('returns all-null for a non-duration string in the duration field', () => {
    // Fixture record 10128 has a compensation string here.
    expect(parseDuration('Prepaid movie ticket (Cinemark)')).toMatchObject(nothing);
    expect(parseDuration('no duration listed')).toMatchObject(nothing);
  });

  it('collapses a zero-hour reading to null, because 0 would read as free labour', () => {
    expect(parseDuration('0 minutes').totalHoursMax).toBeNull();
    expect(parseDuration('0 hours').totalHoursMax).toBeNull();
  });

  it('rejects implausible magnitudes rather than reporting them', () => {
    expect(parseDuration('9999 hours').totalHoursMax).toBeNull();
    expect(parseDuration('600 weeks').spanWeeks).toBeNull();
  });

  it('survives nullish input without throwing', () => {
    expect(parseDuration(null as unknown as string)).toMatchObject({ ...nothing, raw: '' });
    expect(parseDuration(undefined as unknown as string)).toMatchObject({ ...nothing, raw: '' });
    expect(parseDuration(42 as unknown as string)).toMatchObject({ ...nothing, raw: '' });
  });

  it('preserves raw verbatim even when nothing parses', () => {
    expect(parseDuration('Prepaid movie ticket (Cinemark)').raw).toBe('Prepaid movie ticket (Cinemark)');
  });
});

// ===========================================================================
// AUDIT REGRESSIONS - locked by fixture id
//
// Every case below was a live, shipped, materially wrong number. They are
// asserted BY RECORD ID, against the raw string the registry actually sends,
// so that a future refactor of the parsing strategies cannot quietly undo the
// fix while the synthetic cases above keep passing.
//
// Do not "simplify" these into the CASES table. The table is organised by
// string shape; this block is organised by the harm each one did.
// ===========================================================================

/** The raw duration meta value for a fixture record, by id. */
function rawDuration(id: number): string {
  const study = fixture.find((s) => s.id === id);
  if (study === undefined) throw new Error(`fixture record ${id} is missing`);
  return study.meta.aux_study_item_duration;
}

describe('REGRESSION F1: a visit count juxtaposed with a per-visit duration multiplies', () => {
  // The shared failure: the COMPENSATION side of each listing is priced for all
  // the visits, while the DURATION side quoted one visit's hours. Dividing the
  // first by the second inflated the advertised rate by 2.3x to 4.9x. Three of
  // these five were in the live top 10.

  it('9815: 1 screening visit (2 h) + 6 study days (7 h each) = 44 h, not 9 h', () => {
    // raw: "The study involves 1 screening visit lasting up to 2 hours followed
    //       by 6 study days lasting up to 7 hours that can be completed within
    //       4 weeks."
    // Compensation proves the count: $20 screening + $100/study visit, total
    // $620. 620 = 20 + 6 x 100 closes only at six study days.
    // Shipped $68.89/hr. Truth $14.09/hr. THE headline case of the audit: a
    // reader trusting rank 4 was signing up for six fasted 7-hour clinic days.
    const d = parseDuration(rawDuration(9815));
    expect(d.totalHoursMin).toBe(44);
    expect(d.totalHoursMax).toBe(44);
    expect(d.spanWeeks).toBe(4); // the 4 weeks is calendar, and stays calendar
    expect(d.confidence).not.toBe('high'); // inferred, not stated
  });

  it('4611: 1 screening visit (2 h) + 4 study visits (14 h each) = 58 h, not 16 h', () => {
    // raw: "1 screening visit ~ 2hours 4 study visits ~14 hours All visits must
    //       be completed within 6 weeks"
    // Compensation: "up to $820 ($20 for screening; $200/study day completed)".
    // 820 = 20 + 4 x 200, and $200 / 14 h = $14.29/hr independently confirms
    // that the 14 hours are per study day. Shipped $51.25/hr; truth $14.14/hr.
    const d = parseDuration(rawDuration(4611));
    expect(d.totalHoursMax).toBe(58);
    expect(d.spanWeeks).toBe(6);
  });

  it('4613: 1 screening visit (3 h) + 4 study visits (6 h each) = 27 h, not 9 h', () => {
    // raw: "This study will include 1 screening visit (~3 hours) and a maximum
    //       of 4 study visits (~6 hours)."
    // Compensation: $20 + 4 x $100 = the stated $420. Shipped $46.67/hr;
    // truth $15.56/hr.
    expect(parseDuration(rawDuration(4613)).totalHoursMax).toBe(27);
  });

  it('8458: 1 screening visit (3 h) + 3 study visits (6 h each) = 21 h, not 9 h', () => {
    // raw: "This study will include 1 screening visit (~3 hours) 3 study visit
    //       (~6 hours). Participants are anticipated to finish all study visits
    //       within a 6 week timeframe."
    // Compensation literally says "for each study visit (3)" and totals $425 =
    // $50 + 3 x $125. Shipped $47.22/hr; truth $20.24/hr.
    expect(parseDuration(rawDuration(8458)).totalHoursMax).toBe(21);
  });

  it('6987: the parenthesised timepoint list is the appointment count', () => {
    // raw: "30 minute pre-study and baseline appointment; 2 week intervention
    //       with three Neurotracker sessions at each appointment (0, 1, 4, 7,
    //       and 14), lasting approximately 1 hour."
    // "each appointment (0, 1, 4, 7, and 14)" enumerates five appointments, so
    // 0.5 + 5 x 1 = 5.5 h. Shipped 1.5 h / $40.00/hr.
    //
    // DELIBERATE DEVIATION: the audit's target is 5 h ($12.00/hr), which comes
    // from content.rendered ("two 30-minute appointments and four hour-long
    // appointments") - it folds the 30-minute baseline into the day-0
    // appointment. parseDuration is a pure function of the duration string and
    // never sees content.rendered, so 5.5 h is the honest read from its input.
    // The gap understates the rate by $1.09, which is the safe direction, and
    // both readings land the study in the 'ok' bucket and off the top 10.
    const d = parseDuration(rawDuration(6987));
    expect(d.totalHoursMax).toBe(5.5);
    // sessionCount counts "three Neurotracker sessions", NOT the appointments.
    // These are different quantities and conflating them is how the ×5 would
    // get applied twice.
    expect(d.sessionCount).toBe(3);
    expect(d.spanWeeks).toBe(2);
  });

  it('leaves the four records whose count must NOT distribute exactly where they were', () => {
    // The fix has to be a scalpel. These carry the same surface features - a
    // count and a duration in one string - and must be untouched.
    expect(parseDuration(rawDuration(12766)).totalHoursMax).toBe(2); // restatement
    expect(parseDuration(rawDuration(8882)).totalHoursMax).toBe(4.5); // enumeration
    expect(parseDuration(rawDuration(11899)).totalHoursMax).toBe(0.9167); // stated total
    expect(parseDuration(rawDuration(11075)).totalHoursMax).toBe(2.5); // stated total
    // And the two that already multiplied correctly must still multiply.
    expect(parseDuration(rawDuration(4593)).totalHoursMax).toBe(27);
    expect(parseDuration(rawDuration(8874)).totalHoursMax).toBe(4);
  });
});

describe('REGRESSION F5: an unquantified ongoing component makes the total unknowable', () => {
  it('8872: nine days of daily data collection cannot be summed away to 1.33 h', () => {
    // raw: "Each interview: 45 minutes to 1 hour<br>Each survey: 20 minutes<br>
    //       Smartphone-based data collection: several minutes each day for nine
    //       days"
    // The parser used to total the two components it could read (1.08-1.33 h)
    // and drop the third. Against a $140 numerator whose $100 - 71% of the pay
    // - buys precisely that third component, this produced $105.00/hr and
    // ranked the study SECOND on the entire board.
    //
    // "several minutes" has no number. There is no honest total here, and
    // 'low confidence' is not a substitute for saying so: low-confidence rates
    // rank exactly like high-confidence ones. null is the only correct answer.
    const d = parseDuration(rawDuration(8872));
    expect(d.totalHoursMin).toBeNull();
    expect(d.totalHoursMax).toBeNull();
    expect(d.confidence).toBe('low');
    // The nine days are still real calendar time and are still reported.
    expect(d.spanWeeks).toBe(1.29);
  });

  it('does not fire on a study that states its total up front', () => {
    // The guard runs AFTER the stated-total strategies, so a listing that says
    // how long it takes keeps its number even if it also mentions daily tasks.
    expect(parseDuration(rawDuration(6745)).totalHoursMax).toBe(12);
    expect(parseDuration(rawDuration(4626)).totalHoursMax).toBe(17.5);
  });
});
