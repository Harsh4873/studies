/**
 * Tests for parseCompensation.
 *
 * Structure:
 *   1. A table of EVERY distinct `aux_study_item_compensation` value in
 *      fixtures/arv-snapshot.json (68 distinct strings across 86 records),
 *      each with an explicitly stated expected ParsedCompensation.
 *   2. Regression tests for the individual traps the free text contains
 *      (reversed sigil, missing sigil, embedded HTML, stray spaces,
 *      raffle-vs-guaranteed separation, stated-total-beats-summing).
 *   3. Property/invariant tests over all 86 records.
 *
 * Expected values in the table were derived from the documented parser
 * contract in src/types.ts and the three invariants at the top of
 * parse-compensation.ts:
 *   1. raffle money is never guaranteed money,
 *   2. a stated total beats a computed one,
 *   3. unknown is not zero.
 * Where a case exercises a judgement call, the comment says which rule drives
 * the expectation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseCompensation } from '@/lib/parse-compensation.ts';
import type { Confidence, CurrencyKind, ParsedCompensation } from '@/types.ts';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url));

interface FixtureRecord {
  id: number;
  meta: { aux_study_item_compensation: string };
}

const RECORDS = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as FixtureRecord[];

const ALL_RAW_VALUES: string[] = RECORDS.map((r) => r.meta.aux_study_item_compensation);
const DISTINCT_RAW_VALUES: string[] = [...new Set(ALL_RAW_VALUES)];

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

/** Everything on ParsedCompensation except the two free-form fields. */
type Core = Omit<ParsedCompensation, 'raw' | 'notes'>;

/**
 * Every case must state the four fields that drive ranking and display;
 * anything unstated is asserted to hold its "nothing detected" default, so a
 * parser that starts inventing a perVisit or a raffleMax fails the table.
 */
type CaseExpectation = Pick<Core, 'guaranteedMin' | 'guaranteedMax' | 'currencyKind' | 'confidence'> &
  Partial<Core>;

const DEFAULTS: Core = {
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
  confidence: 'high',
};

function core(r: ParsedCompensation): Core {
  const { raw: _raw, notes: _notes, ...rest } = r;
  return rest;
}

interface Case {
  /** Verbatim value from the snapshot. */
  input: string;
  /** Short label for the test name. */
  label: string;
  expected: CaseExpectation;
  /** Case-insensitive substrings that must appear somewhere in notes[]. */
  notesInclude?: string[];
}

function c(label: string, input: string, expected: CaseExpectation, notesInclude?: string[]): Case {
  return notesInclude === undefined ? { label, input, expected } : { label, input, expected, notesInclude };
}

// ---------------------------------------------------------------------------
// The table: one entry per distinct snapshot value
// ---------------------------------------------------------------------------

