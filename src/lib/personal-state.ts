import { getProfile, sanitizeProfile, setProfile, subscribe as subscribeProfile } from './profile';
import type { UserProfile } from '@/types.ts';

export const STUDIES_STATE_KEY = 'harsh.bet/studies:state:v1';
const CLIENT_ID_KEY = 'harsh.bet/owner-vault:client-id';

export interface StudiesFilters {
  query: string;
  minRate: string;
  minTotal: string;
  maxHours: string;
  mode: 'any' | 'online' | 'inperson';
  sort: 'rate' | 'total' | 'time' | 'new';
  tags: string[];
  eligibleOnly: boolean;
  showDismissed: boolean;
}

export interface StudiesPersonalState {
  schemaVersion: 1;
  profile: UserProfile;
  saved: string[];
  dismissed: string[];
  filters: StudiesFilters;
  updatedAtMs: number;
  clientId: string;
}

export const DEFAULT_STUDIES_FILTERS: Readonly<StudiesFilters> = Object.freeze({
  query: '',
  minRate: '0',
  minTotal: '0',
  maxHours: '',
  mode: 'any',
  sort: 'rate',
  tags: [],
  eligibleOnly: false,
  showDismissed: false,
});

type Listener = (state: StudiesPersonalState) => void;
const listeners = new Set<Listener>();
let cache: StudiesPersonalState | null = null;
let observedStamp = 0;
let profileWired = false;
let applyingRemoteProfile = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function getClientId(): string {
  const store = storage();
  if (!store) return 'browser-unavailable';
  try {
    const existing = store.getItem(CLIENT_ID_KEY);
    if (existing && existing.length <= 128) return existing;
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const next = `studies-${random}`.slice(0, 128);
    store.setItem(CLIENT_ID_KEY, next);
    return next;
  } catch {
    return 'browser-storage-blocked';
  }
}

function uniqueStrings(value: unknown, limit = 2000): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => (
    typeof entry === 'string' && entry.length > 0 && entry.length <= 256
  )))].slice(0, limit);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && options.includes(value as T) ? value as T : fallback;
}

function sanitizeFilters(value: unknown): StudiesFilters {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    query: typeof source.query === 'string' ? source.query.slice(0, 300) : '',
    minRate: typeof source.minRate === 'string' ? source.minRate : '0',
    minTotal: typeof source.minTotal === 'string' ? source.minTotal : '0',
    maxHours: typeof source.maxHours === 'string' ? source.maxHours : '',
    mode: oneOf(source.mode, ['any', 'online', 'inperson'] as const, 'any'),
    sort: oneOf(source.sort, ['rate', 'total', 'time', 'new'] as const, 'rate'),
    tags: uniqueStrings(source.tags, 100),
    eligibleOnly: source.eligibleOnly === true,
    showDismissed: source.showDismissed === true,
  };
}

export function parseStudiesState(value: unknown): StudiesPersonalState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1) return null;
  if (!Number.isSafeInteger(source.updatedAtMs) || (source.updatedAtMs as number) < 0) return null;
  const clientId = typeof source.clientId === 'string' && source.clientId.length > 0
    ? source.clientId.slice(0, 128)
    : getClientId();
  return {
    schemaVersion: 1,
    profile: sanitizeProfile(source.profile),
    saved: uniqueStrings(source.saved),
    dismissed: uniqueStrings(source.dismissed),
    filters: sanitizeFilters(source.filters),
    updatedAtMs: source.updatedAtMs as number,
    clientId,
  };
}

function profileHasAnswers(profile: UserProfile): boolean {
  return Object.values(profile).some((value) => value !== null);
}

function freshState(): StudiesPersonalState {
  const profile = getProfile();
  return {
    schemaVersion: 1,
    profile,
    saved: [],
    dismissed: [],
    filters: { ...DEFAULT_STUDIES_FILTERS, tags: [] },
    // An existing v2 profile predates the vault envelope. Give that real local
    // data a migration stamp; a genuinely empty browser stays at zero and can
    // never overwrite an existing cloud record during first sign-in.
    updatedAtMs: profileHasAnswers(profile) ? Date.now() : 0,
    clientId: getClientId(),
  };
}

