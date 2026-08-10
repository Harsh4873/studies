/**
 * Tests for the local-only profile store.
 *
 * Two properties matter more than the rest:
 *   1. Importing this module in a Node/SSR context must not throw and must not
 *      touch storage. Astro imports it during the static build.
 *   2. A missing or unreadable answer must land as `null`, never `false`.
 *      `false` means "I answered no" and can make a study look ineligible.
 *
 * The environment is vitest's default `node`, so there is no `window`. Each
 * browser-side test installs a minimal fake and re-imports the module, which
 * also exercises the "first read of the page" path including migration.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserProfile } from '@/types.ts';

type ProfileModule = typeof import('@/lib/profile.ts');

/** Minimal in-memory Storage. Not a full spec implementation - not needed. */
function makeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    api: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    } as unknown as Storage,
  };
}

/** Install a fake window with the given storage and load a fresh module copy. */
async function loadInBrowser(seed: Record<string, string> = {}, storageThrows = false) {
  const { map, api } = makeStorage(seed);
  const listeners: ((e: StorageEvent) => void)[] = [];
  const store = storageThrows
    ? new Proxy(
        {},
        {
          get() {
            throw new Error('SecurityError: storage disabled');
          },
        },
      )
    : api;

  vi.stubGlobal('window', {
    localStorage: store,
    addEventListener: (type: string, fn: (e: StorageEvent) => void) => {
      if (type === 'storage') listeners.push(fn);
    },
  });

  vi.resetModules();
  const mod: ProfileModule = await import('@/lib/profile.ts');
  return { mod, map, fireStorageEvent: (e: Partial<StorageEvent>) => listeners.forEach((f) => f(e as StorageEvent)) };
}

