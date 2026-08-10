/**
 * Tests for normalize.ts - the seam between "whatever WordPress emitted" and
 * the StudyRecord contract in src/types.ts.
 *
 * What matters here, in order:
 *   1. It must not throw. A single malformed record must not take down a build
 *      that would otherwise ship 85 good studies.
 *   2. HTML entities must be decoded. Titles carry `&amp;` and `&#8211;`, and a
 *      raw entity on the page is a visible defect.
 *   3. Duplicate IRB numbers must collapse to one row. The registry re-posts
 *      the same protocol under new ids, and every "how many studies pay over
 *      $30/hr" claim the site makes is wrong if those double-count.
 *   4. The full 86-record fixture must normalize end to end, and two records
 *      are pinned field-by-field so an accidental contract change is loud.
 *
 * The clock is injected everywhere (2026-08-09T12:00:00Z) so staleness on a
 * normalized record is reproducible.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  TAG_ORDER,
  dedupeStudies,
  deriveTags,
  normalizeAndDedupe,
  normalizeStudies,
  normalizeStudy,
  unexpectedLifecycleValues,
} from '@/lib/normalize.ts';
import type { DedupedStudyRecord } from '@/lib/normalize.ts';
import { parseCompensation } from '@/lib/parse-compensation.ts';
import { computeStaleness } from '@/lib/staleness.ts';
import type { RawStudy, StudyRecord, TaxonomyMaps } from '@/types.ts';

// ---------------------------------------------------------------------------
// Fixture and clock
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url));
const RECORDS = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as RawStudy[];
const BY_ID = new Map<number, RawStudy>(RECORDS.map((r) => [r.id, r]));

const NOW = new Date('2026-08-09T12:00:00Z');

function raw(id: number): RawStudy {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`fixture record ${id} is missing`);
  return found;
}

function one(id: number): DedupedStudyRecord {
  return normalizeStudy(raw(id), { now: NOW });
}

/** A fresh normalized batch. `dedupeStudies` mutates its inputs, so never share. */
function freshBatch(): DedupedStudyRecord[] {
  return normalizeStudies(RECORDS, { now: NOW }).studies;
}

// ===========================================================================
// 1. Fixture preconditions
// ===========================================================================

describe('fixture preconditions', () => {
  it('is 86 records with 79 distinct IRB numbers', () => {
    expect(RECORDS).toHaveLength(86);
    expect(new Set(RECORDS.map((r) => r.meta.aux_study_item_irb_number)).size).toBe(79);
  });

  it('has an IRB number on every record, so dedupe never has to guess', () => {
    expect(RECORDS.filter((r) => !r.meta.aux_study_item_irb_number)).toEqual([]);
  });
});

// ===========================================================================
// 2. HTML entity decoding
// ===========================================================================

describe('normalizeStudy - HTML entities and markup', () => {
  it('decodes &amp; in a title', () => {
    // id 11072, upstream: "Exploring Kinesthetic Glitch through Reflecting &amp; Making"
    expect(raw(11072).title.rendered).toContain('&amp;');
    expect(one(11072).title).toBe('Exploring Kinesthetic Glitch through Reflecting & Making');
    expect(one(11072).title).not.toContain('&amp;');
  });

  it('decodes a numeric entity (&#8211; en dash) in a title', () => {
    // id 6960, upstream: "Buenas &#8211; Giving All a Seat at the Table..."
    expect(raw(6960).title.rendered).toContain('&#8211;');
    expect(one(6960).title).toBe(
      'Buenas – Giving All a Seat at the Table Using Extended Reality: User study 1 – Evaluation of Initial Implementation',
    );
  });

  it('decodes multiple entities in one title', () => {
    // id 5436 carries two &amp; and a curly apostrophe.
    expect(one(5436).title).toBe(
      'The human cerebellum: a novel target for cognitive & motor interventions in aging & Alzheimer’s Disease',
    );
  });

  it('leaves no bare entity or tag in ANY normalized title or summary', () => {
    const entity = /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;
    for (const record of freshBatch()) {
      expect(record.title, `title of ${record.id}`).not.toMatch(entity);
      expect(record.title, `title of ${record.id}`).not.toMatch(/<[^>]+>/);
      expect(record.summary, `summary of ${record.id}`).not.toMatch(entity);
      expect(record.summary, `summary of ${record.id}`).not.toMatch(/<[^>]+>/);
    }
  });

  it('collapses whitespace and caps the summary length', () => {
    for (const record of freshBatch()) {
      expect(record.summary, `summary of ${record.id}`).not.toMatch(/\s{2,}/);
      expect(record.summary.length, `summary of ${record.id}`).toBeLessThanOrEqual(261);
    }
  });
});

