import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('CLI initializes once, supports add/update/query from an unrelated cwd and error envelopes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/akm.js', import.meta.url));
  const run = args => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: os.tmpdir(), env: { ...process.env, AKM_HOME: root }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).data;
  };
  run(['init']);
  const input = path.join(root, 'input.json');
  fs.writeFileSync(input, JSON.stringify({ items: [{ title: '缓存', project: 'Alpha', content: '旧缓存 TTL。', tags: ['cache'] }] }));
  const p = run(['proposal', 'create', '--input', input]);
  run(['proposal', 'apply', p.id, '--revision', p.revision, '--items', '1']);
  assert.equal(run(['query', '--query', 'TTL']).results[0].title, '缓存');
  fs.writeFileSync(input, JSON.stringify({ items: [{ action: 'update', target: 'projects/Alpha/缓存.md', title: '缓存', project: 'Alpha', content: '新缓存使用版本控制。', tags: ['cache'] }] }));
  const update = run(['proposal', 'create', '--input', input]);
  run(['proposal', 'apply', update.id, '--revision', update.revision, '--items', '1']);
  assert.equal(run(['query', '--query', '版本控制']).results[0].title, '缓存');
  const error = spawnSync(process.execPath, [cli, 'query', '--query', 'a', '--vault', 'missing', '--root', root, '--json'], { encoding: 'utf8' });
  assert.equal(error.status, 1);
  assert.equal(JSON.parse(error.stderr).error.code, 'ACTIVE_VAULT_ONLY');
});

test('CLI tracks an active vault and exposes domain metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-domain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/akm.js', import.meta.url));
  const run = args => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: os.tmpdir(), env: { ...process.env, AKM_HOME: root }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).data;
  };
  run(['init']);
  run(['vault', 'create', '--name', 'research']);
  assert.equal(run(['status']).vault.name, 'default');
  run(['vault', 'use', 'research']);
  assert.equal(run(['status']).vault.name, 'research');
  const input = path.join(root, 'items.json');
  fs.writeFileSync(input, JSON.stringify({ items: [{ title: '和弦转位', domain: '音乐理论', content: '改变最低音。' }] }));
  const proposal = run(['proposal', 'create', '--input', input]);
  run(['proposal', 'apply', proposal.id, '--revision', proposal.revision, '--items', '1']);
  assert.equal(run(['domain', 'show', '--name', '音乐理论']).name, '音乐理论');
});
