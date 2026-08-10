/**
 * The normalized dataset as one static JSON file.  ->  /r/studies/api/studies.json
 *
 * WHY THIS EXISTS
 * ---------------
 * Texas A&M's registry is already open, but it is open in a shape nobody can
 * use: compensation and duration are free text, expired postings still report
 * `status: "publish"`, and the endpoint sends no `Access-Control-Allow-Origin`
 * so no browser can read it directly. Every consumer therefore has to rebuild
 * the same parsing and the same expiry detection before they can ask a single
 * interesting question.
 *
 * This file is that work, published. It is the exact `StudyRecord[]` the site
 * itself renders - same parse, same `effectiveHourly`, same `isExpired` - so
 * anyone can build on it without re-deriving anything, and can check our
 * numbers against `compensation.raw` and `duration.raw`, which are carried
 * through verbatim.
 *
 * SHAPE
 * -----
 *   { meta: {...}, studies: (StudyRecord & { detailUrl })[] }
 *
 * `studies` is `src/types.ts`'s `StudyRecord` with one additive field. Nothing
 * is renamed or removed, so a consumer that has the type already can use it
 * unchanged. `meta` is new information only.
 *
 * ============================================================================
 * CONTACT DETAILS ARE REDACTED HERE, AND THAT IS NOT NEGOTIABLE
 * ============================================================================
 * `ContactButton.astro` goes to real trouble to keep coordinators' personal
 * @tamu.edu addresses out of the server-rendered HTML: no `mailto:`, no text
 * node, no attribute, just a hex token reassembled after a click. The threat
 * model it names is "a mirror that re-publishes them in plaintext hands every
 * address-harvesting crawler a clean, structured list."
 *
 * A single JSON file containing every address, keyed and machine-readable, IS
 * that clean structured list - strictly easier to harvest than the HTML the
 * component defends. Publishing it would have made the obfuscation next door
 * pointless theatre.
 *
 * So `contactEmail`, `contactPhone`, and `contactName` (which upstream
 * sometimes fills with an address - study 8458's is `mpkj.engelen@ctral.org`)
 * are nulled out below. The keys stay present so the `StudyRecord` type still
 * describes the payload; only the values are withheld. Every record carries
 * `url`, the official Texas A&M listing, where a human can read the contact
 * exactly as the university published it.
 *
 * The redaction is an explicit override AFTER the spread, so a future field
 * cannot re-introduce the leak by being added to `StudyRecord` - but a future
 * *contact* field would need adding to `redactContact` by hand. The build-time
 * assertion at the bottom of this file is the backstop for that.
 *
 * "endpoint" is a slight misnomer: with `output: 'static'` Astro executes this
 * at build time and writes the body to `dist/api/studies.json`. It is a file
 * on a CDN, not a running service - which is why the CORS header that makes it
 * usable from a browser has to be configured on the host rather than returned
 * from here. See DEPLOY.md; the `Response` headers below only take effect
 * under `astro dev` and `astro preview`.
 */

import type { APIRoute } from 'astro';

import snapshotJson from '@/data/snapshot.json';
import taxonomiesJson from '@/data/taxonomies.json';
import type { Snapshot, StudyRecord, TaxonomyTerm } from '@/types.ts';

const snapshot = snapshotJson as unknown as Snapshot;

/** Written as a keyed map by the current fetcher, as an array historically. */
type TaxonomyFile = Record<string, Record<string, TaxonomyTerm> | TaxonomyTerm[]>;
const taxonomies = taxonomiesJson as unknown as TaxonomyFile;

const FALLBACK_ORIGIN = 'https://harsh.bet';

/** Bump when a field is removed or its meaning changes. Additions do not. */
const SCHEMA_VERSION = 2;

/**
 * The contact fields withheld from the published payload. Listed once so the
 * redactor and the leak assertion below cannot disagree about what is secret.
 */
const REDACTED_CONTACT_FIELDS = ['contactEmail', 'contactPhone', 'contactName'] as const;

/** Anything shaped like an address, anywhere in a serialized string. */
const EMAIL_ANYWHERE_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Null the contact fields, keeping the keys so the record shape is unchanged. */
function redactContact(study: StudyRecord): StudyRecord {
  const out = { ...study };
  for (const field of REDACTED_CONTACT_FIELDS) out[field] = null;
  return out;
}

