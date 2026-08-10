/**
 * EFFECTIVE-RATE TEST SUITE
 * =========================
 *
 * `effectiveHourly` is the headline sort key of the whole product, so the tests
 * here are organised around the three ways it can lie:
 *
 *   1. inventing a number    - 6 calendar weeks read as 1008 contact hours
 *   2. inventing a zero      - "we could not tell" rendered as "$0.00/hr"
 *   3. inventing an infinity - dividing guaranteed pay by zero hours
 *
 * null means UNKNOWN and only unknown. It sorts last in BOTH directions, and it
 * is never 0, NaN, Infinity or negative.
 *
 * Structure:
 *   1. computeEffectiveHourly - inputs, guards, and the never-NaN sweep
 *   2. THE HEADLINE CASE      - study 12775 end-to-end from raw meta
 *   3. THE CONVERSE           - a study with real contact hours computes a sane rate
 *   4. rateBucket             - boundaries at each documented threshold
 *   5. isKnownRate / compareByEffectiveHourly
 *   6. sortStudies            - nulls last ascending AND descending
 *   7. KNOWN ISSUES           - audit findings pinned as-is, not endorsed
 *   8. AUDIT REGRESSIONS      - F1/F5/F8/F16 rates, locked by fixture id
 *   9. F2 scope reconciliation - per-visit pay vs whole-study hours
 *  10. R1/R2                  - "will earn" is pay; contingent pay is unknown
 *  11. F11 unrated ordering   - the money-first order index.astro renders
 *  12. GOLDEN top 10          - the ranking itself, in order
 *  13. fixture sweep          - the invariants across all 86 real records
 *
 * Tests are hermetic: they read fixtures/arv-snapshot.json and never the network.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RATE_BUCKET_THRESHOLDS,
  compareByEffectiveHourly,
  computeEffectiveHourly,
  guaranteedTotal,
  isKnownRate,
  rateBucket,
  reconcileEffectiveHourly,
  sortStudies,
  sortUnrated,
} from '@/lib/effective-rate.ts';
import type { RankableStudy } from '@/lib/effective-rate.ts';
import { parseCompensation } from '@/lib/parse-compensation.ts';
import { parseDuration } from '@/lib/parse-duration.ts';
import { normalizeAndDedupe } from '@/lib/normalize.ts';
import type { ParsedCompensation, ParsedDuration, RawStudy, StudyRecord } from '@/types.ts';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url)), 'utf8'),
) as RawStudy[];

// ---------------------------------------------------------------------------
// Builders - every field defaults to "unknown" so each test states only what
// it is actually about.
// ---------------------------------------------------------------------------

function comp(overrides: Partial<ParsedCompensation> = {}): ParsedCompensation {
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
    raw: '',
    confidence: 'high',
    notes: [],
    ...overrides,
  };
}

function dur(overrides: Partial<ParsedDuration> = {}): ParsedDuration {
  return {
    totalHoursMin: null,
    totalHoursMax: null,
    sessionCount: null,
    spanWeeks: null,
    raw: '',
    confidence: 'high',
    ...overrides,
  };
}

/** Parse a fixture record's two meta strings exactly as the build pipeline does. */
function rateForStudy(id: number): { rate: number | null; compensation: ParsedCompensation; duration: ParsedDuration } {
  const study = fixture.find((s) => s.id === id);
  if (study === undefined) throw new Error(`fixture record ${id} is missing`);
  const compensation = parseCompensation(study.meta.aux_study_item_compensation);
  const duration = parseDuration(study.meta.aux_study_item_duration);
  return { rate: computeEffectiveHourly(compensation, duration), compensation, duration };
}

// ---------------------------------------------------------------------------
// 1. computeEffectiveHourly
// ---------------------------------------------------------------------------

describe('computeEffectiveHourly - the arithmetic', () => {
  it('divides guaranteed ceiling pay by the ceiling of committed hours', () => {
    expect(computeEffectiveHourly(comp({ guaranteedMax: 100 }), dur({ totalHoursMax: 4 }))).toBe(25);
    expect(computeEffectiveHourly(comp({ guaranteedMax: 20 }), dur({ totalHoursMax: 0.5 }))).toBe(40);
  });

  it('pairs the ceiling of pay with the ceiling of hours, never the floor of hours', () => {
    // $100 for 2-5 hours is $20/hr in the advertised scenario. Dividing by the
    // 2-hour floor would advertise $50/hr for every study that quotes a range.
    const rate = computeEffectiveHourly(
      comp({ guaranteedMin: 100, guaranteedMax: 100 }),
      dur({ totalHoursMin: 2, totalHoursMax: 5 }),
    );
    expect(rate).toBe(20);
  });

  it('falls back to the guaranteed floor when only one bound parsed', () => {
    expect(computeEffectiveHourly(comp({ guaranteedMin: 30, guaranteedMax: null }), dur({ totalHoursMax: 4 }))).toBe(
      7.5,
    );
  });

  it('falls back to the hours floor when only one bound parsed', () => {
    expect(computeEffectiveHourly(comp({ guaranteedMax: 30 }), dur({ totalHoursMin: 2, totalHoursMax: null }))).toBe(15);
  });

  it('rounds to cents', () => {
    expect(computeEffectiveHourly(comp({ guaranteedMax: 100 }), dur({ totalHoursMax: 3 }))).toBe(33.33);
    expect(computeEffectiveHourly(comp({ guaranteedMax: 50 }), dur({ totalHoursMax: 3.5 }))).toBe(14.29);
  });

  it('prefers a rate the listing states per hour over arithmetic', () => {
    // A stated rate is the study's own claim and stays right even when the
    // duration text is unparseable.
    expect(computeEffectiveHourly(comp({ isHourlyRate: true, hourlyMin: 20, hourlyMax: 20 }), dur())).toBe(20);
    expect(
      computeEffectiveHourly(comp({ isHourlyRate: true, hourlyMin: 15, hourlyMax: 25 }), dur({ totalHoursMax: 1 })),
    ).toBe(25);
  });

  it('uses the stated hourly floor when only the floor parsed', () => {
    expect(computeEffectiveHourly(comp({ isHourlyRate: true, hourlyMin: 12, hourlyMax: null }), dur())).toBe(12);
  });

  it('falls through to arithmetic when flagged hourly but carrying no number', () => {
    expect(
      computeEffectiveHourly(
        comp({ isHourlyRate: true, hourlyMin: null, hourlyMax: null, guaranteedMax: 100 }),
        dur({ totalHoursMax: 4 }),
      ),
    ).toBe(25);
  });
});

