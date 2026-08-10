/**
 * Tests for diff.ts - snapshot-to-snapshot delta.
 *
 * The module answers one question: "what actually changed upstream since the
 * last build?" Two failure modes matter and both are tested against the real
 * 79-record snapshot as well as against hand-built minimal cases:
 *
 *   FALSE POSITIVE - reporting churn that no participant would notice.
 *     WordPress rewrites `modified` on cosmetic edits and flips meta fields
 *     between `null` and `''`. If the diff reports those, the build log becomes
 *     noise and real changes get lost in it.
 *
 *   FALSE NEGATIVE - missing a change that matters. Compensation, duration,
 *     expiration and IRB re-approval are the four fields a participant acts on.
 *
 * Output must also be deterministic: `diff.json` is committed to the build
 * output, so two runs over the same inputs have to be byte-identical.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DIFF_FIELDS, diffSnapshots, isEmptyDiff, summarizeDiff } from '@/lib/diff.ts';
import { normalizeAndDedupe } from '@/lib/normalize.ts';
import type { RawStudy, Snapshot, StudyRecord } from '@/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url));
const RAW = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as RawStudy[];
const NOW = new Date('2026-08-09T12:00:00Z');

/** The real 79-record snapshot, rebuilt fresh for each caller so tests cannot share mutations. */
function realSnapshot(): Snapshot {
  return {
    fetchedAt: '2026-08-09T12:00:00.000Z',
    totalFromHeader: 86,
    studies: normalizeAndDedupe(RAW, { now: NOW }).studies,
  };
}

/** A minimal StudyRecord with only the fields the diff reads. */
function study(id: string, overrides: Partial<StudyRecord> = {}): StudyRecord {
  return {
    id,
    slug: `study-${id}`,
    title: `Study ${id}`,
    summary: '',
    url: `https://research.tamu.edu/study/study-${id}/`,
    piName: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    irbNumber: `STUDY2026-${id}`,
    irbApprovalDate: '2026-01-01T00:00:00.000Z',
    expirationDate: null,
    recruitmentStartDate: null,
    lifecycleMonths: 6,
    postedDate: '2026-01-01T00:00:00.000Z',
    modifiedDate: '2026-01-01T00:00:00.000Z',
    categoryIds: [],
    locationIds: [],
    sessionTypeIds: [],
    topicIds: [],
    compensation: {
      guaranteedMin: 20,
      guaranteedMax: 20,
      raffleMax: null,
      raffleOnly: false,
      isHourlyRate: false,
      hourlyMin: null,
      hourlyMax: null,
      currencyKind: 'cash',
      perVisit: null,
      visitCount: null,
      completionBonus: null,
      hasNonCashPerk: false,
      sonaCreditOption: false,
      raw: '$20',
      confidence: 'high',
      notes: [],
    },
    duration: {
      totalHoursMin: 1,
      totalHoursMax: 1,
      sessionCount: 1,
      spanWeeks: null,
      raw: '1 hour',
      confidence: 'high',
    },
    eligibility: {
      minAge: 18,
      maxAge: null,
      requiresRightHanded: false,
      requiresMriSafe: false,
      requiresFasting: false,
      excludesCardiovascular: false,
      excludesPregnancy: false,
      excludesSeizure: false,
      excludesNeurological: false,
      requiresSpecificCondition: null,
      requiresParentOrChild: false,
      sexRestriction: null,
      flags: [],
    },
    effectiveHourly: 20,
    isExpired: false,
    staleness: 'fresh',
    tags: [],
    ...overrides,
  };
}

function snapshot(studies: StudyRecord[]): Snapshot {
  return { fetchedAt: '2026-08-09T12:00:00.000Z', totalFromHeader: studies.length, studies };
}

const EMPTY = { added: [], removed: [], changed: [] };

// ===========================================================================
// 1. The watched field set
// ===========================================================================

