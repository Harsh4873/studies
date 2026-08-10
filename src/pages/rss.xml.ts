/**
 * RSS 2.0 feed of newly listed studies.  ->  /r/studies/rss.xml
 *
 * The point: replace "remember to check the site" with a subscription. A feed
 * reader tells you when a study appears; you never poll.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FEED IS NOT JUST `diff.json`
 * ---------------------------------------------------------------------------
 * `src/data/diff.json` is the delta between the snapshot on disk and the one
 * the previous `fetch:data` left behind. That makes it correct but *ephemeral*,
 * and it interacts badly with how the site is deployed:
 *
 *   1. `npm run build` = `fetch:data && astro build`, so the deploy build
 *      re-fetches and re-diffs against the snapshot the refresh workflow just
 *      committed. The diff it computes is therefore usually EMPTY - the
 *      additions were already absorbed one commit earlier.
 *   2. `src/data/` is git-ignored. On a host that builds from a clean checkout
 *      without the committed snapshot there is no baseline at all, so the diff
 *      reports every single study as "added".
 *
 * A feed built only on `diff.added` would swing between empty and 79 items
 * depending on which of those happened. So `added` is used as a *hint*, and
 * the durable spine of the feed is `postedDate` (upstream `date_gmt`), which
 * is a property of the study itself and identical on every machine:
 *
 *   items = (the N most recently posted live studies)  UNION  (diff.added)
 *
 * Each item's `<guid>` is its permalink, which never changes, so a reader
 * notifies you exactly once per study no matter how many times the site
 * rebuilds. That is the property that actually matters for a feed, and it is
 * the one a diff-only feed cannot provide.
 *
 * Change notices (a study's pay, time, or expiry being edited) are emitted
 * only when the build had a real baseline, and their guids are hashes of the
 * changed content - so an edit notifies once, and re-running the build with an
 * empty diff simply omits the item rather than re-announcing it.
 * ---------------------------------------------------------------------------
 *
 * Titles carry the money up front (`$25/hr - $50 total - Study Name`) because
 * a feed reader shows the title and little else. The rules for what may appear
 * there are the same ones RateBadge enforces on the site: a raffle prize is
 * never rendered as pay, an unknown rate is never rendered as $0, and a known
 * $0 is never rendered as unknown.
 */

import type { APIRoute } from 'astro';

import diffJson from '@/data/diff.json';
import snapshotJson from '@/data/snapshot.json';
import { scrubEmails } from '@/lib/mailto.ts';
import type { ParsedCompensation, Snapshot, StudyRecord } from '@/types.ts';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How many recently posted live studies form the baseline of the feed. */
const RECENT_COUNT = 30;

/** Hard cap on items, after the union with `diff.added` and change notices. */
const MAX_ITEMS = 50;

/** Fallback origin if `site` is somehow unset in astro.config.mjs. */
const FALLBACK_ORIGIN = 'https://harsh.bet';

const DISCLAIMER =
  'Unofficial and not affiliated with Texas A&M University. Pay and time figures ' +
  'are parsed automatically from free-text listing fields and may be wrong. ' +
  'Confirm details with the study contact before committing.';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const snapshot = snapshotJson as unknown as Snapshot;

/** Shape of `src/data/diff.json` (a `SnapshotDiff` plus two timestamps). */
interface DiffFile {
  generatedAt: string;
  previousFetchedAt: string | null;
  added: string[];
  removed: string[];
  changed: { id: string; fields: string[] }[];
}

// Cast through `unknown`: TypeScript infers `never[]` for the empty arrays in
// the checked-in diff.json, which would be wrong the moment it has content.
const diff = diffJson as unknown as DiffFile;

/** Diff fields worth telling a subscriber about. IRB renewal is not one. */
const NOTIFIABLE_FIELDS = new Set(['compensation.raw', 'duration.raw', 'expirationDate']);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Escape for both text nodes and attribute values.
 *
 * Everything in this feed goes through here, including the HTML that makes up
 * `<description>`. Escaping rather than wrapping in CDATA is deliberate: study
 * titles are arbitrary upstream text and a CDATA section cannot contain the
 * sequence `]]>`, so CDATA would be one weird title away from invalid XML.
 */
function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/**
 * Drop the control characters XML 1.0 forbids outright.
 *
 * They cannot be represented at all - not as literals, not as numeric entities
 * - so escaping does not help, and one of them anywhere in the document makes
 * the entire feed unparseable. Upstream text is free-form, so this is cheap
 * insurance rather than a hypothetical.
 */
function xmlSafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