describe('computeEffectiveHourly - unknown must stay unknown', () => {
  it('returns null for nullish inputs', () => {
    expect(computeEffectiveHourly(null, dur({ totalHoursMax: 2 }))).toBeNull();
    expect(computeEffectiveHourly(comp({ guaranteedMax: 50 }), null)).toBeNull();
    expect(computeEffectiveHourly(undefined, undefined)).toBeNull();
    expect(computeEffectiveHourly(null, null)).toBeNull();
  });

  it('returns null when pay is unknown', () => {
    expect(computeEffectiveHourly(comp(), dur({ totalHoursMax: 2 }))).toBeNull();
  });

  it('returns null when hours are unknown, however generous the pay', () => {
    // This is the calendar-span path: "Approximately 6 weeks" parses to a span
    // with no contact hours, and $400 divided by nothing is not a number.
    expect(computeEffectiveHourly(comp({ guaranteedMax: 400 }), dur({ spanWeeks: 6 }))).toBeNull();
  });

  it('returns null rather than Infinity when hours are zero', () => {
    const rate = computeEffectiveHourly(comp({ guaranteedMax: 100 }), dur({ totalHoursMin: 0, totalHoursMax: 0 }));
    expect(rate).toBeNull();
    expect(rate).not.toBe(Infinity);
  });

  it('returns null for raffle-only compensation - a lottery ticket is not a wage', () => {
    expect(
      computeEffectiveHourly(
        comp({ raffleOnly: true, raffleMax: 50, guaranteedMin: 0, guaranteedMax: 0 }),
        dur({ totalHoursMax: 0.25 }),
      ),
    ).toBeNull();
  });

  it('ignores raffle money even when guaranteed pay exists alongside it', () => {
    // raffleMax is expected value at best and must never enter the numerator.
    expect(computeEffectiveHourly(comp({ guaranteedMax: 60, raffleMax: 500 }), dur({ totalHoursMax: 1.5 }))).toBe(40);
  });

  it('returns 0 - not null - for a study that genuinely pays nothing', () => {
    // The one legitimate zero. `guaranteedMax: 0` is a measurement ("None");
    // `guaranteedMax: null` is the absence of one. They must not collapse.
    expect(computeEffectiveHourly(comp({ guaranteedMin: 0, guaranteedMax: 0 }), dur({ totalHoursMax: 0.25 }))).toBe(0);
    expect(computeEffectiveHourly(comp({ guaranteedMin: null, guaranteedMax: null }), dur({ totalHoursMax: 0.25 }))).toBeNull();
  });

  it('rejects negative pay and negative hours instead of producing a negative rate', () => {
    expect(computeEffectiveHourly(comp({ guaranteedMin: -50, guaranteedMax: -50 }), dur({ totalHoursMax: 2 }))).toBeNull();
    expect(
      computeEffectiveHourly(comp({ guaranteedMax: 50 }), dur({ totalHoursMin: -2, totalHoursMax: -4 })),
    ).toBeNull();
  });

  it('rejects non-finite pay and hours', () => {
    expect(computeEffectiveHourly(comp({ guaranteedMax: Number.NaN }), dur({ totalHoursMax: 2 }))).toBeNull();
    expect(computeEffectiveHourly(comp({ guaranteedMax: Infinity }), dur({ totalHoursMax: 2 }))).toBeNull();
    expect(computeEffectiveHourly(comp({ guaranteedMax: 50 }), dur({ totalHoursMax: Number.NaN }))).toBeNull();
    // Infinite hours is not a usable divisor either: it falls back to the
    // (absent) floor and ends up null rather than an apparent $0.00/hr.
    expect(computeEffectiveHourly(comp({ guaranteedMax: 50 }), dur({ totalHoursMax: Infinity }))).toBeNull();
  });

  it('never returns NaN, Infinity or a negative number for any combination of adversarial inputs', () => {
    const pays = [null, 0, -0, -1, 1, 0.01, 400, 1e12, Number.NaN, Infinity, -Infinity];
    const hours = [null, 0, -0, -1, 1e-9, 0.25, 1, 2000, Number.NaN, Infinity, -Infinity];
    const flags = [false, true];

    for (const guaranteedMax of pays) {
      for (const guaranteedMin of pays) {
        for (const totalHoursMax of hours) {
          for (const totalHoursMin of hours) {
            for (const raffleOnly of flags) {
              for (const isHourlyRate of flags) {
                const rate = computeEffectiveHourly(
                  comp({ guaranteedMin, guaranteedMax, raffleOnly, isHourlyRate, hourlyMin: null, hourlyMax: null }),
                  dur({ totalHoursMin, totalHoursMax }),
                );
                if (rate === null) continue;
                const label = `pay ${guaranteedMin}/${guaranteedMax} hours ${totalHoursMin}/${totalHoursMax}`;
                expect(Number.isNaN(rate), label).toBe(false);
                expect(Number.isFinite(rate), label).toBe(true);
                expect(rate, label).toBeGreaterThanOrEqual(0);
              }
            }
          }
        }
      }
    }
  });

  it('never returns NaN or Infinity for adversarial stated hourly rates', () => {
    const rates = [null, 0, -0, -5, 5, Number.NaN, Infinity, -Infinity];
    for (const hourlyMin of rates) {
      for (const hourlyMax of rates) {
        const rate = computeEffectiveHourly(comp({ isHourlyRate: true, hourlyMin, hourlyMax }), dur());
        if (rate === null) continue;
        const label = `hourly ${hourlyMin}/${hourlyMax}`;
        expect(Number.isFinite(rate), label).toBe(true);
        expect(rate, label).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE HEADLINE CASE
// ---------------------------------------------------------------------------

describe('THE HEADLINE CASE: study 12775, gallotannins x intestinal microbiome', () => {
  const study = fixture.find((s) => s.id === 12775);

  it('is still in the fixture with the pairing this site was built around', () => {
    expect(study?.meta.aux_study_item_compensation).toBe('$400.00');
    expect(study?.meta.aux_study_item_duration).toBe('Approximately 6 weeks');
  });

  /**
   * THIS EXACT CONFUSION IS WHAT THE SITE EXISTS TO PREVENT.
   *
   * "Approximately 6 weeks" is a CALENDAR SPAN - how long the study runs - not
   * contact time. Treat the span as hours and 6 weeks becomes 6 * 7 * 24 = 1008
   * hours, so the arithmetic reports
   *
   *     $400.00 / 1008 h = $0.40/hr
   *
   * A student sorting by hourly rate would then see the best-paying study on
   * the board sitting at the very bottom, beneath a $10 fifteen-minute survey,
   * labelled as paying forty cents an hour. The gentler variants of the same
   * mistake are no better - 6 weeks of 40-hour weeks gives $1.67/hr, 6 weeks of
   * 8-hour days gives $1.19/hr - because all three numbers are inventions. The
   * listing never states how many hours the participant actually spends.
   *
   * The honest output is null: pay is known ($400), hours are not, so the rate
   * cannot be computed and the study belongs in the clearly-labelled "unknown
   * rate" bucket where it prompts the reader to ask the coordinator.
   */
  it('produces effectiveHourly null - NOT ~$0.40/hr from 1008 phantom contact hours', () => {
    const { rate, compensation, duration } = rateForStudy(12775);

    // Pay parsed fine; it is the hours that are genuinely unknown.
    expect(compensation.guaranteedMax).toBe(400);
    expect(duration.spanWeeks).toBe(6);
    expect(duration.totalHoursMax).toBeNull();

    expect(rate).toBeNull();

    // The numbers a span-as-hours parser would have produced. None may appear.
    expect(rate).not.toBeCloseTo(0.4, 2); // 400 / 1008
    expect(rate).not.toBeCloseTo(1.19, 2); // 400 / 336
    expect(rate).not.toBeCloseTo(1.67, 2); // 400 / 240
    // And it is not a zero, an Infinity, or a NaN pretending to be a rate.
    expect(rate).not.toBe(0);
    expect(rate).not.toBe(Infinity);
    expect(Number.isNaN(rate as number)).toBe(false);
  });

  it('lands in the "unknown" bucket, never in "low"', () => {
    const { rate } = rateForStudy(12775);
    expect(rateBucket(rate)).toBe('unknown');
    // 0.40 would have been bucketed 'low' - "this study is a bad deal" - which
    // is a claim about a $400 study that the data does not support.
    expect(rateBucket(0.4)).toBe('low');
  });

  it('sorts to the unknown block at the end, not to the bottom of the known rates', () => {
    const { rate } = rateForStudy(12775);
    const board: RankableStudy[] = [{ effectiveHourly: 12 }, { effectiveHourly: rate }, { effectiveHourly: 5 }];

    // Descending: unknown last.
    expect(sortStudies(board, 'desc').map((s) => s.effectiveHourly)).toEqual([12, 5, null]);
    // Ascending: still last. A 0.40 would have sorted FIRST here - presented as
    // the cheapest study on the board.
    expect(sortStudies(board, 'asc').map((s) => s.effectiveHourly)).toEqual([5, 12, null]);
  });

  it('applies the same protection to every other calendar-span-only listing', () => {
    // Same failure mode, different records: pay is stated, hours are not.
    for (const id of [11321, 8876, 8404, 6953, 4642, 4630, 8333]) {
      const { rate, duration } = rateForStudy(id);
      expect(duration.totalHoursMax, `record ${id}`).toBeNull();
      expect(rate, `record ${id}`).toBeNull();
      expect(rateBucket(rate), `record ${id}`).toBe('unknown');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. THE CONVERSE
// ---------------------------------------------------------------------------

describe('THE CONVERSE: stated contact hours produce a real rate', () => {
  it('study 11896 - "$20/ hr" x "3 visits, 5 hours total" - computes $20.00/hr', () => {
    const { rate, compensation, duration } = rateForStudy(11896);

    expect(compensation.isHourlyRate).toBe(true);
    expect(duration.totalHoursMax).toBe(5);
    expect(duration.sessionCount).toBe(3);

    expect(rate).toBe(20);
    expect(rateBucket(rate)).toBe('good');
    expect(isKnownRate(rate)).toBe(true);
  });

  it('the same duration string with a lump-sum payment divides correctly', () => {
    // "3 visits, 5 hours total" at a flat $100 is $20/hr - and the 5 hours is
    // the TOTAL, so the three visits must not multiply it to 15 hours.
    const duration = parseDuration('3 visits, 5 hours total');
    expect(duration.totalHoursMax).toBe(5);
    expect(computeEffectiveHourly(comp({ guaranteedMin: 100, guaranteedMax: 100 }), duration)).toBe(20);
  });

  it('study 5436 - "$50 per visit for 2 visits ($100 total)" over "(6 hours total)" - $16.67/hr', () => {
    const { rate } = rateForStudy(5436);
    expect(rate).toBe(16.67);
    expect(rateBucket(rate)).toBe('ok');
  });

  it('study 4593 - $560 over 27 distributive hours - $20.74/hr', () => {
    const { rate, duration } = rateForStudy(4593);
    expect(duration.totalHoursMax).toBe(27); // 3 + 12x1.5 + 3x2
    expect(rate).toBe(20.74);
  });

  it('study 8331 - a 40-50 minute survey for $80 - $96.00/hr', () => {
    // Short and well paid is a real and important result, not an outlier to
    // be smoothed away.
    const { rate } = rateForStudy(8331);
    expect(rate).toBe(96);
    expect(rateBucket(rate)).toBe('great');
  });

  it('study 6980 - "12.5 hours over a 3-week period" for $175 - $14.00/hr', () => {
    // The mirror image of the headline case: the SAME string carries both a
    // calendar span and real contact hours, and only the hours are divided.
    const { rate, duration } = rateForStudy(6980);
    expect(duration.spanWeeks).toBe(3);
    expect(duration.totalHoursMax).toBe(12.5);
    expect(rate).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// 4. rateBucket
// ---------------------------------------------------------------------------

describe('rateBucket', () => {
  it('exposes the documented thresholds', () => {
    expect(RATE_BUCKET_THRESHOLDS).toEqual({ ok: 10, good: 20, great: 40 });
  });

  it('is inclusive-lower and exclusive-upper at every boundary', () => {
    const boundaries: [number, string][] = [
      [0, 'low'],
      [9.99, 'low'],
      [9.999, 'low'],
      [RATE_BUCKET_THRESHOLDS.ok - 1e-9, 'low'], // a hair under $10
      [RATE_BUCKET_THRESHOLDS.ok, 'ok'], // exactly $10.00 is 'ok'
      [10.01, 'ok'],
      [19.99, 'ok'],
      [RATE_BUCKET_THRESHOLDS.good - 1e-9, 'ok'], // a hair under $20
      [RATE_BUCKET_THRESHOLDS.good, 'good'], // exactly $20.00 is 'good'
      [20.01, 'good'],
      [39.99, 'good'],
      [RATE_BUCKET_THRESHOLDS.great - 1e-9, 'good'], // a hair under $40
      [RATE_BUCKET_THRESHOLDS.great, 'great'], // exactly $40.00 is 'great'
      [40.01, 'great'],
      [1000, 'great'],
    ];
    for (const [rate, bucket] of boundaries) {
      expect(rateBucket(rate), `$${rate}/hr`).toBe(bucket);
    }
  });

  it('buckets a genuine $0.00/hr study as low, not unknown', () => {
    // $0 is a fact about the study; the UI should say "pays nothing", not
    // "we do not know what this pays".
    expect(rateBucket(0)).toBe('low');
  });

  it('buckets null as unknown', () => {
    expect(rateBucket(null)).toBe('unknown');
  });

  it('buckets NaN, Infinity and negatives as unknown rather than as a bad deal', () => {
    expect(rateBucket(Number.NaN)).toBe('unknown');
    expect(rateBucket(Infinity)).toBe('unknown');
    expect(rateBucket(-Infinity)).toBe('unknown');
    expect(rateBucket(-1)).toBe('unknown');
    expect(rateBucket(undefined as unknown as number)).toBe('unknown');
  });

  it('sits below a campus job at the low/ok boundary, which is the point of $10', () => {
    // Federal minimum is $7.25 and campus jobs run $10-13, so anything under
    // $10 costs the participant money in opportunity terms.
    expect(rateBucket(7.25)).toBe('low');
    expect(rateBucket(13)).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 5. isKnownRate and compareByEffectiveHourly
// ---------------------------------------------------------------------------

describe('isKnownRate', () => {
  it('accepts finite non-negative numbers, including zero', () => {
    expect(isKnownRate(0)).toBe(true);
    expect(isKnownRate(0.01)).toBe(true);
    expect(isKnownRate(137.5)).toBe(true);
  });

  it('rejects null and every non-measurement', () => {
    expect(isKnownRate(null)).toBe(false);
    expect(isKnownRate(Number.NaN)).toBe(false);
    expect(isKnownRate(Infinity)).toBe(false);
    expect(isKnownRate(-1)).toBe(false);
    expect(isKnownRate(undefined as unknown as number)).toBe(false);
  });
});

describe('compareByEffectiveHourly', () => {
  it('orders known rates high-to-low by default', () => {
    expect(compareByEffectiveHourly(30, 10)).toBeLessThan(0);
    expect(compareByEffectiveHourly(10, 30)).toBeGreaterThan(0);
    expect(compareByEffectiveHourly(10, 10)).toBe(0);
  });

  it('orders known rates low-to-high when ascending', () => {
    expect(compareByEffectiveHourly(10, 30, 'asc')).toBeLessThan(0);
    expect(compareByEffectiveHourly(30, 10, 'asc')).toBeGreaterThan(0);
  });

  it('pushes unknowns after knowns in BOTH directions', () => {
    for (const direction of ['desc', 'asc'] as const) {
      expect(compareByEffectiveHourly(null, 10, direction), direction).toBeGreaterThan(0);
      expect(compareByEffectiveHourly(10, null, direction), direction).toBeGreaterThan(-1e9);
      expect(compareByEffectiveHourly(10, null, direction), direction).toBeLessThan(0);
      // Even a $0.00 known rate outranks an unknown - it is information.
      expect(compareByEffectiveHourly(0, null, direction), direction).toBeLessThan(0);
    }
  });

  it('treats two unknowns as equal so their original order survives', () => {
    expect(compareByEffectiveHourly(null, null)).toBe(0);
    expect(compareByEffectiveHourly(null, null, 'asc')).toBe(0);
  });

  it('treats NaN and Infinity as unknown, not as extreme rates', () => {
    expect(compareByEffectiveHourly(Number.NaN, 10)).toBeGreaterThan(0);
    expect(compareByEffectiveHourly(Infinity, 10)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. sortStudies
// ---------------------------------------------------------------------------

describe('sortStudies', () => {
  const board = (): RankableStudy[] => [
    { effectiveHourly: 12 },
    { effectiveHourly: null },
    { effectiveHourly: 40 },
    { effectiveHourly: 0 },
    { effectiveHourly: null },
    { effectiveHourly: 7.5 },
  ];

  it('sorts best-paying first by default', () => {
    expect(sortStudies(board()).map((s) => s.effectiveHourly)).toEqual([40, 12, 7.5, 0, null, null]);
  });

  it('sinks unknowns to the end when sorting DESCENDING', () => {
    const sorted = sortStudies(board(), 'desc').map((s) => s.effectiveHourly);
    expect(sorted.slice(-2)).toEqual([null, null]);
    expect(sorted.slice(0, 4)).toEqual([40, 12, 7.5, 0]);
  });

  it('sinks unknowns to the end when sorting ASCENDING', () => {
    // The case that is easy to get wrong: a naive ascending sort with null
    // coerced to 0 would present unrated studies as the cheapest on the board.
    const sorted = sortStudies(board(), 'asc').map((s) => s.effectiveHourly);
    expect(sorted).toEqual([0, 7.5, 12, 40, null, null]);
    expect(sorted.slice(-2)).toEqual([null, null]);
    expect(sorted[0]).not.toBeNull();
  });

  it('sinks NaN and Infinity rates alongside nulls in both directions', () => {
    const weird: RankableStudy[] = [
      { effectiveHourly: Number.NaN },
      { effectiveHourly: 15 },
      { effectiveHourly: Infinity },
      { effectiveHourly: null },
    ];
    for (const direction of ['desc', 'asc'] as const) {
      const sorted = sortStudies(weird, direction);
      expect(sorted[0]?.effectiveHourly, direction).toBe(15);
      expect(sorted.slice(1).every((s) => !isKnownRate(s.effectiveHourly)), direction).toBe(true);
    }
  });

  it('returns a new array and does not mutate the input', () => {
    const input = board();
    const before = input.map((s) => s.effectiveHourly);
    const sorted = sortStudies(input);
    expect(sorted).not.toBe(input);
    expect(input.map((s) => s.effectiveHourly)).toEqual(before);
  });

  it('accepts a readonly array', () => {
    const frozen: readonly RankableStudy[] = Object.freeze([{ effectiveHourly: 5 }, { effectiveHourly: 10 }]);
    expect(() => sortStudies(frozen)).not.toThrow();
    expect(sortStudies(frozen).map((s) => s.effectiveHourly)).toEqual([10, 5]);
  });

  it('is stable, so a caller can pre-sort by date and keep it as the tie-break', () => {
    interface Dated extends RankableStudy {
      id: string;
    }
    const tied: Dated[] = [
      { id: 'a', effectiveHourly: 10 },
      { id: 'b', effectiveHourly: 10 },
      { id: 'c', effectiveHourly: null },
      { id: 'd', effectiveHourly: null },
    ];
    expect(sortStudies(tied).map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortStudies(tied, 'asc').map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles empty and all-unknown inputs', () => {
    expect(sortStudies([])).toEqual([]);
    const allUnknown: RankableStudy[] = [{ effectiveHourly: null }, { effectiveHourly: null }];
    expect(sortStudies(allUnknown)).toHaveLength(2);
    expect(sortStudies(allUnknown, 'asc').every((s) => s.effectiveHourly === null)).toBe(true);
  });

  it('preserves every input element - sorting never drops an unrated study', () => {
    const input = board();
    expect(sortStudies(input)).toHaveLength(input.length);
    expect(sortStudies(input, 'asc')).toHaveLength(input.length);
  });
});

// ---------------------------------------------------------------------------
// 7. Fixture sweep - the invariant across all 86 real records
// ---------------------------------------------------------------------------

describe('invariant sweep over all 86 fixture records', () => {
  const computed = fixture.map((study) => ({
    id: study.id,
    compRaw: study.meta.aux_study_item_compensation,
    durRaw: study.meta.aux_study_item_duration,
    rate: computeEffectiveHourly(
      parseCompensation(study.meta.aux_study_item_compensation),
      parseDuration(study.meta.aux_study_item_duration),
    ),
  }));

  it('covers all 86 records', () => {
    expect(computed).toHaveLength(86);
  });

  it('every effectiveHourly is null or a finite non-negative number - never NaN, Infinity or negative', () => {
    for (const { id, rate } of computed) {
      if (rate === null) continue;
      expect(typeof rate, `record ${id}`).toBe('number');
      expect(Number.isNaN(rate), `record ${id}`).toBe(false);
      expect(Number.isFinite(rate), `record ${id}`).toBe(true);
      expect(rate, `record ${id}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('every effectiveHourly is strictly positive unless the listing states no pay', () => {
    // The only legitimate 0.00/hr is a study that says it pays nothing.
    for (const { id, compRaw, rate } of computed) {
      if (rate === null || rate > 0) continue;
      expect(compRaw.trim().toLowerCase(), `record ${id} computed $0.00/hr`).toMatch(/^(?:none|)$/);
    }
  });

  it('every record with a rate has both parseable pay and parseable contact hours', () => {
    for (const { id, durRaw, rate } of computed) {
      if (rate === null) continue;
      const duration = parseDuration(durRaw);
      const compensation = parseCompensation(fixture.find((s) => s.id === id)?.meta.aux_study_item_compensation ?? '');
      const hasHours = duration.totalHoursMax !== null || duration.totalHoursMin !== null;
      // A stated hourly rate is allowed to stand in for unparseable hours.
      expect(hasHours || compensation.isHourlyRate, `record ${id}`).toBe(true);
    }
  });

  it('every record whose duration has no contact hours has a null rate, unless pay is stated per hour', () => {
    for (const study of fixture) {
      const duration = parseDuration(study.meta.aux_study_item_duration);
      if (duration.totalHoursMax !== null) continue;
      const compensation = parseCompensation(study.meta.aux_study_item_compensation);
      if (compensation.isHourlyRate) continue;
      expect(computeEffectiveHourly(compensation, duration), `record ${study.id}`).toBeNull();
    }
  });

  it('rateBucket returns a valid label for all 86, and unknowns are labelled unknown', () => {
    const valid = ['unknown', 'low', 'ok', 'good', 'great'];
    for (const { id, rate } of computed) {
      const bucket = rateBucket(rate);
      expect(valid, `record ${id}`).toContain(bucket);
      expect(bucket === 'unknown', `record ${id}`).toBe(rate === null);
    }
  });

  // 21 = 15 records with unknown pay or unknown hours, plus the 6 whose
  // compensation field is blank (previously mis-ranked as a confident $0.00).
  //
  // Was 20/66. Record 8872 joined the unknown bucket when its duration stopped
  // pretending to be totallable (audit F5) - it was ranked #2 on the whole
  // board at $105/hr on a denominator that omitted nine days of the study.
  // Being unranked is the correct outcome for it, not a loss of coverage.
  it('leaves 21 records in the unknown-rate bucket and ranks the other 65', () => {
    const unknown = computed.filter((c) => c.rate === null);
    const known = computed.filter((c) => c.rate !== null);
    expect(unknown).toHaveLength(21);
    expect(known).toHaveLength(65);
    // The headline study is one of them, by design.
    expect(unknown.map((c) => c.id)).toContain(12775);
    expect(unknown.map((c) => c.id)).toContain(8872);
  });

  it('sorts the whole board with every unknown at the end, in both directions', () => {
    const board: RankableStudy[] = computed.map((c) => ({ effectiveHourly: c.rate }));

    for (const direction of ['desc', 'asc'] as const) {
      const sorted = sortStudies(board, direction);
      expect(sorted, direction).toHaveLength(86);

      // 65 known / 21 unknown; see the count test above for why this moved.
      const firstUnknown = sorted.findIndex((s) => s.effectiveHourly === null);
      expect(firstUnknown, direction).toBe(65);
      expect(sorted.slice(65).every((s) => s.effectiveHourly === null), direction).toBe(true);

      const known = sorted.slice(0, 65).map((s) => s.effectiveHourly as number);
      for (let i = 1; i < known.length; i += 1) {
        const [prev, curr] = [known[i - 1] as number, known[i] as number];
        if (direction === 'desc') expect(prev, `${prev} >= ${curr}`).toBeGreaterThanOrEqual(curr);
        else expect(prev, `${prev} <= ${curr}`).toBeLessThanOrEqual(curr);
      }
    }
  });

  it('puts the genuinely best-paying study at the top of the descending board', () => {
    // Record 9821: $550 across three visits totalling 4 hours.
    const sorted = sortStudies(
      computed.map((c) => ({ id: c.id, effectiveHourly: c.rate })),
      'desc',
    );
    expect(sorted[0]).toEqual({ id: 9821, effectiveHourly: 137.5 });
  });
});

// ---------------------------------------------------------------------------
// Known issues found while writing this suite. Behaviour is pinned as it is
// today so that a fix is a deliberate, visible change; each is reported
// upstream rather than patched here.
// ---------------------------------------------------------------------------

describe('KNOWN ISSUES (pinned, not endorsed)', () => {
  it('REGRESSION: a BLANK compensation field is unknown pay, never a confident $0.00', () => {
    // Was a known issue, now fixed in parse-compensation.ts. Six fixture
    // records have an empty `aux_study_item_compensation` AND parseable hours.
    // '' used to map to guaranteedMin/Max 0 at confidence 'high', so these
    // computed a confident $0.00/hr, landed in the 'low' bucket and rendered
    // as "Unpaid" - asserting something the listing never said. An empty field
    // now parses as null/'low' and the rate is null, so they sort into the
    // unknown block instead. "None" still means a real, ranked zero.
    const blank = fixture.filter((s) => s.meta.aux_study_item_compensation === '');
    expect(blank.map((s) => s.id)).toEqual(
      expect.arrayContaining([12764, 12762, 11319, 11317, 9959, 8402]),
    );

    for (const s of blank) {
      const { rate, compensation } = rateForStudy(s.id);
      expect(compensation.guaranteedMax).toBeNull();
      expect(compensation.confidence).toBe('low');
      expect(rate).toBeNull();
      expect(rateBucket(rate)).toBe('unknown');
    }

    // The contrast case: an explicit "None" is still a confident, ranked zero.
    const none = fixture.find((s) => /^none/i.test(s.meta.aux_study_item_compensation.trim()));
    expect(none).toBeDefined();
    const noneRate = rateForStudy(none!.id);
    expect(noneRate.compensation.guaranteedMax).toBe(0);
    expect(noneRate.compensation.confidence).toBe('high');
  });

  it('effective-rate.ts: a stated per-component hourly rate can outrank a stated total', () => {
    // Record 7660: "$20/hr for imaging session, $10/hr for lab session
    // ($40-50 total)" over "1 hr lab visit followed by a 1.5-2hr imaging
    // session". The stated-hourly branch takes the $20 ceiling and returns
    // $20.00/hr, but the listing's own total says $40-50 for 2.5-3 hours,
    // i.e. $16.67/hr. Preferring a stated rate is right in general; preferring
    // it over a stated TOTAL that contradicts it overstates this study by 20%.
    const { rate, compensation, duration } = rateForStudy(7660);
    expect(compensation.isHourlyRate).toBe(true);
    expect(compensation.guaranteedMax).toBe(50);
    expect(duration.totalHoursMax).toBe(3);
    expect(rate).toBe(20);
    expect(50 / 3).toBeCloseTo(16.67, 2); // what the total implies
  });

  // NOTE. The three AUDIT F2 entries that used to sit here - 12766 pinned at
  // $35.00, 8874 at $7.50, 4618 at $64.29 - are FIXED and have been moved down
  // into "REGRESSION: scope reconciliation (audit F2)" rather than re-pinned,
  // which is what the note on those pins asked for. They are not deleted; they
  // now assert the honest arithmetic instead of the wrong number.

  it('(F2 remainder): the RATE is reconciled but the DISPLAYED TOTAL is still one visit short', () => {
    // Half of F2 is closed and half is not, and the half that is not is
    // visible on the card: #12766 now shows an honest $60.00/hr next to a
    // "$70" total, and #8874 an honest $15.00/hr next to "$30".
    // `reconcileEffectiveHourly` already computes the right figure - 120 and
    // 60 - but nothing writes it back, because `compensation` is gated to
    // equal `parseCompensation(meta)` field-for-field (normalize.test.ts:793)
    // and the total therefore belongs to parse-compensation.ts.
    //
    // Pinned so the inconsistency is a named, visible debt rather than an
    // oddity a reader notices first. When the parser learns to close these
    // studies out, this test goes red - move it into the F2 regression block.
    for (const [id, shownTotal, honestTotal] of [
      [12766, 70, 120],
      [8874, 30, 60],
    ] as const) {
      const { compensation, duration } = rateForStudy(id);
      const shown = compensation.guaranteedMax ?? compensation.guaranteedMin;
      expect(shown, `record ${id}`).toBe(shownTotal);
      expect(reconcileEffectiveHourly(compensation, duration).guaranteedTotal, `record ${id}`).toBe(honestTotal);
    }
  });

  it('(F9): 8331 is ranked #2 live on a duration that is probably per-session', () => {
    // "40-50 minutes" against a compensation string describing two sessions
    // ($30 + $50 = $80); content.rendered confirms "Each participant will
    // complete two sessions." If the 40-50 minutes is per session the rate is
    // $80 / 1.5 h = $53.33/hr, not $96.00. Nothing reconciles a
    // compensation-side session count against a duration-side one, so this
    // holds rank 2 of the live board on an unexamined assumption.
    const { rate, compensation, duration } = rateForStudy(8331);
    expect(duration.sessionCount).toBeNull(); // the duration side found no count
    expect(compensation.guaranteedMax).toBe(80); // the pay side describes two
    expect(rate).toBe(96); // pinned, probably ~1.8x high
    expect(80 / 1.5).toBeCloseTo(53.33, 2);
  });

  it('REGRESSION (audit F16): rounding hours to 4dp no longer shifts the rate by a cent', () => {
    // Record 11315: $20 for "20 mins". 20 minutes is 1/3 h, and ParsedDuration
    // stores hours at 4dp, so the stored value is 0.3333 and 20 / 0.3333 used
    // to yield $60.01 - a provably wrong number on a page whose entire pitch is
    // arithmetic honesty, in the top 5 no less. computeEffectiveHourly now
    // snaps an hours value that is within 0.01 min of a whole minute back to
    // whole/60 before dividing. The STORED value is deliberately untouched:
    // the rounding is a display/precision concern of the division, not of the
    // duration parser, and 0.3333 is still what ParsedDuration carries.
    const { rate, duration } = rateForStudy(11315);
    expect(duration.totalHoursMax).toBe(0.3333);
    expect(rate).toBe(60);
    expect(20 / (1 / 3)).toBeCloseTo(60, 6); // the exact answer, now matched
  });
});

// ===========================================================================
// AUDIT REGRESSIONS - the rates, locked by fixture id
//
// An adversarial audit of all 86 records found that FOUR of the ten
// highest-ranked live studies were materially wrong, every one of them in the
// direction that costs the reader: three inflated 2.3x-4.9x, one understated
// so badly it was buried. These tests exist so that never silently recurs.
//
// Each assertion names the arithmetic. If one of these fails, do not adjust
// the number to match the code - work out which of the two is lying.
// ===========================================================================

describe('REGRESSION: the rates the audit found materially wrong', () => {
  it('9815: $620 over 44 hours is $14.09/hr, not $68.89/hr', () => {
    // Six fasted 7-hour clinic days plus a 2-hour screening = 44 h, against a
    // $620 ceiling. Shipped at rank 4 with a green $68.89/hr badge - a reader
    // who trusted it was committing to 44 hours at less than the ok-bucket
    // floor. This single row is the reason the site exists.
    const { rate } = rateForStudy(9815);
    expect(rate).toBeCloseTo(14.09, 2);
    expect(rateBucket(rate)).toBe('ok');
  });

  it('4611: $820 over 58 hours is $14.14/hr, not $51.25/hr', () => {
    const { rate } = rateForStudy(4611);
    expect(rate).toBeCloseTo(14.14, 2);
  });

  it('4613: $420 over 27 hours is $15.56/hr, not $46.67/hr', () => {
    const { rate } = rateForStudy(4613);
    expect(rate).toBeCloseTo(15.56, 2);
  });

  it('8458: $425 over 21 hours is $20.24/hr, not $47.22/hr', () => {
    const { rate } = rateForStudy(8458);
    expect(rate).toBeCloseTo(20.24, 2);
    // It also leaves the 'great' bucket, which is the visible half of the fix.
    expect(rateBucket(rate)).toBe('good');
  });

  it('6987: $60 over 5.5 hours is $10.91/hr, not $40.00/hr', () => {
    // DELIBERATE DEVIATION from the audit's $12.00/hr target, which reads 5 h
    // out of content.rendered. parseDuration only sees the duration field, and
    // from that field alone the total is 0.5 + 5 x 1 = 5.5 h. The deviation
    // understates the rate by $1.09 - the safe direction - and both readings
    // put the study in 'ok' and out of the top 10, which is the whole point.
    // See the matching note in parse-duration.test.ts.
    const { rate } = rateForStudy(6987);
    expect(rate).toBeCloseTo(10.91, 2);
    expect(rateBucket(rate)).toBe('ok');
    expect(rate).toBeLessThan(12.0); // never again in the 'great' bucket
  });

  it('8872: unrankable, not the second-best deal on the board at $105/hr', () => {
    // $140 for one interview, one survey, and nine days of smartphone data
    // collection whose time nothing quantifies. There is no honest denominator.
    const { rate, compensation, duration } = rateForStudy(8872);
    expect(rate).toBeNull();
    expect(rateBucket(rate)).toBe('unknown');
    // The pay is still known and still $140 - only the RATE is unknown, and
    // the card must be able to say "$140 total, rate unknown".
    expect(compensation.guaranteedMax).toBe(140);
    expect(duration.totalHoursMax).toBeNull();
  });

  it('11899: $10 guaranteed over 0.9167 h is $10.91/hr, not $21.82/hr', () => {
    // The other $10 of the advertised "up to $20" is a task-performance bonus.
    // Contingent money in the ranking numerator is the mirror image of letting
    // raffle money in, and it is excluded for exactly the same reason.
    const { rate, compensation } = rateForStudy(11899);
    expect(compensation.guaranteedMax).toBe(10);
    expect(rate).toBeCloseTo(10.91, 2);
  });

  it('11315: exactly $60.00/hr, with no rounding cent', () => {
    expect(rateForStudy(11315).rate).toBe(60);
    expect(rateForStudy(11315).rate).not.toBe(60.01);
  });
});

// ===========================================================================
// REGRESSION: scope reconciliation (audit F2)
//
// THE RULE: the numerator and the denominator must describe the SAME AMOUNT OF
// STUDY before they are divided. Both source fields are free text and either
// can be written per-visit or whole-study with no marker distinguishing them,
// so dividing them blind does not give an approximate rate - it gives one that
// is out by the visit count, in whichever direction the listing happened to be
// phrased.
//
// These three were pinned at their WRONG values in the KNOWN ISSUES block
// above until `reconcileEffectiveHourly` landed. They have been MOVED here
// rather than re-pinned, per the instruction on the pins. Each names the
// arithmetic; if one fails, work out which of the two numbers is lying before
// touching either.
// ===========================================================================

describe('REGRESSION F2: per-visit pay is never divided by whole-study hours', () => {
  it('12766: 2 x $50 + $20 over 2 h is $60.00/hr, not $35.00/hr', () => {
    // "$50 per laboratory visit; $10 for parent questionnaires; $10 for child
    // questionnaires" over "2 hours (in the form of two 1-hour visits)".
    // guaranteedMin is $70 - ONE visit's $50 plus the two one-off $10
    // questionnaires - against the hours of BOTH visits.
    //
    // The audit's single biggest UNDERSTATEMENT. Understating is not the safe
    // direction here: at $35/hr this study sat at rank 6, below studies it
    // beats, which buries a genuinely good deal - the other half of the
    // product promise.
    const { rate, compensation, duration } = rateForStudy(12766);
    expect(compensation.perVisit).toBe(50);
    expect(compensation.guaranteedMax).toBeNull(); // no whole-study total stated
    expect(duration.sessionCount).toBe(2); // the count IS available
    expect(rate).toBe(60.0); // was 35.00

    // Only the REPEATING component is multiplied. 2 x $70 = $140 would be the
    // easy wrong answer; the two questionnaire payments happen once.
    const r = reconcileEffectiveHourly(compensation, duration);
    expect(r.basis).toBe('per-visit-pay-scaled');
    expect(r.visitCount).toBe(2);
    expect(r.guaranteedTotal).toBe(120); // 2 x $50 + $20, NOT 2 x $70
    expect((50 * 2 + 20) / 2).toBe(60);
  });

  it('8874: 2 x $30 over 4 h is $15.00/hr in the ok bucket, not $7.50/hr in low', () => {
    // "$30 per visit" over "Two visits, each about 2 hours, completed within
    // two weeks." The bucket move matters as much as the number: a reader
    // filtering out 'low' would never have seen this study at all.
    const { rate, compensation, duration } = rateForStudy(8874);
    expect(compensation.perVisit).toBe(30);
    expect(duration.sessionCount).toBe(2);
    expect(rate).toBe(15.0); // was 7.50
    expect(rateBucket(rate)).toBe('ok'); // was 'low'
    expect(reconcileEffectiveHourly(compensation, duration).guaranteedTotal).toBe(60);
    expect((30 * 2) / 4).toBe(15);
  });

  it('4618: $225 over 3 x 3.5 h is $21.43/hr, not $64.29/hr', () => {
    // The same defect in the opposite direction, and the dangerous one: "up to
    // $225 over 3 visits (1 visit a year)" divided by "Visits last around
    // 3-3.5 hours" - ALL the pay over ONE visit's hours. Overstated 2.8x, and
    // it led the expired board. Here the HOURS are scaled, not the pay.
    const { rate, compensation, duration } = rateForStudy(4618);
    expect(compensation.guaranteedMax).toBe(225); // whole-study pay
    expect(duration.totalHoursMax).toBe(3.5); // ONE visit's hours
    expect(rate).toBeCloseTo(21.43, 2); // was 64.29

    const r = reconcileEffectiveHourly(compensation, duration);
    expect(r.basis).toBe('per-session-hours-scaled');
    expect(r.visitCount).toBe(3);
    expect(225 / (3.5 * 3)).toBeCloseTo(21.43, 2);
  });

  it('4620: both operands are per-visit, so the ratio was already right - now for a reason', () => {
    // "$50 for each visit" / "Visits last around 1.5 hours" came out at the
    // correct $33.33 purely by coincidence before. It must still be $33.33,
    // and it must NOT be scaled: multiplying both sides cancels.
    const { rate, compensation, duration } = rateForStudy(4620);
    expect(rate).toBeCloseTo(33.33, 2);
    const r = reconcileEffectiveHourly(compensation, duration);
    expect(r.basis).toBe('single-visit');
    // Neither field states how many visits there are, so the study TOTAL is
    // honestly unknown even though the rate is not.
    expect(r.guaranteedTotal).toBeNull();
  });

  it('does not re-scale the F1 records, whose hours are already whole-study', () => {
    // The failure mode this fix could most easily cause. 9815 carries
    // `perVisit: 100` AND a stated $620 total; 4611/4613/8458 all have a
    // duration-side session count, which is a hard veto on treating their
    // hours as per-session. Scaling any of them a second time would undo F1 -
    // the highest-impact fix in the suite.
    const EXPECTED: Record<number, number> = { 9815: 14.09, 4611: 14.14, 4613: 15.56, 8458: 20.24, 6987: 10.91 };
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const { rate, compensation, duration } = rateForStudy(Number(id));
      expect(rate, `record ${id}`).toBeCloseTo(expected, 2);
      expect(reconcileEffectiveHourly(compensation, duration).basis, `record ${id}`).toBe('whole-study');
    }
  });

  it('refuses to rank when the scopes differ and no count reconciles them', () => {
    // The honest answer to "pay is per visit, hours are for the study, and
    // nobody said how many visits" is null - the study drops into the
    // "rate unknown" block carrying its total, which is a claim the data
    // supports. A number here would be wrong by exactly the visit count.
    const r = reconcileEffectiveHourly(
      comp({ perVisit: 40, guaranteedMin: 40, guaranteedMax: null }),
      dur({ totalHoursMax: 6, raw: '6 hours in the lab' }),
    );
    expect(r.rate).toBeNull();
    expect(r.basis).toBe('unreconciled');
    expect(rateBucket(r.rate)).toBe('unknown');
  });

  it('takes the reading that pays LESS when the two fields disagree on the count', () => {
    // A disagreement between the compensation text and the duration text is
    // real information, not something to average away. Overstating costs the
    // reader a wasted trip; understating costs them a study they might have
    // taken, so the conservative reading wins and the result is low-confidence.
    const scaledPay = reconcileEffectiveHourly(
      comp({ perVisit: 50, guaranteedMin: 50, guaranteedMax: null, visitCount: 2 }),
      dur({ totalHoursMax: 4, sessionCount: null, raw: '4 hours over the study' }),
    );
    expect(scaledPay.rate).toBe(25); // 2 x $50 / 4 h, not 3 x
    expect(scaledPay.confidence).toBe('high'); // only one count exists - no dispute

    const disputed = reconcileEffectiveHourly(
      comp({ guaranteedMax: 300, visitCount: 2 }),
      dur({ totalHoursMax: 2, sessionCount: null, raw: 'Visits last about 2 hours' }),
    );
    // Hours are per-session, so MORE visits is the conservative reading.
    expect(disputed.rate).toBe(75); // $300 / (2 h x 2 visits)
    expect(disputed.basis).toBe('per-session-hours-scaled');
  });

  it('will not multiply by a headcount mistaken for a session count (audit R3)', () => {
    // "20 participants per session" parses as 20 sessions on the duration side.
    // A count that large is not a visit count anyone wrote down on purpose, and
    // multiplying by it would bury a study as thoroughly as under-counting
    // inflates one. Above MAX_RECONCILABLE_VISITS nothing reconciles.
    const r = reconcileEffectiveHourly(
      comp({ guaranteedMax: 100, visitCount: 200 }),
      dur({ totalHoursMax: 1, sessionCount: null, raw: 'Sessions last 1 hour' }),
    );
    expect(r.rate).toBeNull();
    expect(r.basis).toBe('unreconciled');
  });
});

describe('REGRESSION R1/R2: ordinary "earn" pay reaches the rate, contingent pay does not', () => {
  // The parse-side lock is in parse-compensation.test.ts. This is the half a
  // reader actually sees: R1's damage was a real payment rendered as a green
  // "$0.00/hr" in the 'low' bucket, which RateBadge prints as "Unpaid"
  // (RateBadge.astro:63-70, `rate === 0 || comp.guaranteedMax === 0`).
  const ONE_HOUR = '1 hour';

  it('"Participants will earn $30 for completing the survey." is $30.00/hr, not Unpaid', () => {
    const rate = computeEffectiveHourly(
      parseCompensation('Participants will earn $30 for completing the survey.'),
      parseDuration(ONE_HOUR),
    );
    expect(rate).toBe(30);
    expect(rate).not.toBe(0);
    expect(rateBucket(rate)).toBe('good');
  });

  it('all five R1 probes agree on the money once the hours are held constant', () => {
    const rates = [
      'Participants will earn $30 for completing the survey.',
      'You can earn $45 for the session.',
      'You will earn up to $200 over the course of the study.',
      'Participants will be earning $30.',
      'Payment is $60, which will be earned upon completion of all visits.',
    ].map((raw) => computeEffectiveHourly(parseCompensation(raw), parseDuration(ONE_HOUR)));

    expect(rates).toEqual([30, 45, 200, 30, 60]);
    // The specific published lie: none of them is a confident zero.
    for (const r of rates) expect(r).not.toBe(0);
  });

  it('R2: all-contingent pay is unrankable, not $0.00/hr', () => {
    // `guaranteedMax: 0` is a measurement and `null` is the absence of one. An
    // unmeasured floor must sink into the unrated block, not rank as unpaid.
    const comp2 = parseCompensation('Participants have an opportunity to earn $50 based on task performance.');
    expect(comp2.guaranteedMax).toBeNull();
    const rate = computeEffectiveHourly(comp2, parseDuration(ONE_HOUR));
    expect(rate).toBeNull();
    expect(rateBucket(rate)).toBe('unknown');
  });

  it('a genuine "None" is still a ranked, measured $0.00/hr', () => {
    // The contrast case R2 must not sweep up with it.
    expect(computeEffectiveHourly(parseCompensation('None'), parseDuration(ONE_HOUR))).toBe(0);
    expect(rateBucket(0)).toBe('low');
  });
});

// ===========================================================================
// REGRESSION F11: the unrated block is ordered by money, not by date
//
// A study with no computable rate is not a cheap study, so it gets its own
// section below the ranked board. That was always right. What was wrong was
// the order WITHIN it: sorting by posting date alone put #11321 - $1,000
// guaranteed, the largest payout in the entire corpus - FOURTH, below two
// studies that state no pay at all, and below all 48 ranked rows including
// three $0.00/hr surveys.
// ===========================================================================

describe('REGRESSION F11: unrated studies are ordered by guaranteed money', () => {
  const CLOCK = new Date('2026-08-09T12:00:00Z');
  const { studies } = normalizeAndDedupe(fixture, { now: CLOCK });
  const unrated = sortUnrated(studies.filter((s) => !s.isExpired && !isKnownRate(s.effectiveHourly)));

  it('puts the $1,000 study first, not fourth', () => {
    expect(unrated[0]?.id).toBe('11321');
    expect(guaranteedTotal(unrated[0]!)).toBe(1000);
  });

  it('orders the whole live unrated block by guaranteed total descending', () => {
    expect(unrated.map((s) => [s.id, guaranteedTotal(s)])).toEqual([
      ['11321', 1000], // Oura ring study, 24 weekly visits, no contact hours stated
      ['12775', 400],
      ['8404', 350],
      ['8333', 150], // ceiling; ties 6953 and is the newer posting
      ['6953', 150],
      ['8872', 140], // F5: real pay, but there is no honest denominator
      ['6997', 15],
      ['8417', 0], // raffle-only: a measured zero, so it beats "no pay stated"
      ['6978', 0],
      // No stated pay at all sinks to the bottom, newest first - the same
      // reason a null rate sorts last on the main board.
      ['12764', null],
      ['12762', null],
      ['11319', null],
      ['10128', null],
      ['9959', null],
      ['6990', null],
    ]);
  });

  it('sinks unknown pay below a measured $0, and breaks ties by date', () => {
    const posted = (d: string) => ({ compensation: { guaranteedMin: null, guaranteedMax: null }, postedDate: d });
    const paid = (n: number, d: string) => ({
      compensation: { guaranteedMin: n, guaranteedMax: n },
      postedDate: d,
    });

    expect(
      sortUnrated([
        posted('2026-01-01T00:00:00Z'),
        paid(0, '2020-01-01T00:00:00Z'),
        paid(500, '2019-01-01T00:00:00Z'),
      ]).map((s) => s.compensation.guaranteedMax),
    ).toEqual([500, 0, null]);

    // Equal money: newest posting first.
    expect(
      sortUnrated([paid(50, '2024-01-01T00:00:00Z'), paid(50, '2025-01-01T00:00:00Z')]).map((s) => s.postedDate),
    ).toEqual(['2025-01-01T00:00:00Z', '2024-01-01T00:00:00Z']);
  });

  it('does not mutate its input and preserves every element', () => {
    const input = [...unrated];
    const out = sortUnrated(input);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(input.length);
    expect(new Set(out.map((s) => s.id))).toEqual(new Set(input.map((s) => s.id)));
  });

  it('prefers the ceiling when reading a guaranteed total, and null when there is none', () => {
    expect(guaranteedTotal({ compensation: { guaranteedMin: 10, guaranteedMax: 150 }, postedDate: '' })).toBe(150);
    expect(guaranteedTotal({ compensation: { guaranteedMin: 10, guaranteedMax: null }, postedDate: '' })).toBe(10);
    expect(guaranteedTotal({ compensation: { guaranteedMin: null, guaranteedMax: null }, postedDate: '' })).toBeNull();
  });
});

// ===========================================================================
// GOLDEN RANKING
// ===========================================================================

describe('GOLDEN: the live top 10, in order', () => {
  /**
   * THIS TEST EXISTS TO CATCH SILENT RANKING REGRESSIONS.
   *
   * The top of this board is the product. Everything else on the page - the
   * filters, the cards, the badges - is in service of the claim that the study
   * at rank 1 is the best real deal available. Four of the ten rows below were
   * wrong when the audit ran, and nothing in the test suite noticed, because
   * every individual parser test passed. Only the ORDER encodes the promise.
   *
   * WHEN THIS TEST FAILS, IT HAS DONE ITS JOB. Updating the expected list is a
   * deliberate act, never a casual one. Before you touch it:
   *
   *   1. Identify which record moved and by how much.
   *   2. Re-derive that record's rate by hand from its two raw meta strings.
   *   3. Satisfy yourself the NEW number is the honest one.
   *   4. Update the list AND the note next to the row, in the same commit as
   *      the parser change that caused it.
   *
   * Never update this list to make a red build green.
   *
   * TIES. There is a two-way tie at $33.33 (8408, 8399) and a three-way tie at
   * $30.00 (9953, 8338, 6960). sortStudies is a stable sort, so tied rows come
   * out in INPUT order, and this test therefore has to feed it the same input
   * order the page does or it will assert an ordering the site never renders.
   * scripts/fetch-data.ts sorts the deduped records by numeric id ascending
   * before writing src/data/snapshot.json, and index.astro ranks that array;
   * `byNumericId` below reproduces that step. Verified against dist/index.html.
   */
  const EXPECTED_LIVE_TOP_10: [string, number][] = [
    ['9821', 137.5], // $550 ceiling / 4 h across three visits. Audited correct; floor is $112.50/hr.
    ['8331', 96.0], // SUSPECT - audit F9 says "40-50 minutes" is per session and the real rate is ~$53.33. UNFIXED.
    ['11315', 60.0], // $20 / 20 min. Was $60.01 before the F16 rounding fix.
    // ------------------------------------------------------------------
    // WHY THIS LIST CHANGED (round 3, audit F2 - scope reconciliation).
    //
    //   before: 9821, 8331, 11315, 9957, 10126, 12766, 8399, 8408, 6960, 8338
    //   after:  9821, 8331, 11315, 12766, 9957, 10126, 8399, 8408, 6960, 8338
    //
    // ONE row moved, and only because its rate did: 12766 went 35.00 -> 60.00
    // when `reconcileEffectiveHourly` stopped dividing ONE laboratory visit's
    // $50 (plus $20 of one-off questionnaires) by BOTH visits' hours. The
    // honest figure is 2 x $50 + $20 = $120 over 2 h. That lifted it from rank
    // 6 to rank 4, where it ties 11315 at $60.00 and takes the lower-id half
    // of the tie. Membership is unchanged; no other row's rate moved.
    //
    // This was the audit's single biggest UNDERSTATEMENT, and understating is
    // not the safe direction - it buried the study below ones it beats, which
    // is exactly the failure the ranked board exists to prevent.
    // ------------------------------------------------------------------
    ['12766', 60.0],
    ['9957', 45.0], // $45 / 1 h. Audited correct.
    ['10126', 40.0], // $20 / 30 min. Audited correct.
    ['8399', 33.33], // $50 / 1.5 h. Audited correct. Tied with 8408; lower id first.
    ['8408', 33.33], // $50 / 1.5 h. Audited correct.
    ['6960', 30.0], // $30 / 1 h. Audited correct. Tied with 8338 and 9953; lowest id first.
    ['8338', 30.0], // $120 / 4 h. Hours are arguably 4.25 (audit F15); rate would be $28.24.
  ];

  /** Exactly the ordering scripts/fetch-data.ts writes into snapshot.json. */
  function byNumericId(a: { id: string }, b: { id: string }): number {
    return Number(a.id) - Number(b.id);
  }

  const { studies: deduped } = normalizeAndDedupe(fixture, { now: new Date('2026-08-09T12:00:00Z') });
  const studies = [...deduped].sort(byNumericId);
  const liveRanked = sortStudies(
    studies.filter((s) => !s.isExpired && isKnownRate(s.effectiveHourly)),
    'desc',
  );

  it('matches the expected top 10 exactly, id and rate', () => {
    expect(liveRanked.slice(0, 10).map((s) => [s.id, s.effectiveHourly])).toEqual(EXPECTED_LIVE_TOP_10);
  });

  it('is the order the built page actually renders', () => {
    // Belt and braces. The block above re-derives the board from the fixture;
    // this one reads the committed build artifact that index.astro imports, so
    // a divergence between the pipeline and what ships - a change to the sort
    // in scripts/fetch-data.ts, say - cannot hide behind a passing re-derivation.
    const built = JSON.parse(
      readFileSync(fileURLToPath(new URL('../data/snapshot.json', import.meta.url)), 'utf8'),
    ) as { studies: { id: string; isExpired: boolean; effectiveHourly: number | null }[] };

    const builtTop10 = sortStudies(
      built.studies.filter((s) => !s.isExpired && isKnownRate(s.effectiveHourly)),
      'desc',
    ).slice(0, 10);

    expect(builtTop10.map((s) => [s.id, s.effectiveHourly])).toEqual(EXPECTED_LIVE_TOP_10);
  });

  it('renders the unrated block money-first in the shipped snapshot too', () => {
    // index.astro builds the second section as
    //   sortUnrated(live.filter((s) => !isKnownRate(s.effectiveHourly)))
    // so the same three lines are exercised here against the committed
    // artifact the page actually imports. The head of this block is the only
    // part a reader scans, and #11321 is $1,000.
    const built = JSON.parse(
      readFileSync(fileURLToPath(new URL('../data/snapshot.json', import.meta.url)), 'utf8'),
    ) as { studies: (StudyRecord & { isExpired: boolean })[] };

    const builtUnrated = sortUnrated(
      built.studies.filter((s) => !s.isExpired && !isKnownRate(s.effectiveHourly)),
    );

    expect(builtUnrated.slice(0, 3).map((s) => [s.id, guaranteedTotal(s)])).toEqual([
      ['11321', 1000],
      ['12775', 400],
      ['8404', 350],
    ]);
    // And nothing with stated money is below something without.
    const firstUnpriced = builtUnrated.findIndex((s) => guaranteedTotal(s) === null);
    expect(builtUnrated.slice(firstUnpriced).every((s) => guaranteedTotal(s) === null)).toBe(true);
  });

  it('no longer contains any of the four records the audit disqualified', () => {
    // 9815 ($68.89 -> $14.09), 8458 ($47.22 -> $20.24), 6987 ($40.00 -> $10.91)
    // were inflated into the top 10; 8872 ($105.00) was not rankable at all.
    const top10 = new Set(liveRanked.slice(0, 10).map((s) => s.id));
    for (const id of ['9815', '8458', '6987', '8872']) {
      expect(top10.has(id), `record ${id} is back in the top 10`).toBe(false);
    }
  });

  it('ranks 48 live studies and leaves the rest honestly unranked', () => {
    const live = studies.filter((s) => !s.isExpired);
    expect(live).toHaveLength(63);
    expect(liveRanked).toHaveLength(48);
  });

  it('keeps the expired board free of the F1 records too', () => {
    // 4611 and 4613 head the expired list, which is sorted the same way and is
    // reachable through the RSS feed and /api/studies.json whether or not the
    // page splits it out.
    const expiredRanked = sortStudies(
      studies.filter((s) => s.isExpired && isKnownRate(s.effectiveHourly)),
      'desc',
    );
    const byId = new Map(expiredRanked.map((s) => [s.id, s.effectiveHourly]));
    expect(byId.get('4611')).toBeCloseTo(14.14, 2);
    expect(byId.get('4613')).toBeCloseTo(15.56, 2);
    // 4618: F2 FIXED (round 3). $225 across 3 visits x 3.5 h = 10.5 h, not one
    // visit's hours. It no longer leads the expired board at a phantom 3x rate.
    expect(byId.get('4618')).toBeCloseTo(21.43, 2);
  });
});

// ===========================================================================
// GLOBAL INVARIANTS over all 86 records, re-asserted end to end
// ===========================================================================

describe('GLOBAL INVARIANTS: the whole pipeline over all 86 records', () => {
  const CLOCK = new Date('2026-08-09T12:00:00Z');
  const { studies } = normalizeAndDedupe(fixture, { now: CLOCK });

  const everyRate: { id: number; rate: number | null }[] = fixture.map((s) => ({
    id: s.id,
    rate: computeEffectiveHourly(
      parseCompensation(s.meta.aux_study_item_compensation),
      parseDuration(s.meta.aux_study_item_duration),
    ),
  }));

  /** The full reconciliation for all 86, not just the number it returns. */
  const everyReconciled = fixture.map((s) => ({
    id: s.id,
    compensation: parseCompensation(s.meta.aux_study_item_compensation),
    reconciled: reconcileEffectiveHourly(
      parseCompensation(s.meta.aux_study_item_compensation),
      parseDuration(s.meta.aux_study_item_duration),
    ),
  }));

  it('emits no NaN, no Infinity and no negative rate for any of the 86', () => {
    for (const { id, rate } of everyRate) {
      if (rate === null) continue;
      expect(Number.isNaN(rate), `record ${id} is NaN`).toBe(false);
      expect(Number.isFinite(rate), `record ${id} is not finite`).toBe(true);
      expect(rate, `record ${id} is negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it('the scope-reconciled numbers are finite and non-negative too', () => {
    // The F2 reconciliation multiplies a parsed count into the numerator or the
    // denominator, which is a new way to produce a NaN, an Infinity or a
    // negative. Every derived figure is checked, not just the headline rate.
    for (const { id, reconciled } of everyReconciled) {
      const { rate, guaranteedTotal: total, visitCount } = reconciled;
      for (const [label, v] of [['rate', rate], ['guaranteedTotal', total], ['visitCount', visitCount]] as const) {
        if (v === null) continue;
        expect(Number.isFinite(v), `record ${id}: ${label} is not finite`).toBe(true);
        expect(v, `record ${id}: ${label} is negative`).toBeGreaterThanOrEqual(0);
      }
      // A count is a count of visits: a whole number, and never a headcount.
      if (visitCount !== null) {
        expect(Number.isInteger(visitCount), `record ${id}: fractional visit count`).toBe(true);
        expect(visitCount, `record ${id}: implausible visit count`).toBeLessThanOrEqual(60);
      }
      // `null` rate and a basis that claims a rate cannot coexist.
      if (rate === null) {
        expect(['unknown', 'unreconciled'], `record ${id}: ${reconciled.basis} with a null rate`).toContain(
          reconciled.basis,
        );
      }
    }
  });

  it('computeEffectiveHourly is exactly reconcileEffectiveHourly().rate for all 86', () => {
    // The wrapper must stay a wrapper. Anything that computes a rate a second,
    // slightly different way is how the two operands drifted apart in the
    // first place.
    for (const { id, reconciled } of everyReconciled) {
      const direct = everyRate.find((r) => r.id === id);
      expect(reconciled.rate, `record ${id}`).toBe(direct?.rate);
    }
  });

  it('emits no NaN, no Infinity and no negative rate for any of the 79 survivors', () => {
    for (const s of studies) {
      if (s.effectiveHourly === null) continue;
      expect(Number.isFinite(s.effectiveHourly), `record ${s.id}`).toBe(true);
      expect(s.effectiveHourly, `record ${s.id}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('never lets raffle money into guaranteed pay or into the rate', () => {
    // The mirror of the contingent-money rule (audit F8). A lottery ticket is
    // not a wage. Every record in the corpus that carries a prize is pinned to
    // the prize/guaranteed split the audit verified by hand, so a regression
    // shows up as a specific wrong number rather than a soft property failure.
    const EXPECTED: Record<number, { raffle: number; guaranteed: number }> = {
      11075: { raffle: 50, guaranteed: 10 }, // "$10 gift card AND three entries", one payment described twice
      8898: { raffle: 100, guaranteed: 10 },
      6753: { raffle: 100, guaranteed: 10 },
      8331: { raffle: 200, guaranteed: 80 }, // the prize is the largest single draw, not the $1,000 pool
      6987: { raffle: 50, guaranteed: 60 },
      6969: { raffle: 100, guaranteed: 5 }, // "1 of 5 $100" - a drawing with no drawing word
      8417: { raffle: 50, guaranteed: 0 }, // raffle-only
      6978: { raffle: 10, guaranteed: 0 }, // raffle-only
      6745: { raffle: 10, guaranteed: 165 },
      4626: { raffle: 10, guaranteed: 165 },
      4624: { raffle: 10, guaranteed: 165 },
    };

    const found: number[] = [];
    for (const s of fixture) {
      const c = parseCompensation(s.meta.aux_study_item_compensation);
      const prize = c.raffleMax ?? 0;
      if (prize === 0) continue;
      found.push(s.id);
      const guaranteed = c.guaranteedMax ?? c.guaranteedMin ?? 0;
      expect(
        { raffle: prize, guaranteed },
        `record ${s.id}: ${JSON.stringify(s.meta.aux_study_item_compensation.slice(0, 80))}`,
      ).toEqual(EXPECTED[s.id]);

      if (c.raffleOnly) {
        expect(guaranteed, `record ${s.id} is raffle-only`).toBe(0);
        expect(
          computeEffectiveHourly(c, parseDuration(s.meta.aux_study_item_duration)),
          `record ${s.id} is raffle-only`,
        ).toBeNull();
      }
      // And the rate, when one exists, is guaranteed pay over hours - the prize
      // is nowhere in it.
      const d = parseDuration(s.meta.aux_study_item_duration);
      const rate = computeEffectiveHourly(c, d);
      if (rate !== null && d.totalHoursMax !== null && !c.isHourlyRate) {
        expect(rate * d.totalHoursMax, `record ${s.id}`).toBeCloseTo(guaranteed, 0);
      }
    }

    // No record may quietly appear or disappear from the prize-bearing set.
    expect(found.sort((a, b) => a - b)).toEqual(
      Object.keys(EXPECTED)
        .map(Number)
        .sort((a, b) => a - b),
    );
  });

  it('never lets raffle money into the SCALED total either', () => {
    // The F2 reconciliation introduced a second numerator - `guaranteedTotal`,
    // which is what a future fix will write back onto the card - so the raffle
    // rule has to hold there too, not just on `guaranteedMin/Max`. No prize
    // record scales today; if one starts to, this fails and a human checks
    // that the prize was not the thing multiplied.
    for (const { id, compensation, reconciled } of everyReconciled) {
      const prize = compensation.raffleMax ?? 0;
      if (prize === 0 || reconciled.guaranteedTotal === null) continue;
      const guaranteed = compensation.guaranteedMax ?? compensation.guaranteedMin ?? 0;
      expect(reconciled.guaranteedTotal, `record ${id}: prize money reached the total`).toBe(guaranteed);
      expect(reconciled.guaranteedTotal, `record ${id}`).not.toBe(guaranteed + prize);
    }
  });

  it('sinks every unknown to the end of the sort, in both directions', () => {
    const board = studies.map((s) => ({ id: s.id, effectiveHourly: s.effectiveHourly }));
    const unknownCount = board.filter((s) => s.effectiveHourly === null).length;
    expect(unknownCount).toBeGreaterThan(0);

    for (const direction of ['desc', 'asc'] as const) {
      const sorted = sortStudies(board, direction);
      expect(sorted, direction).toHaveLength(board.length);
      const tail = sorted.slice(sorted.length - unknownCount);
      expect(tail.every((s) => s.effectiveHourly === null), direction).toBe(true);
      const head = sorted.slice(0, sorted.length - unknownCount);
      expect(head.every((s) => s.effectiveHourly !== null), direction).toBe(true);
    }
  });

  it('never reports a rate above $200/hr or a nonzero rate below $1/hr without cause', () => {
    // A tripwire, not a rule: any rate outside this band is either a genuine
    // outlier the audit already blessed, or a new unit mismatch.
    const BLESSED_BELOW_ONE: number[] = []; // none today
    for (const { id, rate } of everyRate) {
      if (rate === null || rate === 0) continue;
      expect(rate, `record ${id} exceeds $200/hr`).toBeLessThan(200);
      if (rate < 1 && !BLESSED_BELOW_ONE.includes(id)) {
        throw new Error(`record ${id} reports $${rate}/hr - check for a unit mismatch`);
      }
    }
  });
});