const CASES: Case[] = [
  // --- Bare amounts. The clean case: one number, no instrument named. ------
  c('plain $400.00', '$400.00', {
    guaranteedMin: 400,
    guaranteedMax: 400,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $350.00', '$350.00', {
    guaranteedMin: 350,
    guaranteedMax: 350,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $175', '$175', {
    guaranteedMin: 175,
    guaranteedMax: 175,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $150', '$150', {
    guaranteedMin: 150,
    guaranteedMax: 150,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $120', '$120', {
    guaranteedMin: 120,
    guaranteedMax: 120,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $60', '$60', {
    guaranteedMin: 60,
    guaranteedMax: 60,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $50', '$50', {
    guaranteedMin: 50,
    guaranteedMax: 50,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $45', '$45', {
    guaranteedMin: 45,
    guaranteedMax: 45,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $30', '$30', {
    guaranteedMin: 30,
    guaranteedMax: 30,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $20', '$20', {
    guaranteedMin: 20,
    guaranteedMax: 20,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $15', '$15', {
    guaranteedMin: 15,
    guaranteedMax: 15,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('plain $10', '$10', {
    guaranteedMin: 10,
    guaranteedMax: 10,
    currencyKind: 'unknown',
    confidence: 'high',
  }),

  // --- Sigil quirks --------------------------------------------------------
  // TRAP: the sigil is typed AFTER the number, and the value has a trailing
  // space that stripHtml trims.
  c('reversed sigil "20$" with a trailing NBSP', '20$\u00A0', {
    guaranteedMin: 20,
    guaranteedMax: 20,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  // TRAP: stray space between the sigil and the digits; the parenthetical is
  // an hourly rate, not a second payment, so the $60 stands alone.
  c('stray space after sigil + parenthetical rate', '$ 60 ($17.14 / hour)', {
    guaranteedMin: 60,
    guaranteedMax: 60,
    isHourlyRate: true,
    hourlyMin: 17.14,
    hourlyMax: 17.14,
    currencyKind: 'unknown',
    confidence: 'high',
  }),

  // --- Hourly rates. Rule 3: no stated total means no invented total. ------
  // TRAP: stray space between the slash and the unit.
  c('hourly "$20/ hr" (stray space)', '$20/ hr', {
    guaranteedMin: null,
    guaranteedMax: null,
    isHourlyRate: true,
    hourlyMin: 20,
    hourlyMax: 20,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('hourly "$25/hr"', '$25/hr', {
    guaranteedMin: null,
    guaranteedMax: null,
    isHourlyRate: true,
    hourlyMin: 25,
    hourlyMax: 25,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('hourly "$25 per hour"', '$25 per hour', {
    guaranteedMin: null,
    guaranteedMax: null,
    isHourlyRate: true,
    hourlyMin: 25,
    hourlyMax: 25,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  // A range of rates is a downgrade, not a failure.
  c('hourly range "$15-25/hour"', '$15-25/hour', {
    guaranteedMin: null,
    guaranteedMax: null,
    isHourlyRate: true,
    hourlyMin: 15,
    hourlyMax: 25,
    currencyKind: 'unknown',
    confidence: 'medium',
  }),
  // An unquantified bonus means the parsed figures are not the whole story.
  c(
    'hourly with unquantified bonus',
    '$10/hour. For some experiments, additional bonuses may be earned during the study.',
    {
      guaranteedMin: null,
      guaranteedMax: null,
      isHourlyRate: true,
      hourlyMin: 10,
      hourlyMax: 10,
      currencyKind: 'unknown',
      confidence: 'medium',
    },
    ['bonus'],
  ),
  // Two stated rates plus a firm parenthetical total: the total is guaranteed
  // money, the rates stay in the hourly fields.
  c(
    'two hourly rates with a stated range total',
    '$20/hr for imaging session, $10/hr for lab session ($40-50 total)',
    {
      guaranteedMin: 40,
      guaranteedMax: 50,
      isHourlyRate: true,
      hourlyMin: 10,
      hourlyMax: 20,
      currencyKind: 'unknown',
      confidence: 'medium',
    },
  ),

  // --- Ceilings. "up to" fixes the roof, never the floor (rule 3). ---------
  // TRAP: literal <br> inside the meta value.
  c(
    'ceiling with embedded <br>',
    'Up to $30\u00A0<br>Paid as Amazon gift card',
    {
      guaranteedMin: null,
      guaranteedMax: 30,
      currencyKind: 'giftcard',
      confidence: 'high',
    },
    ['ceiling'],
  ),
  c('ceiling "Up to $150"', 'Up to $150', {
    guaranteedMin: null,
    guaranteedMax: 150,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  c('ceiling "Up to $300"', 'Up to $300', {
    guaranteedMin: null,
    guaranteedMax: 300,
    currencyKind: 'unknown',
    confidence: 'high',
  }),
  // "12 therapy sessions" and "3 follow up assessments" are activities, not
  // dollars, and must not be tokenized as money or as a visit count.
  c(
    'ceiling followed by bare activity counts',
    'Up to $560 for completing all study components, including a baseline assessment, 12 therapy sessions across 6 weeks, and 3 follow up assessments at 3-, 6-, and 12-months after the therapy phase.',
    {
      guaranteedMin: null,
      guaranteedMax: 560,
      currencyKind: 'unknown',
      confidence: 'high',
    },
  ),
  // Record 11899, audit finding F8 - the mirror image of the raffle rule.
  //
  // The $20 ceiling is only reachable by WINNING the task bonus at every visit:
  // "$5 per lab visit" is attendance pay, "an opportunity to earn an additional
  // $5 ... for task-related reward" is not. The parser excludes raffle money
  // from guaranteed pay and must exclude contingent performance money for the
  // same reason - the study decides whether you get it, not you.
  //
  // This case used to assert guaranteedMax: 20 with the comment "the ceiling
  // wins over the $5-per-visit component amounts", which put $10 of money the
  // participant may never see into the ranking numerator and advertised
  // $21.82/hr for a study whose guaranteed rate is $10.91/hr.
  //
  // $20 ceiling / ($5 guaranteed + $5 contingent per occasion) = exactly 2
  // occasions, so the decomposition is arithmetic, not a guess: visitCount 2,
  // guaranteed 2 x $5 = $10. Confidence drops to 'medium' because the listing
  // never states the visit count outright.
  c(
    'ceiling with per-lab-visit component',
    'Up to $20: Participants are compensated $5 per lab visit in the form of a gift card. Each participant will have an opportunity to earn an additional $5 during each lab visit for task-related reward.\u00A0',
    {
      guaranteedMin: null,
      guaranteedMax: 10,
      perVisit: 5,
      visitCount: 2,
      currencyKind: 'giftcard',
      confidence: 'medium',
    },
  ),
  // "$200/study day" is a per-DAY rate and must not become an hourly rate.
  c(
    'ceiling $820 with a per-study-day component',
    'If you complete all visits, you will be compensated up to $820 ($20 for screening; $200/study day completed) for your time and effort.',
    {
      guaranteedMin: null,
      guaranteedMax: 820,
      currencyKind: 'unknown',
      confidence: 'high',
    },
  ),
  c(
    'ceiling $225 over 3 visits',
    'Participating families can be compensated up to $225 over 3 visits (1 visit a year). Participants traveling 50 miles or more may be eligible for mileage compensation.',
    {
      guaranteedMin: null,
      guaranteedMax: 225,
      visitCount: 3,
      currencyKind: 'unknown',
      confidence: 'high',
    },
  ),

  // --- Stated totals beat summing (rule 2) ---------------------------------
  c(
    'stated "Total $425" beats summing $50 + $125',
    '$50 for the screening visit and $125 for each study visit (3). Total $425 compensation',
    {
      guaranteedMin: 425,
      guaranteedMax: 425,
      perVisit: 125,
      visitCount: 3,
      currencyKind: 'unknown',
      confidence: 'high',
    },
  ),
  c(
    'stated "totally $1000" beats summing $20 + $500',
    'Participants will be compensated $20 per visit. They will also receive a completion bonus of $500 for completing all visits, totally $1000. Finally, participants will be asked to wear an Oura ring for the 6-months of the study. After the study is complete they will be able to keep the ring.',
    {
      guaranteedMin: 1000,
      guaranteedMax: 1000,
      perVisit: 20,
      completionBonus: 500,
      hasNonCashPerk: true,
      currencyKind: 'mixed',
      confidence: 'medium',
    },
  ),
  c(
    'trailing "($100 total)" beats summing',
    '$50 per visit for 2 visits ($100 total)',
    {
      guaranteedMin: 100,
      guaranteedMax: 100,
      perVisit: 50,
      visitCount: 2,
      currencyKind: 'unknown',
      confidence: 'high',
    },
  ),
  c(
    'mid-string "(total $60)" beats summing $20 + $20',
    '$20 per session and an additional $20 for completing both sessions (total $60) in Amazon gift cards',
    {
      guaranteedMin: 60,
      guaranteedMax: 60,
      perVisit: 20,
      visitCount: 2,
      completionBonus: 20,
      currencyKind: 'giftcard',
      confidence: 'high',
    },
  ),
  // Sums to $130, states $120. The stated figure wins.
  c(
    'four session amounts with a stated $120 total',
    'The participants will receive $20 for the first session, $35 for the second, $30 for the third, and $45 for the fourth. This structure is designed to ensure fair compensation even if they choose not to complete all four sessions. The total compensation for completing all four sessions is $120.',
    {
      guaranteedMin: 120,
      guaranteedMax: 120,
      visitCount: 4,
      currencyKind: 'unknown',
      confidence: 'medium',
    },
  ),
  // Leading grand total corroborated by its own parenthesised breakdown.
  c(
    'leading grand total with itemised breakdown',
    '$225.00 (Baseline appointments - $50; 3-month appointments - $75; 6 month appointments - $100)',
    {
      guaranteedMin: 225,
      guaranteedMax: 225,
      currencyKind: 'unknown',
      confidence: 'high',
    },
    ['breakdown'],
  ),
  c(
    'ceiling total $620 with per-visit rate',
    'If participants agree to take part in this research, we will pay for each visit completed = $20 for the screening visit and $100 for each study visit completed to compensate for time and effort. If all visits are completed, compensation is up to a total of $620.',
    {
      guaranteedMin: null,
      guaranteedMax: 620,
      perVisit: 100,
      currencyKind: 'unknown',
      confidence: 'medium',
    },
  ),
  c(
    'ceiling total $420, same wording as the $620 record',
    'If participants agree to take part in this research, we will pay for each visit completed = $20 for the screening visit and $100 for each study visit completed to compensate for time and effort. If all visits are completed, compensation is up to a total of $420.',
    {
      guaranteedMin: null,
      guaranteedMax: 420,
      perVisit: 100,
      currencyKind: 'unknown',
      confidence: 'medium',
    },
  ),
  c(
    'possible total $550 in Visa debit cards',
    'Participants will be compensated with a $150 Visa debit card for each study visit, and a $100 bonus Visa debit card for completing all three visits, for a possible total of $550 in Visa debit cards. Disbursement will occur at the end of each visit. Please note that we are unable to offer mileage compensation.',
    {
      guaranteedMin: null,
      guaranteedMax: 550,
      perVisit: 150,
      visitCount: 3,
      completionBonus: 100,
      currencyKind: 'cash',
      confidence: 'medium',
    },
  ),

  // --- Summing, the last resort -------------------------------------------
  c('two phases summed', 'First Phase: $10 Second Phase: $20', {
    guaranteedMin: 30,
    guaranteedMax: 30,
    currencyKind: 'unknown',
    confidence: 'medium',
  }),
  c(
    'two sessions summed, cents preserved',
    'Session 1: Participants will be compensated with $5.00.\u00A0Session 2: Participants will be compensated with $10.00.',
    {
      guaranteedMin: 15,
      guaranteedMax: 15,
      currencyKind: 'unknown',
      confidence: 'medium',
    },
  ),
  // TRAP: <br> separates the clauses; without stripping, "$20Each" corrupts
  // the scan. "maximum $100" caps one component, so the sum is an estimate.
  c(
    'three <br>-separated components, one capped',
    'Each interview:\u00A0$20<br>Each survey: $20<br>Smartphone-based data collection: maximum $100',
    {
      guaranteedMin: 140,
      guaranteedMax: 140,
      currencyKind: 'unknown',
      confidence: 'low',
    },
    ['capped'],
  ),

  // --- Per-visit without a count: floor known, ceiling unknown (rule 3) ----
  c('per-visit only', '$30 per visit', {
    guaranteedMin: 30,
    guaranteedMax: null,
    perVisit: 30,
    currencyKind: 'unknown',
    confidence: 'medium',
  }),
  c('for-each-visit only', 'You will be compensated $50 for each visit to the imaging center.', {
    guaranteedMin: 50,
    guaranteedMax: null,
    perVisit: 50,
    currencyKind: 'unknown',
    confidence: 'medium',
  }),
  c(
    'per-visit plus two questionnaire payments',
    '$50 per laboratory visit; $10 for parent questionnaires; $10 for child questionnaires',
    {
      guaranteedMin: 70,
      guaranteedMax: null,
      perVisit: 50,
      currencyKind: 'unknown',
      confidence: 'medium',
    },
  ),

  // --- Gift cards ----------------------------------------------------------
  c('gift card worth $25', 'Amazon gift card worth $25', {
    guaranteedMin: 25,
    guaranteedMax: 25,
    currencyKind: 'giftcard',
    confidence: 'high',
  }),
  c('gift card worth $30', 'Amazon gift card worth $30', {
    guaranteedMin: 30,
    guaranteedMax: 30,
    currencyKind: 'giftcard',
    confidence: 'high',
  }),
  c('gift card worth $50', 'Amazon gift card worth $50', {
    guaranteedMin: 50,
    guaranteedMax: 50,
    currencyKind: 'giftcard',
    confidence: 'high',
  }),
  c('$25 Amazon Gift Card', '$25 Amazon Gift Card', {
    guaranteedMin: 25,
    guaranteedMax: 25,
    currencyKind: 'giftcard',
    confidence: 'high',
  }),
  c('$15 Amazon gift card', '$15 Amazon gift card', {
    guaranteedMin: 15,
    guaranteedMax: 15,
    currencyKind: 'giftcard',
    confidence: 'high',
  }),
  c('$10 Amazon e-gift card', '$10 Amazon e-gift card', {
    guaranteedMin: 10,
    guaranteedMax: 10,
    currencyKind: 'giftcard',
    confidence: 'high',
  }),
  c('$20 Amazon e-gift card', '$20 Amazon e-gift card', {
    guaranteedMin: 20,
    guaranteedMax: 20,
    currencyKind: 'giftcard',
    confidence: 'high',
  }),
  c('$30 e-gift card', '$30 e-gift card', {
    guaranteedMin: 30,
    guaranteedMax: 30,
    currencyKind: 'giftcard',
    confidence: 'high',
  }),

  // --- Non-cash perks make it 'mixed' --------------------------------------
  c(
    'gift card plus cuff and scale',
    '$150 Amazon gift card, Bluetooth enabled blood pressure cuff and weight scale',
    {
      guaranteedMin: 150,
      guaranteedMax: 150,
      hasNonCashPerk: true,
      currencyKind: 'mixed',
      confidence: 'high',
    },
    ['perk'],
  ),
  c(
    'gift card plus glucometer and scale',
    'Participants will receive a $150 Amazon gift card, Bluetooth-enabled glucometer, and weight scale',
    {
      guaranteedMin: 150,
      guaranteedMax: 150,
      hasNonCashPerk: true,
      currencyKind: 'mixed',
      confidence: 'high',
    },
  ),
  // Alternatives, not additions: $20 either way, never $40.
  c(
    'lunch OR gift card, both $20',
    'Choice of up to $20 worth of a Blue Baker lunch OR a $20 Amazon gift card',
    {
      guaranteedMin: null,
      guaranteedMax: 20,
      hasNonCashPerk: true,
      currencyKind: 'mixed',
      confidence: 'high',
    },
  ),

  // --- SONA / course credit ------------------------------------------------
  c('$10 each plus optional SONA credit', '$10 each; if partner is seeking research credit- 1 SONA credit can be granted', {
    guaranteedMin: 10,
    guaranteedMax: 10,
    sonaCreditOption: true,
    currencyKind: 'mixed',
    confidence: 'high',
  }),
  // Rate ladder per group and per visit; no total is stated anywhere.
  c(
    'SONA option with a multi-rate hourly ladder',
    'Participants will have the option to select course credit compensation via SONA or financial compensation. Reimbursement amounts will vary depending on the study group a participant belongs to, the length of their visit, and which study visit they are completing. Rates of payment for each group are as follows: Baseline control group – Visit 1: $17.5/hr Inactive control group – Visit 1: $17.5/hr; Visit 2: $20/hr In-person intervention &amp; active control groups: Visit 1: $17.50/hr; Visit 2: $20/hr; Visit 3: $22.50/hr Participants who complete a reward-based Doors task will receive up to an additional $8.00. Participants who complete the 3-month follow-up questionnaires will be compensated $25 for their time.',
    {
      guaranteedMin: null,
      guaranteedMax: null,
      isHourlyRate: true,
      hourlyMin: 17.5,
      hourlyMax: 22.5,
      sonaCreditOption: true,
      currencyKind: 'mixed',
      confidence: 'low',
    },
    ['hourly rate'],
  ),

  // --- Raffles. Rule 1: a lottery ticket is not a payment. -----------------
  c(
    'raffle only: one of three $10 cards',
    'Participants can elect to be entered into a drawing for one of three $10 Amazon gift cards.',
    {
      guaranteedMin: 0,
      guaranteedMax: 0,
      raffleMax: 10,
      raffleOnly: true,
      currencyKind: 'giftcard',
      confidence: 'high',
    },
    ['raffle'],
  ),
  c(
    'raffle only: one of four $50 cards',
    'Participants will be entered into a drawing for one of four $50 Amazon gift cards for their time and effort.',
    {
      guaranteedMin: 0,
      guaranteedMax: 0,
      raffleMax: 50,
      raffleOnly: true,
      currencyKind: 'giftcard',
      confidence: 'high',
    },
    ['raffle'],
  ),
  // TRAP: the "$" is missing from the guaranteed 60, and a raffle prize
  // follows in the same sentence.
  c(
    'missing sigil "60 gift card" plus a raffle',
    '60 gift card to Amazon AND entered into a raffle for one of two $50\u00A0Amazon gift card\u00A0',
    {
      guaranteedMin: 60,
      guaranteedMax: 60,
      raffleMax: 50,
      currencyKind: 'giftcard',
      confidence: 'high',
    },
  ),
  // "The first 400 participants" must not be read as $400.
  c(
    'guaranteed $10 plus a $100 prize drawing (long)',
    'The first 400 participants will be offered a $10 gift card after completing the survey. Additionally, all participants will be entered into a prize drawing with a chance to win one of the ten $100 gift cards. The target population consists of individuals aged 55 and older. This approach ensures that the incentive is accessible and user-friendly for all participants, particularly those who may not be familiar with or comfortable using e-gift cards.',
    {
      guaranteedMin: 10,
      guaranteedMax: 10,
      raffleMax: 100,
      currencyKind: 'giftcard',
      confidence: 'low',
    },
  ),
  c(
    'guaranteed $10 plus a $100 prize drawing (short)',
    'The first 400 participants will be offered a $10 gift card after completing the survey. Additionally, all participants will be entered into a prize drawing with a chance to win one of the ten $100 gift cards. The target population consists of individuals aged 65 and older.\u00A0',
    {
      guaranteedMin: 10,
      guaranteedMax: 10,
      raffleMax: 100,
      currencyKind: 'giftcard',
      confidence: 'high',
    },
  ),
  // "one of 5 $100" must not read a phantom $5 from the reversed-sigil rule,
  // and "1 of 5 $100 gift cards" is a raffle even though it never says so.
  c(
    'guaranteed $5 plus two "one of 5 $100" prize pools',
    'Participants recruited externally will receive $5 for coming in and enter a drawing to get one of 5 $100 gift cards\u00A0(awarded to those who earn the most points).\u00A0Participants will also be recruited through the Psychology Subject Pool. Participants from the subject pool will receive research credit (2) and be eligible to receive 1 of 5 $100 gift cards (awarded to those who earn the most points).\u00A0',
    {
      guaranteedMin: 5,
      guaranteedMax: 5,
      raffleMax: 100,
      sonaCreditOption: true,
      currencyKind: 'mixed',
      confidence: 'high',
    },
  ),
  // TRAP: <u> emphasis, guaranteed and raffled money in one sentence, and the
  // same $10 restated later in the text.
  c(
    'guaranteed $10 and raffled $50 in one sentence, with a restatement',
    'If you complete\u00A0<u>ALL THREE</u>\u00A0study sessions, then you will receive one $10 Amazon gift card and three entries for a drawing to win one of five $50 Amazon gift cards. You will receive the $10 Amazon gift card for completing the first session, one drawing entry for completing the second session, and two additional drawing entries for completing the third session. Upon completion of data collection, five participants will be randomly chosen without replacement from the drawing to each receive one $50 Amazon gift card.',
    {
      guaranteedMin: 10,
      guaranteedMax: 10,
      raffleMax: 50,
      visitCount: 3,
      currencyKind: 'giftcard',
      confidence: 'low',
    },
    ['repeated mention'],
  ),
  // Stated $80 total, plus a $200 raffle prize that must stay out of it.
  c(
    'stated $80 total alongside a $200 random drawing',
    'Participants in this research will be compensated with $30 for the first session completed and $50 for the second session completed. The total compensation for the entire two-session participation will be $80. If participants withdraw from the study before the second session, they can only receive $30 for their first participation. Participants will receive a $10 referral bonus for each friend or family member they successfully refer to join our experiment, with a limit of 10 referrals. All participants who consent to participate in the study in 2025 will be eligible for a random drawing. At the conclusion of the 2025 study period, five participants will be randomly selected to receive a $200 gift card.',
    {
      guaranteedMin: 80,
      guaranteedMax: 80,
      raffleMax: 200,
      currencyKind: 'giftcard',
      confidence: 'low',
    },
  ),

  // --- The two Bryan-College Station monsters ------------------------------
  c(
    'Bryan-College Station, community members only',
    'For Bryan-College Station community members: They will receive $5 for the screening survey at the first in-person appointment in cash. They will receive $25 in cash for each EEG laboratory visit ($50 total) with a chance to win up to an additional $5 in cash during one of the computerized tasks at the laboratory appointment (up to $10 total). Participants will not be compensated for the clinical interview portion, as this is for eligibility purposes. Participants will receive $0.50 for completing each survey in the EMA portion of the study, with a $5 weekly bonus payment if they have 90% completion on the surveys ($90). The post-study questionnaire and EEG in lab session completion will reward the participant $45 in cash. This would add up to a possible $165 in cash for completing the EMA over the roughly 1 month period.',
    {
      guaranteedMin: null,
      guaranteedMax: 165,
      raffleMax: 10,
      perVisit: 25,
      completionBonus: 5,
      currencyKind: 'cash',
      confidence: 'low',
    },
  ),
  c(
    'Bryan-College Station, community members and SONA students',
    'For Bryan-College Station community members: They will receive $5 for the screening survey at the first in-person appointment in cash. They will receive $25 in cash for each EEG laboratory visit ($50 total) with a chance to win up to an additional $5 in cash during one of the computerized tasks at the laboratory appointment (up to $10 total). Participants will not be compensated for the clinical interview portion, as this is for eligibility purposes. Participants will receive $0.50 for completing each survey in the EMA portion of the study, with a $5 weekly bonus payment if they have 90% completion on the surveys ($90). The post-study questionnaire and EEG in lab session completion will reward the participant $45 in cash. This would add up to a possible $165 in cash for completing the EMA over the roughly 1 month period. For Texas A&amp;M University students interested in participating for course credit through SONA, they will be given $5 in cash at the first in person appointment for the screening survey. They will receive 0.5 credits for every 30 minutes of participation (0.5 credits for the prescreen questionnaire and approximately 2-2.5 credits for the laboratory appointment with additional credit rewarded for EMA). They also have a chance to win up to an additional $5 in cash during one of the computerized tasks at the laboratory appointment (up to $10 total).',
    {
      guaranteedMin: null,
      guaranteedMax: 165,
      raffleMax: 10,
      perVisit: 25,
      completionBonus: 5,
      sonaCreditOption: true,
      currencyKind: 'mixed',
      confidence: 'low',
    },
  ),

  // --- Nothing offered -----------------------------------------------------
  c(
    '"None"',
    'None',
    { guaranteedMin: 0, guaranteedMax: 0, raffleMax: 0, currencyKind: 'unknown', confidence: 'high' },
    ['no compensation offered'],
  ),
  c(
    '"None" with a trailing non-breaking space',
    'None\u00A0',
    { guaranteedMin: 0, guaranteedMax: 0, raffleMax: 0, currencyKind: 'unknown', confidence: 'high' },
    ['no compensation offered'],
  ),
  // A blank field is the ABSENCE of a claim, not a claim of $0. Contrast the
  // "None" cases above, which assert a confident zero. See types.ts:291-293.
  c(
    'empty string (9 records)',
    '',
    { guaranteedMin: null, guaranteedMax: null, raffleMax: null, currencyKind: 'unknown', confidence: 'low' },
    ['no compensation stated'],
  ),
];

// ---------------------------------------------------------------------------
// 1. Table
// ---------------------------------------------------------------------------

describe('parseCompensation - every distinct value in the snapshot', () => {
  it.each(CASES)('$label', ({ input, expected, notesInclude }) => {
    const result = parseCompensation(input);

    expect(core(result)).toEqual({ ...DEFAULTS, ...expected });
    expect(result.raw).toBe(input);

    for (const fragment of notesInclude ?? []) {
      expect(result.notes.join(' | ').toLowerCase()).toContain(fragment.toLowerCase());
    }
  });

  it('covers every distinct value present in the fixture', () => {
    const covered = new Set(CASES.map((k) => k.input));
    const uncovered = DISTINCT_RAW_VALUES.filter((v) => !covered.has(v));

    expect(uncovered).toEqual([]);
    expect(covered.size).toBe(DISTINCT_RAW_VALUES.length);
  });

  it('does not test strings that are absent from the fixture', () => {
    const present = new Set(DISTINCT_RAW_VALUES);
    expect(CASES.map((k) => k.input).filter((v) => !present.has(v))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Regression tests for individual traps
// ---------------------------------------------------------------------------

describe('sigil traps', () => {
  it('reads "20$" as twenty dollars, not as an unparsed string', () => {
    const r = parseCompensation('20$ ');
    expect(r.guaranteedMin).toBe(20);
    expect(r.guaranteedMax).toBe(20);
  });

  it('does not invent a $5 from "one of 5 $100 gift cards"', () => {
    const r = parseCompensation(
      'Participants recruited externally will receive $5 for coming in and enter a drawing to get one of 5 $100 gift cards (awarded to those who earn the most points).',
    );
    // The only guaranteed $5 is the "for coming in" payment; the "5 $" in
    // "one of 5 $100" must not add a second one.
    expect(r.guaranteedMin).toBe(5);
    expect(r.guaranteedMax).toBe(5);
    expect(r.raffleMax).toBe(100);
  });

  it('reads a bare "60 gift card" as $60', () => {
    const r = parseCompensation('60 gift card to Amazon AND entered into a raffle for one of two $50 Amazon gift card ');
    expect(r.guaranteedMax).toBe(60);
  });

  it('does not read "the first 400 participants" as $400', () => {
    const r = parseCompensation(
      'The first 400 participants will be offered a $10 gift card after completing the survey.',
    );
    expect(r.guaranteedMax).toBe(10);
  });

  it('does not read "12 therapy sessions" or "3 follow up assessments" as money', () => {
    const r = parseCompensation(
      'Up to $560 for completing all study components, including a baseline assessment, 12 therapy sessions across 6 weeks, and 3 follow up assessments at 3-, 6-, and 12-months after the therapy phase.',
    );
    expect(r.guaranteedMax).toBe(560);
  });

  it('tolerates a stray space between the sigil and the digits', () => {
    expect(parseCompensation('$ 60').guaranteedMax).toBe(60);
  });
});

describe('HTML inside meta values', () => {
  it('splits clauses on <br> instead of fusing digits into the next word', () => {
    const r = parseCompensation('Each interview: $20<br>Each survey: $20<br>Smartphone-based data collection: maximum $100');
    expect(r.guaranteedMax).toBe(140);
  });

  it('strips <u> without losing the words it wraps', () => {
    const withTags = parseCompensation('If you complete <u>ALL THREE</u> study sessions, then you will receive one $10 Amazon gift card.');
    const withoutTags = parseCompensation('If you complete ALL THREE study sessions, then you will receive one $10 Amazon gift card.');
    expect(core(withTags)).toEqual(core(withoutTags));
    expect(withTags.visitCount).toBe(3);
  });

  it('decodes entities: "&#36;50" is fifty dollars and "A&amp;M" is not money', () => {
    expect(parseCompensation('&#36;50').guaranteedMax).toBe(50);
    expect(parseCompensation('Texas A&amp;M students receive $25').guaranteedMax).toBe(25);
  });

  it('preserves the raw string with its markup intact', () => {
    const raw = 'Up to $30 <br>Paid as Amazon gift card';
    expect(parseCompensation(raw).raw).toBe(raw);
  });
});

describe('hourly rate detection', () => {
  it.each([
    ['$25/hr', 25],
    ['$20/ hr', 20],
    ['$25 per hour', 25],
    ['$17.50/hr', 17.5],
    ['($17.14 / hour)', 17.14],
  ])('treats %s as an hourly rate', (input, rate) => {
    const r = parseCompensation(input);
    expect(r.isHourlyRate).toBe(true);
    expect(r.hourlyMin).toBe(rate);
    expect(r.hourlyMax).toBe(rate);
  });

  it('does not treat "$200/study day" as an hourly rate', () => {
    const r = parseCompensation('$200/study day completed');
    expect(r.isHourlyRate).toBe(false);
    expect(r.hourlyMin).toBeNull();
    expect(r.hourlyMax).toBeNull();
  });

  it('never multiplies an hourly rate by a guessed duration (rule 3)', () => {
    const r = parseCompensation('$25/hr');
    expect(r.guaranteedMin).toBeNull();
    expect(r.guaranteedMax).toBeNull();
  });
});

describe('raffle money is separated from guaranteed money (rule 1)', () => {
  it('marks a drawing-only listing as raffleOnly with zero guaranteed pay', () => {
    const r = parseCompensation('Participants will be entered into a drawing for one of four $50 Amazon gift cards for their time and effort.');
    expect(r.raffleOnly).toBe(true);
    expect(r.guaranteedMin).toBe(0);
    expect(r.guaranteedMax).toBe(0);
    expect(r.raffleMax).toBe(50);
  });

  it('never lets a $100 drawing outrank a guaranteed $50', () => {
    const drawing = parseCompensation('Participants can elect to be entered into a drawing for one of three $100 Amazon gift cards.');
    const guaranteed = parseCompensation('$50');

    expect(drawing.guaranteedMax).toBe(0);
    expect(guaranteed.guaranteedMax).toBe(50);
    expect(guaranteed.guaranteedMax as number).toBeGreaterThan(drawing.guaranteedMax as number);
  });

  it('splits guaranteed from raffled money inside a single sentence', () => {
    const r = parseCompensation(
      'you will receive one $10 Amazon gift card and three entries for a drawing to win one of five $50 Amazon gift cards.',
    );
    expect(r.guaranteedMin).toBe(10);
    expect(r.guaranteedMax).toBe(10);
    expect(r.raffleMax).toBe(50);
    expect(r.raffleOnly).toBe(false);
  });

  it('reports the largest single prize, not the pool value', () => {
    // "one of five $50" is worth $50 to a winner, never $250.
    const r = parseCompensation('entered into a drawing to win one of five $50 Amazon gift cards.');
    expect(r.raffleMax).toBe(50);
  });

  it('treats "1 of 5 $100 gift cards" as a raffle even without the word drawing', () => {
    const r = parseCompensation('Participants from the subject pool will be eligible to receive 1 of 5 $100 gift cards.');
    expect(r.raffleMax).toBe(100);
    expect(r.guaranteedMax).toBe(0);
    expect(r.raffleOnly).toBe(true);
  });

  it('keeps a raffle prize out of a stated total', () => {
    const r = parseCompensation(
      'The total compensation for the entire two-session participation will be $80. At the conclusion of the 2025 study period, five participants will be randomly selected to receive a $200 gift card.',
    );
    expect(r.guaranteedMax).toBe(80);
    expect(r.raffleMax).toBe(200);
  });
});

describe('a stated total beats a computed one (rule 2)', () => {
  it('$425: uses the stated total instead of summing $50 + $125', () => {
    const r = parseCompensation('$50 for the screening visit and $125 for each study visit (3). Total $425 compensation');
    expect(r.guaranteedMin).toBe(425);
    expect(r.guaranteedMax).toBe(425);
    expect(r.guaranteedMax).not.toBe(175); // the naive sum
  });

  it('$1000: uses "totally $1000" instead of summing $20 + $500', () => {
    const r = parseCompensation(
      'Participants will be compensated $20 per visit. They will also receive a completion bonus of $500 for completing all visits, totally $1000.',
    );
    expect(r.guaranteedMax).toBe(1000);
    expect(r.guaranteedMax).not.toBe(520);
  });

  it('$820: uses the ceiling instead of summing $20 + $200', () => {
    const r = parseCompensation(
      'If you complete all visits, you will be compensated up to $820 ($20 for screening; $200/study day completed) for your time and effort.',
    );
    expect(r.guaranteedMax).toBe(820);
    expect(r.guaranteedMin).toBeNull(); // "up to" fixes no floor
    expect(r.guaranteedMax).not.toBe(1040);
  });

  it('$225: a leading grand total is not added to its own breakdown', () => {
    const r = parseCompensation('$225.00 (Baseline appointments - $50; 3-month appointments - $75; 6 month appointments - $100)');
    expect(r.guaranteedMax).toBe(225);
    expect(r.guaranteedMax).not.toBe(450);
  });

  it('$80: measures the 62-character gap between "total" and the amount', () => {
    const r = parseCompensation(
      'Participants in this research will be compensated with $30 for the first session completed and $50 for the second session completed. The total compensation for the entire two-session participation will be $80.',
    );
    expect(r.guaranteedMax).toBe(80);
    expect(r.guaranteedMax).not.toBe(160); // 30 + 50 + 80, the summing fallback
  });

  it('does not bind "total" across a closing parenthesis', () => {
    // "($50 total)" must not attach to the $5 that follows it.
    const r = parseCompensation(
      'They will receive $25 in cash for each EEG laboratory visit ($50 total) with a chance to win up to an additional $5 in cash.',
    );
    expect(r.guaranteedMax).toBe(50);
    expect(r.raffleMax).toBe(5);
  });

  it('prefers the grand total over an embedded sub-total', () => {
    const r = parseCompensation(
      'They will receive $25 in cash for each EEG laboratory visit ($50 total). This would add up to a possible $165 in cash.',
    );
    expect(r.guaranteedMax).toBe(165);
  });

  it('falls back to summing only when no total is stated', () => {
    const r = parseCompensation('First Phase: $10 Second Phase: $20');
    expect(r.guaranteedMax).toBe(30);
    expect(r.confidence).toBe('medium');
    expect(r.notes.join(' ')).toMatch(/summed/i);
  });
});

describe('restatement dedup', () => {
  it('does not double-count one payment described twice', () => {
    const r = parseCompensation(
      'you will receive one $10 Amazon gift card. You will receive the $10 Amazon gift card for completing the first session.',
    );
    expect(r.guaranteedMax).toBe(10);
    expect(r.guaranteedMax).not.toBe(20);
    expect(r.notes.join(' ')).toMatch(/repeated mention/i);
  });

  it('still sums two genuinely distinct payments of the same size', () => {
    const r = parseCompensation('Each interview: $20 Each survey: $20');
    expect(r.guaranteedMax).toBe(40);
  });
});

describe('nothing offered', () => {
  // Saying "None" is an affirmative claim that the study pays nothing.
  it.each(['None', 'None ', 'none', 'N/A'])('returns explicit zeros for %j', (input) => {
    const r = parseCompensation(input);
    expect(r.guaranteedMin).toBe(0);
    expect(r.guaranteedMax).toBe(0);
    expect(r.raffleMax).toBe(0);
    expect(r.raffleOnly).toBe(false);
    expect(r.confidence).toBe('high');
    expect(r.notes).toEqual(['no compensation offered']);
    expect(r.raw).toBe(input);
  });

  // Saying nothing at all is not. Eight published studies have a blank
  // compensation field; five of them state their hours, so a zero here used to
  // produce a confident $0.00/hr and an "Unpaid" badge on a listing that never
  // claimed to be unpaid. That is the false claim this module exists to avoid.
  it.each(['', '   ', ' ', '<br>'])('reports unknown, not zero, for the blank value %j', (input) => {
    const r = parseCompensation(input);
    expect(r.guaranteedMin).toBeNull();
    expect(r.guaranteedMax).toBeNull();
    expect(r.raffleMax).toBeNull();
    expect(r.raffleOnly).toBe(false);
    expect(r.confidence).toBe('low');
    expect(r.notes.join(' ')).toMatch(/no compensation stated/i);
    expect(r.raw).toBe(input);
  });

  it('distinguishes "no pay" (zero) from "unknown pay" (null)', () => {
    const nothing = parseCompensation('None');
    const unknown = parseCompensation('Compensation details available upon request.');

    expect(nothing.guaranteedMax).toBe(0);
    expect(unknown.guaranteedMax).toBeNull();
    expect(unknown.confidence).toBe('low');
    expect(unknown.notes.join(' ')).toMatch(/no dollar amount/i);
  });

  it('tolerates non-string input without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []] as unknown[]) {
      const r = parseCompensation(bad as string);
      expect(r.raw).toBe('');
      // Junk input is unknown pay, not zero pay - same rule as a blank field.
      expect(r.guaranteedMax).toBeNull();
      expect(r.confidence).toBe('low');
    }
  });
});

describe('purity', () => {
  it('returns identical results when the same value is parsed twice', () => {
    for (const v of DISTINCT_RAW_VALUES) {
      expect(parseCompensation(v)).toEqual(parseCompensation(v));
    }
  });

  it('is order-independent (no leaked regex lastIndex between calls)', () => {
    const forward = DISTINCT_RAW_VALUES.map((v) => parseCompensation(v));
    const backward = [...DISTINCT_RAW_VALUES].reverse().map((v) => parseCompensation(v));
    backward.reverse();
    expect(backward).toEqual(forward);
  });

  it('does not mutate the input string reference it was handed', () => {
    const raw = 'Up to $30 <br>Paid as Amazon gift card';
    const before = raw.slice();
    parseCompensation(raw);
    expect(raw).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 3. Invariants over all 86 records
// ---------------------------------------------------------------------------

const CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];
const CURRENCIES: CurrencyKind[] = ['cash', 'giftcard', 'credit', 'mixed', 'unknown'];

/** Every numeric field on the result, for blanket finiteness checks. */
function numericFields(r: ParsedCompensation): [string, number | null][] {
  return [
    ['guaranteedMin', r.guaranteedMin],
    ['guaranteedMax', r.guaranteedMax],
    ['raffleMax', r.raffleMax],
    ['hourlyMin', r.hourlyMin],
    ['hourlyMax', r.hourlyMax],
    ['perVisit', r.perVisit],
    ['visitCount', r.visitCount],
    ['completionBonus', r.completionBonus],
  ];
}

describe('invariants over all 86 snapshot records', () => {
  it('parses exactly 86 records', () => {
    expect(RECORDS).toHaveLength(86);
    expect(ALL_RAW_VALUES.every((v) => typeof v === 'string')).toBe(true);
  });

  const parsed = ALL_RAW_VALUES.map((raw, i) => ({ i, raw, r: parseCompensation(raw) }));

  it('guaranteedMin <= guaranteedMax whenever both are non-null', () => {
    for (const { i, raw, r } of parsed) {
      if (r.guaranteedMin !== null && r.guaranteedMax !== null) {
        expect(
          r.guaranteedMin <= r.guaranteedMax,
          `record ${i} (${JSON.stringify(raw.slice(0, 60))}): ${r.guaranteedMin} > ${r.guaranteedMax}`,
        ).toBe(true);
      }
    }
  });

  it('hourlyMin <= hourlyMax whenever both are non-null', () => {
    for (const { i, r } of parsed) {
      if (r.hourlyMin !== null && r.hourlyMax !== null) {
        expect(r.hourlyMin <= r.hourlyMax, `record ${i}`).toBe(true);
      }
    }
  });

  it('contains no NaN, no Infinity and no negative amounts', () => {
    for (const { i, raw, r } of parsed) {
      for (const [field, value] of numericFields(r)) {
        if (value === null) continue;
        const where = `record ${i} field ${field} (${JSON.stringify(raw.slice(0, 60))})`;
        expect(Number.isFinite(value), `${where} is not finite: ${value}`).toBe(true);
        expect(Number.isNaN(value), `${where} is NaN`).toBe(false);
        expect(value, where).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('rounds every money field to at most two decimal places', () => {
    for (const { i, r } of parsed) {
      for (const [field, value] of numericFields(r)) {
        if (value === null) continue;
        expect(Math.round(value * 100) / 100, `record ${i} field ${field}`).toBe(value);
      }
    }
  });

  it('raffleOnly === true implies guaranteedMax === 0', () => {
    for (const { i, raw, r } of parsed) {
      if (r.raffleOnly) {
        expect(r.guaranteedMax, `record ${i} (${JSON.stringify(raw.slice(0, 60))})`).toBe(0);
        expect(r.guaranteedMin, `record ${i}`).toBe(0);
      }
    }
  });

  it('raffleOnly === true implies a raffle prize was actually found', () => {
    for (const { i, r } of parsed) {
      if (r.raffleOnly) {
        expect(r.raffleMax, `record ${i}`).not.toBeNull();
        expect(r.raffleMax as number, `record ${i}`).toBeGreaterThan(0);
      }
    }
  });

  it('confidence is always one of the three allowed values', () => {
    for (const { i, r } of parsed) {
      expect(CONFIDENCES, `record ${i}`).toContain(r.confidence);
    }
  });

  it('currencyKind is always one of the five allowed values', () => {
    for (const { i, r } of parsed) {
      expect(CURRENCIES, `record ${i}`).toContain(r.currencyKind);
    }
  });

  it('raw round-trips unchanged', () => {
    for (const { i, raw, r } of parsed) {
      expect(r.raw, `record ${i}`).toBe(raw);
    }
  });

  it('notes is always an array of non-empty strings', () => {
    for (const { i, r } of parsed) {
      expect(Array.isArray(r.notes), `record ${i}`).toBe(true);
      for (const n of r.notes) {
        expect(typeof n, `record ${i}`).toBe('string');
        expect(n.length, `record ${i}`).toBeGreaterThan(0);
      }
    }
  });

  it('every low-or-medium confidence result explains itself in notes', () => {
    for (const { i, raw, r } of parsed) {
      if (r.confidence !== 'high') {
        expect(r.notes.length, `record ${i} (${JSON.stringify(raw.slice(0, 60))}) has no note`).toBeGreaterThan(0);
      }
    }
  });

  it('hourly fields are populated if and only if isHourlyRate', () => {
    for (const { i, r } of parsed) {
      if (r.isHourlyRate) {
        expect(r.hourlyMin, `record ${i}`).not.toBeNull();
        expect(r.hourlyMax, `record ${i}`).not.toBeNull();
      } else {
        expect(r.hourlyMin, `record ${i}`).toBeNull();
        expect(r.hourlyMax, `record ${i}`).toBeNull();
      }
    }
  });

  it('visitCount, when present, is a positive integer', () => {
    for (const { i, r } of parsed) {
      if (r.visitCount !== null) {
        expect(Number.isInteger(r.visitCount), `record ${i}`).toBe(true);
        expect(r.visitCount, `record ${i}`).toBeGreaterThan(0);
      }
    }
  });

  it('returns a complete object with every declared key on every record', () => {
    const keys = Object.keys({ ...DEFAULTS, raw: '', notes: [] }).sort();
    for (const { i, r } of parsed) {
      expect(Object.keys(r).sort(), `record ${i}`).toEqual(keys);
    }
  });

  it('leaves no record wholly unparsed: 77 of 86 have text, 9 are empty', () => {
    const empty = parsed.filter(({ raw }) => raw.trim() === '');
    expect(empty).toHaveLength(9);

    // Of the 77 non-empty values, only the two "None" records may report zero
    // guaranteed pay without being raffle-only.
    const zeroPay = parsed.filter(
      ({ raw, r }) => raw.trim() !== '' && r.guaranteedMax === 0 && !r.raffleOnly,
    );
    expect(zeroPay.map(({ raw }) => raw.trim())).toEqual(['None', 'None', 'None']);
  });

  it('finds a guaranteed amount, an hourly rate, or a raffle for every non-empty record', () => {
    const unparsed = parsed.filter(
      ({ raw, r }) =>
        raw.trim() !== '' &&
        r.guaranteedMin === null &&
        r.guaranteedMax === null &&
        !r.isHourlyRate &&
        r.raffleMax === null,
    );
    expect(unparsed.map(({ raw }) => raw)).toEqual([]);
  });
});

// ===========================================================================
// AUDIT REGRESSIONS - locked by fixture id
// ===========================================================================

/** The raw compensation meta value for a fixture record, by id. */
function rawComp(id: number): string {
  const found = RECORDS.find((r) => r.id === id);
  if (found === undefined) throw new Error(`fixture record ${id} is missing`);
  return found.meta.aux_study_item_compensation;
}

describe('REGRESSION F8: contingent performance money is not guaranteed money', () => {
  it('11899: the guaranteed ceiling excludes the per-visit performance bonus', () => {
    // raw: "Up to $20: Participants are compensated $5 per lab visit in the
    //       form of a gift card. Each participant will have an opportunity to
    //       earn an additional $5 during each lab visit for task-related
    //       reward."
    //
    // The parser already refuses to count "chance to win up to an additional
    // $5" as guaranteed pay on records 6745/4626/4624. "opportunity to earn an
    // additional $5" is the identical construction with the lottery word
    // removed, and it was landing in the ranking numerator - $20 / 0.9167 h =
    // $21.82/hr for a study whose guaranteed rate is $10.91/hr.
    const r = parseCompensation(rawComp(11899));
    expect(r.guaranteedMax).toBe(10);
    expect(r.perVisit).toBe(5);
    // $20 ceiling / ($5 guaranteed + $5 contingent) = exactly 2 occasions.
    // The decomposition is arithmetic, so the visit count falls out of it.
    expect(r.visitCount).toBe(2);
    // Contingent money is not silently deleted - the reader is told about it.
    expect(r.notes.join(' ')).toMatch(/contingent/i);
    // And it is NOT relabelled as a completion bonus, which the UI renders as
    // "guaranteed if you finish" - the exact claim this fix exists to deny.
    expect(r.completionBonus).toBeNull();
  });

  it('keeps completion bonuses inside guaranteed pay - showing up is not performing', () => {
    // The line the fix must not cross. A bonus you get by attending and
    // finishing is money you control; a bonus the study awards on your task
    // score is not. These three are all attendance money and must be untouched.
    expect(parseCompensation(rawComp(9821)).guaranteedMax).toBe(550); // "$100 bonus ... for completing all three visits"
    expect(parseCompensation(rawComp(11321)).guaranteedMax).toBe(1000); // "a completion bonus of $500 for completing all visits"
    expect(parseCompensation(rawComp(6995)).guaranteedMax).toBe(60); // "an additional $20 for completing both sessions"
    // And a bare "reward" is not a trigger: 6745's "session completion will
    // reward the participant $45 in cash" is ordinary attendance pay. Matching
    // it would strip $45 out of a real total.
    expect(parseCompensation(rawComp(6745)).guaranteedMax).toBe(165);
  });

  it('4632: an explicitly earnable bonus is excluded and explained', () => {
    // "complete a reward-based Doors task will receive up to an additional
    // $8.00" - contingent, so out of guaranteed pay, with a note saying so.
    expect(parseCompensation(rawComp(4632)).notes.join(' ')).toMatch(/contingent/i);
  });
});

// ===========================================================================
// AUDIT R1 / R2 - the contingent-money exclusion must not eat attendance pay
//
// The F8 fix above (contingent money out of guaranteed pay) was first landed
// with `(?:may|might|can|could|will)\s+(?:be\s+)?earn(?:ed)?` in the trigger
// alternation. Because a contingent clause runs from its trigger to the end of
// the sentence, that alternation swallowed the WHOLE payment of any listing
// that used "earn" as the ordinary verb for attendance pay - the single most
// common way this genre states it. `guaranteedMin/Max` came back 0/0, which
// `RateBadge` renders as literally "Unpaid" (RateBadge.astro:64-67), so a paid
// study would ship as unpaid, drop into the 'low' bucket, and be filtered out
// by anyone screening on rate.
//
// The five strings below are the exact probes from `__audit__.md` R1. Rows 4
// and 5 kept their money under the broken regex purely because the amount
// happened to sit BEFORE the trigger - the tell that the behaviour turned on
// word order rather than on meaning. All five must now agree.
//
// This is a FALSE-NEGATIVE-PREFERRING rule and that is deliberate: F8 cost one
// study a 2x overstatement, R1 can zero a study out entirely. Do not widen the
// trigger to make one of these pass.
// ===========================================================================

describe('REGRESSION R1: "will/can earn" is attendance pay, never contingent pay', () => {
  /** The five probes from __audit__.md R1, before -> after. */
  const PROBES: { raw: string; min: number | null; max: number | null; why: string }[] = [
    {
      raw: 'Participants will earn $30 for completing the survey.',
      min: 30,
      max: 30,
      why: 'was 0/0 and shipped as "Unpaid"',
    },
    {
      raw: 'You can earn $45 for the session.',
      min: 45,
      max: 45,
      why: 'was 0/0 and shipped as "Unpaid"',
    },
    {
      raw: 'You will earn up to $200 over the course of the study.',
      min: null,
      max: 200,
      why: 'was 0/0; the honest answer is a ceiling with an unknown floor',
    },
    {
      raw: 'Participants will be earning $30.',
      min: 30,
      max: 30,
      why: 'never broken - the amount followed the trigger',
    },
    {
      raw: 'Payment is $60, which will be earned upon completion of all visits.',
      min: 60,
      max: 60,
      why: 'never broken - the amount preceded the trigger',
    },
  ];

  for (const { raw, min, max, why } of PROBES) {
    it(`${JSON.stringify(raw)} -> ${String(min)}/${String(max)} (${why})`, () => {
      const r = parseCompensation(raw);
      expect({ guaranteedMin: r.guaranteedMin, guaranteedMax: r.guaranteedMax }).toEqual({
        guaranteedMin: min,
        guaranteedMax: max,
      });
      // The specific harm: a real payment reported as a confident zero.
      expect(r.guaranteedMax, 'a paying study must never parse as $0').not.toBe(0);
      expect(r.notes.join(' '), 'attendance pay is not contingent money').not.toMatch(/contingent/i);
    });
  }

  it('rows 1, 2 and 4 agree: word order and inflection do not change the answer', () => {
    // The three ways to say the same $30 attendance payment.
    const rates = [
      'Participants will earn $30 for completing the survey.',
      'Participants will be earning $30.',
      'Participants receive $30 for completing the survey.',
    ].map((s) => parseCompensation(s).guaranteedMax);
    expect(rates).toEqual([30, 30, 30]);
  });

  it('5945: "You can earn up to $300" is a real corpus ceiling, not contingent money', () => {
    // The reason the omission is load-bearing rather than theoretical. This
    // string is in the snapshot today; under the broken regex the whole $300
    // went to zero.
    const r = parseCompensation(rawComp(5945));
    expect(r.guaranteedMax).toBe(300);
    expect(r.notes.join(' ')).not.toMatch(/contingent/i);
  });

  it('still catches the construction F8 was about: "opportunity to earn"', () => {
    // Narrowing must not reopen F8. Something has to GRANT the opportunity to
    // earn; merely describing earning as the mechanism of payment is not it.
    expect(parseCompensation(rawComp(11899)).guaranteedMax).toBe(10);

    const kept = parseCompensation(
      'Participants receive $40 for the visit. Each participant will have an opportunity to earn an additional $10 for accuracy.',
    );
    expect(kept.guaranteedMax).toBe(40);
    expect(kept.notes.join(' ')).toMatch(/contingent/i);
  });

  it('4615: an unpriced bonus is still surfaced, by the unpriced-bonus path', () => {
    // "For some experiments, additional bonuses may be earned during the study"
    // used to match the deleted alternation. It carries no dollar figure, so
    // dropping it from the contingent trigger costs nothing: the note comes
    // from the unpriced-bonus path at the end of parseCompensation instead.
    const r = parseCompensation(rawComp(4615));
    expect(r.hourlyMax).toBe(10);
    expect(r.notes.join(' ')).toMatch(/bonus/i);
  });
});

describe('REGRESSION R2: all-contingent pay is unknown ($null), not a measured $0', () => {
  it('"opportunity to earn $50 based on task performance" has an UNKNOWN floor', () => {
    // effective-rate.ts's own rule: `guaranteedMax: 0` is a measurement,
    // `guaranteedMax: null` is the absence of one. "You may earn up to $X if
    // you perform" states no floor at all, so emitting 0 turns silence into a
    // confident claim that the study pays nothing - it ranks the study in the
    // 'low' bucket, renders it "Unpaid", and (because 0 is not null) suppresses
    // the content-fallback that would otherwise go looking in the body.
    const r = parseCompensation('Participants have an opportunity to earn $50 based on task performance.');
    expect(r.guaranteedMin).toBeNull();
    expect(r.guaranteedMax).toBeNull();
    expect(r.confidence).toBe('low');
    // The money is not deleted from the page, only from the guarantee.
    expect(r.notes.join(' ')).toMatch(/contingent/i);
  });

  it('a raffle-only listing keeps its legitimate $0 - a lottery ticket is a complete offer', () => {
    // The distinction R2 turns on. "Enter a drawing for a $50 gift card" fully
    // describes what is on offer, and its guaranteed component really is a
    // measured zero. 8417 and 6978 are the corpus cases.
    for (const id of [8417, 6978]) {
      const r = parseCompensation(rawComp(id));
      expect(r.raffleOnly, `record ${id}`).toBe(true);
      expect(r.guaranteedMax, `record ${id}`).toBe(0);
    }
  });

  it('"None" is still a measured zero, and blank is still unknown', () => {
    // The two poles either side of the contingent case, unchanged.
    const none = parseCompensation('None');
    expect(none.guaranteedMax).toBe(0);
    expect(none.confidence).toBe('high');

    const blank = parseCompensation('');
    expect(blank.guaranteedMax).toBeNull();
    expect(blank.confidence).toBe('low');
  });
});

describe('REGRESSION F15: a listing that contradicts itself says so', () => {
  it('8338: itemised amounts sum to $130 but the stated total is $120', () => {
    // raw: "The participants will receive $20 for the first session, $35 for
    //       the second, $30 for the third, and $45 for the fourth. ... The
    //       total compensation for completing all four sessions is $120."
    //
    // 20 + 35 + 30 + 45 = 130. Rule 2 (a stated total beats a computed one) is
    // still right and $120 is still the number used - but the reader had no
    // way to know the listing disagrees with itself, on a study where the gap
    // is 8% of the pay.
    const r = parseCompensation(rawComp(8338));
    expect(r.guaranteedMax).toBe(120);
    expect(r.visitCount).toBe(4);
    const note = r.notes.find((n) => /contradict/i.test(n));
    expect(note, 'no contradiction note on 8338').toBeDefined();
    expect(note).toMatch(/130/);
    expect(note).toMatch(/120/);
  });

  it('does not cry contradiction on listings that merely itemise', () => {
    // The trigger has to be narrow or it fires on every breakdown. Two
    // near-misses, both of which must stay silent:
    //   8458 - "$50 for the screening visit and $125 for each study visit (3).
    //           Total $425" - two component amounts against a visit count of 3,
    //           and a per-visit rate, so the components are not an itemisation.
    //   8331 - components sum to $110 against a stated $80, but no visit count
    //           parses, so there is nothing to check the itemisation against.
    for (const id of [8458, 8331]) {
      expect(
        parseCompensation(rawComp(id)).notes.filter((n) => /contradict/i.test(n)),
        `record ${id}`,
      ).toEqual([]);
    }
  });
});
