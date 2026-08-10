/**
 * Build-time upstream reader.
 *
 * The TAMU registry sends no `Access-Control-Allow-Origin`, so a browser can
 * never read it. Every call in this module runs in Node during
 * `npm run fetch:data` / `npm run build`.
 *
 * Design rules, in priority order:
 *
 *   1. NEVER THROW. A stale-but-present site beats a broken deploy, so total
 *      network failure falls back to the committed fixture
 *      (`fixtures/arv-snapshot.json`) and the caller is told which path was
 *      taken via `result.source`.
 *   2. NEVER SILENTLY TRUNCATE. `per_page=100` covers all 86 records today,
 *      but `X-WP-TotalPages` is read on every run and pages 2..N are fetched
 *      when the registry grows past one page. A short read is surfaced as a
 *      warning, never swallowed.
 *   3. BE A POLITE CONSUMER. Descriptive User-Agent with a contact URL, a
 *      hard request timeout, bounded retries with exponential backoff, and a
 *      small delay between pages so we never hammer a university server.
 */

import { readFile } from 'node:fs/promises';
import { STUDY_API_URL, TAXONOMY_ENDPOINTS } from '@/types.ts';
import type { RawStudy, TaxonomyMaps, TaxonomyTerm } from '@/types.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Identifies the crawler and points a server admin at something actionable.
 * Anonymous scraping of a public university endpoint is how you get blocked.
 */
export const USER_AGENT =
  'studies-site/1.0 (+https://harsh.bet/studies; build-time aggregator of public TAMU study listings; static site, one fetch per deploy)';

/** Upstream returns everything in one page at this size (86 records today). */
export const DEFAULT_PER_PAGE = 100;

/** Per-request wall clock budget. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Total attempts per request, including the first. */
export const DEFAULT_ATTEMPTS = 3;

/** First backoff delay; doubles per attempt (500ms, 1000ms). */
export const DEFAULT_BASE_DELAY_MS = 500;

/** Courtesy pause between pages of a paginated read. */
export const INTER_PAGE_DELAY_MS = 250;

/**
 * Refuse to walk more than this many pages. Guards against an upstream that
 * reports a nonsense `X-WP-TotalPages` and turns a build into a crawl.
 */
export const MAX_PAGES = 25;

/** Frozen snapshot of all 86 raw records, committed to the repo. */
const FIXTURE_URL = new URL('../../fixtures/arv-snapshot.json', import.meta.url);

/** Written by a previous successful run; used as a taxonomy fallback. */
const TAXONOMY_CACHE_URL = new URL('../data/taxonomies.json', import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the data actually came from. Always log this. */
export type FetchSource = 'network' | 'fixture' | 'cache' | 'empty';

export interface FetchOptions {
  perPage?: number;
  timeoutMs?: number;
  /** Total attempts per HTTP request, including the first. Minimum 1. */
  attempts?: number;
  baseDelayMs?: number;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Set false to make network failure return an empty result instead. */
  allowFallback?: boolean;
  /** Injectable logger. Defaults to `console`. Pass a no-op to silence. */
  log?: Logger;
}

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface FetchStudiesResult {
  studies: RawStudy[];
  /** `X-WP-Total`. Compare with `studies.length` to detect truncation. */
  totalFromHeader: number;
  /** `X-WP-TotalPages` as reported by page 1. */
  totalPages: number;
  source: FetchSource;
  /** ISO 8601 timestamp of this read. */
  fetchedAt: string;
  /** Non-fatal problems worth showing in build output. */
  warnings: string[];
  /** Why the network path failed, when it did. */
  error: string | null;
}

export interface FetchTaxonomiesResult {
  taxonomies: TaxonomyMaps;
  source: FetchSource;
  warnings: string[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function toPositiveInt(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/** 5xx and 429 are worth retrying; 4xx generally is not. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// HTTP with timeout + exponential backoff
// ---------------------------------------------------------------------------

interface HttpResult<T> {
  data: T;
  headers: Headers;
}

/**
 * GET JSON with a hard timeout and bounded exponential backoff.
 *
 * Throws only after every attempt is exhausted. Callers in this module always
 * catch, so nothing escapes to the build.
 */
async function getJson<T>(url: string, opts: Required<Pick<FetchOptions, 'timeoutMs' | 'attempts' | 'baseDelayMs'>> & { fetchImpl: typeof fetch; log: Logger }): Promise<HttpResult<T>> {
  const { timeoutMs, attempts, baseDelayMs, fetchImpl, log } = opts;
  let lastError: unknown = new Error('no attempts made');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate',
          'user-agent': USER_AGENT,
        },
      });

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        if (!isRetryableStatus(res.status)) throw Object.assign(err, { fatal: true });
        throw err;
      }

      const data = (await res.json()) as T;
      return { data, headers: res.headers };
    } catch (err) {
      lastError = err;
      const fatal = typeof err === 'object' && err !== null && (err as { fatal?: boolean }).fatal === true;
      const isLast = attempt === attempts;

      if (fatal || isLast) break;

      // 500ms, 1000ms, 2000ms... plus jitter so parallel builds do not sync up.
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
      log.warn(`[fetch] attempt ${attempt}/${attempts} failed (${describeError(err)}); retrying in ${delay}ms`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(describeError(lastError));
}

// ---------------------------------------------------------------------------
// Fixture fallback
// ---------------------------------------------------------------------------

/**
 * Read the committed snapshot of all 86 raw records.
 *
 * Returns `[]` rather than throwing if the fixture is missing or corrupt -
 * this is the last line of defence and must not itself break the build.
 */
export async function loadFixtureStudies(): Promise<RawStudy[]> {
  try {
    const text = await readFile(FIXTURE_URL, 'utf8');
    const parsed: unknown = JSON.parse(text);

    // Tolerate both a bare array and a `{ studies: [...] }` wrapper.
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { studies?: unknown }).studies)
        ? ((parsed as { studies: unknown[] }).studies)
        : [];

    return list.filter(isRawStudyLike);
  } catch {
    return [];
  }
}

