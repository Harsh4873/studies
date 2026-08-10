/**
 * LOCAL-ONLY user profile storage.
 *
 * ============================================================================
 * PRIVACY CONTRACT - read this before touching anything in here.
 * ============================================================================
 * The values in a `UserProfile` are self-reported health facts: pregnancy,
 * seizure history, cardiovascular disease, MRI implant status. This module is
 * the ONLY place they are ever written, and the only place they are ever
 * written TO is `window.localStorage` on the user's own machine.
 *
 *   - There is no `fetch`, no `navigator.sendBeacon`, no `<img>` ping, no
 *     analytics call, and no query-string round trip anywhere in this file,
 *     and there must never be one.
 *   - The site is a static build (`output: 'static'`), so there is no server
 *     to receive the data even if someone tried.
 *   - The one place profile data leaves the browser is a `mailto:` body the
 *     user explicitly composes and explicitly sends from their own mail
 *     client - see `src/lib/mailto.ts`. That is a user action, not a
 *     transmission by this site.
 *
 * ============================================================================
 * SSR CONTRACT
 * ============================================================================
 * Astro imports this file during the static build, in Node, where `window`
 * and `localStorage` do not exist. Every storage access is therefore guarded.
 * On the server every read yields `EMPTY_PROFILE` (all-null) and every write
 * is a no-op that still notifies subscribers, so component code can call these
 * functions unconditionally without `typeof window` checks of its own.
 *
 * The guard is a try/catch, not just a `typeof` check: Safari in Lockdown /
 * private mode and Chrome with third-party storage blocked both *have* a
 * `localStorage` object that throws `SecurityError` on access. A crash there
 * would take the whole page's client script down.
 *
 * ============================================================================
 * NULL SEMANTICS
 * ============================================================================
 * `null` means "not answered", never "no". `src/lib/parse-eligibility.ts`
 * turns unanswered criteria into an `'unknown'` verdict rather than an
 * `'ineligible'` one, which is what makes filtering conservative instead of
 * silently hiding studies the user would qualify for. Anything in this file
 * that coerces a missing value to `false` is a bug.
 */

import type { Sex, UserProfile } from '@/types.ts';

// ---------------------------------------------------------------------------
// Storage key + versioning
// ---------------------------------------------------------------------------

/**
 * Storage key. Namespaced so it cannot collide with anything else served from
 * the same origin (the site lives at harsh.bet/r/studies/, and localStorage is
 * scoped per-origin, NOT per-path - a sibling app at harsh.bet/r/other/ shares
 * this bucket).
 */
export const PROFILE_STORAGE_KEY = 'harsh.bet/r/studies:profile';

/**
 * Schema version of the stored envelope.
 *
 * Bump this whenever a field is added, removed, or changes meaning, and add a
 * step to `MIGRATIONS`. Never reuse a version number.
 *
 *   v1 - bare `UserProfile` object stored at the key with no envelope.
 *   v2 - `{ v: 2, savedAt: ISO, profile: UserProfile }` envelope. Current.
 */
export const PROFILE_SCHEMA_VERSION = 2;

/** Legacy keys checked once on first read, then migrated and deleted. */
const LEGACY_KEYS = ['studies:profile', 'tamu-studies-profile'] as const;

/** The all-unanswered profile. Frozen: callers get copies, never this object. */
export const EMPTY_PROFILE: Readonly<UserProfile> = Object.freeze({
  age: null,
  rightHanded: null,
  mriSafe: null,
  hasCardiovascularCondition: null,
  isPregnant: null,
  hasSeizureHistory: null,
  sex: null,
  willingToFast: null,
  isTamuStudent: null,
});

/** Every key of `UserProfile`, so unknown keys in stored JSON get dropped. */
export const PROFILE_FIELDS = Object.keys(EMPTY_PROFILE) as (keyof UserProfile)[];

/**
 * Plausible human ages. A stored 900 or -3 is corruption or someone poking at
 * devtools; treat it as unanswered rather than feeding it to the age
 * comparison, where it would produce confident nonsense.
 */
export const MIN_PLAUSIBLE_AGE = 0;
export const MAX_PLAUSIBLE_AGE = 120;

const SEX_VALUES: readonly Sex[] = ['male', 'female', 'other'];

// ---------------------------------------------------------------------------
// Storage access (all guarded)
// ---------------------------------------------------------------------------