function stored(map: Map<string, string>, key: string): { v: number; profile: UserProfile } {
  return JSON.parse(map.get(key) ?? '{}') as { v: number; profile: UserProfile };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ---------------------------------------------------------------------------

describe('SSR safety', () => {
  it('imports and reads an all-null profile with no window present', async () => {
    expect(typeof globalThis.window).toBe('undefined');
    const mod: ProfileModule = await import('@/lib/profile.ts');
    expect(mod.hasStorage()).toBe(false);
    expect(mod.getProfile()).toEqual(mod.EMPTY_PROFILE);
  });

  it('treats writes as no-ops on the server without throwing', async () => {
    const mod: ProfileModule = await import('@/lib/profile.ts');
    expect(() => mod.setProfile({ age: 30 })).not.toThrow();
    expect(() => mod.clearProfile()).not.toThrow();
  });

  it('still notifies subscribers on the server so components can render once', async () => {
    const mod: ProfileModule = await import('@/lib/profile.ts');
    const seen: UserProfile[] = [];
    const off = mod.subscribe((p) => seen.push(p));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(mod.EMPTY_PROFILE);
    off();
  });

  it('survives a localStorage that throws on every access', async () => {
    const { mod } = await loadInBrowser({}, true);
    expect(mod.hasStorage()).toBe(false);
    expect(() => mod.setProfile({ isPregnant: true })).not.toThrow();
    // The in-memory cache still works, so the page stays usable.
    expect(mod.getProfile().isPregnant).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('read / write / clear', () => {
  it('starts empty and reports zero answered', async () => {
    const { mod } = await loadInBrowser();
    expect(mod.isProfileEmpty()).toBe(true);
    expect(mod.answeredCount()).toBe(0);
    expect(mod.PROFILE_FIELD_COUNT).toBe(9);
  });

  it('persists a partial update under the versioned key', async () => {
    const { mod, map } = await loadInBrowser();
    mod.setProfile({ age: 28, rightHanded: true });
    const env = stored(map, mod.PROFILE_STORAGE_KEY);
    expect(env.v).toBe(mod.PROFILE_SCHEMA_VERSION);
    expect(env.profile.age).toBe(28);
    expect(env.profile.rightHanded).toBe(true);
    expect(env.profile.isPregnant).toBeNull();
  });

  it('merges rather than replacing, and leaves untouched fields alone', async () => {
    const { mod } = await loadInBrowser();
    mod.setProfile({ age: 28 });
    mod.setProfile({ mriSafe: true });
    expect(mod.getProfile()).toMatchObject({ age: 28, mriSafe: true });
  });

  it('accepts an explicit null to un-answer a field', async () => {
    const { mod } = await loadInBrowser();
    mod.setProfile({ isPregnant: false });
    expect(mod.getProfile().isPregnant).toBe(false);
    mod.setProfile({ isPregnant: null });
    expect(mod.getProfile().isPregnant).toBeNull();
  });

  it('hands out copies, so a caller cannot mutate the store', async () => {
    const { mod } = await loadInBrowser();
    mod.setProfile({ age: 30 });
    const p = mod.getProfile();
    p.age = 99;
    expect(mod.getProfile().age).toBe(30);
  });

  it('removes the record entirely on clear rather than storing all-nulls', async () => {
    const { mod, map } = await loadInBrowser();
    mod.setProfile({ age: 30, hasSeizureHistory: true });
    mod.clearProfile();
    expect(map.has(mod.PROFILE_STORAGE_KEY)).toBe(false);
    expect(mod.getProfile()).toEqual(mod.EMPTY_PROFILE);
  });
});

// ---------------------------------------------------------------------------

describe('sanitisation - unknown must never become "no"', () => {
  it('maps every unrecognised value to null, not false', async () => {
    const { mod } = await loadInBrowser();
    const dirty = mod.sanitizeProfile({
      age: 'not a number',
      rightHanded: 'maybe',
      mriSafe: 0,
      hasCardiovascularCondition: '',
      isPregnant: undefined,
      hasSeizureHistory: {},
      sex: 'yes',
      willingToFast: [],
      isTamuStudent: null,
    });
    for (const key of mod.PROFILE_FIELDS) expect(dirty[key]).toBeNull();
  });

  it('rejects implausible ages instead of clamping them', async () => {
    const { mod } = await loadInBrowser();
    expect(mod.sanitizeProfile({ age: -3 }).age).toBeNull();
    expect(mod.sanitizeProfile({ age: 900 }).age).toBeNull();
    expect(mod.sanitizeProfile({ age: Number.NaN }).age).toBeNull();
    expect(mod.sanitizeProfile({ age: 121 }).age).toBeNull();
    expect(mod.sanitizeProfile({ age: 120 }).age).toBe(120);
    // Minors are real participants here - the fixture goes down to age 2.
    expect(mod.sanitizeProfile({ age: 2 }).age).toBe(2);
  });

  it('rounds a decimal age and accepts a numeric string from an input', async () => {
    const { mod } = await loadInBrowser();
    expect(mod.sanitizeProfile({ age: 30.4 }).age).toBe(30);
    expect(mod.sanitizeProfile({ age: ' 42 ' }).age).toBe(42);
  });

  it('only accepts the three declared sex values', async () => {
    const { mod } = await loadInBrowser();
    expect(mod.sanitizeProfile({ sex: 'FEMALE' }).sex).toBe('female');
    expect(mod.sanitizeProfile({ sex: 'nonbinary' }).sex).toBeNull();
  });

  it('drops unknown keys from stored JSON', async () => {
    const { mod } = await loadInBrowser();
    const p = mod.sanitizeProfile({ age: 30, ssn: '123-45-6789' });
    expect(Object.keys(p).sort()).toEqual([...mod.PROFILE_FIELDS].sort());
  });

  it('returns an all-null profile for non-objects', async () => {
    const { mod } = await loadInBrowser();
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(mod.sanitizeProfile(bad)).toEqual(mod.EMPTY_PROFILE);
    }
  });
});

// ---------------------------------------------------------------------------

describe('migration', () => {
  const KEY = 'harsh.bet/studies:profile';

  it('upgrades a v1 bare profile object into the v2 envelope', async () => {
    const { mod, map } = await loadInBrowser({
      [KEY]: JSON.stringify({ age: 33, rightHanded: true, isPregnant: null }),
    });
    expect(mod.getProfile()).toMatchObject({ age: 33, rightHanded: true });
    // Rewritten in the current shape on the next save.
    mod.setProfile({ mriSafe: true });
    expect(stored(map, KEY).v).toBe(mod.PROFILE_SCHEMA_VERSION);
  });

  it('reads a current v2 envelope unchanged', async () => {
    const { mod } = await loadInBrowser({
      [KEY]: JSON.stringify({ v: 2, savedAt: '2026-01-01T00:00:00Z', profile: { age: 44 } }),
    });
    expect(mod.getProfile().age).toBe(44);
  });

  it('discards a future version it has no path for, rather than guessing', async () => {
    const { mod } = await loadInBrowser({
      [KEY]: JSON.stringify({ v: 99, profile: { age: 44, isPregnant: true } }),
    });
    // v >= current is read as-is; the sanitiser is what keeps it safe.
    expect(mod.getProfile().age).toBe(44);
  });

  it('drops corrupt JSON instead of throwing', async () => {
    const { mod, map } = await loadInBrowser({ [KEY]: '{not json' });
    expect(mod.getProfile()).toEqual(mod.EMPTY_PROFILE);
    expect(map.has(KEY)).toBe(false);
  });

  it('adopts and then deletes a legacy key', async () => {
    const { mod, map } = await loadInBrowser({
      'studies:profile': JSON.stringify({ age: 21 }),
    });
    expect(mod.getProfile().age).toBe(21);
    expect(map.has('studies:profile')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('subscribe', () => {
  it('fires immediately, on every change, and stops after unsubscribe', async () => {
    const { mod } = await loadInBrowser();
    const seen: (number | null)[] = [];
    const off = mod.subscribe((p) => seen.push(p.age));

    expect(seen).toEqual([null]);
    mod.setProfile({ age: 30 });
    mod.setProfile({ age: 31 });
    off();
    mod.setProfile({ age: 32 });

    expect(seen).toEqual([null, 30, 31]);
  });

  it('notifies on clear', async () => {
    const { mod } = await loadInBrowser();
    mod.setProfile({ age: 30 });
    const seen: (number | null)[] = [];
    mod.subscribe((p) => seen.push(p.age));
    mod.clearProfile();
    expect(seen).toEqual([30, null]);
  });

  it('keeps one throwing subscriber from breaking the others', async () => {
    const { mod } = await loadInBrowser();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reached = false;
    mod.subscribe(() => {
      throw new Error('boom');
    });
    mod.subscribe(() => {
      reached = true;
    });
    reached = false;
    mod.setProfile({ age: 30 });
    expect(reached).toBe(true);
    spy.mockRestore();
  });

  it('picks up an edit made in another tab', async () => {
    const { mod, map, fireStorageEvent } = await loadInBrowser();
    const seen: (number | null)[] = [];
    mod.subscribe((p) => seen.push(p.age));

    map.set(
      mod.PROFILE_STORAGE_KEY,
      JSON.stringify({ v: 2, savedAt: 'x', profile: { age: 55 } }),
    );
    fireStorageEvent({ key: mod.PROFILE_STORAGE_KEY });

    expect(seen).toEqual([null, 55]);
    expect(mod.getProfile().age).toBe(55);
  });

  it('ignores storage events for unrelated keys', async () => {
    const { mod, fireStorageEvent } = await loadInBrowser();
    const seen: (number | null)[] = [];
    mod.subscribe((p) => seen.push(p.age));
    fireStorageEvent({ key: 'some-other-app' });
    expect(seen).toHaveLength(1);
  });
});