// ===========================================================================
// 3. Two fully normalized records, pinned field by field
// ===========================================================================

describe('normalizeStudy - full record snapshots', () => {
  it('normalizes id 11901 "Green Campus and Health" exactly', () => {
    expect(one(11901)).toEqual({
      id: '11901',
      slug: 'green-campus-and-health-2',
      title: 'Green Campus and Health',
      summary:
        'This study aims to better understand the roles of the campus environment in promoting or hindering the students’ health and quality of life, and support our future efforts to develop healthy campus environments.',
      url: 'https://research.tamu.edu/study/green-campus-and-health-2/',
      // Upstream stores the "PI: " prefix inside the value; normalize preserves
      // the meta field verbatim rather than second-guessing it.
      piName: 'PI: Chanam Lee, PhD, MLA',
      contactName: 'Li Deng',
      contactEmail: 'lideng@tamu.edu',
      contactPhone: null,
      irbNumber: 'STUDY2025-1035',
      // Naive "2025-11-21T19:58:09" is read as UTC, not as America/Chicago.
      irbApprovalDate: '2025-11-21T19:58:09.000Z',
      expirationDate: null,
      recruitmentStartDate: null,
      lifecycleMonths: 6,
      postedDate: '2026-04-08T00:59:57.000Z',
      modifiedDate: '2026-04-08T00:59:57.000Z',
      categoryIds: [37],
      locationIds: [53, 54],
      sessionTypeIds: [62],
      topicIds: [34],
      compensation: {
        guaranteedMin: 10,
        guaranteedMax: 10,
        raffleMax: null,
        raffleOnly: false,
        isHourlyRate: false,
        hourlyMin: null,
        hourlyMax: null,
        currencyKind: 'giftcard',
        perVisit: null,
        visitCount: null,
        completionBonus: null,
        hasNonCashPerk: false,
        sonaCreditOption: false,
        raw: '$10 Amazon e-gift card',
        confidence: 'high',
        notes: [],
      },
      duration: {
        totalHoursMin: 0.3333,
        totalHoursMax: 0.5,
        sessionCount: null,
        spanWeeks: null,
        raw: '20-30 minutes',
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
      // $10 over the 30-minute (worst-case) end of "20-30 minutes".
      effectiveHourly: 20,
      isExpired: false,
      staleness: 'fresh',
      tags: ['online', 'survey'],
      duplicateIds: [],
      duplicateOf: null,
    });
  });

  it('normalizes id 12764 "Practicing Gender Neutral Pronouns" exactly', () => {
    expect(one(12764)).toEqual({
      id: '12764',
      slug: 'practicing-gender-neutral-pronouns',
      title: 'Practicing Gender Neutral Pronouns',
      summary:
        'This study is designed to test the effect of different tasks, including practicing gender neutral pronouns, on misgendering',
      url: 'https://research.tamu.edu/study/practicing-gender-neutral-pronouns/',
      piName: 'PI: Allegra Midgette, Ph.D.',
      contactName: 'Mirka Dirzo (lab manager)',
      contactEmail: 'mdlab@tamu.edu',
      contactPhone: null,
      irbNumber: 'STUDY2026-0369',
      irbApprovalDate: '2026-04-21T11:00:54.000Z',
      expirationDate: null,
      recruitmentStartDate: null,
      lifecycleMonths: 3,
      postedDate: '2026-06-04T16:01:33.000Z',
      modifiedDate: '2026-06-04T16:01:33.000Z',
      categoryIds: [39],
      locationIds: [59],
      sessionTypeIds: [62],
      topicIds: [],
      compensation: {
        // Upstream sent '' for compensation on this record (9 of 86 do). A
        // blank field is unknown pay, NOT $0 - see types.ts:291-293 - so the
        // amounts stay null, confidence drops, and effectiveHourly is null
        // rather than a confident $0.00/hr with an "Unpaid" badge.
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
        confidence: 'low',
        notes: ['no compensation stated in the listing'],
      },
      duration: {
        totalHoursMin: 0.75,
        totalHoursMax: 1,
        sessionCount: null,
        spanWeeks: null,
        raw: '45-60 minutes',
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
      effectiveHourly: null,
      isExpired: false,
      staleness: 'fresh',
      tags: ['online'],
      duplicateIds: [],
      duplicateOf: null,
    });
  });
});

// ===========================================================================
// 4. The whole corpus normalizes
// ===========================================================================

describe('normalizeStudies - the full 86-record fixture', () => {
  it('normalizes all 86 without throwing and without a single failure', () => {
    const { studies, failures } = normalizeStudies(RECORDS, { now: NOW });
    expect(failures).toEqual([]);
    expect(studies).toHaveLength(86);
  });

  it('produces a well-formed StudyRecord for every input', () => {
    for (const s of freshBatch()) {
      expect(typeof s.id).toBe('string');
      expect(s.id).toMatch(/^\d+$/);
      expect(s.title.length, `record ${s.id} has an empty title`).toBeGreaterThan(0);
      expect(s.url).toMatch(/^https:\/\/research\.tamu\.edu\//);
      expect(s.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(s.modifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(['fresh', 'aging', 'stale', 'expired']).toContain(s.staleness);
      expect(s.effectiveHourly === null || typeof s.effectiveHourly === 'number').toBe(true);
      expect(Array.isArray(s.tags)).toBe(true);
      for (const tag of s.tags) expect(TAG_ORDER).toContain(tag);
    }
  });

  it('emits ISO-8601 UTC for every date it emits', () => {
    for (const s of freshBatch()) {
      for (const [field, value] of Object.entries({
        irbApprovalDate: s.irbApprovalDate,
        expirationDate: s.expirationDate,
        recruitmentStartDate: s.recruitmentStartDate,
      })) {
        if (value !== null) {
          expect(value, `${field} of ${s.id}`).toBe(new Date(value).toISOString());
        }
      }
    }
  });

  it('maps the 100/125 age sentinels through to maxAge null', () => {
    // The sentinel rule lives in parse-eligibility, but the normalized record
    // is what the UI reads, so it is asserted at this level too.
    expect(one(12764).eligibility.maxAge).toBeNull();
    expect(one(4636).eligibility.maxAge).toBeNull();
    expect(one(8408).eligibility.maxAge).toBe(81);
  });

  it('takes both isExpired and staleness from the staleness module', () => {
    for (const rec of RECORDS) {
      const expected = computeStaleness(rec, NOW);
      const actual = normalizeStudy(rec, { now: NOW });
      expect({ isExpired: actual.isExpired, staleness: actual.staleness }, `record ${rec.id}`).toEqual(expected);
    }
  });

  it('reports 16 expired records among the 86', () => {
    expect(freshBatch().filter((s) => s.isExpired)).toHaveLength(16);
  });

  it('never marks a record live when its expiration date has passed', () => {
    for (const s of freshBatch()) {
      if (s.expirationDate !== null && Date.parse(s.expirationDate) < NOW.getTime()) {
        expect(s.isExpired, `record ${s.id}`).toBe(true);
        expect(s.staleness).toBe('expired');
      }
    }
  });

  it('is a pure function of (record, now)', () => {
    // Two normalizations of the same input must be byte-identical, or the
    // build's snapshot.json churns on every run.
    for (const rec of RECORDS.slice(0, 20)) {
      expect(JSON.stringify(normalizeStudy(rec, { now: NOW }))).toBe(
        JSON.stringify(normalizeStudy(rec, { now: NOW })),
      );
    }
  });
});

// ===========================================================================
// 5. Deduplication
// ===========================================================================

describe('dedupeStudies', () => {
  it('collapses the 86 records to 79 across 7 IRB groups', () => {
    const result = dedupeStudies(freshBatch());
    expect(result.studies).toHaveLength(79);
    expect(result.dropped).toHaveLength(7);
    expect(result.groups).toHaveLength(7);
  });

  it('keeps the most recently modified posting in each group', () => {
    const result = dedupeStudies(freshBatch());
    expect(
      result.groups.map((g) => ({ irb: g.irbNumber, kept: g.keptId, dropped: g.droppedIds })),
    ).toEqual([
      // Sorted by first appearance in the input, which is upstream's own order.
      { irb: 'STUDY2026-0054', kept: '11896', dropped: ['11324'] },
      { irb: 'STUDY2025-0632', kept: '11321', dropped: ['8876'] },
      { irb: 'STUDY2026-0257', kept: '11319', dropped: ['11317'] },
      { irb: 'STUDY2025-0760', kept: '9028', dropped: ['8908'] },
      { irb: 'STUDY2024-0633', kept: '8903', dropped: ['8411'] },
      { irb: 'STUDY2024-1446', kept: '8898', dropped: ['6753'] },
      { irb: 'STUDY2024-0630', kept: '8333', dropped: ['7003'] },
    ]);
  });

  it('picks the survivor by modifiedDate, not by id', () => {
    const result = dedupeStudies(freshBatch());
    const byId = new Map(freshBatch().map((s) => [s.id, s]));
    for (const group of result.groups) {
      const kept = byId.get(group.keptId);
      for (const droppedId of group.droppedIds) {
        const dropped = byId.get(droppedId);
        expect(
          Date.parse(kept?.modifiedDate ?? ''),
          `${group.keptId} should be newer than ${droppedId}`,
        ).toBeGreaterThan(Date.parse(dropped?.modifiedDate ?? ''));
      }
    }
  });

  it('records the lineage on both sides', () => {
    const result = dedupeStudies(freshBatch());
    const survivors = new Map(result.studies.map((s) => [s.id, s]));

    expect(survivors.get('11896')?.duplicateIds).toEqual(['11324']);
    expect(survivors.get('11896')?.duplicateOf).toBeNull();
    expect(result.dropped.map((s) => [s.id, s.duplicateOf])).toEqual([
      ['11324', '11896'],
      ['8876', '11321'],
      ['11317', '11319'],
      ['8908', '9028'],
      ['8411', '8903'],
      ['6753', '8898'],
      ['7003', '8333'],
    ]);
  });

  it('leaves duplicateIds empty and duplicateOf null on the 72 unique records', () => {
    const result = dedupeStudies(freshBatch());
    const uniques = result.studies.filter((s) => s.duplicateIds.length === 0);
    expect(uniques).toHaveLength(72);
    expect(uniques.every((s) => s.duplicateOf === null)).toBe(true);
  });

  it('reports no title divergence - all 7 pairs are the same protocol re-posted', () => {
    expect(dedupeStudies(freshBatch()).groups.every((g) => g.titlesDiverge === false)).toBe(true);
  });

  it('flags divergent titles when the same IRB number carries two different studies', () => {
    const [a, b] = [one(11901), one(12764)];
    b.irbNumber = a.irbNumber;
    const result = dedupeStudies([a, b]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.titlesDiverge).toBe(true);
  });

  it('preserves the input ordering of survivors', () => {
    const batch = freshBatch();
    const result = dedupeStudies(batch);
    const survivorIds = new Set(result.studies.map((s) => s.id));
    expect(result.studies.map((s) => s.id)).toEqual(
      batch.map((s) => s.id).filter((id) => survivorIds.has(id)),
    );
  });

  it('never merges records that have no IRB number', () => {
    const a = one(11901);
    const b = one(12764);
    a.irbNumber = null;
    b.irbNumber = null;
    const result = dedupeStudies([a, b]);
    expect(result.studies).toHaveLength(2);
    expect(result.groups).toEqual([]);
  });

  it('groups on the IRB number ignoring case and punctuation', () => {
    const a = one(11901);
    const b = one(12764);
    a.irbNumber = 'STUDY2025-1035';
    b.irbNumber = ' study2025_1035 ';
    b.modifiedDate = '2030-01-01T00:00:00.000Z';
    const result = dedupeStudies([a, b]);
    expect(result.studies).toHaveLength(1);
    expect(result.studies[0]?.id).toBe('12764');
  });

  it('handles an empty input', () => {
    expect(dedupeStudies([])).toEqual({ studies: [], dropped: [], groups: [] });
  });

  /**
   * DOCUMENTS CURRENT BEHAVIOUR - see the findings note.
   *
   * `dedupeStudies` writes `duplicateIds` / `duplicateOf` onto the records it
   * was handed rather than onto copies, so it is not safe to run twice: the
   * second pass sees no duplicates left and resets every survivor's lineage to
   * `[]`. The "also posted as 8876" affordance in the UI disappears silently.
   */
  it('mutates its input and loses the lineage if run a second time', () => {
    const batch = freshBatch();
    const first = dedupeStudies(batch);

    // The caller's own array has been written to.
    expect(batch.filter((s) => s.duplicateOf !== null || s.duplicateIds.length > 0)).toHaveLength(14);

    const second = dedupeStudies(first.studies);
    expect(second.studies).toHaveLength(79);
    expect(second.groups).toEqual([]);
    // Lineage from the first pass is gone.
    expect(second.studies.filter((s) => s.duplicateIds.length > 0)).toEqual([]);
  });
});

describe('normalizeAndDedupe', () => {
  it('is the one-call shape the build script uses', () => {
    const result = normalizeAndDedupe(RECORDS, { now: NOW });
    expect(result.failures).toEqual([]);
    expect(result.studies).toHaveLength(79);
    expect(result.dropped).toHaveLength(7);
    expect(result.groups).toHaveLength(7);
  });

  it('yields 79 distinct ids and 79 distinct IRB numbers', () => {
    const { studies } = normalizeAndDedupe(RECORDS, { now: NOW });
    expect(new Set(studies.map((s) => s.id)).size).toBe(79);
    expect(new Set(studies.map((s) => s.irbNumber)).size).toBe(79);
  });

  it('keeps the expired count at 16 after dedupe', () => {
    const { studies } = normalizeAndDedupe(RECORDS, { now: NOW });
    expect(studies.filter((s) => s.isExpired)).toHaveLength(16);
    const tally = { fresh: 0, aging: 0, stale: 0, expired: 0 };
    for (const s of studies) tally[s.staleness] += 1;
    expect(tally).toEqual({ fresh: 12, aging: 24, stale: 27, expired: 16 });
  });

  // 61, not 66: the survivors whose compensation field is blank but whose hours
  // parse used to compute a confident $0.00/hr. Blank pay is unknown pay.
  //
  // The count is unchanged across the audit fixes, but its MEMBERSHIP is not:
  // 8402 gained a rate ($12.00/hr, recovered from its body - audit F3) and 8872
  // lost one (its hours are not totallable - audit F5). Two real corrections
  // that happen to cancel; if this number ever moves, check which.
  it('leaves 61 of the 79 survivors with a computable hourly rate', () => {
    const { studies } = normalizeAndDedupe(RECORDS, { now: NOW });
    expect(studies.filter((s) => s.effectiveHourly !== null)).toHaveLength(61);
    const blank = studies.filter((s) => s.compensation.raw.trim() === '');
    expect(blank.length).toBeGreaterThan(0);
    expect(blank.every((s) => s.effectiveHourly === null)).toBe(true);
  });
});

// ===========================================================================
// 6. Tags
// ===========================================================================

describe('deriveTags', () => {
  const emptyTaxonomies: TaxonomyMaps = { category: {}, location: {}, sessionType: {}, topic: {} };

  it('tags an online questionnaire study', () => {
    expect(one(11901).tags).toEqual(['online', 'survey']);
  });

  it('tags an MRI study', () => {
    expect(one(8406).tags).toContain('mri');
  });

  it('emits tags in the canonical order, never duplicated', () => {
    for (const s of freshBatch()) {
      const positions = s.tags.map((t) => TAG_ORDER.indexOf(t as (typeof TAG_ORDER)[number]));
      expect([...positions].sort((a, b) => a - b), `record ${s.id}`).toEqual(positions);
      expect(new Set(s.tags).size).toBe(s.tags.length);
    }
  });

  it('does not treat lowercase "ar" in prose as augmented reality', () => {
    expect(deriveTags(raw(11901), 'participants are asked to walk around the area', null)).not.toContain('vr-ar');
    expect(deriveTags(raw(11901), 'the study uses an AR headset', null)).toContain('vr-ar');
  });

  it('lets an "Online Only" location term veto a keyword-only in-person guess', () => {
    const taxonomies: TaxonomyMaps = {
      ...emptyTaxonomies,
      location: { 59: { id: 59, name: 'Online Only', slug: 'online-only', taxonomy: 'aux_study_location', count: 1 } },
    };
    const tags = deriveTags(raw(12764), 'please come to our lab for an in-person visit', taxonomies);
    expect(tags).toContain('online');
    expect(tags).not.toContain('in-person');
  });

  it('works with no taxonomies at all', () => {
    expect(() => deriveTags(raw(11901), 'an online survey', null)).not.toThrow();
    expect(() => deriveTags(raw(11901), 'an online survey', undefined)).not.toThrow();
  });
});

// ===========================================================================
// 7. Defensive coercion
// ===========================================================================

describe('normalizeStudy - defensive coercion', () => {
  it('survives a record with null title/content/excerpt/meta', () => {
    const bad = {
      id: 1,
      title: null,
      content: null,
      excerpt: null,
      meta: null,
      date_gmt: null,
      modified_gmt: null,
    } as unknown as RawStudy;

    const record = normalizeStudy(bad, { now: NOW });
    expect(record.id).toBe('1');
    expect(record.title).toBe('');
    expect(record.irbNumber).toBeNull();
    expect(record.postedDate).toBe('1970-01-01T00:00:00.000Z');
    expect(record.categoryIds).toEqual([]);
  });

  it('survives a completely empty object', () => {
    expect(() => normalizeStudy({} as unknown as RawStudy, { now: NOW })).not.toThrow();
  });

  it('does not call .trim() on the non-string meta values upstream really sends', () => {
    const rec = structuredClone(raw(11901));
    // lifecycle arrives as a number, aux_is_internal as a boolean,
    // expiration_date as literal null, button_link_object as an object.
    expect(() => normalizeStudy(rec, { now: NOW })).not.toThrow();
    expect(typeof rec.meta.aux_study_item_lifecycle).toBe('number');
    expect(normalizeStudy(rec, { now: NOW }).lifecycleMonths).toBe(6);
  });

  it('turns a literal null expiration date into null, not into a string', () => {
    const withNull = RECORDS.find((r) => r.meta.aux_study_item_expiration_date === null);
    expect(withNull, 'fixture no longer contains a literal-null expiration date').toBeDefined();
    if (withNull) expect(normalizeStudy(withNull, { now: NOW }).expirationDate).toBeNull();
  });

  it('keeps an off-vocabulary lifecycle value and reports the drift', () => {
    const drifted = structuredClone(raw(11901));
    (drifted.meta as { aux_study_item_lifecycle: unknown }).aux_study_item_lifecycle = 24;
    expect(normalizeStudy(drifted, { now: NOW }).lifecycleMonths).toBe(24);
    expect(unexpectedLifecycleValues()).toContain(24);
  });

  it('collects failures rather than aborting the batch', () => {
    // A literal `null` in the array is what a truncated or partially-failed
    // upstream page looks like after JSON.parse. It must cost one study, not 86.
    const { studies, failures } = normalizeStudies(
      [...RECORDS, null as unknown as RawStudy],
      { now: NOW },
    );
    expect(studies).toHaveLength(86);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.id).toBeUndefined();
    expect(typeof failures[0]?.error).toBe('string');
  });

  it('skips several malformed entries and still returns every good one', () => {
    const junk = [null, undefined, 'not a record', 42] as unknown as RawStudy[];
    const { studies, failures } = normalizeStudies([...RECORDS, ...junk], { now: NOW });
    expect(studies.length + failures.length).toBe(86 + junk.length);
    expect(studies.length).toBeGreaterThanOrEqual(86);
  });

  /**
   * DOCUMENTS CURRENT BEHAVIOUR - see the findings note.
   *
   * When `excerpt.rendered` is shorter than 40 characters, the summary falls
   * back to `content.rendered`, which always begins with the site's navigation
   * chrome ("Home Aggie Research Volunteers <title> <title> PI: ..."). Every
   * record in the current snapshot has a long excerpt, so this is latent - but
   * one upstream record with an empty excerpt puts breadcrumbs on a card.
   * parse-eligibility.ts strips the same chrome before matching; normalize.ts
   * does not.
   */
  it('leaks navigation chrome into the summary when the excerpt is empty', () => {
    const noExcerpt = structuredClone(raw(11901));
    noExcerpt.excerpt = { rendered: '' };
    const summary = normalizeStudy(noExcerpt, { now: NOW }).summary;
    expect(summary.startsWith('Home Aggie Research Volunteers')).toBe(true);
    // The real blurb is still in there, just behind the chrome and the
    // duplicated title.
    expect(summary).toContain('This study aims to better understand');
  });

  it('never leaks that chrome for any record in the current fixture', () => {
    for (const s of freshBatch()) {
      expect(s.summary, `summary of ${s.id}`).not.toContain('Home Aggie Research Volunteers');
    }
  });
});

// ===========================================================================
// 8. Structural compatibility with the contract
// ===========================================================================

describe('DedupedStudyRecord is structurally a StudyRecord', () => {
  it('assigns to StudyRecord without a cast', () => {
    const record: StudyRecord = one(11901);
    expect(record.id).toBe('11901');
  });

  it('carries exactly two extra fields beyond the contract', () => {
    const extras = Object.keys(one(11901)).filter(
      (k) => !(k in ({} as Record<string, never>)) && ['duplicateIds', 'duplicateOf'].includes(k),
    );
    expect(extras.sort()).toEqual(['duplicateIds', 'duplicateOf']);
  });
});

// ===========================================================================
// 9. AUDIT REGRESSION F3 - money written in the body, not the meta field
//
// Nine records have a blank `aux_study_item_compensation`. Three of them state
// their pay in `content.rendered`, and the site rendered all three as "Pay
// unclear". A fully itemised $420 study and a clean $12/hr study were sitting
// in the "no stated pay" pile.
//
// The fallback is a FALLBACK. It reads the body only when the meta field
// yields no money signal at all, so a parsed meta value can never be
// overridden by prose. The test below that pins that gate is the important one
// in this block: it is the difference between recovering three studies and
// silently rewriting eighty.
// ===========================================================================

describe('REGRESSION F3: compensation recovered from the study body', () => {
  const survivors = normalizeAndDedupe(RECORDS, { now: NOW }).studies;

  function survivor(id: string): StudyRecord {
    const found = survivors.find((s) => s.id === id);
    if (found === undefined) throw new Error(`survivor ${id} is missing`);
    return found;
  }

  it('4607 (LEAP): $420 across six visits, not "no compensation stated"', () => {
    // body: "Each family will receive $420 for participation in all six
    //        visits, which are prorated at $80 initial, $40 6-month, $90
    //        1-year, $50 18-month, $100 2-year, $60 30-month."
    const r = survivor('4607');
    expect(r.compensation.guaranteedMin).toBe(420);
    expect(r.compensation.guaranteedMax).toBe(420);
    expect(r.compensation.visitCount).toBe(6);

    // NOT $840. Handing the whole sentence to parseCompensation would total the
    // $420 and its own itemisation; the sentence is cut at the restatement
    // marker so only the total is parsed.
    expect(r.compensation.guaranteedMax).not.toBe(840);

    // Recovered pay is never presented as confidently as stated pay, and it
    // says where it came from.
    expect(r.compensation.confidence).toBe('medium');
    expect(r.compensation.notes.join(' ')).toMatch(/study description/i);

    // The duration field really is blank, so no hours are invented to go with
    // the recovered money. "$420 total, rate unknown" is the honest card.
    expect(r.duration.totalHoursMax).toBeNull();
    expect(r.effectiveHourly).toBeNull();
  });

  it('8402: $15 gift card over a 75-minute appointment = $12.00/hr', () => {
    // body: "Parents schedule a 75-minute appointment and receive a $15 Amazon
    //        e-gift card for their participation."
    const r = survivor('8402');
    expect(r.compensation.guaranteedMax).toBe(15);
    expect(r.compensation.currencyKind).toBe('giftcard');
    expect(r.compensation.confidence).toBe('medium');
    expect(r.compensation.notes.join(' ')).toMatch(/study description/i);
    expect(r.duration.totalHoursMax).toBe(1.25);
    expect(r.effectiveHourly).toBe(12);
  });

  it('10128: a perk stated in the DURATION field is flagged, and buys no money', () => {
    // The coordinator pasted "Prepaid movie ticket (Cinemark)" into
    // aux_study_item_duration. It is a real perk and is surfaced as one - but
    // a stray string in the wrong field must never become a payout or an hour.
    const r = survivor('10128');
    expect(r.compensation.hasNonCashPerk).toBe(true);
    expect(r.compensation.notes.join(' ')).toMatch(/duration field/i);
    expect(r.compensation.guaranteedMin).toBeNull();
    expect(r.compensation.guaranteedMax).toBeNull();
    expect(r.duration.totalHoursMax).toBeNull();
    expect(r.effectiveHourly).toBeNull();
  });

  it('NEVER overrides a study that has a valid compensation meta field', () => {
    // THE GATE. Every survivor whose meta field carries any money signal must
    // parse to exactly what parseCompensation makes of that field alone - byte
    // for byte, note for note. If this fails, the body is being allowed to
    // argue with the listing, and an adversarial run of the extractor over the
    // 77 non-blank records disagrees with the meta parse on eight of them.
    const BLANK_META = new Set(['4607', '8402', '10128', '12764', '12762', '11319', '9959', '6990']);

    let checked = 0;
    for (const s of survivors) {
      const metaRaw = raw(Number(s.id)).meta.aux_study_item_compensation;
      if (metaRaw.trim() === '') {
        expect(BLANK_META.has(s.id), `record ${s.id} has blank meta but is not in the expected set`).toBe(true);
        continue;
      }
      checked += 1;
      // `raw` is compared separately: normalizeStudy trims and de-entities the
      // meta string before parsing it, which is pre-existing behaviour and not
      // an override. Every field that carries a claim about money must match.
      const { raw: gotRaw, ...gotRest } = s.compensation;
      const { raw: _wantRaw, ...wantRest } = parseCompensation(metaRaw.trim());
      expect(gotRest, `record ${s.id} was overridden by its body text`).toEqual(wantRest);
      expect(gotRaw, `record ${s.id} took its raw from the body`).toBe(metaRaw.trim());
      expect(
        s.compensation.notes.some((n) => /study description/i.test(n)),
        `record ${s.id} was tagged as body-extracted`,
      ).toBe(false);
    }
    // The great majority of the board must be untouched by this feature.
    expect(checked).toBeGreaterThanOrEqual(70);
  });

  it('recovers exactly three records and no more', () => {
    const recovered = survivors.filter((s) =>
      s.compensation.notes.some((n) => /study description|duration field/i.test(n)),
    );
    expect(recovered.map((s) => s.id).sort()).toEqual(['10128', '4607', '8402']);
  });
});
