/**
 * Shared HTML/text helpers.
 *
 * Every parser depends on these, so the behaviour here is part of the
 * contract. Two upstream quirks drive the design:
 *
 *   1. Meta values contain literal markup - `<br>` between distinct pay
 *      clauses and `<u>` for emphasis. Example:
 *        "Each interview: $20<br>Each survey: $20<br>...maximum $100"
 *      Naively deleting tags yields "$20Each survey: $20", which silently
 *      corrupts number extraction. So `<br>` and block-level tags collapse to
 *      whitespace rather than to nothing.
 *
 *   2. Titles carry HTML entities - `&amp;`, `&#8211;` (en dash), `&#038;`.
 */

/** Tags that imply a line/word break when removed. */
const BLOCK_TAG_RE =
  /<\s*\/?\s*(?:br|p|div|li|ul|ol|tr|td|th|h[1-6]|section|article|blockquote|hr)\b[^>]*>/gi;

const ANY_TAG_RE = /<[^>]*>/g;

/** Script/style bodies must go entirely, not just their tags. */
const SCRIPT_STYLE_RE = /<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  deg: '°',
  cent: '¢',
  pound: '£',
  euro: '€',
  trade: '™',
  copy: '©',
  reg: '®',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  times: '×',
  minus: '−',
  plusmn: '±',
  eacute: 'é',
  szlig: 'ß',
};

/**
 * Decode HTML entities: named (`&amp;`), decimal (`&#8211;`) and hex
 * (`&#x2013;`). Unrecognised entities are left verbatim rather than dropped,
 * so nothing is silently lost.
 */
export function decodeEntities(s: string): string {
  if (!s) return '';

  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);

      // Reject NaN, out-of-range, and surrogate halves.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;

      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }

    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Strip HTML to plain text.
 *
 * Block tags and `<br>` become a single space so adjacent clauses stay
 * separated; inline tags such as `<u>` are removed without adding space.
 * Entities are decoded afterwards, and whitespace is collapsed.
 *
 *   stripHtml('Each interview: $20<br>Each survey: $20')
 *     -> 'Each interview: $20 Each survey: $20'
 *   stripHtml('complete <u>ALL THREE</u> sessions')
 *     -> 'complete ALL THREE sessions'
 */
export function stripHtml(s: string | null | undefined): string {
  if (!s) return '';

  const withoutTags = s
    .replace(SCRIPT_STYLE_RE, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(BLOCK_TAG_RE, ' ')
    .replace(ANY_TAG_RE, '');

  // Decode last: an encoded "&lt;br&gt;" must surface as text, not be treated
  // as a tag to strip.
  return collapseWhitespace(decodeEntities(withoutTags));
}

/** Collapse all whitespace runs (including NBSP and newlines) to single spaces. */
export function collapseWhitespace(s: string): string {
  return s.replace(/[\s ​]+/g, ' ').trim();
}

/**
 * Truncate to at most `n` characters, appending an ellipsis. Breaks on a word
 * boundary when one is reasonably close, so words are not cut mid-way. The
 * returned string - ellipsis included - never exceeds `n`.
 */
export function truncate(s: string, n: number): string {
  if (!s) return '';
  if (!Number.isFinite(n) || n <= 0) return '';

  const text = s.trim();
  if (text.length <= n) return text;

  const ellipsis = '…';
  if (n <= ellipsis.length) return ellipsis.slice(0, n);

  const budget = n - ellipsis.length;
  const slice = text.slice(0, budget);
  const lastSpace = slice.lastIndexOf(' ');

  // Only honour the word boundary if it does not gut the string.
  const body = lastSpace > budget * 0.6 ? slice.slice(0, lastSpace) : slice;

  return body.replace(/[\s.,;:!?-]+$/, '') + ellipsis;
}
