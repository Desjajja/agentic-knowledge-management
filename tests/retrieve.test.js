import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { retrieve, rank, tokenize } from '../src/retrieve.js';
import { safe, rootDir, resolveVault } from '../src/storage.js';
import { add, fixture, item } from './helpers.js';
import { withLock } from '../src/transaction.js';

test('Chinese content, aliases, tags, project filter and line citations', t => {
  const { vault } = fixture(t);
  add(vault, [item({ aliases: ['offline recovery'], tags: ['distributed-systems'] }), item({ project: 'Beta', title: '消息可靠性', content: '消费者按事件 ID 实现幂等消费。' })]);
  assert.equal(retrieve(vault, 'offline recovery').results[0].title, '同步架构');
  assert.equal(retrieve(vault, 'distributed-systems').results[0].title, '同步架构');
  const q = retrieve(vault, '幂等消费');
  assert.equal(q.results[0].project, 'Beta');
  const actualLines = fs.readFileSync(safe(vault, q.results[0].path), 'utf8').split('\n');
  const s = q.results[0].snippet;
  assert.equal(s.text, actualLines.slice(s.startLine - 1, s.endLine).join('\n'));
  assert.equal(retrieve(vault, '幂等消费', { project: 'Alpha' }).results.length, 0);
  assert.equal(retrieve(vault, 'xyzunknown987').results.length, 0);
});

test('queries see external edits immediately and copied roots need no old absolute paths', t => {
  const { root, vault } = fixture(t);
  add(vault, [item()]);
  fs.appendFileSync(safe(vault, 'projects/Alpha/同步架构.md'), '\nUniqueExternalMarker\n');
  assert.equal(retrieve(vault, 'UniqueExternalMarker').results.length, 1);
  const migrated = path.join(root, 'copy');
  fs.mkdirSync(migrated);
  for (const file of ['config.json', 'vaults', 'workspaces']) fs.cpSync(path.join(root, file), path.join(migrated, file), { recursive: true });
  assert.equal(retrieve(resolveVault(migrated).dir, 'UniqueExternalMarker').results.length, 1);
});

test('ranking is stable for ties and rejects invalid limits', () => {
  const docs = ['b', 'a'].map(x => ({ id: x, title: x, path: `${x}.md`, project: 'p', body: 'same term', props: {} }));
  assert.deepEqual(rank(docs, 'same').map(d => d.id), ['a', 'b']);
  assert.throws(() => rank(docs, 'same', { k: 0 }));
  assert.throws(() => rank(docs, ' '));
  assert(tokenize('事件ID版本42').includes('id'));
  assert(tokenize('事件ID版本42').includes('42'));
  assert.deepEqual(tokenize('---'), []);
});

test('unrelated Chinese question cannot match only common single characters', t => {
  const { vault } = fixture(t);
  add(vault, [item({ title: '保证金与强平', content: '使用标记价格计算账户的保证金。资金费率是交易双方的定期支付。' })]);
  assert.equal(retrieve(vault, '和弦第一转位与第二转位的低音分别是什么？').results.length, 0);
  assert.equal(retrieve(vault, '光合作用叶绿体').results.length, 0);
  assert.equal(retrieve(vault, '保证金怎么计算？').results.length, 1);
});

test('an AKM transaction cannot interleave between reading two query pages', t => {
  const { vault } = fixture(t);
  add(vault, [item(), item({ title: '事件版本号' })]);
  const original = fs.readFileSync;
  let attempted = false;
  fs.readFileSync = function (file, ...args) {
    if (String(file).endsWith('/同步架构.md') && !attempted) {
      attempted = true;
      assert.throws(() => withLock(vault, () => { throw new Error('interleaved'); }), { code: 'VAULT_BUSY' });
    }
    return original.call(this, file, ...args);
  };
  try { assert.equal(retrieve(vault, '服务端').results.length, 2); }
  finally { fs.readFileSync = original; }
  assert(attempted);
});
