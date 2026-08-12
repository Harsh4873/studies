import { describe, expect, it } from 'vitest';
import {
  OWNER_VAULT_APP_NAME,
  adoptSharedAuthSession,
  parseOwnerVaultMembership,
} from '../src/owner-vault';

describe('owner vault contract', () => {
  it('accepts only an active versioned membership with a safe vault id', () => {
    expect(parseOwnerVaultMembership({
      vaultId: 'vault_1234567890',
      schemaVersion: 1,
      status: 'active',
    })).toEqual({ vaultId: 'vault_1234567890', schemaVersion: 1, status: 'active' });
    expect(parseOwnerVaultMembership({
      vaultId: 'vault_1234567890',
      schemaVersion: 1,
      status: 'migrating',
    })).toBeNull();
    expect(parseOwnerVaultMembership({
      vaultId: '../private',
      schemaVersion: 1,
      status: 'active',
    })).toBeNull();
  });

  it('copies the first legacy session without deleting it', () => {
    const values = new Map<string, string>();
    const prefix = 'firebase:authUser:test-key';
    values.set(`${prefix}:legacy-app`, 'legacy-session');
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    adoptSharedAuthSession('test-key', ['missing', 'legacy-app'], storage);

    expect(values.get(`${prefix}:${OWNER_VAULT_APP_NAME}`)).toBe('legacy-session');
    expect(values.get(`${prefix}:legacy-app`)).toBe('legacy-session');
  });

  it('never overwrites an existing shared session', () => {
    const values = new Map<string, string>();
    const prefix = 'firebase:authUser:test-key';
    values.set(`${prefix}:${OWNER_VAULT_APP_NAME}`, 'shared-session');
    values.set(`${prefix}:legacy-app`, 'legacy-session');
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    adoptSharedAuthSession('test-key', ['legacy-app'], storage);

    expect(values.get(`${prefix}:${OWNER_VAULT_APP_NAME}`)).toBe('shared-session');
  });
});
