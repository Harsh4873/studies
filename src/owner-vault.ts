import type { User } from 'firebase/auth';
import { doc, getDoc, type Firestore } from 'firebase/firestore';

export const OWNER_VAULT_APP_NAME = 'harsh-bet-owner-vault-v1';
export const OWNER_VAULT_SCHEMA_VERSION = 1;

export interface OwnerVaultMembership {
  vaultId: string;
  schemaVersion: 1;
  status: 'active';
}

export class OwnerVaultAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerVaultAccessError';
  }
}

export function parseOwnerVaultMembership(value: unknown): OwnerVaultMembership | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== OWNER_VAULT_SCHEMA_VERSION) return null;
  if (candidate.status !== 'active') return null;
  if (typeof candidate.vaultId !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(candidate.vaultId)) {
    return null;
  }
  return {
    vaultId: candidate.vaultId,
    schemaVersion: OWNER_VAULT_SCHEMA_VERSION,
    status: 'active',
  };
}

/**
 * Copy, never move, an existing Firebase Auth session into the shared app
 * namespace. The old record remains a rollback path until the owner confirms
 * every app is reading the shared vault correctly.
 */
export function adoptSharedAuthSession(
  apiKey: string,
  legacyAppNames: readonly string[],
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage === 'undefined'
    ? undefined
    : localStorage,
): void {
  if (!storage) return;
  try {
    const prefix = `firebase:authUser:${apiKey}`;
    const sharedKey = `${prefix}:${OWNER_VAULT_APP_NAME}`;
    if (storage.getItem(sharedKey)) return;
    for (const legacyName of legacyAppNames) {
      const session = storage.getItem(`${prefix}:${legacyName}`);
      if (!session) continue;
      storage.setItem(sharedKey, session);
      return;
    }
  } catch {
    // A browser that blocks persistence simply asks for sign-in again.
  }
}

/** Resolve a verified Google session to its private shared owner vault. */
export async function resolveOwnerVault(
  firestore: Firestore,
  user: User,
): Promise<OwnerVaultMembership> {
  let token;
  try {
    token = await user.getIdTokenResult();
  } catch {
    throw new OwnerVaultAccessError(
      'The shared vault could not verify this Google session. Sign in again with Google.',
    );
  }

  if (
    token.signInProvider !== 'google.com'
    || typeof token.claims.email !== 'string'
    || token.claims.email_verified !== true
  ) {
    throw new OwnerVaultAccessError(
      'The shared vault requires a verified session signed in with Google.',
    );
  }

  const snapshot = await getDoc(doc(firestore, 'owner_vault_members', user.uid));
  const membership = snapshot.exists() ? parseOwnerVaultMembership(snapshot.data()) : null;
  if (!membership) {
    throw new OwnerVaultAccessError(
      'This Google account is not a member of the private harsh.bet owner vault.',
    );
  }
  return membership;
}
