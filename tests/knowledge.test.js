import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyProposal, createProposal, editProposal, inspectProposal, showPage } from '../src/knowledge.js';
import { hash, listFiles, readJSON, renderPage, safe } from '../src/storage.js';
import { assertReadable, commit, recover, withLock } from '../src/transaction.js';
import { retrieve } from '../src/retrieve.js';
import { add, fixture, item } from './helpers.js';

test('updates preserve source links as single valid references without nested markdown', t => {
  const { vault } = fixture(t);
  const p=createProposal(vault,{items:[item({sources:[{kind:'document',name:'first.md',content:'原始事实'}]})]});
  applyProposal(vault,p.id,p.revision,[1]);
  const target=p.items[0].target;
  for(let n=0;n<2;n++) {
    const update=createProposal(vault,{items:[item({action:'update',target,content:`原始事实。新增事实${n}`,sources:[{kind:'document',name:`update${n}.md`,content:`新增事实${n}`}]})]});
    applyProposal(vault,update.id,update.revision,[1]);
  }
  const page=showPage(vault,target);
  assert.equal(page.props.source_refs.length,3);
  for(const ref of page.props.source_refs){assert(/^\[[a-f0-9]{64}\]\(sources\/[a-f0-9]{64}\.txt\)$/.test(ref));assert(fs.existsSync(safe(vault,ref.match(/\(sources\/([^)]*)\)/)[0].slice(1,-1))));}
});