/** Accept both shapes, and emit the keyed one. */
function termMap(key: string): Record<string, { id: number; name: string; slug: string }> {
  const raw = taxonomies[key];
  const terms: TaxonomyTerm[] = Array.isArray(raw) ? raw : raw === undefined ? [] : Object.values(raw);
  const out: Record<string, { id: number; name: string; slug: string }> = {};
  for (const term of terms) {
    if (term && typeof term.id === 'number') {
      out[String(term.id)] = { id: term.id, name: term.name, slug: term.slug };
    }
  }
  return out;
}

export const GET: APIRoute = (context) => {
  const origin = (context.site ?? new URL(FALLBACK_ORIGIN)).origin;
  const base = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/`;
  const abs = (path: string): string => `${origin}${base}${path.replace(/^\/+/, '')}`;

  const studies: StudyRecord[] = Array.isArray(snapshot.studies) ? snapshot.studies : [];
  const rated = studies.filter((s) => typeof s.effectiveHourly === 'number');
  const expired = studies.filter((s) => s.isExpired);

  const payload = {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: snapshot.fetchedAt,
      /** Where the numbers came from, so nobody has to guess. */
      source: 'https://research.tamu.edu/wp-json/wp/v2/study',
      site: abs(''),
      feed: abs('rss.xml'),
      self: abs('api/studies.json'),

      count: studies.length,
      /** `X-WP-Total` at fetch time. Exceeds `count` because near-duplicate
       *  re-postings of the same IRB protocol are collapsed to one record. */
      upstreamTotal: snapshot.totalFromHeader,
      expiredCount: expired.length,
      ratedCount: rated.length,

      /** Term-id -> term, for the `*Ids` arrays on each study. */
      taxonomies: {
        category: termMap('category'),
        location: termMap('location'),
        sessionType: termMap('sessionType'),
        topic: termMap('topic'),
      },

      /** The rules a consumer will otherwise get wrong. */
      notes: [
        'effectiveHourly is guaranteed USD per hour of participant time. null means UNKNOWN, never zero: unknown pay, unknown hours, and raffle-only compensation all produce null. A genuine unpaid study is 0, which is a different claim. Do not coerce null to 0 when sorting.',
        'isExpired is derived here, not upstream. The registry keeps serving expired postings with status "publish", so it cannot be used to tell whether a study is still recruiting.',
        'compensation.raw and duration.raw are the original free-text fields. Every parsed number is a heuristic reading of them and may be wrong; check against raw before relying on a figure.',
        'contactEmail, contactPhone and contactName are always null here. They are deliberately withheld: the upstream listings carry the personal addresses of graduate students and research coordinators, who agreed to appear on a university recruitment page and not in a bulk-downloadable file. Use each record’s `url` to reach the official listing, which shows the contact.',
      ],

      license:
        'Underlying study data is published by Texas A&M University. This normalization is provided as-is with no warranty. Attribution appreciated, not required.',
      disclaimer:
        'Unofficial. Not affiliated with, endorsed by, or operated by Texas A&M University. Parsed figures are derived automatically from free text and may be inaccurate. Confirm details with the study contact and the official listing before participating.',
    },

    // Every field of StudyRecord, verbatim, plus the local permalink - except
    // the contact fields, which `redactContact` nulls. The spread keeps the
    // rest honest: no allow-list to fall out of date when src/types.ts gains a
    // field. The redaction runs after it so it always wins.
    studies: studies.map((study) => ({
      ...redactContact(study),
      /** Human-readable page for this record, showing the parse and its input. */
      detailUrl: abs(`study/${study.slug}/`),
    })),
  };

  const body = `${JSON.stringify(payload, null, 2)}\n`;

  /**
   * Backstop, not decoration. This runs at build time, so an address that ever
   * reaches the payload - through a new `StudyRecord` field, a note, a raw
   * compensation string a coordinator pasted an address into - fails the build
   * instead of shipping. Silence here is the whole point of the file.
   */
  const leak = EMAIL_ANYWHERE_RE.exec(body);
  if (leak !== null) {
    throw new Error(
      `api/studies.json would publish an email address in plaintext (${leak[0]}). ` +
        'Contact details are withheld from this endpoint on purpose - see the header ' +
        'comment. Redact the field that carries it rather than relaxing this check.',
    );
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Only effective in dev/preview - a static file's real headers come from
      // the host. DEPLOY.md has the Vercel and Cloudflare Pages config.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
