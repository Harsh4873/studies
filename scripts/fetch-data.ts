/**
 * Build-time data pipeline.  `npm run fetch:data`
 *
 *   fetch (network, fixture fallback)
 *     -> normalize (RawStudy -> StudyRecord)
 *     -> dedupe (collapse re-posted protocols by IRB number)
 *     -> diff against the previous src/data/snapshot.json
 *     -> write src/data/{snapshot,diff,raw-studies,taxonomies}.json
 *     -> print a human summary
 *
 * The upstream API sends no `Access-Control-Allow-Origin`, so this is the only
 * place the registry is ever read; the browser gets a static JSON snapshot.
 *
 * Determinism: apart from `fetchedAt`, running this twice over unchanged
 * upstream data produces byte-identical output. Records are sorted by id and
 * object keys are emitted in a fixed order, so `git diff` on the snapshot
 * shows real changes rather than serialization churn.
 *
 * Exit codes: 0 on success (including the fixture-fallback path - a stale site
 * beats a broken deploy), 1 only when there is nothing at all to publish.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Snapshot, SnapshotDiff, StudyRecord } from '../src/types.ts';

/**
 * Teach bare Node the `@/*` -> `src/*` alias from tsconfig.json.
 *
 * Vite/Astro read tsconfig `paths`; `node --experimental-strip-types` does
 * not, and the parser modules import each other as `@/lib/html.ts`. Without
 * this the CLI dies on ERR_MODULE_NOT_FOUND while the site build is fine -
 * the most confusing possible failure mode.
 *
 * Hooks must be installed before the aliased modules load, which is why every
 * `src/` import below is dynamic rather than static (static imports hoist
 * above this call).
 */
