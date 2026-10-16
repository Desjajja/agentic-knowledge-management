import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVault, init, resolveVault, setActiveVault, activeVaultStatus } from '../src/storage.js';
import { withTestVault } from '../scripts/test-vault-session.js';

test('test vault session activates test and restores the prior vault on success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-switch-'));
  try {
    init(root, 'default'); createVault(root, 'test');
    const before = activeVaultStatus(root);
    let seen;
    await withTestVault({ root, testVault: 'test' }, async ({ active, vault }) => {
      seen = { name: active.vault.name, vault };
      assert.equal(activeVaultStatus(root).vault.name, 'test');
    });
    assert.equal(seen.name, 'test');
    assert.equal(activeVaultStatus(root).vault.id, before.vault.id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('test vault session restores the prior vault after a failed test', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-switch-'));
  try {
    init(root, 'default'); createVault(root, 'test');
    const before = activeVaultStatus(root);
    await assert.rejects(() => withTestVault({ root }, async () => {
      assert.equal(activeVaultStatus(root).vault.name, 'test');
      throw new Error('simulated model failure');
    }), /simulated model failure/);
    assert.equal(activeVaultStatus(root).vault.id, before.vault.id);
    assert.equal(resolveVault(root, 'default').manifest.name, 'default');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
