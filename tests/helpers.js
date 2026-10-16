import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, resolveVault } from '../src/storage.js';
import { applyProposal, createProposal } from '../src/knowledge.js';
export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-test-'));
  init(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, vault: resolveVault(root).dir };
}
export const item = (overrides = {}) => ({ title: '同步架构', project: 'Alpha', content: '服务端负责最终状态同步。', tags: ['sync'], aliases: ['server sync'], related: [], ...overrides });
export function add(vault, entries) {
  const p = createProposal(vault, { items: entries });
  return { proposal: p, receipt: applyProposal(vault, p.id, p.revision, entries.map((_, i) => i + 1)) };
}