const SRC_URL = new URL('../src/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(specifier.slice(2), SRC_URL).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'data');
const SNAPSHOT_PATH = join(OUT_DIR, 'snapshot.json');
const DIFF_PATH = join(OUT_DIR, 'diff.json');
const RAW_PATH = join(OUT_DIR, 'raw-studies.json');
const TAXONOMY_PATH = join(OUT_DIR, 'taxonomies.json');

function log(msg = ''): void {
  console.log(msg);
}

function money(n: number | null): string {
  return n === null ? '  n/a  ' : `$${n.toFixed(2).padStart(6)}`;
}

/** Numeric-aware id ordering, so the snapshot is stable and readable. */
function byId(a: StudyRecord, b: StudyRecord): number {
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Previous snapshot, or null on first run / unreadable file. */
async function loadPreviousSnapshot(): Promise<Snapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Snapshot).studies)) {
      return parsed as Snapshot;
    }
    return null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const now = new Date();

  // Dynamic so the alias hook above is already installed. See registerHooks().
  const { fetchAllStudies, fetchTaxonomies } = await import('../src/lib/fetch-studies.ts');
  const { normalizeAndDedupe, unexpectedLifecycleValues } = await import('../src/lib/normalize.ts');
  const { diffSnapshots, isEmptyDiff, summarizeDiff } = await import('../src/lib/diff.ts');

  log('='.repeat(72));
  log('fetch:data - Texas A&M paid study registry');
  log('='.repeat(72));

  // --- 1. Fetch ------------------------------------------------------------
  const [studiesResult, taxonomyResult] = [await fetchAllStudies(), await fetchTaxonomies()];

  if (studiesResult.studies.length === 0) {
    console.error('[fetch:data] FATAL: no records from network and no usable fixture. Nothing to publish.');
    process.exitCode = 1;
    return;
  }

  // --- 2. Normalize + dedupe ----------------------------------------------
  const { studies: deduped, dropped, groups, failures } = normalizeAndDedupe(studiesResult.studies, {
    taxonomies: taxonomyResult.taxonomies,
    now,
  });

  for (const failure of failures) {
    console.error(`[fetch:data] skipped malformed record ${String(failure.id)}: ${failure.error}`);
  }

  const studies = [...deduped].sort(byId);

  const snapshot: Snapshot = {
    fetchedAt: studiesResult.fetchedAt,
    totalFromHeader: studiesResult.totalFromHeader,
    studies,
  };

  // --- 3. Diff -------------------------------------------------------------
  const previous = await loadPreviousSnapshot();
  const diff: SnapshotDiff = diffSnapshots(previous, snapshot);

  // --- 4. Write ------------------------------------------------------------
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(
    DIFF_PATH,
    `${JSON.stringify({ generatedAt: snapshot.fetchedAt, previousFetchedAt: previous?.fetchedAt ?? null, ...diff }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    RAW_PATH,
    `${JSON.stringify(
      {
        fetchedAt: snapshot.fetchedAt,
        source: studiesResult.source,
        totalFromHeader: studiesResult.totalFromHeader,
        studies: [...studiesResult.studies].sort((a, b) => a.id - b.id),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(TAXONOMY_PATH, `${JSON.stringify(taxonomyResult.taxonomies, null, 2)}\n`, 'utf8');

  // --- 5. Summary ----------------------------------------------------------
  const expired = studies.filter((s) => s.isExpired);
  const rated = studies.filter((s) => s.effectiveHourly !== null);
  const rates = rated.map((s) => s.effectiveHourly as number).sort((a, b) => a - b);
  const median = rates.length === 0 ? null : (rates[rates.length >> 1] ?? null);
  const staleness = studies.reduce<Record<string, number>>((acc, s) => {
    acc[s.staleness] = (acc[s.staleness] ?? 0) + 1;
    return acc;
  }, {});
  const tagCounts = studies.reduce<Record<string, number>>((acc, s) => {
    for (const tag of s.tags) acc[tag] = (acc[tag] ?? 0) + 1;
    return acc;
  }, {});

  log();
  log('-'.repeat(72));
  log(`source            ${studiesResult.source.toUpperCase()}${studiesResult.source === 'fixture' ? '  <-- STALE DATA: network read failed' : ''}`);
  log(`taxonomies        ${taxonomyResult.source} (${Object.values(taxonomyResult.taxonomies).reduce((n, m) => n + Object.keys(m).length, 0)} terms)`);
  log(`fetched           ${studiesResult.studies.length} raw records (X-WP-Total: ${studiesResult.totalFromHeader}, pages: ${studiesResult.totalPages})`);
  log(`duplicates        ${dropped.length} collapsed across ${groups.length} IRB group(s)`);
  log(`published         ${studies.length} studies`);
  log(`expired           ${expired.length} (${studies.length === 0 ? 0 : Math.round((expired.length / studies.length) * 100)}%)`);
  log(`staleness         ${Object.entries(staleness).map(([k, v]) => `${k}:${v}`).join('  ') || 'n/a'}`);
  log(`rateable          ${rated.length}/${studies.length} have effectiveHourly (median ${money(median)}/hr)`);
  log(`tags              ${Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || 'none'}`);
  log('-'.repeat(72));

  if (groups.length > 0) {
    log();
    log('Duplicate protocols collapsed (kept = most recently modified):');
    for (const g of groups) {
      log(`  ${g.irbNumber.padEnd(16)} kept ${g.keptId}  dropped ${g.droppedIds.join(', ')}${g.titlesDiverge ? '   [titles differ - verify]' : ''}`);
    }
  }

  const drift = unexpectedLifecycleValues();
  if (drift.length > 0) {
    log();
    log(`WARNING: lifecycle values outside 3|6|12 observed: ${drift.join(', ')}`);
  }

  for (const warning of [...studiesResult.warnings, ...taxonomyResult.warnings]) {
    log(`WARNING: ${warning}`);
  }

  log();
  if (previous === null) {
    log('Diff: no previous snapshot (first run) - all studies reported as added.');
  } else {
    const index = new Map(studies.map((s) => [s.id, s]));
    log(`Diff vs ${previous.fetchedAt}: ${summarizeDiff(diff, index)}`);
  }

  log();
  log(`Top 5 by guaranteed $/hr:`);
  for (const s of [...rated].sort((a, b) => (b.effectiveHourly ?? 0) - (a.effectiveHourly ?? 0)).slice(0, 5)) {
    log(`  ${money(s.effectiveHourly)}/hr  ${s.isExpired ? '[expired] ' : ''}${s.title.slice(0, 58)}`);
  }

  log();
  log(`Wrote ${SNAPSHOT_PATH}`);
  log(`Wrote ${DIFF_PATH}${isEmptyDiff(diff) ? ' (empty diff)' : ''}`);
  log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err: unknown) => {
  // fetchAllStudies/normalize/diff are all non-throwing, so reaching here means
  // something genuinely unexpected (disk full, permissions) went wrong.
  console.error('[fetch:data] unexpected failure:', err);
  process.exitCode = 1;
});
