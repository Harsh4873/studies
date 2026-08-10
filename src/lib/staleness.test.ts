/**
 * Tests for the staleness module.
 *
 * The bug this module exists to catch: upstream serves `status: "publish"` on
 * all 86 records while 16 of them carry an expiration date that has already
 * passed (2025-01-02 through 2026-01-28). Those must come out `isExpired`.
 *
 * Every test injects a fixed `now`. Nothing here reads the system clock except
 * the one test that deliberately checks the default parameter exists.
 *
 * `now` is pinned at 2026-08-09T12:00:00Z - the date the corpus expectations
 * in the implementation notes were computed against.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  AGING_AFTER_MONTHS,
  STALE_AFTER_MONTHS,
  computeStaleness,
  monthsBetween,
  parseStudyDate,
} from '@/lib/staleness.ts';
import type { StalenessInput } from '@/lib/staleness.ts';
import type { RawStudy, Staleness, StudyRecord } from '@/types.ts';

// ---------------------------------------------------------------------------
// Fixture and clock
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url));
const RECORDS = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as RawStudy[];
const BY_ID = new Map<number, RawStudy>(RECORDS.map((r) => [r.id, r]));

function record(id: number): RawStudy {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`fixture record ${id} is missing`);
  return found;
}

/** The single injected clock for the whole suite. */
const NOW = new Date('2026-08-09T12:00:00Z');

/** `now` minus n whole months, at the same clock time. */
function monthsBefore(n: number, extraDays = 0): Date {
  const d = new Date(NOW.getTime());
  d.setUTCMonth(d.getUTCMonth() - n);
  if (extraDays !== 0) d.setUTCDate(d.getUTCDate() + extraDays);
  return d;
}

function input(expiration: string | null, irb: string | null): StalenessInput {
  return { expirationDate: expiration, irbApprovalDate: irb };
}

// ===========================================================================
// 1. parseStudyDate
// ===========================================================================

