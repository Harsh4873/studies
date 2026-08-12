import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetProfileCacheForTests } from './profile';
import {
  DEFAULT_STUDIES_FILTERS,
  STUDIES_STATE_KEY,
  __resetStudiesStateForTests,
  applyRemoteStudiesState,
  loadStudiesState,
  parseStudiesState,
  updateStudiesFilters,
} from './personal-state';

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

function profile(age: number | null = null) {
  return {
    age,
    rightHanded: null,
    mriSafe: null,
    hasCardiovascularCondition: null,
    isPregnant: null,
    hasSeizureHistory: null,
    sex: null,
    willingToFast: null,
    isTamuStudent: null,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  installStorage();
  __resetProfileCacheForTests();
  __resetStudiesStateForTests();
});

describe('Studies personal state', () => {
  it('starts as an unstamped empty browser and cannot outrank cloud state', () => {
    const state = loadStudiesState();
    expect(state.updatedAtMs).toBe(0);
    expect(state.profile).toEqual(profile());
    expect(state.saved).toEqual([]);
    expect(state.dismissed).toEqual([]);
    expect(state.filters).toEqual(DEFAULT_STUDIES_FILTERS);
  });

  it('persists every filter with a monotonic content stamp', () => {
    const before = loadStudiesState();
    const filters = {
      ...DEFAULT_STUDIES_FILTERS,
      query: 'MRI',
      minRate: '25',
      tags: ['mri'],
      eligibleOnly: true,
      showDismissed: true,
    };
    const next = updateStudiesFilters(filters);
    expect(next.updatedAtMs).toBeGreaterThan(before.updatedAtMs);
    expect(next.filters).toEqual(filters);
    expect(JSON.parse(localStorage.getItem(STUDIES_STATE_KEY) ?? '{}').filters).toEqual(filters);
  });

  it('adopts a newer complete remote record and rejects an older one', () => {
    const newer = {
      schemaVersion: 1,
      profile: profile(27),
      saved: ['study-1'],
      dismissed: ['study-2'],
      filters: { ...DEFAULT_STUDIES_FILTERS, query: 'sleep' },
      updatedAtMs: 500,
      clientId: 'remote-browser',
    } as const;
    expect(applyRemoteStudiesState(newer)).toMatchObject({ updatedAtMs: 500, saved: ['study-1'] });

    const older = { ...newer, saved: ['wrong'], updatedAtMs: 499 };
    expect(applyRemoteStudiesState(older)?.saved).toEqual(['study-1']);
    expect(loadStudiesState().profile.age).toBe(27);
  });

  it('fails closed on malformed cloud records', () => {
    expect(parseStudiesState({ schemaVersion: 1, updatedAtMs: 'now' })).toBeNull();
    expect(parseStudiesState({ schemaVersion: 2, updatedAtMs: 1 })).toBeNull();
  });
});
