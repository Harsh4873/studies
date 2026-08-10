/**
 * Tests for the inquiry-email composer and the anti-harvesting helpers.
 *
 * The important tests in here are not the formatting ones. They are:
 *   - "never hides a declared condition" - asserted over all 86 fixture
 *     records, for every screened condition, so a future refactor cannot
 *     quietly drop a disclosure branch.
 *   - "%0D%0A" - a bare %0A collapses the message to one paragraph in several
 *     desktop mail clients.
 *   - the token round-trip and the "no @ in the token" property, which is the
 *     whole basis of the scrape protection.
 *
 * Hermetic: reads fixtures/arv-snapshot.json, never the network.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildInquiryEmail,
  decodeEmailToken,
  encodeEmailToken,
  encodeMailtoComponent,
  looksLikeEmail,
  scrubEmails,
  type InquiryStudy,
} from '@/lib/mailto.ts';
import { parseEligibility } from '@/lib/parse-eligibility.ts';
import { EMPTY_PROFILE } from '@/lib/profile.ts';
import { stripHtml } from '@/lib/html.ts';
import type { ParsedEligibility, RawStudy, UserProfile } from '@/types.ts';

const FIXTURE = fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url));
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RawStudy[];

/** Fixture records projected into the shape `buildInquiryEmail` consumes. */
const studies: InquiryStudy[] = raw.map((r) => ({
  title: stripHtml(r.title.rendered),
  irbNumber: r.meta.aux_study_item_irb_number || null,
  url: r.link,
  contactName: r.meta.aux_study_item_contact_name || null,
  contactEmail: r.meta.aux_study_item_contact_email || null,
  expirationDate:
    typeof r.meta.aux_study_item_expiration_date === 'string'
      ? r.meta.aux_study_item_expiration_date || null
      : null,
  isExpired: false,
  staleness: 'fresh',
  eligibility: parseEligibility(r),
}));

function profile(patch: Partial<UserProfile>): UserProfile {
  return { ...EMPTY_PROFILE, ...patch };
}

function stub(eligibility: Partial<ParsedEligibility>): InquiryStudy {
  return {
    title: 'A Study Of Things',
    irbNumber: 'STUDY2025-0001',
    url: 'https://research.tamu.edu/study/a-study-of-things/',
    contactName: 'Dana Coordinator',
    contactEmail: 'dana@tamu.edu',
    expirationDate: null,
    isExpired: false,
    staleness: 'fresh',
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
      ...eligibility,
    },
  };
}

// ---------------------------------------------------------------------------

