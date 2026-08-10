import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripHtml, decodeEntities, truncate, collapseWhitespace } from '@/lib/html.ts';
import type { RawStudy } from '@/types.ts';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/arv-snapshot.json', import.meta.url)), 'utf8'),
) as RawStudy[];

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('Kinesthetic Glitch &amp; Making')).toBe('Kinesthetic Glitch & Making');
    expect(decodeEntities('Buenas &#8211; Seat')).toBe('Buenas – Seat');
    expect(decodeEntities('a &#x2013; b')).toBe('a – b');
    expect(decodeEntities('post_type=study&#038;p=12780')).toBe('post_type=study&p=12780');
  });

  it('leaves unknown entities untouched rather than dropping them', () => {
    expect(decodeEntities('100 &widget; wide')).toBe('100 &widget; wide');
    expect(decodeEntities('&#xZZ;')).toBe('&#xZZ;');
  });
});

describe('stripHtml', () => {
  it('turns <br> into a separator so adjacent clauses do not fuse', () => {
    expect(stripHtml('Each interview: $20<br>Each survey: $20')).toBe(
      'Each interview: $20 Each survey: $20',
    );
  });

  it('removes inline tags without inserting space', () => {
    expect(stripHtml('complete <u>ALL THREE</u> sessions')).toBe('complete ALL THREE sessions');
  });

  it('handles nullish input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml('')).toBe('');
  });

  it('decodes entities after stripping, so encoded markup survives as text', () => {
    expect(stripHtml('<p>a &lt;br&gt; b</p>')).toBe('a <br> b');
  });

  it('leaves no residual tags or entities across all 86 real records', () => {
    for (const study of fixture) {
      for (const value of [study.title.rendered, study.meta.aux_study_item_compensation]) {
        const out = stripHtml(value);
        expect(out).not.toMatch(/<[^>]+>/);
        expect(out).not.toMatch(/&(amp|lt|gt|quot|#\d+);/);
      }
    }
  });

  it('never fuses a digit directly onto a following word (the <br> hazard)', () => {
    const fused = fixture
      .map((s) => stripHtml(s.meta.aux_study_item_compensation))
      .filter((t) => /\d[A-Z][a-z]/.test(t));
    expect(fused).toEqual([]);
  });
});

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('never exceeds the requested length, ellipsis included', () => {
    const long = 'a'.repeat(300);
    for (const n of [1, 2, 5, 20, 64]) {
      expect(truncate(long, n).length).toBeLessThanOrEqual(n);
    }
  });

  it('breaks on a word boundary when one is close enough', () => {
    expect(truncate('the quick brown fox jumps over', 20)).toBe('the quick brown…');
  });

  it('handles degenerate lengths', () => {
    expect(truncate('anything', 0)).toBe('');
    expect(truncate('', 10)).toBe('');
  });
});

describe('collapseWhitespace', () => {
  it('collapses newlines, tabs and nbsp runs', () => {
    expect(collapseWhitespace('  a\n\n\tb  c  ')).toBe('a b c');
  });
});
