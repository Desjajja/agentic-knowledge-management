import fs from 'node:fs';
import path from 'node:path';
import { activeVaultStatus, atomicWrite, check, createVault, importVault, resolveVault, setActiveVault } from '../src/storage.js';

/**
 * Run a test against a named Vault and always restore the previous active Vault.
 *
 * The helper deliberately snapshots only workspace selection. Test data lives
 * in the supplied AKM root; callers can use a temporary root to guarantee that
 * production pages are never touched.
 */
export async function withTestVault({ root, testVault = 'test', workspace, sourcePath }, fn) {
  const before = activeVaultStatus(root, workspace);
  const configFile = path.join(root, 'config.json');
  const configBefore = fs.readFileSync(configFile);
  let test = vaultByName(root, testVault);
  let created = false;
  if (!test) {
    if (sourcePath) {
      importVault(root, sourcePath, testVault);
    } else {
      createVault(root, testVault);
    }
    test = vaultByName(root, testVault);
    created = true;
  }
  setActiveVault(root, test.manifest.id, workspace);
  const selected = activeVaultStatus(root, workspace);
  check(selected.vault.name === testVault, `Test Vault was not activated: ${testVault}`, 'TEST_VAULT_NOT_ACTIVE');
  try {
    return await fn({ before, active: selected, root, vault: resolveVault(root, selected.vault.id, workspace).dir });
  } finally {
    // Restoration is intentionally in finally so model failures, tool errors,
    // timeouts and assertion failures cannot leave the user's Vault selected.
    setActiveVault(root, before.vault.id, workspace);
    const restored = activeVaultStatus(root, workspace);
    check(restored.vault.id === before.vault.id, 'Active Vault restoration failed', 'ACTIVE_VAULT_RESTORE_FAILED');
    if (created) {
      const dir = path.join(root, 'vaults', testVault);
      // Only remove a Vault created by this invocation. Existing test data is
      // never deleted by the harness.
      fs.rmSync(dir, { recursive: true, force: true });
      // importVault updates config.defaultVault; restore the complete config
      // snapshot so a temporary test import cannot change future selection.
      atomicWrite(configFile, configBefore);
    }
  }
}

function vaultByName(root, name) {
  try {
    const resolved = resolveVault(root, name);
    return { manifest: resolved.manifest };
  } catch (error) {
    if (error.code === 'VAULT_NOT_FOUND') return null;
    throw error;
  }
}
