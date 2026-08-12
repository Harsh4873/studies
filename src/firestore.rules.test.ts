import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFile } from 'node:fs/promises';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';

const PROJECT_ID = 'demo-studies-vault';
const PRIMARY_UID = 'owner-primary';
const SECONDARY_UID = 'owner-secondary';
const VAULT_ID = 'owner-vault-123';
const EMULATOR_ADDRESS = process.env.FIRESTORE_EMULATOR_HOST;

function context(environment: RulesTestEnvironment, uid: string) {
  return environment.authenticatedContext(uid, {
    email: `${uid}@example.test`,
    email_verified: true,
    firebase: { sign_in_provider: 'google.com' },
  }).firestore();
}

function validState(updatedAtMs = 1) {
  return {
    schemaVersion: 1,
    profile: {
      age: null,
      rightHanded: null,
      mriSafe: null,
      hasCardiovascularCondition: null,
      isPregnant: null,
      hasSeizureHistory: null,
      sex: null,
      willingToFast: null,
      isTamuStudent: null,
    },
    saved: [],
    dismissed: [],
    filters: {
      query: '',
      minRate: '0',
      minTotal: '0',
      maxHours: '',
      mode: 'any',
      sort: 'rate',
      tags: [],
      eligibleOnly: false,
      showDismissed: false,
    },
    updatedAtMs,
    clientId: 'rules-test',
  };
}

describe.skipIf(!EMULATOR_ADDRESS)('Studies shared owner-vault rules', () => {
  let environment: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, rawPort] = EMULATOR_ADDRESS!.split(':');
    const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
    environment = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host, port: Number(rawPort), rules },
    });
  });

  beforeEach(async () => {
    await environment.withSecurityRulesDisabled(async (admin) => {
      for (const uid of [PRIMARY_UID, SECONDARY_UID]) {
        await setDoc(doc(admin.firestore(), 'owner_vault_members', uid), {
          schemaVersion: 1,
          vaultId: VAULT_ID,
          status: 'active',
          legacyWritesEnabled: false,
        });
      }
    });
  });

  afterEach(async () => environment.clearFirestore());
  afterAll(async () => environment.cleanup());

  it('lets both provisioned accounts read and update the same Studies document', async () => {
    const primary = context(environment, PRIMARY_UID);
    const secondary = context(environment, SECONDARY_UID);
    await assertSucceeds(setDoc(doc(primary, 'studies_vaults', VAULT_ID), validState(10)));
    await assertSucceeds(getDoc(doc(secondary, 'studies_vaults', VAULT_ID)));
    await assertSucceeds(setDoc(doc(secondary, 'studies_vaults', VAULT_ID), validState(11)));
  });

  it('denies an unprovisioned account and timestamp regressions', async () => {
    const primary = context(environment, PRIMARY_UID);
    const stranger = context(environment, 'owner-stranger');
    await assertSucceeds(setDoc(doc(primary, 'studies_vaults', VAULT_ID), validState(10)));
    await assertFails(getDoc(doc(stranger, 'studies_vaults', VAULT_ID)));
    await assertFails(setDoc(doc(primary, 'studies_vaults', VAULT_ID), validState(9)));
  });

  it('keeps frozen legacy data readable but not writable', async () => {
    const primary = context(environment, PRIMARY_UID);
    await environment.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'degree_users', PRIMARY_UID), {
        schemaVersion: 1,
        terms: [],
        updatedAtMs: 1,
        clientId: 'legacy',
      });
    });
    await assertSucceeds(getDoc(doc(primary, 'degree_users', PRIMARY_UID)));
    await assertFails(setDoc(doc(primary, 'degree_users', PRIMARY_UID), {
      schemaVersion: 1,
      terms: [],
      updatedAtMs: 2,
      clientId: 'legacy',
    }));
  });
});