/**
 * The live `Storage` object, or null when unavailable.
 *
 * Unavailable covers: server-side rendering, Safari private mode, and any
 * browser configured to block storage for this origin. Never throws.
 */
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    if (!s) return null;
    // Touch it - merely reading `window.localStorage` does not always throw;
    // some engines defer the SecurityError to first use.
    const probe = '__probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** True when profile data can actually be persisted in this environment. */
export function hasStorage(): boolean {
  return storage() !== null;
}

// ---------------------------------------------------------------------------
// Validation / coercion
// ---------------------------------------------------------------------------

/** Anything that is not a real boolean becomes null ("not answered"). */
function asTristate(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  // v1 wrote radio values straight through in one build; accept those strings.
  if (value === 'true' || value === 'yes') return true;
  if (value === 'false' || value === 'no') return false;
  return null;
}

/** Integer age inside the plausible range, else null. */
function asAge(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < MIN_PLAUSIBLE_AGE || rounded > MAX_PLAUSIBLE_AGE) return null;
  return rounded;
}

function asSex(value: unknown): Sex | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return (SEX_VALUES as readonly string[]).includes(v) ? (v as Sex) : null;
}

/**
 * Coerce arbitrary parsed JSON into a valid `UserProfile`.
 *
 * Total and non-throwing: garbage in yields `EMPTY_PROFILE`, partial input
 * yields the recognised fields with the rest null. Exported because this is
 * the single point where untrusted persisted data enters the type system, and
 * it is worth testing directly.
 */