/** Structural guard - enough to reject junk without duplicating the schema. */
function isRawStudyLike(value: unknown): value is RawStudy {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RawStudy>;
  return typeof v.id === 'number' && typeof v.meta === 'object' && v.meta !== null;
}

// ---------------------------------------------------------------------------
// Studies
// ---------------------------------------------------------------------------

/**
 * Fetch every study record from upstream.
 *
 * Reads `X-WP-Total` and `X-WP-TotalPages` off page 1 and keeps paging until
 * the reported page count is exhausted, so growing past 100 records widens the
 * index instead of silently cutting it off. On unrecoverable failure the
 * committed fixture is returned with `source: 'fixture'`.
 *
 * This function does not throw.
 */
export async function fetchAllStudies(options: FetchOptions = {}): Promise<FetchStudiesResult> {
  const log = options.log ?? consoleLogger;
  const http = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    attempts: Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS),
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    log,
  };
  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const allowFallback = options.allowFallback ?? true;
  const warnings: string[] = [];
  const fetchedAt = new Date().toISOString();

  try {
    if (typeof http.fetchImpl !== 'function') throw new Error('no fetch implementation available');

    const firstUrl = `${STUDY_API_URL}?per_page=${perPage}&page=1&orderby=id&order=asc`;
    log.info(`[fetch:studies] GET ${firstUrl}`);

    const first = await getJson<unknown>(firstUrl, http);
    if (!Array.isArray(first.data)) throw new Error('upstream did not return a JSON array');

    const studies: RawStudy[] = first.data.filter(isRawStudyLike);
    if (studies.length !== first.data.length) {
      warnings.push(`page 1: dropped ${first.data.length - studies.length} malformed record(s)`);
    }

    const totalFromHeader = toPositiveInt(first.headers.get('x-wp-total')) ?? studies.length;
    const reportedPages = toPositiveInt(first.headers.get('x-wp-totalpages')) ?? 1;
    const totalPages = Math.max(1, reportedPages);

    log.info(`[fetch:studies] page 1/${totalPages}: ${studies.length} records (X-WP-Total: ${totalFromHeader})`);

    if (totalPages > MAX_PAGES) {
      warnings.push(`upstream reports ${totalPages} pages; capping at ${MAX_PAGES}`);
    }

    const lastPage = Math.min(totalPages, MAX_PAGES);
    for (let page = 2; page <= lastPage; page += 1) {
      await sleep(INTER_PAGE_DELAY_MS);
      const url = `${STUDY_API_URL}?per_page=${perPage}&page=${page}&orderby=id&order=asc`;
      log.info(`[fetch:studies] GET ${url}`);
      const next = await getJson<unknown>(url, http);
      if (!Array.isArray(next.data)) throw new Error(`page ${page} did not return a JSON array`);
      const pageRecords = next.data.filter(isRawStudyLike);
      studies.push(...pageRecords);
      log.info(`[fetch:studies] page ${page}/${totalPages}: ${pageRecords.length} records`);
    }

    if (studies.length === 0) throw new Error('upstream returned zero records');

    // Truncation check. A short read is a data-quality bug, not a crash: we
    // still publish, but the discrepancy is loud and lands in the summary.
    if (totalFromHeader !== studies.length) {
      warnings.push(
        `X-WP-Total is ${totalFromHeader} but ${studies.length} record(s) were read - upstream may be paginating differently`,
      );
    }

    // Dedupe by upstream id: overlapping pages happen when records are added
    // mid-crawl and would otherwise produce phantom duplicates downstream.
    const seen = new Set<number>();
    const unique = studies.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    if (unique.length !== studies.length) {
      warnings.push(`removed ${studies.length - unique.length} record(s) repeated across pages`);
    }

    for (const w of warnings) log.warn(`[fetch:studies] WARNING ${w}`);
    log.info(`[fetch:studies] SOURCE=network - ${unique.length} records`);

    return { studies: unique, totalFromHeader, totalPages, source: 'network', fetchedAt, warnings, error: null };
  } catch (err) {
    const message = describeError(err);
    log.error(`[fetch:studies] network read FAILED: ${message}`);

    if (!allowFallback) {
      log.error('[fetch:studies] SOURCE=empty - fallback disabled');
      return { studies: [], totalFromHeader: 0, totalPages: 0, source: 'empty', fetchedAt, warnings, error: message };
    }

    const fixture = await loadFixtureStudies();
    if (fixture.length === 0) {
      log.error('[fetch:studies] SOURCE=empty - fixture unreadable too; downstream must handle an empty list');
      return { studies: [], totalFromHeader: 0, totalPages: 0, source: 'empty', fetchedAt, warnings, error: message };
    }

    warnings.push(`network read failed (${message}); served ${fixture.length} record(s) from the committed fixture`);
    log.warn(`[fetch:studies] SOURCE=fixture - falling back to ${fixture.length} committed records (data may be stale)`);

    return {
      studies: fixture,
      totalFromHeader: fixture.length,
      totalPages: 1,
      source: 'fixture',
      fetchedAt,
      warnings,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

function emptyTaxonomies(): TaxonomyMaps {
  return { category: {}, location: {}, sessionType: {}, topic: {} };
}

function isTaxonomyTermLike(value: unknown): value is TaxonomyTerm {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<TaxonomyTerm>;
  return typeof v.id === 'number' && typeof v.name === 'string';
}

/**
 * Index a vocabulary by term id.
 *
 * Accepts both shapes we might be handed: the array the API returns, and the
 * already-indexed `Record<id, term>` that `fetch-data.ts` writes to
 * `src/data/taxonomies.json`. Reading the cache back would silently yield zero
 * terms otherwise.
 */
function indexTerms(terms: unknown): Record<number, TaxonomyTerm> {
  const out: Record<number, TaxonomyTerm> = {};
  if (Array.isArray(terms)) {
    for (const term of terms) if (isTaxonomyTermLike(term)) out[term.id] = term;
    return out;
  }
  if (typeof terms === 'object' && terms !== null) {
    for (const term of Object.values(terms)) if (isTaxonomyTermLike(term)) out[term.id] = term;
  }
  return out;
}

/**
 * Fetch the four term vocabularies used to label studies.
 *
 * Taxonomies are decoration, not the product: on failure this degrades to the
 * last cached `src/data/taxonomies.json`, and then to empty maps. Normalization
 * keyword-infers tags when the maps are empty, so the site still works.
 *
 * This function does not throw.
 */
export async function fetchTaxonomies(options: FetchOptions = {}): Promise<FetchTaxonomiesResult> {
  const log = options.log ?? consoleLogger;
  const http = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    attempts: Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS),
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    log,
  };
  const warnings: string[] = [];
  const taxonomies = emptyTaxonomies();

  try {
    if (typeof http.fetchImpl !== 'function') throw new Error('no fetch implementation available');

    for (const [key, endpoint] of Object.entries(TAXONOMY_ENDPOINTS) as [keyof TaxonomyMaps, string][]) {
      await sleep(INTER_PAGE_DELAY_MS);
      const { data } = await getJson<unknown>(`${endpoint}?per_page=100&orderby=id&order=asc`, http);
      taxonomies[key] = indexTerms(data);
      log.info(`[fetch:taxonomies] ${key}: ${Object.keys(taxonomies[key]).length} terms`);
    }

    log.info('[fetch:taxonomies] SOURCE=network');
    return { taxonomies, source: 'network', warnings, error: null };
  } catch (err) {
    const message = describeError(err);
    log.error(`[fetch:taxonomies] network read FAILED: ${message}`);

    try {
      const cached: unknown = JSON.parse(await readFile(TAXONOMY_CACHE_URL, 'utf8'));
      const maps = emptyTaxonomies();
      let total = 0;
      for (const key of Object.keys(maps) as (keyof TaxonomyMaps)[]) {
        maps[key] = indexTerms((cached as Record<string, unknown>)[key]);
        total += Object.keys(maps[key]).length;
      }
      if (total > 0) {
        warnings.push(`taxonomy fetch failed (${message}); reused ${total} cached term(s)`);
        log.warn(`[fetch:taxonomies] SOURCE=cache - reused ${total} terms from src/data/taxonomies.json`);
        return { taxonomies: maps, source: 'cache', warnings, error: message };
      }
    } catch {
      // fall through to empty
    }

    warnings.push(`taxonomy fetch failed (${message}); continuing with no term labels`);
    log.warn('[fetch:taxonomies] SOURCE=empty - tags will be inferred from text only');
    return { taxonomies: emptyTaxonomies(), source: 'empty', warnings, error: message };
  }
}
