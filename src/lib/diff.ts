/**
 * Snapshot-to-snapshot delta.
 *
 * Purpose: answer "what actually changed upstream since the last build?"
 * without diffing whole JSON blobs. Upstream rewrites `modified` on cosmetic
 * edits and reorders arrays freely, so a naive deep-equal reports churn on
 * every run. This module compares only the fields a participant would care
 * about:
 *
 *   compensation.raw   - what the study says it pays
 *   duration.raw       - how much of your time it wants
 *   expirationDate     - whether the posting is still supposed to be live
 *   irbApprovalDate    - re-approval, i.e. the protocol was renewed
 *
 * Output is deterministic: ids are sorted numerically where possible so two
 * runs over the same inputs produce byte-identical `diff.json`.
 */

import type { Snapshot, SnapshotDiff, StudyRecord } from '@/types.ts';

/**
 * The watched fields, in report order. Each reads a comparable scalar off a
 * record; `null` and `''` are treated as the same "absent" value so a
 * WordPress meta field flipping between them is not reported as a change.
 */
export const DIFF_FIELDS: readonly { field: string; read: (s: StudyRecord) => string | null }[] = [
  { field: 'compensation.raw', read: (s) => s.compensation?.raw ?? null },
  { field: 'duration.raw', read: (s) => s.duration?.raw ?? null },
  { field: 'expirationDate', read: (s) => s.expirationDate },
  { field: 'irbApprovalDate', read: (s) => s.irbApprovalDate },
];

/** Absent, empty, and whitespace-only all normalize to `null`. */
function canonical(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Numeric-aware id ordering, so 9028 sorts before 11324. */
function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function indexById(studies: readonly StudyRecord[] | undefined): Map<string, StudyRecord> {
  const map = new Map<string, StudyRecord>();
  for (const study of studies ?? []) {
    if (study && typeof study.id === 'string') map.set(study.id, study);
  }
  return map;
}

/**
 * Field-level delta between two snapshots.
 *
 * A missing/null `prev` means "first ever run": everything in `next` is
 * reported as `added`, which is honest - there is no baseline to compare to.
 *
 * Never throws; malformed records are skipped rather than crashing the build.
 */
export function diffSnapshots(
  prev: Snapshot | null | undefined,
  next: Snapshot | null | undefined,
): SnapshotDiff {
  const prevById = indexById(prev?.studies);
  const nextById = indexById(next?.studies);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: { id: string; fields: string[] }[] = [];

  for (const [id, nextStudy] of nextById) {
    const prevStudy = prevById.get(id);
    if (prevStudy === undefined) {
      added.push(id);
      continue;
    }

    const fields: string[] = [];
    for (const { field, read } of DIFF_FIELDS) {
      if (canonical(read(prevStudy)) !== canonical(read(nextStudy))) fields.push(field);
    }
    if (fields.length > 0) changed.push({ id, fields });
  }

  for (const id of prevById.keys()) {
    if (!nextById.has(id)) removed.push(id);
  }

  added.sort(compareIds);
  removed.sort(compareIds);
  changed.sort((a, b) => compareIds(a.id, b.id));

  return { added, removed, changed };
}

/** True when nothing a participant would notice moved. */
export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/** One-line-per-item human summary for build logs. */
export function summarizeDiff(diff: SnapshotDiff, byId?: Map<string, StudyRecord>): string {
  if (isEmptyDiff(diff)) return 'no changes since the previous snapshot';

  const label = (id: string): string => {
    const title = byId?.get(id)?.title;
    return title ? `${id} (${title.slice(0, 60)})` : id;
  };

  const lines: string[] = [
    `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`,
  ];
  for (const id of diff.added) lines.push(`  + ${label(id)}`);
  for (const id of diff.removed) lines.push(`  - ${id}`);
  for (const { id, fields } of diff.changed) lines.push(`  ~ ${label(id)}: ${fields.join(', ')}`);

  return lines.join('\n');
}