describe('DIFF_FIELDS', () => {
  it('watches exactly the four fields a participant acts on, in report order', () => {
    expect(DIFF_FIELDS.map((f) => f.field)).toEqual([
      'compensation.raw',
      'duration.raw',
      'expirationDate',
      'irbApprovalDate',
    ]);
  });

  it('each reader returns a string or null for a real record', () => {
    const record = realSnapshot().studies[0];
    expect(record).toBeDefined();
    for (const { field, read } of DIFF_FIELDS) {
      const value = read(record as StudyRecord);
      expect(value === null || typeof value === 'string', field).toBe(true);
    }
  });
});

// ===========================================================================
// 2. No-op diffs
// ===========================================================================

describe('diffSnapshots - no-op', () => {
  it('reports nothing for two references to the same snapshot', () => {
    const snap = realSnapshot();
    expect(diffSnapshots(snap, snap)).toEqual(EMPTY);
  });

  it('reports nothing for two independently built copies of the real 79-record snapshot', () => {
    const a = realSnapshot();
    const b = realSnapshot();
    expect(a.studies).toHaveLength(79);
    const diff = diffSnapshots(a, b);
    expect(diff).toEqual(EMPTY);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it('reports nothing when only `fetchedAt` moved', () => {
    const a = realSnapshot();
    const b = { ...realSnapshot(), fetchedAt: '2026-09-01T00:00:00.000Z' };
    expect(diffSnapshots(a, b)).toEqual(EMPTY);
  });

  it('reports nothing for two empty snapshots', () => {
    expect(diffSnapshots(snapshot([]), snapshot([]))).toEqual(EMPTY);
  });

  it('isEmptyDiff is true only when all three lists are empty', () => {
    expect(isEmptyDiff({ added: [], removed: [], changed: [] })).toBe(true);
    expect(isEmptyDiff({ added: ['1'], removed: [], changed: [] })).toBe(false);
    expect(isEmptyDiff({ added: [], removed: ['1'], changed: [] })).toBe(false);
    expect(isEmptyDiff({ added: [], removed: [], changed: [{ id: '1', fields: ['duration.raw'] }] })).toBe(false);
  });
});

// ===========================================================================
// 3. Added and removed
// ===========================================================================

describe('diffSnapshots - added and removed', () => {
  it('reports a brand-new study as added', () => {
    const prev = snapshot([study('100')]);
    const next = snapshot([study('100'), study('200')]);
    expect(diffSnapshots(prev, next)).toEqual({ added: ['200'], removed: [], changed: [] });
  });

  it('reports a vanished study as removed', () => {
    const prev = snapshot([study('100'), study('200')]);
    const next = snapshot([study('100')]);
    expect(diffSnapshots(prev, next)).toEqual({ added: [], removed: ['200'], changed: [] });
  });

  it('reports added and removed together', () => {
    const prev = snapshot([study('100'), study('200')]);
    const next = snapshot([study('200'), study('300')]);
    expect(diffSnapshots(prev, next)).toEqual({ added: ['300'], removed: ['100'], changed: [] });
  });

  it('treats a first-ever run (no previous snapshot) as everything added', () => {
    const next = realSnapshot();
    for (const prev of [null, undefined]) {
      const diff = diffSnapshots(prev, next);
      expect(diff.added).toHaveLength(79);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([]);
    }
  });

  it('treats a missing next snapshot as everything removed', () => {
    const diff = diffSnapshots(realSnapshot(), null);
    expect(diff.removed).toHaveLength(79);
    expect(diff.added).toEqual([]);
  });

  it('reports nothing when both sides are missing', () => {
    expect(diffSnapshots(null, null)).toEqual(EMPTY);
    expect(diffSnapshots(undefined, undefined)).toEqual(EMPTY);
  });

  it('detects the real seven duplicates disappearing if dedupe were switched off', () => {
    const deduped = realSnapshot();
    const all = snapshot(normalizeAndDedupe(RAW, { now: NOW }).studies);
    const withDupes = snapshot([
      ...all.studies,
      ...normalizeAndDedupe(RAW, { now: NOW }).dropped,
    ]);
    const diff = diffSnapshots(withDupes, deduped);
    expect(diff.removed).toEqual(['6753', '7003', '8411', '8876', '8908', '11317', '11324']);
    expect(diff.added).toEqual([]);
  });
});

// ===========================================================================
// 4. Changed
// ===========================================================================

describe('diffSnapshots - changed', () => {
  it.each([
    ['compensation.raw', (s: StudyRecord) => (s.compensation.raw = '$40')],
    ['duration.raw', (s: StudyRecord) => (s.duration.raw = '2 hours')],
    ['expirationDate', (s: StudyRecord) => (s.expirationDate = '2027-01-01T00:00:00.000Z')],
    ['irbApprovalDate', (s: StudyRecord) => (s.irbApprovalDate = '2026-06-01T00:00:00.000Z')],
  ])('detects a change to %s', (field, mutate) => {
    const before = study('100');
    const after = study('100');
    mutate(after);
    expect(diffSnapshots(snapshot([before]), snapshot([after]))).toEqual({
      added: [],
      removed: [],
      changed: [{ id: '100', fields: [field] }],
    });
  });

  it('lists several changed fields in DIFF_FIELDS order', () => {
    const after = study('100', { irbApprovalDate: '2026-06-01T00:00:00.000Z' });
    after.compensation.raw = '$40';
    after.duration.raw = '2 hours';
    const diff = diffSnapshots(snapshot([study('100')]), snapshot([after]));
    expect(diff.changed).toEqual([
      { id: '100', fields: ['compensation.raw', 'duration.raw', 'irbApprovalDate'] },
    ]);
  });

  it('detects a real pay change on a real record', () => {
    const prev = realSnapshot();
    const next = realSnapshot();
    const target = next.studies.find((s) => s.id === '11901');
    expect(target?.compensation.raw).toBe('$10 Amazon e-gift card');
    if (target) target.compensation.raw = '$25 Amazon e-gift card';

    expect(diffSnapshots(prev, next)).toEqual({
      added: [],
      removed: [],
      changed: [{ id: '11901', fields: ['compensation.raw'] }],
    });
  });

  it('detects an expiration being extended - the change that resurrects a listing', () => {
    const prev = realSnapshot();
    const next = realSnapshot();
    const target = next.studies.find((s) => s.id === '4632');
    expect(target?.expirationDate).toBe('2025-01-02T00:00:00.000Z');
    if (target) target.expirationDate = '2027-01-02T00:00:00.000Z';

    expect(diffSnapshots(prev, next).changed).toEqual([{ id: '4632', fields: ['expirationDate'] }]);
  });

  it('detects an IRB re-approval', () => {
    const prev = realSnapshot();
    const next = realSnapshot();
    const target = next.studies.find((s) => s.id === '12764');
    if (target) target.irbApprovalDate = '2026-07-01T00:00:00.000Z';
    expect(diffSnapshots(prev, next).changed).toEqual([{ id: '12764', fields: ['irbApprovalDate'] }]);
  });
});

// ===========================================================================
// 5. Changes that must NOT be reported
// ===========================================================================

describe('diffSnapshots - noise suppression', () => {
  it('ignores a cosmetic title edit', () => {
    const after = study('100', { title: 'Study 100 (updated wording)' });
    expect(diffSnapshots(snapshot([study('100')]), snapshot([after]))).toEqual(EMPTY);
  });

  it('ignores `modified` being rewritten upstream', () => {
    const after = study('100', { modifiedDate: '2026-08-01T00:00:00.000Z' });
    expect(diffSnapshots(snapshot([study('100')]), snapshot([after]))).toEqual(EMPTY);
  });

  it.each([
    ['summary', { summary: 'a new blurb' }],
    ['slug', { slug: 'renamed' }],
    ['contactEmail', { contactEmail: 'someone-else@tamu.edu' }],
    ['tags', { tags: ['online', 'survey'] }],
    ['staleness', { staleness: 'stale' as const }],
    ['effectiveHourly', { effectiveHourly: 99 }],
    ['categoryIds', { categoryIds: [1, 2, 3] }],
  ])('ignores a change to %s', (_label, patch) => {
    expect(diffSnapshots(snapshot([study('100')]), snapshot([study('100', patch)]))).toEqual(EMPTY);
  });

  it('ignores a parsed-compensation change when the raw text is identical', () => {
    // Only `.raw` is watched. A parser improvement must not look like upstream
    // churn, or every parser release reports 86 changed studies.
    const after = study('100');
    after.compensation.guaranteedMax = 45;
    after.compensation.confidence = 'low';
    expect(diffSnapshots(snapshot([study('100')]), snapshot([after]))).toEqual(EMPTY);
  });

  it.each([
    ['null -> empty string', null, ''],
    ['empty string -> null', '', null],
    ['null -> whitespace', null, '   '],
    ['value -> same value with padding', '2026-01-01T00:00:00.000Z', ' 2026-01-01T00:00:00.000Z '],
  ])('treats %s as no change on expirationDate', (_label, before, after) => {
    expect(
      diffSnapshots(
        snapshot([study('100', { expirationDate: before })]),
        snapshot([study('100', { expirationDate: after })]),
      ),
    ).toEqual(EMPTY);
  });

  it('DOES report null -> a real date', () => {
    const diff = diffSnapshots(
      snapshot([study('100', { expirationDate: null })]),
      snapshot([study('100', { expirationDate: '2027-01-01T00:00:00.000Z' })]),
    );
    expect(diff.changed).toEqual([{ id: '100', fields: ['expirationDate'] }]);
  });
});

// ===========================================================================
// 6. Determinism
// ===========================================================================

describe('diffSnapshots - determinism', () => {
  it('sorts ids numerically, not lexically', () => {
    const prev = snapshot([study('11324'), study('9028'), study('700')]);
    const next = snapshot([study('11896'), study('8908'), study('90')]);
    const diff = diffSnapshots(prev, next);
    expect(diff.added).toEqual(['90', '8908', '11896']);
    expect(diff.removed).toEqual(['700', '9028', '11324']);
  });

  it('sorts changed entries numerically too', () => {
    const ids = ['11324', '9028', '700'];
    const prev = snapshot(ids.map((id) => study(id)));
    const next = snapshot(ids.map((id) => study(id, { expirationDate: '2027-01-01T00:00:00.000Z' })));
    expect(diffSnapshots(prev, next).changed.map((c) => c.id)).toEqual(['700', '9028', '11324']);
  });

  it('falls back to string ordering for non-numeric ids', () => {
    const prev = snapshot([]);
    const next = snapshot([study('zebra'), study('alpha'), study('12')]);
    expect(diffSnapshots(prev, next).added).toEqual(['12', 'alpha', 'zebra']);
  });

  it('is independent of input ordering', () => {
    const a = realSnapshot();
    const b = realSnapshot();
    b.studies.reverse();
    const target = b.studies.find((s) => s.id === '11901');
    if (target) target.duration.raw = '45 minutes';

    const forwards = diffSnapshots(a, b);
    const backwards = diffSnapshots({ ...a, studies: [...a.studies].reverse() }, b);
    expect(forwards).toEqual(backwards);
    expect(forwards.changed).toEqual([{ id: '11901', fields: ['duration.raw'] }]);
  });

  it('serializes identically across repeated runs', () => {
    const a = realSnapshot();
    const b = realSnapshot();
    b.studies = b.studies.slice(0, 70);
    expect(JSON.stringify(diffSnapshots(a, b))).toBe(JSON.stringify(diffSnapshots(realSnapshot(), b)));
  });
});

// ===========================================================================
// 7. Malformed input
// ===========================================================================

describe('diffSnapshots - malformed input', () => {
  it('never throws on junk', () => {
    const junk = {
      fetchedAt: '',
      totalFromHeader: 0,
      studies: [null, undefined, {}, { id: 5 }, 'nope'] as unknown as StudyRecord[],
    };
    expect(() => diffSnapshots(junk, realSnapshot())).not.toThrow();
    expect(() => diffSnapshots(realSnapshot(), junk)).not.toThrow();
    expect(() => diffSnapshots({} as Snapshot, {} as Snapshot)).not.toThrow();
  });

  it('skips records without a string id rather than crashing the build', () => {
    const next = snapshot([study('100'), { id: 5 } as unknown as StudyRecord]);
    const diff = diffSnapshots(snapshot([study('100')]), next);
    expect(diff).toEqual(EMPTY);
  });

  /**
   * DOCUMENTS CURRENT BEHAVIOUR - see the findings note.
   *
   * A record whose `id` is a number rather than a string is invisible to
   * `indexById`, so if the previous snapshot had it as a string and the next
   * one has it as a number, the study is reported as REMOVED even though it is
   * still there. `StudyRecord.id` is typed `string` and `normalizeStudy` always
   * emits `String(raw.id)`, so this is only reachable from a hand-edited or
   * externally-produced snapshot.json.
   */
  it('reports a still-present record as removed when its id arrives as a number', () => {
    const prev = snapshot([study('100')]);
    const next = snapshot([{ ...study('100'), id: 100 } as unknown as StudyRecord]);
    expect(diffSnapshots(prev, next)).toEqual({ added: [], removed: ['100'], changed: [] });
  });

  it('tolerates a record missing its parsed sub-objects', () => {
    const broken = { id: '100' } as unknown as StudyRecord;
    expect(() => diffSnapshots(snapshot([broken]), snapshot([study('100')]))).not.toThrow();
    const diff = diffSnapshots(snapshot([broken]), snapshot([study('100')]));
    expect(diff.changed).toEqual([
      { id: '100', fields: ['compensation.raw', 'duration.raw', 'irbApprovalDate'] },
    ]);
  });

  it('handles a snapshot with a missing studies array', () => {
    expect(diffSnapshots({ fetchedAt: '', totalFromHeader: 0 } as Snapshot, realSnapshot()).added).toHaveLength(79);
  });
});

// ===========================================================================
// 8. summarizeDiff
// ===========================================================================

describe('summarizeDiff', () => {
  it('says so plainly when nothing moved', () => {
    expect(summarizeDiff({ added: [], removed: [], changed: [] })).toBe(
      'no changes since the previous snapshot',
    );
  });

  it('leads with the counts and lists one item per line', () => {
    const text = summarizeDiff({
      added: ['200'],
      removed: ['100'],
      changed: [{ id: '300', fields: ['compensation.raw', 'duration.raw'] }],
    });
    expect(text.split('\n')).toEqual([
      '1 added, 1 removed, 1 changed',
      '  + 200',
      '  - 100',
      '  ~ 300: compensation.raw, duration.raw',
    ]);
  });

  it('labels ids with titles when a lookup map is supplied', () => {
    const byId = new Map<string, StudyRecord>([['11901', study('11901', { title: 'Green Campus and Health' })]]);
    const text = summarizeDiff({ added: ['11901'], removed: [], changed: [] }, byId);
    expect(text).toContain('+ 11901 (Green Campus and Health)');
  });

  it('truncates a long title to 60 characters', () => {
    const longTitle = 'x'.repeat(200);
    const byId = new Map<string, StudyRecord>([['1', study('1', { title: longTitle })]]);
    expect(summarizeDiff({ added: ['1'], removed: [], changed: [] }, byId)).toContain(`(${'x'.repeat(60)})`);
  });

  it('falls back to bare ids when the map has no entry', () => {
    expect(summarizeDiff({ added: ['999'], removed: [], changed: [] }, new Map())).toContain('+ 999');
  });

  it('summarizes a real first-ever run', () => {
    const diff = diffSnapshots(null, realSnapshot());
    const byId = new Map(realSnapshot().studies.map((s) => [s.id, s]));
    const text = summarizeDiff(diff, byId);
    expect(text.startsWith('79 added, 0 removed, 0 changed')).toBe(true);
    expect(text.split('\n')).toHaveLength(80);
  });
});