describe('encodeMailtoComponent', () => {
  it('encodes every newline as %0D%0A regardless of input line ending', () => {
    expect(encodeMailtoComponent('a\nb')).toBe('a%0D%0Ab');
    expect(encodeMailtoComponent('a\r\nb')).toBe('a%0D%0Ab');
    expect(encodeMailtoComponent('a\rb')).toBe('a%0D%0Ab');
  });

  it('escapes the characters encodeURIComponent leaves behind', () => {
    // These terminate ?body= early in a few clients, truncating the message.
    expect(encodeMailtoComponent("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('round-trips through decodeURIComponent', () => {
    const text = 'Hi — "quotes", 50% & $30/hr (per visit)\nLine two';
    expect(decodeURIComponent(encodeMailtoComponent(text))).toBe(text.replace('\n', '\r\n'));
  });
});

describe('email tokens', () => {
  it('round-trips every contact address in the fixture', () => {
    for (const s of studies) {
      if (!s.contactEmail) continue;
      expect(decodeEmailToken(encodeEmailToken(s.contactEmail))).toBe(s.contactEmail);
    }
  });

  it('produces a token with no @, no dot, and no domain fragment', () => {
    for (const s of studies) {
      if (!s.contactEmail) continue;
      const token = encodeEmailToken(s.contactEmail);
      expect(token).toMatch(/^[0-9a-f]+$/);
      expect(token).not.toContain('@');
      expect(token.toLowerCase()).not.toContain('tamu');
    }
  });

  it('returns empty string on malformed tokens rather than throwing', () => {
    expect(decodeEmailToken('')).toBe('');
    expect(decodeEmailToken('abc')).toBe('');
    expect(decodeEmailToken('zzzz')).toBe('');
  });
});

describe('scrubEmails', () => {
  it('removes an address hidden in a name field (fixture study 8458)', () => {
    expect(scrubEmails('mpkj.engelen@ctral.org')).toBe('[email hidden]');
  });

  it('leaves ordinary text alone and tolerates null', () => {
    expect(scrubEmails('Marielle P Engelen, PhD')).toBe('Marielle P Engelen, PhD');
    expect(scrubEmails(null)).toBe('');
  });

  it('recognises a bare address but not a name', () => {
    expect(looksLikeEmail('dana@tamu.edu')).toBe(true);
    expect(looksLikeEmail('Dana Coordinator')).toBe(false);
    expect(looksLikeEmail(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('buildInquiryEmail - subject and structure', () => {
  it('names the study and the IRB number in the subject', () => {
    const { subject } = buildInquiryEmail(stub({}), profile({}));
    expect(subject).toBe('Participant interest - A Study Of Things (STUDY2025-0001)');
  });

  it('truncates a long title but keeps the IRB number intact', () => {
    const long = stub({});
    long.title = 'A'.repeat(200);
    const { subject } = buildInquiryEmail(long, profile({}));
    expect(subject.length).toBeLessThan(120);
    expect(subject).toContain('STUDY2025-0001');
  });

  it('always asks whether recruitment is still open', () => {
    for (const s of studies) {
      const { body } = buildInquiryEmail(s, profile({ age: 30 }));
      expect(body).toMatch(/is this study still recruiting\?/i);
    }
  });

  it('mentions the expiry date when the posting has already lapsed', () => {
    const expired = { ...stub({}), isExpired: true, expirationDate: '2025-01-02T00:00:00.000Z' };
    expect(buildInquiryEmail(expired, profile({})).body).toContain('2025-01-02');
  });

  it('falls back to a generic salutation when the name field holds an address', () => {
    const s = { ...stub({}), contactName: 'mpkj.engelen@ctral.org' };
    const { body } = buildInquiryEmail(s, profile({}));
    expect(body.startsWith('Dear study team,')).toBe(true);
    expect(body).not.toContain('mpkj.engelen@ctral.org');
  });
});

// ---------------------------------------------------------------------------
// The honesty guarantee.
// ---------------------------------------------------------------------------

/**
 * Each case: a profile answer that a study screens for, the eligibility field
 * that makes the study screen for it, and wording that must appear in the body.
 */
const DISCLOSURE_CASES: {
  name: string;
  eligibility: Partial<ParsedEligibility>;
  profile: Partial<UserProfile>;
  expect: RegExp;
}[] = [
  {
    name: 'pregnancy',
    eligibility: { excludesPregnancy: true },
    profile: { isPregnant: true },
    expect: /I am currently pregnant/i,
  },
  {
    name: 'cardiovascular',
    eligibility: { excludesCardiovascular: true },
    profile: { hasCardiovascularCondition: true },
    expect: /I have a cardiovascular condition/i,
  },
  {
    name: 'seizure history',
    eligibility: { excludesSeizure: true },
    profile: { hasSeizureHistory: true },
    expect: /history of seizures/i,
  },
  {
    name: 'MRI safety',
    eligibility: { requiresMriSafe: true },
    profile: { mriSafe: false },
    expect: /cannot undergo MRI safely/i,
  },
  {
    name: 'handedness',
    eligibility: { requiresRightHanded: true },
    profile: { rightHanded: false },
    expect: /not right-handed/i,
  },
  {
    name: 'fasting',
    eligibility: { requiresFasting: true },
    profile: { willingToFast: false },
    expect: /prefer not to fast/i,
  },
  {
    name: 'age below the minimum',
    eligibility: { minAge: 25 },
    profile: { age: 19 },
    expect: /below the minimum age of 25/i,
  },
  {
    name: 'age above the maximum',
    eligibility: { minAge: 18, maxAge: 35 },
    profile: { age: 44 },
    expect: /above the maximum age of 35/i,
  },
  {
    name: 'sex restriction',
    eligibility: { sexRestriction: 'female' },
    profile: { sex: 'male' },
    expect: /enrols female participants only, and I am male/i,
  },
  {
    name: 'student status vs a non-students-only study',
    eligibility: { flags: ['non-students only'] },
    profile: { isTamuStudent: true },
    expect: /I am a Texas A&M student, and I see the listing asks for non-students/i,
  },
  // Ambiguous mentions the parser could not resolve still get disclosed.
  {
    name: 'pregnancy mentioned but not clearly a criterion',
    eligibility: {
      flags: ['pregnancy is mentioned but not clearly a criterion - confirm with the study team'],
    },
    profile: { isPregnant: true },
    expect: /I am currently pregnant/i,
  },
  {
    name: 'seizure history vs a brain-stimulation study that never says "seizure"',
    eligibility: { flags: ['involves non-invasive brain stimulation'] },
    profile: { hasSeizureHistory: true },
    expect: /history of seizures/i,
  },
  {
    name: 'MRI-unsafe vs an implanted-device screen',
    eligibility: {
      flags: ['implanted medical device screening required (no MRI mentioned)'],
    },
    profile: { mriSafe: false },
    expect: /cannot undergo MRI safely/i,
  },
];

describe('buildInquiryEmail - never hides a declared condition', () => {
  for (const c of DISCLOSURE_CASES) {
    it(`discloses ${c.name}`, () => {
      const mail = buildInquiryEmail(stub(c.eligibility), profile(c.profile));
      expect(mail.body).toMatch(c.expect);
      expect(mail.disclosures.some((d) => c.expect.test(d))).toBe(true);
      // The disclosure must also survive into the href the user actually
      // clicks, not just the preview string.
      expect(decodeURIComponent(mail.href)).toMatch(c.expect);
    });
  }

  it('places disclosures before the ask, never after it', () => {
    const mail = buildInquiryEmail(stub({ excludesPregnancy: true }), profile({ isPregnant: true }));
    expect(mail.body.indexOf('I am currently pregnant')).toBeLessThan(
      mail.body.indexOf('what would the next step be'),
    );
  });

  it('discloses across the whole fixture: any screened + declared pair shows up', () => {
    const declared = profile({
      isPregnant: true,
      hasCardiovascularCondition: true,
      hasSeizureHistory: true,
      mriSafe: false,
      rightHanded: false,
      willingToFast: false,
    });

    let checked = 0;
    for (const s of studies) {
      const e = s.eligibility;
      const { body } = buildInquiryEmail(s, declared);
      if (e.excludesPregnancy) {
        expect(body).toMatch(/currently pregnant/i);
        checked += 1;
      }
      if (e.excludesCardiovascular) {
        expect(body).toMatch(/cardiovascular condition/i);
        checked += 1;
      }
      if (e.excludesSeizure) {
        expect(body).toMatch(/history of seizures/i);
        checked += 1;
      }
      if (e.requiresMriSafe) {
        expect(body).toMatch(/cannot undergo MRI safely/i);
        checked += 1;
      }
      if (e.requiresRightHanded) {
        expect(body).toMatch(/not right-handed/i);
        checked += 1;
      }
      if (e.requiresFasting) {
        expect(body).toMatch(/prefer not to fast/i);
        checked += 1;
      }
    }
    // Guards against the assertions silently never running.
    expect(checked).toBeGreaterThan(40);
  });

  it('says nothing at all about a condition the user did not answer', () => {
    const mail = buildInquiryEmail(
      stub({ excludesPregnancy: true, excludesSeizure: true }),
      profile({ age: 30 }),
    );
    expect(mail.disclosures).toEqual([]);
    expect(mail.body).not.toMatch(/pregnan/i);
    expect(mail.body).not.toMatch(/seizure/i);
  });

  it('does not volunteer a negative answer to a study that never asked', () => {
    // The study screens for nothing; "I am not pregnant" would be gratuitous
    // health disclosure to a stranger.
    const mail = buildInquiryEmail(stub({}), profile({ isPregnant: false, age: 30 }));
    expect(mail.body).not.toMatch(/pregnan/i);
  });

  it('confirms, rather than discloses, when the answer matches the criterion', () => {
    const mail = buildInquiryEmail(
      stub({ excludesPregnancy: true, requiresRightHanded: true }),
      profile({ isPregnant: false, rightHanded: true }),
    );
    expect(mail.disclosures).toEqual([]);
    expect(mail.body).toContain('I am not pregnant.');
    expect(mail.body).toContain('I am right-handed.');
  });
});

// ---------------------------------------------------------------------------

describe('buildInquiryEmail - href', () => {
  it('addresses the listed recipient and carries subject and body', () => {
    const mail = buildInquiryEmail(stub({}), profile({ age: 30 }));
    expect(mail.to).toBe('dana@tamu.edu');
    expect(mail.href.startsWith('mailto:dana@tamu.edu?subject=')).toBe(true);
    expect(mail.href).toContain('&body=');
    expect(mail.href).toContain('%0D%0A');
  });

  it('decodes back to exactly the body it reports', () => {
    const mail = buildInquiryEmail(stub({}), profile({ age: 30 }));
    const encoded = mail.href.slice(mail.href.indexOf('&body=') + '&body='.length);
    expect(decodeURIComponent(encoded)).toBe(mail.body.replace(/\n/g, '\r\n'));
  });

  it('still produces a usable draft when the listing has no address', () => {
    const mail = buildInquiryEmail({ ...stub({}), contactEmail: null }, profile({}));
    expect(mail.to).toBeNull();
    expect(mail.href.startsWith('mailto:?subject=')).toBe(true);
  });

  it('flags an over-long draft instead of truncating it', () => {
    const short = buildInquiryEmail(stub({}), profile({ age: 30 }));
    expect(short.isLong).toBe(false);

    // Every condition declared against a study that screens for all of them:
    // the disclosures are what make it long, and they are never dropped.
    const loaded = buildInquiryEmail(
      stub({
        excludesPregnancy: true,
        excludesCardiovascular: true,
        excludesSeizure: true,
        requiresMriSafe: true,
        requiresRightHanded: true,
        requiresFasting: true,
        requiresSpecificCondition: 'chronic low back pain',
      }),
      profile({
        isPregnant: true,
        hasCardiovascularCondition: true,
        hasSeizureHistory: true,
        mriSafe: false,
        rightHanded: false,
        willingToFast: false,
      }),
    );
    expect(loaded.disclosures).toHaveLength(6);
    expect(loaded.isLong).toBe(true);
    // Flagged, not shortened - the full text is still there for the fallback.
    expect(decodeURIComponent(loaded.href)).toContain('I am currently pregnant');
  });

  it('keeps an ordinary draft comfortably inside the safe URL length', () => {
    // Regression guard: the prose is deliberately tight because
    // percent-encoding roughly doubles it.
    for (const s of studies) {
      const mail = buildInquiryEmail(s, profile({ age: 28, rightHanded: true }));
      expect(mail.href.length).toBeLessThan(2000);
      expect(mail.isLong).toBe(false);
    }
  });

  it('produces a parseable URL for every study in the fixture', () => {
    for (const s of studies) {
      const mail = buildInquiryEmail(s, profile({ age: 27, rightHanded: true }));
      expect(() => new URL(mail.href)).not.toThrow();
      expect(mail.href).not.toContain('\n');
      expect(mail.href).not.toContain(' ');
    }
  });
});