test('add → edit proposal → selected apply → update → retrieve, with preserved custom properties', t => {
  const { vault } = fixture(t);
  const p = createProposal(vault, { items: [item(), item({ title: '临时草稿', content: '不要保存' })] });
  assert.equal(p.items[0].newProject, true);
  assert.equal(fs.existsSync(safe(vault, 'projects/Alpha/index.md')), false);
  const edited = editProposal(vault, p.id, p.revision, [{ label: 1, set: { tags: ['sync', 'architecture'] } }, { label: 2, set: { state: 'discarded' } }]);
  assert.deepEqual(edited.items.map(i => i.label), [1, 2]);
  assert.throws(() => applyProposal(vault, p.id, p.revision, [1]), { code: 'STALE_REVISION' });
  const receipt = applyProposal(vault, p.id, edited.revision, [1]);
  assert.equal(applyProposal(vault, p.id, edited.revision, [1]).replayed, true);
  assert(!fs.existsSync(safe(vault, 'projects/Alpha/临时草稿.md')));
  let page = showPage(vault, '同步架构');
  assert.deepEqual(page.props.tags, ['sync', 'architecture']);
  assert(page.props.sources.length > 0);
  fs.writeFileSync(safe(vault, page.path), renderPage({ ...page.props, owner: 'Alice' }, page.title, page.body.replace(/^#.*\n/, '')));
  const update = createProposal(vault, { items: [item({ action: 'update', target: page.path, content: '客户端现在使用版本号过滤过期事件。', tags: ['versioning'] })] });
  assert(update.items[0].before.includes('服务端'));
  applyProposal(vault, update.id, update.revision, [1]);
  page = showPage(vault, '同步架构');
  assert.equal(page.props.owner, 'Alice');
  assert(page.body.includes('版本号'));
  assert.equal(page.props.sources.length, 2);
  assert.equal(retrieve(vault, '过滤过期事件').results[0].path, page.path);
  const index = fs.readFileSync(safe(vault, 'projects/Alpha/index.md'), 'utf8');
  assert.equal(index.split('[[projects/Alpha/同步架构|同步架构]]').length - 1, 1);
  assert(receipt.operationId);
});

test('partial selection preserves other labels and permits later apply', t => {
  const { vault } = fixture(t);
  const p = createProposal(vault, { items: [item(), item({ title: '事件版本号' })] });
  const first = applyProposal(vault, p.id, p.revision, [1]);
  const remaining = inspectProposal(vault, p.id);
  assert.equal(remaining.items[1].state, 'proposed');
  applyProposal(vault, p.id, first.revision, [2]);
  assert(showPage(vault, '事件版本号'));
});

test('external edit and stale proposal never overwrite a page', t => {
  const { vault } = fixture(t);
  add(vault, [item()]);
  const p = createProposal(vault, { items: [item({ action: 'update', target: 'projects/Alpha/同步架构.md', content: '新结论' })] });
  const target = safe(vault, 'projects/Alpha/同步架构.md');
  fs.appendFileSync(target, '\n用户在 Obsidian 修改。\n');
  const before = fs.readFileSync(target, 'utf8');
  assert.throws(() => applyProposal(vault, p.id, p.revision, [1]), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.equal(inspectProposal(vault, p.id).items[0].state, 'proposed');
});

test('related dependencies cannot refresh a selected update precondition', t => {
  const { vault } = fixture(t);
  add(vault, [item({ title: 'B' }), item({ title: 'A' })]);
  const p = createProposal(vault, { items: [
    item({ title: 'B', action: 'update', target: 'projects/Alpha/B.md', content: 'proposed B' }),
    item({ title: 'A', action: 'update', target: 'projects/Alpha/A.md', content: 'proposed A', related: ['[[projects/Alpha/B]]'] }),
  ] });
  const b = safe(vault, 'projects/Alpha/B.md');
  fs.appendFileSync(b, '\nexternal B edit\n');
  assert.throws(() => applyProposal(vault, p.id, p.revision, [1, 2]), { code: 'CONFLICT' });
  assert.throws(() => applyProposal(vault, p.id, p.revision, [2, 1]), { code: 'CONFLICT' });
  assert(fs.readFileSync(b, 'utf8').includes('external B edit'));
});

test('relations resolve exactly; missing, unselected and ambiguous targets are rejected', t => {
  const { vault } = fixture(t);
  const p = createProposal(vault, { items: [item({ related: ['[[Alpha/事件版本号]]'] }), item({ title: '事件版本号' })] });
  assert.throws(() => applyProposal(vault, p.id, p.revision, [1]), { code: 'UNRESOLVED_LINK' });
  applyProposal(vault, p.id, p.revision, [1, 2]);
  assert.deepEqual(showPage(vault, '同步架构').props.related, ['[[projects/Alpha/事件版本号|事件版本号]]']);
  add(vault, [item({ project: 'Beta', title: '事件版本号' })]);
  assert.throws(() => createProposal(vault, { items: [item({ title: '新页', related: ['事件版本号'] })] }), { code: 'AMBIGUOUS_LINK' });
});

test('unsafe names, target traversal and symlink ancestors are rejected', t => {
  const { root, vault } = fixture(t);
  assert.throws(() => createProposal(vault, { items: [item({ project: '../outside' })] }), { code: 'INVALID_INPUT' });
  assert.throws(() => createProposal(vault, { items: [item({ action: 'update', target: 'projects/Alpha/../../vault.json' })] }));
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, safe(vault, 'projects/Escape'));
  assert.throws(() => createProposal(vault, { items: [item({ project: 'Escape' })] }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('failed multi-file commit rolls back notes, sources, project indexes and proposal state', t => {
  const { vault } = fixture(t);
  const p = createProposal(vault, { items: [item()] });
  assert.throws(() => applyProposal(vault, p.id, p.revision, [1], { afterWrite: i => { if (i === 3) throw new Error('fault'); } }), /fault/);
  assert.equal(listFiles(vault, 'projects').length, 0);
  assert.equal(listFiles(vault, '.raw').length, 0);
  assert.equal(inspectProposal(vault, p.id).items[0].state, 'proposed');
  assert.equal(recover(vault).restored.length, 0);
  applyProposal(vault, p.id, p.revision, [1]);
  assert(showPage(vault, '同步架构'));
});

test('process crash is recovered, and live lock is not cleared', t => {
  const { vault } = fixture(t);
  const transactionModule = new URL('../src/transaction.js', import.meta.url).href;
  const script = `import { withLock, commit } from ${JSON.stringify(transactionModule)};
  const vault = process.argv[1];
  withLock(vault, () => commit(vault, [{path:'projects/crash.md',content:'partial'}], {'projects/crash.md':null}, {afterWrite:()=>process.exit(23)}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, vault], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  assert.throws(() => assertReadable(vault), { code: 'VAULT_BUSY' });
  assert.equal(recover(vault, { clearStaleLock: true }).restored.length, 1);
  assert(!fs.existsSync(safe(vault, 'projects/crash.md')));
  withLock(vault, () => assert.throws(() => recover(vault, { clearStaleLock: true }), { code: 'VAULT_BUSY' }));
});

test('recovery preserves unexpected external edits rather than deleting them', t => {
  const { vault } = fixture(t);
  assert.throws(() => withLock(vault, () => commit(vault, [{ path: 'projects/conflict.md', content: 'ours' }], { 'projects/conflict.md': null }, { afterWrite: () => { fs.writeFileSync(safe(vault, 'projects/conflict.md'), 'user'); throw new Error('fault'); } })), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => recover(vault), { code: 'RECOVERY_CONFLICT' });
  assert.equal(fs.readFileSync(safe(vault, 'projects/conflict.md'), 'utf8'), 'user');
});