function readState(): StudiesPersonalState {
  const store = storage();
  if (!store) return freshState();
  try {
    const raw = store.getItem(STUDIES_STATE_KEY);
    if (!raw) return freshState();
    return parseStudiesState(JSON.parse(raw)) ?? freshState();
  } catch {
    return freshState();
  }
}

function persist(state: StudiesPersonalState): void {
  try {
    storage()?.setItem(STUDIES_STATE_KEY, JSON.stringify(state));
  } catch {
    // Keep the in-memory state usable when browser storage is unavailable.
  }
}

function notify(state: StudiesPersonalState): void {
  for (const listener of [...listeners]) listener(structuredClone(state));
}

function mintStamp(): number {
  const next = Math.max(Date.now(), observedStamp + 1);
  observedStamp = next;
  return next;
}

function wireProfile(): void {
  if (profileWired || typeof window === 'undefined') return;
  profileWired = true;
  subscribeProfile((profile) => {
    if (applyingRemoteProfile) return;
    const current = loadStudiesState();
    if (JSON.stringify(current.profile) === JSON.stringify(profile)) return;
    updateStudiesState({ profile });
  });
}

export function loadStudiesState(): StudiesPersonalState {
  if (!cache) {
    cache = readState();
    observedStamp = Math.max(observedStamp, cache.updatedAtMs);
    wireProfile();
  }
  return structuredClone(cache);
}

export function updateStudiesState(
  patch: Partial<Pick<StudiesPersonalState, 'profile' | 'saved' | 'dismissed' | 'filters'>>,
): StudiesPersonalState {
  const current = loadStudiesState();
  const next: StudiesPersonalState = {
    ...current,
    ...patch,
    profile: patch.profile ? sanitizeProfile(patch.profile) : current.profile,
    saved: patch.saved ? uniqueStrings(patch.saved) : current.saved,
    dismissed: patch.dismissed ? uniqueStrings(patch.dismissed) : current.dismissed,
    filters: patch.filters ? sanitizeFilters(patch.filters) : current.filters,
    updatedAtMs: mintStamp(),
    clientId: current.clientId || getClientId(),
  };
  cache = next;
  persist(next);
  notify(next);
  return structuredClone(next);
}

export function applyRemoteStudiesState(value: unknown): StudiesPersonalState | null {
  const remote = parseStudiesState(value);
  if (!remote) return null;
  observedStamp = Math.max(observedStamp, remote.updatedAtMs);
  const current = loadStudiesState();
  if (remote.updatedAtMs < current.updatedAtMs) return current;
  cache = remote;
  persist(remote);
  applyingRemoteProfile = true;
  try {
    setProfile(remote.profile);
  } finally {
    applyingRemoteProfile = false;
  }
  notify(remote);
  return structuredClone(remote);
}

export function subscribeStudiesState(listener: Listener): () => void {
  listeners.add(listener);
  listener(loadStudiesState());
  return () => listeners.delete(listener);
}

export function updateStudiesFilters(filters: StudiesFilters): StudiesPersonalState {
  return updateStudiesState({ filters });
}

export function toggleStudySaved(id: string): StudiesPersonalState {
  const state = loadStudiesState();
  const saved = state.saved.includes(id) ? state.saved.filter((entry) => entry !== id) : [...state.saved, id];
  return updateStudiesState({ saved, dismissed: state.dismissed.filter((entry) => entry !== id) });
}

export function toggleStudyDismissed(id: string): StudiesPersonalState {
  const state = loadStudiesState();
  const dismissed = state.dismissed.includes(id)
    ? state.dismissed.filter((entry) => entry !== id)
    : [...state.dismissed, id];
  return updateStudiesState({ dismissed, saved: state.saved.filter((entry) => entry !== id) });
}

export function hasMeaningfulStudiesState(state: StudiesPersonalState): boolean {
  return profileHasAnswers(state.profile)
    || state.saved.length > 0
    || state.dismissed.length > 0
    || JSON.stringify(state.filters) !== JSON.stringify(DEFAULT_STUDIES_FILTERS);
}

export function __resetStudiesStateForTests(): void {
  cache = null;
  observedStamp = 0;
}