const RFC822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const RFC822_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** RFC 822 in GMT, which is what RSS 2.0 `pubDate` wants. */
function rfc822(iso: string | null | undefined, fallback: Date): string {
  const d = iso ? new Date(iso) : new Date(NaN);
  const date = Number.isNaN(d.getTime()) ? fallback : d;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${RFC822_DAYS[date.getUTCDay()] ?? 'Mon'}, ${pad(date.getUTCDate())} ` +
    `${RFC822_MONTHS[date.getUTCMonth()] ?? 'Jan'} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`
  );
}

/** Whole dollars unless the cents carry information. Mirrors RateBadge. */
function usd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded)
    ? `$${rounded.toLocaleString('en-US')}`
    : `$${rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "2 hours", "1-3 hours", or null when the listing never said. */
function hoursLabel(study: StudyRecord): string | null {
  const lo = study.duration?.totalHoursMin ?? null;
  const hi = study.duration?.totalHoursMax ?? null;
  const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (lo !== null && hi !== null && lo !== hi) return `${num(lo)}-${num(hi)} hours`;
  const one = hi ?? lo;
  if (one === null) return null;
  return `${num(one)} ${one === 1 ? 'hour' : 'hours'}`;
}

function agesLabel(study: StudyRecord): string {
  const min = study.eligibility?.minAge;
  const max = study.eligibility?.maxAge ?? null;
  if (typeof min !== 'number') return 'not stated';
  return max === null ? `${min} and up` : `${min}-${max}`;
}

/**
 * The money phrase that leads the item title.
 *
 * Same five mutually exclusive cases as RateBadge, in the same order, for the
 * same reason: each one is a different claim about the world and collapsing
 * any two of them into "$0" or "unknown" would be a lie the data does not
 * support. A raffle prize can never surface here as a dollar figure.
 */
function payHeadline(study: StudyRecord): string {
  const rate = study.effectiveHourly;
  const comp: ParsedCompensation | undefined = study.compensation;
  const guaranteed = comp?.guaranteedMax ?? null;
  const hasGuaranteedPay = typeof guaranteed === 'number' && Number.isFinite(guaranteed) && guaranteed > 0;

  // 1. A real, rankable rate. Add the total alongside it when there is one.
  if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
    const perHour = `${usd(rate)}/hr`;
    return hasGuaranteedPay ? `${perHour} - ${usd(guaranteed as number)} total` : perHour;
  }

  // 2. A known zero is information, not an absence of it.
  if (rate === 0 || (guaranteed === 0 && comp?.raffleOnly !== true && (comp?.raffleMax ?? null) === null)) {
    return 'Unpaid';
  }

  // 3. Raffle-only: there is no guaranteed money to name.
  if (comp?.raffleOnly === true) return 'Drawing entry only';

  // 4. Pay known, time unknown - so a rate would be invented, not computed.
  if (hasGuaranteedPay) {
    const total = usd(guaranteed as number);
    return comp?.guaranteedMin === null ? `up to ${total} total, rate unknown` : `${total} total, rate unknown`;
  }

  // 5. Nothing usable.
  return 'Pay unclear';
}

/** FNV-1a. Only needs to change when the input does; not a security hash. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Item bodies
// ---------------------------------------------------------------------------

/** `<dt>/<dd>` pair, omitted entirely when there is nothing honest to say. */
function row(label: string, value: string | null): string {
  return value === null || value === '' ? '' : `<p><strong>${label}:</strong> ${value}</p>`;
}

function describe(study: StudyRecord, detailUrl: string, prefix?: string): string {
  const comp = study.compensation;
  // Free-text fields; the site's no-raw-addresses policy applies here too.
  const compRaw = scrubEmails(comp?.raw ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .trim();
  const durRaw = scrubEmails(study.duration?.raw ?? '')
    .replace(/<[^>]*>/g, '')
    .trim();

  const raffle =
    typeof comp?.raffleMax === 'number' && comp.raffleMax > 0
      ? `${usd(comp.raffleMax)} prize drawing - <em>not guaranteed pay</em>`
      : null;

  return [
    prefix ? `<p><em>${prefix}</em></p>` : '',
    study.summary ? `<p>${study.summary}</p>` : '',
    row('Pay', payHeadline(study)),
    row('Drawing', raffle),
    row('Time', hoursLabel(study)),
    row('Ages', agesLabel(study)),
    row('Tags', study.tags?.length ? study.tags.join(', ') : null),
    row('IRB', study.irbNumber),
    row('Expires', study.expirationDate ? study.expirationDate.slice(0, 10) : null),
    study.isExpired ? '<p><strong>This posting has already expired.</strong></p>' : '',
    compRaw ? `<p><strong>Listed compensation text:</strong> ${compRaw}</p>` : '',
    durRaw ? `<p><strong>Listed duration text:</strong> ${durRaw}</p>` : '',
    `<p><a href="${detailUrl}">Full breakdown</a> &middot; <a href="${study.url}">Official listing on research.tamu.edu</a></p>`,
    `<p><small>${DISCLAIMER}</small></p>`,
  ]
    .filter(Boolean)
    .join('\n');
}

interface FeedItem {
  title: string;
  link: string;
  guid: string;
  guidIsPermalink: boolean;
  pubDate: Date;
  description: string;
  categories: string[];
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const GET: APIRoute = (context) => {
  const origin = (context.site ?? new URL(FALLBACK_ORIGIN)).origin;
  // BASE_URL is '/r/studies/' in this project; normalize either spelling.
  const base = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/`;
  const abs = (path: string): string => `${origin}${base}${path.replace(/^\/+/, '')}`;

  const studies: StudyRecord[] = Array.isArray(snapshot.studies) ? snapshot.studies : [];
  const byId = new Map(studies.map((s) => [s.id, s]));

  const posted = (s: StudyRecord): number => {
    const t = new Date(s.postedDate).getTime();
    return Number.isNaN(t) ? 0 : t;
  };

  // --- 1. The durable spine: most recently posted live studies. ------------
  const recent = studies
    .filter((s) => !s.isExpired)
    .sort((a, b) => posted(b) - posted(a))
    .slice(0, RECENT_COUNT);

  // --- 2. Anything this build's diff calls new, even if already expired. ---
  const selected = new Map(recent.map((s) => [s.id, s]));
  for (const id of diff.added ?? []) {
    const study = byId.get(id);
    if (study) selected.set(id, study);
  }

  const fallbackDate = new Date(snapshot.fetchedAt ?? Date.now());

  const items: FeedItem[] = [...selected.values()].map((study) => {
    const detailUrl = abs(`study/${study.slug}/`);
    return {
      title: `${payHeadline(study)} - ${study.title}`,
      link: detailUrl,
      guid: detailUrl,
      guidIsPermalink: true,
      pubDate: new Date(posted(study) || fallbackDate.getTime()),
      description: describe(
        study,
        detailUrl,
        study.isExpired ? 'This listing is already past its expiration date.' : undefined,
      ),
      categories: study.tags ?? [],
    };
  });

  // --- 3. Change notices, when this build actually had a baseline. ---------
  // Guid is a hash of the changed values, so an edit is announced once and a
  // rebuild with an empty diff simply drops the item instead of repeating it.
  for (const entry of diff.changed ?? []) {
    const fields = (entry.fields ?? []).filter((f) => NOTIFIABLE_FIELDS.has(f));
    if (fields.length === 0) continue;
    const study = byId.get(entry.id);
    if (!study) continue;

    const fingerprint = hash(
      [study.compensation?.raw ?? '', study.duration?.raw ?? '', study.expirationDate ?? ''].join('|'),
    );
    const detailUrl = abs(`study/${study.slug}/`);
    const what = fields
      .map((f) => (f === 'compensation.raw' ? 'pay' : f === 'duration.raw' ? 'time commitment' : 'expiry date'))
      .join(' and ');

    items.push({
      title: `Updated ${what}: ${payHeadline(study)} - ${study.title}`,
      link: detailUrl,
      guid: `${detailUrl}#updated-${fingerprint}`,
      guidIsPermalink: false,
      pubDate: new Date(diff.generatedAt ?? fallbackDate),
      description: describe(study, detailUrl, `The ${what} on this listing changed upstream.`),
      categories: study.tags ?? [],
    });
  }

  items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  const published = items.slice(0, MAX_ITEMS);

  const feedUrl = abs('rss.xml');
  const siteUrl = abs('');
  const lastBuild = published[0]?.pubDate ?? fallbackDate;

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>TAMU paid research studies - new listings</title>
    <link>${xml(siteUrl)}</link>
    <atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${xml(
      'Newly posted paid research studies recruiting volunteers at Texas A&M, with the ' +
        'effective hourly rate in every title. ' +
        DISCLAIMER,
    )}</description>
    <language>en-us</language>
    <docs>https://www.rssboard.org/rss-specification</docs>
    <generator>studies-site</generator>
    <lastBuildDate>${rfc822(lastBuild.toISOString(), fallbackDate)}</lastBuildDate>
    <pubDate>${rfc822(snapshot.fetchedAt, fallbackDate)}</pubDate>
    <ttl>360</ttl>
${published
  .map(
    (item) => `    <item>
      <title>${xml(xmlSafe(item.title))}</title>
      <link>${xml(item.link)}</link>
      <guid isPermaLink="${item.guidIsPermalink ? 'true' : 'false'}">${xml(item.guid)}</guid>
      <pubDate>${rfc822(item.pubDate.toISOString(), fallbackDate)}</pubDate>
${item.categories.map((c) => `      <category>${xml(xmlSafe(c))}</category>`).join('\n')}
      <description>${xml(xmlSafe(item.description))}</description>
    </item>`,
  )
  .join('\n')}
  </channel>
</rss>
`;

  return new Response(body, {
    headers: {
      // Static output writes the body to a file; these matter for `astro dev`
      // and `astro preview`. In production the host sets them - see DEPLOY.md.
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