export function sanitizeProfile(value: unknown): UserProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_PROFILE };
  }
  const src = value as Record<string, unknown>;
  return {
    age: asAge(src['age']),
    rightHanded: asTristate(src['rightHanded']),
    mriSafe: asTristate(src['mriSafe']),
    hasCardiovascularCondition: asTristate(src['hasCardiovascularCondition']),
    isPregnant: asTristate(src['isPregnant']),
    hasSeizureHistory: asTristate(src['hasSeizureHistory']),
    sex: asSex(src['sex']),
    willingToFast: asTristate(src['willingToFast']),
    isTamuStudent: asTristate(src['isTamuStudent']),
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

interface ProfileEnvelope {
  v: number;
  savedAt: string;
  profile: UserProfile;
}

/**
 * Upgrade a stored payload of any known vintage to the current shape.
 *
 * Steps run in order from the detected version to `PROFILE_SCHEMA_VERSION`, so
 * a v1 payload written a year ago walks through every intermediate step rather
 * than being thrown away. Adding a field only needs a new entry here; because
 * `sanitizeProfile` defaults unknown fields to null, a field added in v3 will
 * correctly read as "not answered" for someone upgrading from v2.
 */
const MIGRATIONS: Record<number, (data: unknown) => unknown> = {
  // v1 stored the bare profile object. Wrap it; field names did not change.
  1: (data) => ({ v: 2, savedAt: new Date(0).toISOString(), profile: data }),
};

function migrate(raw: unknown): UserProfile | null {
  let current = raw;

  for (let guard = 0; guard < 16; guard += 1) {
    if (current === null || typeof current !== 'object') return null;
    const obj = current as Record<string, unknown>;

    // An object with no `v` and no `profile` is a v1 bare profile.
    const version =
      typeof obj['v'] === 'number' ? obj['v'] : 'profile' in obj ? PROFILE_SCHEMA_VERSION : 1;

    if (version >= PROFILE_SCHEMA_VERSION) {
      return sanitizeProfile('profile' in obj ? obj['profile'] : obj);
    }

    const step = MIGRATIONS[version];
    // Unknown old version with no migration path: discard rather than guess.
    if (!step) return null;
    current = step(current);
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-memory cache + subscribers
// ---------------------------------------------------------------------------

type Listener = (profile: UserProfile) => void;

const listeners = new Set<Listener>();

/** null = not yet read from storage this page-load. */
let cache: UserProfile | null = null;

function readFromStorage(): UserProfile {
  const s = storage();
  if (!s) return { ...EMPTY_PROFILE };

  let text: string | null = null;
  try {
    text = s.getItem(PROFILE_STORAGE_KEY);
  } catch {
    return { ...EMPTY_PROFILE };
  }

  // Nothing under the current key - look for a legacy key and adopt it.
  if (text === null) {
    for (const key of LEGACY_KEYS) {
      try {
        const legacy = s.getItem(key);
        if (legacy !== null) {
          text = legacy;
          s.removeItem(key);
          break;
        }
      } catch {
        /* ignore an unreadable legacy key */
      }
    }
  }

  if (text === null) return { ...EMPTY_PROFILE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Corrupt JSON. Drop it - a half-read health profile is worse than none.
    try {
      s.removeItem(PROFILE_STORAGE_KEY);
    } catch {
      /* nothing else to do */
    }
    return { ...EMPTY_PROFILE };
  }

  const migrated = migrate(parsed);
  if (migrated === null) return { ...EMPTY_PROFILE };
  return migrated;
}

function writeToStorage(profile: UserProfile): void {
  const s = storage();
  if (!s) return;
  const envelope: ProfileEnvelope = {
    v: PROFILE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    profile,
  };
  try {
    s.setItem(PROFILE_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota exhausted or storage blocked mid-session. The in-memory cache is
    // still correct for this page, so the UI keeps working; it just will not
    // survive a reload. Silent by design - there is nothing the user can act
    // on, and this must never throw into a change handler.
  }
}

function notify(profile: UserProfile): void {
  for (const fn of [...listeners]) {
    try {
      fn({ ...profile });
    } catch (err) {
      // One bad subscriber must not stop the others from updating.
      console.error('[profile] subscriber threw:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The current profile.
 *
 * Always returns a fresh object, so callers cannot mutate shared state by
 * accident. On the server, or when storage is unavailable, returns the
 * all-null `EMPTY_PROFILE`, which means every eligibility check comes back
 * `'unknown'` - the correct conservative default for a static prerender.
 */
export function getProfile(): UserProfile {
  if (cache === null) cache = readFromStorage();
  return { ...cache };
}

/**
 * Merge a partial update into the stored profile and return the result.
 *
 * Only keys present in `patch` are touched, so a form field can be written in
 * isolation. Pass an explicit `null` to un-answer a field; omitting the key
 * leaves it alone. Values are sanitized on the way in, so an out-of-range age
 * from a number input lands as `null` rather than as bad data.
 */
export function setProfile(patch: Partial<UserProfile>): UserProfile {
  const base = getProfile();
  const merged: Record<string, unknown> = { ...base };

  for (const field of PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      merged[field] = patch[field];
    }
  }

  const next = sanitizeProfile(merged);
  cache = next;
  writeToStorage(next);
  notify(next);
  return { ...next };
}

/**
 * Forget everything. Removes the stored record outright rather than writing an
 * all-null one, so "clear" really does leave nothing behind on the machine.
 */
export function clearProfile(): void {
  const s = storage();
  if (s) {
    try {
      s.removeItem(PROFILE_STORAGE_KEY);
      for (const key of LEGACY_KEYS) s.removeItem(key);
    } catch {
      /* already gone or unreadable */
    }
  }
  cache = { ...EMPTY_PROFILE };
  notify(cache);
}

/**
 * Observe profile changes. Returns an unsubscribe function.
 *
 * The callback fires immediately with the current value so subscribers do not
 * need a separate initial read, and again on every `setProfile`/`clearProfile`
 * - including ones made in another tab, via the `storage` event. Cross-tab
 * matters here: someone editing their profile in one tab and reading a study
 * page in another should not see two different eligibility verdicts.
 *
 * No-op on the server: it registers the listener, calls it once with
 * `EMPTY_PROFILE`, and returns a working unsubscribe.
 */
export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  ensureCrossTabListener();
  try {
    cb(getProfile());
  } catch (err) {
    console.error('[profile] subscriber threw on initial call:', err);
  }
  return () => {
    listeners.delete(cb);
  };
}

let crossTabWired = false;

function ensureCrossTabListener(): void {
  if (crossTabWired || typeof window === 'undefined') return;
  crossTabWired = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== PROFILE_STORAGE_KEY) return;
    // `event.key === null` means the whole store was cleared.
    cache = readFromStorage();
    notify(cache);
  });
}

// ---------------------------------------------------------------------------
// Small helpers used by the UI
// ---------------------------------------------------------------------------

/** True when nothing has been answered. */
export function isProfileEmpty(profile: UserProfile = getProfile()): boolean {
  return PROFILE_FIELDS.every((f) => profile[f] === null);
}

/** How many of the nine questions have an answer. Drives the panel summary. */
export function answeredCount(profile: UserProfile = getProfile()): number {
  return PROFILE_FIELDS.filter((f) => profile[f] !== null).length;
}

/** Total number of questions, so the UI does not hardcode "9". */
export const PROFILE_FIELD_COUNT = PROFILE_FIELDS.length;

/**
 * Reset the module cache. Test-only seam - lets a test simulate a fresh page
 * load after poking at localStorage directly. Not used by the site.
 */
export function __resetProfileCacheForTests(): void {
  cache = null;
}