describe('parseStudyDate', () => {
  it('reads a naive WordPress datetime as UTC', () => {
    // "2026-01-28T00:00:00" is exactly what meta.aux_study_item_expiration_date
    // holds on record 5436. No offset, so it must be pinned to UTC and not to
    // whatever timezone the build machine happens to run in.
    expect(parseStudyDate('2026-01-28T00:00:00')?.getTime()).toBe(Date.UTC(2026, 0, 28, 0, 0, 0));
  });

  it('reads a naive datetime with a real clock time', () => {
    // Record 11901's IRB approval date, verbatim.
    expect(record(11901).meta.aux_study_item_irb_approval_date).toBe('2025-11-21T19:58:09');
    expect(parseStudyDate('2025-11-21T19:58:09')?.getTime()).toBe(Date.UTC(2025, 10, 21, 19, 58, 9));
  });

  it('reads a bare date as UTC midnight', () => {
    expect(parseStudyDate('2025-10-02')?.getTime()).toBe(Date.UTC(2025, 9, 2));
  });

  it('accepts a space separator instead of T', () => {
    expect(parseStudyDate('2025-10-02 08:30')?.getTime()).toBe(Date.UTC(2025, 9, 2, 8, 30));
  });

  it('honours an explicit Z', () => {
    expect(parseStudyDate('2026-01-28T00:00:00Z')?.getTime()).toBe(Date.UTC(2026, 0, 28));
  });

  it('honours an explicit numeric offset', () => {
    // -06:00 is America/Chicago in winter; midnight there is 06:00 UTC.
    expect(parseStudyDate('2026-01-28T00:00:00-06:00')?.getTime()).toBe(Date.UTC(2026, 0, 28, 6));
    expect(parseStudyDate('2026-01-28T00:00:00+02:00')?.getTime()).toBe(Date.UTC(2026, 0, 27, 22));
  });

  it('accepts US slash dates', () => {
    // Some IRB approval dates render as "04/21/2026" in the page body.
    expect(parseStudyDate('04/21/2026')?.getTime()).toBe(Date.UTC(2026, 3, 21));
    expect(parseStudyDate('1/2/2025')?.getTime()).toBe(Date.UTC(2025, 0, 2));
  });

  it('passes a Date through and rejects an invalid one', () => {
    const d = new Date('2026-01-28T00:00:00Z');
    expect(parseStudyDate(d)).toBe(d);
    expect(parseStudyDate(new Date('nonsense'))).toBeNull();
  });

  it('accepts an epoch number', () => {
    expect(parseStudyDate(Date.UTC(2026, 0, 28))?.getTime()).toBe(Date.UTC(2026, 0, 28));
    expect(parseStudyDate(Number.NaN)).toBeNull();
    expect(parseStudyDate(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['garbage', 'not a date at all'],
    ['object', {}],
    ['array', []],
    ['boolean', true],
    ['number-ish string', 'NaN'],
  ])('returns null for %s', (_label, value) => {
    expect(parseStudyDate(value)).toBeNull();
  });

  it('never returns an Invalid Date', () => {
    for (const value of ['2025-13-01', '2025-02-31', '2025-00-10', '2025-04-00', '99/99/2025']) {
      const d = parseStudyDate(value);
      expect(d === null || !Number.isNaN(d.getTime()), `value ${value}`).toBe(true);
    }
  });

  it('rejects calendar rollovers rather than silently shifting the month', () => {
    // Date.UTC(2025, 1, 31) silently becomes 2025-03-03.
    expect(parseStudyDate('2025-02-31')).toBeNull();
    expect(parseStudyDate('2025-13-01')).toBeNull();
  });

  it('parses every date upstream actually sends in the 86-record snapshot', () => {
    for (const r of RECORDS) {
      expect(parseStudyDate(r.meta.aux_study_item_irb_approval_date), `irb of ${r.id}`).toBeInstanceOf(Date);
      const exp = r.meta.aux_study_item_expiration_date;
      if (typeof exp === 'string' && exp !== '') {
        expect(parseStudyDate(exp), `expiration of ${r.id}`).toBeInstanceOf(Date);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Timezone independence, checked for real rather than asserted in a comment
// ---------------------------------------------------------------------------

describe('parseStudyDate - machine timezone independence', () => {
  const originalTz = process.env.TZ;
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  it.each(['UTC', 'America/Chicago', 'Pacific/Kiritimati', 'Pacific/Niue'])(
    'reads "2026-01-28T00:00:00" identically under TZ=%s',
    (tz) => {
      process.env.TZ = tz;
      expect(parseStudyDate('2026-01-28T00:00:00')?.getTime()).toBe(Date.UTC(2026, 0, 28));
    },
  );

  it('classifies a record identically under a far-east and a far-west timezone', () => {
    const source = input('2025-10-02T00:00:00', '2024-06-28T21:30:35');
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
    const east = computeStaleness(source, NOW);
    process.env.TZ = 'Pacific/Niue'; // UTC-11
    const west = computeStaleness(source, NOW);
    expect(east).toEqual(west);
    expect(east).toEqual({ isExpired: true, staleness: 'expired' });
  });
});

// ===========================================================================
// 2. monthsBetween
// ===========================================================================

describe('monthsBetween', () => {
  it('is 0 for the same instant', () => {
    expect(monthsBetween(NOW, NOW)).toBe(0);
  });

  it.each([1, 2, 3, 6, 9, 12, 18, 24])('is exactly %i for an %i-month anniversary', (n) => {
    expect(monthsBetween(monthsBefore(n), NOW)).toBeCloseTo(n, 10);
  });

  it('counts calendar months, not 30-day blocks', () => {
    // Feb -> Mar is one month even though it is 28 days.
    expect(monthsBetween(new Date('2025-02-10T00:00:00Z'), new Date('2025-03-10T00:00:00Z'))).toBeCloseTo(1, 10);
    // Jul -> Aug is one month even though it is 31 days.
    expect(monthsBetween(new Date('2025-07-10T00:00:00Z'), new Date('2025-08-10T00:00:00Z'))).toBeCloseTo(1, 10);
  });

  it('returns a fraction inside a month', () => {
    const half = monthsBetween(new Date('2025-01-01T00:00:00Z'), new Date('2025-01-16T00:00:00Z'));
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
  });

  it('is monotonic', () => {
    let previous = -Infinity;
    for (const days of [0, 5, 20, 40, 100, 300, 1000]) {
      const earlier = new Date(NOW.getTime() - days * 86_400_000);
      const value = monthsBetween(earlier, NOW);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('is negative when the later argument precedes the earlier one', () => {
    expect(monthsBetween(NOW, monthsBefore(6))).toBeCloseTo(-6, 10);
  });

  it('handles a month-end anniversary without overflowing', () => {
    // 31 Jan + 1 month has no 31st, so it must clamp to 28 Feb rather than
    // rolling into March.
    const value = monthsBetween(new Date('2025-01-31T00:00:00Z'), new Date('2025-02-28T00:00:00Z'));
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThan(2);
  });
});

// ===========================================================================
// 3. computeStaleness - bucket boundaries
// ===========================================================================

describe('computeStaleness - fresh / aging / stale boundaries', () => {
  it('exposes the documented thresholds', () => {
    expect(AGING_AFTER_MONTHS).toBe(9);
    expect(STALE_AFTER_MONTHS).toBe(18);
  });

  const bucket = (irb: Date): Staleness =>
    computeStaleness(input(null, irb.toISOString()), NOW).staleness;

  it('is fresh for a brand-new IRB approval', () => {
    expect(bucket(NOW)).toBe('fresh');
    expect(bucket(monthsBefore(0, -1))).toBe('fresh');
  });

  it('is fresh right up to, but not including, 9 months', () => {
    expect(bucket(monthsBefore(8))).toBe('fresh');
    // One day short of the 9-month anniversary (approval is one day newer).
    expect(bucket(monthsBefore(9, 1))).toBe('fresh');
  });

  it('becomes aging exactly at 9 months', () => {
    expect(bucket(monthsBefore(9))).toBe('aging');
    // One day past the anniversary.
    expect(bucket(monthsBefore(9, -1))).toBe('aging');
  });

  it('stays aging through the 18-month anniversary inclusive', () => {
    expect(bucket(monthsBefore(12))).toBe('aging');
    expect(bucket(monthsBefore(17))).toBe('aging');
    expect(bucket(monthsBefore(18))).toBe('aging');
  });

  it('becomes stale just past 18 months', () => {
    expect(bucket(monthsBefore(18, -1))).toBe('stale');
    expect(bucket(monthsBefore(19))).toBe('stale');
    expect(bucket(monthsBefore(36))).toBe('stale');
  });

  it('never reports isExpired when there is no expiration date', () => {
    for (const n of [0, 9, 18, 36]) {
      expect(computeStaleness(input(null, monthsBefore(n).toISOString()), NOW).isExpired).toBe(false);
    }
  });
});

// ===========================================================================
// 4. computeStaleness - expiry
// ===========================================================================

describe('computeStaleness - expiry', () => {
  it('marks a past expiration date expired regardless of a fresh IRB approval', () => {
    const result = computeStaleness(input('2025-10-02T00:00:00', NOW.toISOString()), NOW);
    expect(result).toEqual({ isExpired: true, staleness: 'expired' });
  });

  it('is expired one millisecond after the expiration instant', () => {
    const exp = '2026-08-09T11:59:59';
    expect(computeStaleness(input(exp, NOW.toISOString()), NOW).isExpired).toBe(true);
  });

  it('is NOT expired at the exact expiration instant (strictly-before comparison)', () => {
    const result = computeStaleness(input('2026-08-09T12:00:00', NOW.toISOString()), NOW);
    expect(result.isExpired).toBe(false);
    expect(result.staleness).toBe('fresh');
  });

  it('caps a future-dated listing at "aging" even with an ancient IRB approval', () => {
    // Documented judgement call: a future expiration date is an affirmative
    // "live until" from the study team, so a 3-year-old approval does not make
    // the listing stale.
    const result = computeStaleness(input('2027-01-01T00:00:00', monthsBefore(36).toISOString()), NOW);
    expect(result).toEqual({ isExpired: false, staleness: 'aging' });
  });

  it('does not upgrade a fresh listing just because it has a future expiration', () => {
    const result = computeStaleness(input('2027-01-01T00:00:00', monthsBefore(2).toISOString()), NOW);
    expect(result).toEqual({ isExpired: false, staleness: 'fresh' });
  });
});

// ===========================================================================
// 5. computeStaleness - missing and malformed input
// ===========================================================================

describe('computeStaleness - missing and malformed input', () => {
  it('falls back to "stale" when there is nothing to reason from', () => {
    expect(computeStaleness(input(null, null), NOW)).toEqual({ isExpired: false, staleness: 'stale' });
    expect(computeStaleness({}, NOW)).toEqual({ isExpired: false, staleness: 'stale' });
  });

  it('is pessimistic - never "fresh" - on an unparseable IRB approval date', () => {
    expect(computeStaleness(input(null, 'not a date'), NOW).staleness).toBe('stale');
    expect(computeStaleness(input(null, ''), NOW).staleness).toBe('stale');
  });

  it('uses "aging" when the approval date is missing but a future expiration exists', () => {
    expect(computeStaleness(input('2027-01-01T00:00:00', null), NOW)).toEqual({
      isExpired: false,
      staleness: 'aging',
    });
  });

  it('treats a literal null expiration exactly like an absent one', () => {
    const withNull = computeStaleness(input(null, '2025-01-01T00:00:00'), NOW);
    const withEmpty = computeStaleness(input('', '2025-01-01T00:00:00'), NOW);
    expect(withNull).toEqual(withEmpty);
  });

  it('does not call .trim() on a non-string meta value', () => {
    // 4 of 86 records send literal `null` here rather than ''.
    expect(() =>
      computeStaleness({ expirationDate: null, irbApprovalDate: null } as StalenessInput, NOW),
    ).not.toThrow();
    expect(() => computeStaleness({ expirationDate: 12345 } as unknown as StalenessInput, NOW)).not.toThrow();
  });

  it('recovers from an invalid `now`', () => {
    expect(() => computeStaleness(input(null, '2025-01-01T00:00:00'), new Date('nonsense'))).not.toThrow();
  });

  it('treats a future IRB approval date as fresh rather than throwing', () => {
    expect(computeStaleness(input(null, '2027-01-01T00:00:00'), NOW).staleness).toBe('fresh');
  });

  it('has a working default `now`', () => {
    // The only test allowed to touch the system clock. A listing that expired
    // in 2025 is expired under any plausible present.
    expect(computeStaleness(input('2025-01-02T00:00:00', '2024-05-22T21:32:43')).isExpired).toBe(true);
  });
});

// ===========================================================================
// 6. computeStaleness - accepts all three source shapes
// ===========================================================================

describe('computeStaleness - source shapes', () => {
  it('reads a RawStudy from meta.aux_study_item_*', () => {
    const raw = record(4632);
    expect(raw.meta.aux_study_item_expiration_date).toBe('2025-01-02T00:00:00');
    expect(computeStaleness(raw, NOW)).toEqual({ isExpired: true, staleness: 'expired' });
  });

  it('reads a StudyRecord from its top-level ISO fields', () => {
    const asRecord = {
      expirationDate: '2025-01-02T00:00:00.000Z',
      irbApprovalDate: '2024-05-22T21:32:43.000Z',
    } as StudyRecord;
    expect(computeStaleness(asRecord, NOW)).toEqual({ isExpired: true, staleness: 'expired' });
  });

  it('gives the same answer for a RawStudy and the equivalent bare input, on every record', () => {
    for (const raw of RECORDS) {
      const viaRaw = computeStaleness(raw, NOW);
      const viaInput = computeStaleness(
        input(raw.meta.aux_study_item_expiration_date, raw.meta.aux_study_item_irb_approval_date),
        NOW,
      );
      expect(viaInput, `record ${raw.id}`).toEqual(viaRaw);
    }
  });
});

// ===========================================================================
// 7. The real bug: 16 published records with past expiration dates
// ===========================================================================

describe('computeStaleness - the 86-record snapshot at 2026-08-09', () => {
  const WITH_EXPIRATION = RECORDS.filter(
    (r) => typeof r.meta.aux_study_item_expiration_date === 'string' && r.meta.aux_study_item_expiration_date !== '',
  );

  it('16 of 86 records carry an expiration date', () => {
    expect(WITH_EXPIRATION).toHaveLength(16);
  });

  it('every one of them is already in the past while status is still "publish"', () => {
    for (const raw of WITH_EXPIRATION) {
      expect(raw.status, `record ${raw.id}`).toBe('publish');
      const result = computeStaleness(raw, NOW);
      expect(result.isExpired, `record ${raw.id} expiring ${raw.meta.aux_study_item_expiration_date}`).toBe(true);
      expect(result.staleness).toBe('expired');
    }
  });

  it.each([
    // The three dates called out in the brief, plus the latest one in the set.
    [4632, '2025-01-02T00:00:00'],
    [4642, '2025-04-02T00:00:00'],
    [4634, '2025-04-02T00:00:00'],
    [4620, '2025-04-02T00:00:00'],
    [4618, '2025-04-02T00:00:00'],
    [4636, '2025-10-02T00:00:00'],
    [4630, '2025-10-02T00:00:00'],
    [4626, '2025-10-02T00:00:00'],
    [4624, '2025-10-02T00:00:00'],
    [4615, '2025-10-02T00:00:00'],
    [4613, '2025-10-02T00:00:00'],
    [4611, '2025-10-02T00:00:00'],
    [4607, '2025-10-02T00:00:00'],
    [4593, '2025-10-02T00:00:00'],
    [4591, '2025-10-02T00:00:00'],
    [5436, '2026-01-28T00:00:00'],
  ])('record %i expires %s and is reported expired', (id, expected) => {
    const raw = record(id);
    expect(raw.meta.aux_study_item_expiration_date).toBe(expected);
    expect(computeStaleness(raw, NOW)).toEqual({ isExpired: true, staleness: 'expired' });
  });

  it('lists exactly those 16 ids as expired', () => {
    const expired = RECORDS.filter((r) => computeStaleness(r, NOW).isExpired).map((r) => r.id);
    expect(expired.sort((a, b) => a - b)).toEqual(
      [4591, 4593, 4607, 4611, 4613, 4615, 4618, 4620, 4624, 4626, 4630, 4632, 4634, 4636, 4642, 5436],
    );
  });

  it('produces the expected bucket distribution over all 86 records', () => {
    const tally: Record<Staleness, number> = { fresh: 0, aging: 0, stale: 0, expired: 0 };
    for (const raw of RECORDS) tally[computeStaleness(raw, NOW).staleness] += 1;
    expect(tally).toEqual({ expired: 16, stale: 29, aging: 27, fresh: 14 });
  });

  it('reports isExpired if and only if staleness is "expired"', () => {
    for (const raw of RECORDS) {
      const { isExpired, staleness } = computeStaleness(raw, NOW);
      expect(isExpired, `record ${raw.id}`).toBe(staleness === 'expired');
    }
  });

  it('re-classifies the whole corpus as the clock advances, without any record going backwards', () => {
    const rank: Record<Staleness, number> = { fresh: 0, aging: 1, stale: 2, expired: 3 };
    const later = new Date('2027-08-09T12:00:00Z');
    for (const raw of RECORDS) {
      const before = computeStaleness(raw, NOW).staleness;
      const after = computeStaleness(raw, later).staleness;
      expect(rank[after], `record ${raw.id} went ${before} -> ${after}`).toBeGreaterThanOrEqual(rank[before]);
    }
  });
});
