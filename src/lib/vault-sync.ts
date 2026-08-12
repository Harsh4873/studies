import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, onSnapshot, setDoc, type Unsubscribe } from 'firebase/firestore';
import { authPersistenceReady, firebaseAuth, googleProvider, ownerFirestore } from '../firebase';
import { resolveOwnerVault } from '../owner-vault';
import {
  applyRemoteStudiesState,
  hasMeaningfulStudiesState,
  loadStudiesState,
  parseStudiesState,
  subscribeStudiesState,
  type StudiesPersonalState,
} from './personal-state';

export type VaultSyncStatus =
  | { state: 'connecting' }
  | { state: 'signed-out' }
  | { state: 'syncing'; email?: string }
  | { state: 'synced'; email?: string }
  | { state: 'error'; message: string; email?: string };

type StatusListener = (status: VaultSyncStatus) => void;
const listeners = new Set<StatusListener>();
let currentStatus: VaultSyncStatus = { state: 'connecting' };
let started = false;

function publish(status: VaultSyncStatus): void {
  currentStatus = status;
  for (const listener of [...listeners]) listener(status);
}

function compareState(a: StudiesPersonalState, b: StudiesPersonalState): number {
  if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs - b.updatedAtMs;
  return a.clientId.localeCompare(b.clientId);
}

export function subscribeVaultStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  listener(currentStatus);
  return () => listeners.delete(listener);
}

export function startStudiesVaultSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  let authRevision = 0;
  let stopSnapshot: Unsubscribe | null = null;
  let stopState: (() => void) | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let vaultReady = false;
  let applyingRemote = false;
  let activeVault: string | null = null;

  const teardown = () => {
    stopSnapshot?.();
    stopSnapshot = null;
    stopState?.();
    stopState = null;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
    vaultReady = false;
    activeVault = null;
  };

  const scheduleWrite = (state: StudiesPersonalState, email: string | undefined) => {
    if (!vaultReady || !activeVault || applyingRemote) return;
    if (writeTimer) clearTimeout(writeTimer);
    const targetVault = activeVault;
    const payload = structuredClone(state);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      publish({ state: 'syncing', ...(email ? { email } : {}) });
      void setDoc(doc(ownerFirestore, 'studies_vaults', targetVault), payload).then(() => {
        if (activeVault === targetVault) publish({ state: 'synced', ...(email ? { email } : {}) });
      }).catch((error: unknown) => {
        if (activeVault !== targetVault) return;
        publish({
          state: 'error',
          message: error instanceof Error ? error.message : 'Studies could not save to the owner vault.',
          ...(email ? { email } : {}),
        });
      });
    }, 500);
  };

  void authPersistenceReady.catch(() => undefined).then(() => {
    onAuthStateChanged(firebaseAuth, (user) => {
      const revision = ++authRevision;
      teardown();
      if (!user) {
        publish({ state: 'signed-out' });
        return;
      }
      const email = user.email ?? undefined;
      publish({ state: 'syncing', ...(email ? { email } : {}) });

      void resolveOwnerVault(ownerFirestore, user).then((membership) => {
        if (revision !== authRevision || firebaseAuth.currentUser !== user) return;
        activeVault = membership.vaultId;
        const reference = doc(ownerFirestore, 'studies_vaults', membership.vaultId);
        stopState = subscribeStudiesState((state) => scheduleWrite(state, email));
        stopSnapshot = onSnapshot(reference, (snapshot) => {
          if (revision !== authRevision || activeVault !== membership.vaultId) return;
          const local = loadStudiesState();
          const remote = snapshot.exists() ? parseStudiesState(snapshot.data()) : null;
          vaultReady = true;
          if (!remote) {
            if (hasMeaningfulStudiesState(local)) scheduleWrite(local, email);
            else publish({ state: 'synced', ...(email ? { email } : {}) });
            return;
          }
          if (compareState(local, remote) > 0) {
            scheduleWrite(local, email);
            return;
          }
          applyingRemote = true;
          try {
            applyRemoteStudiesState(remote);
          } finally {
            applyingRemote = false;
          }
          publish({ state: 'synced', ...(email ? { email } : {}) });
        }, (error) => {
          if (revision !== authRevision) return;
          publish({ state: 'error', message: error.message, ...(email ? { email } : {}) });
        });
      }).catch((error: unknown) => {
        if (revision !== authRevision) return;
        publish({
          state: 'error',
          message: error instanceof Error ? error.message : 'This account cannot access the owner vault.',
          ...(email ? { email } : {}),
        });
      });
    });
  });
}

export async function signInToStudiesVault(): Promise<void> {
  await authPersistenceReady;
  await signInWithPopup(firebaseAuth, googleProvider);
}

export async function signOutOfStudiesVault(): Promise<void> {
  await signOut(firebaseAuth);
}
