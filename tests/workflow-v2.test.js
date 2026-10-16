import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, item, add } from './helpers.js';
import { sumUsage, usageRounds } from '../src/telemetry.js';
import { sourceChunks, fidelityIssues } from '../src/source.js';
import { retrieveEvidence } from '../src/evidence.js';
import { knowledgeTools } from '../src/pi-tools.js';

test('aggregate query and repeated section reads return each page and section once', async t => {
  const { vault } = fixture(t);
  add(vault, [item({ content: '同步架构。\n\n## 修订\n服务端状态是准绳。' })]);
  const p = showPage(vault, 'projects/Alpha/同步架构.md');
  const [tool] = knowledgeTools(vault, { discovered: new Map([[p.path, p.hash]]) });
  const out = await tool.execute('', { query: '同步架构', reads: [{ path: p.path, sections: [1, 2] }, { path: p.path, sections: [2] }] });
  assert.equal(out.details.results.length, 1);
  assert.deepEqual(out.details.results[0].passages.map(p => p.section), [1, 2]);
  assert.equal(out.details.budget.used, out.details.results[0].passages.reduce((n, p) => n + p.text.length, 0));
});
import { createProposal, editProposal, applyProposal, getProposal, showPage } from '../src/knowledge.js';
import { safe } from '../src/storage.js';

test('all-round telemetry preserves totals and represents unavailable usage', () => {
  const usage = { input: 10, output: 20, reasoning: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 30 };
  const rounds = usageRounds([{ role: 'user' }, { role: 'assistant', usage }, { role: 'assistant', usage }]);
  assert.equal(sumUsage(rounds).totalTokens, 60);
  assert.equal(sumUsage(rounds).reasoning, 10);
  assert.equal(sumUsage([...rounds, { usage: null }]).input, null);
  assert.equal(usageRounds([{ role: 'assistant', usage: { totalTokens: 0, input: 0, output: 0 } }])[0].usage, null);
});

test('chunking covers tail and fails before processing over-budget sources', () => {
  const input = 'First paragraph.\n\n' + 'x'.repeat(50) + '\n\nTail correction.';
  const chunks = sourceChunks(input, { maxChars: 25 });
  assert(chunks.at(-1).includes('Tail correction.'));
  assert.equal(chunks.join('').replace(/\s/g, ''), input.replace(/\s/g, ''));
  assert.throws(() => sourceChunks(input, { maxChars: 10, maxChunks: 1 }), { code: 'SOURCE_BUDGET' });
});

test('evidence selects matching and tail caveat sections within budget with valid line ranges', t => {
  const { vault } = fixture(t);
  add(vault, [item({ content: '## Background\n' + 'unrelated text '.repeat(1000) + '\n\n## Fencing definition\nStorage rejects lower token values.\n\n## Update 2016 rebuttal\nA rebuttal exists; this essay is not peer reviewed.' })]);
  const evidence = retrieveEvidence(vault, 'fencing', { budgetChars: 500, perPageChars: 500 });
  const p = evidence.results[0];
  assert(p.content.includes('lower token'));
  assert(p.content.includes('rebuttal'));
  assert(p.contentTruncated);
  assert(evidence.budget.used <= 500);
  const lines = fs.readFileSync(safe(vault, p.path), 'utf8').split('\n');
  for (const passage of p.passages) assert.equal(lines.slice(passage.startLine - 1, passage.endLine).join('\n').slice(0, passage.text.length), passage.text);
  assert.throws(() => retrieveEvidence(vault, 'fencing', { k: 0 }));
  assert.equal(retrieveEvidence(vault, 'fencing', { project: 'Beta' }).results.length, 0);
});

test('query variants fuse without duplicates and changed evidence cannot be silently refreshed', async t => {
  const { vault } = fixture(t);
  add(vault, [item({ aliases: ['fencing'], content: '栅栏令牌' }), item({ project: 'Beta', title: '其他项目', content: 'fencing' })]);
  const [aggregate] = knowledgeTools(vault, { project: 'Alpha' });
  const output = await aggregate.execute('', { query: '栅栏令牌', queries: ['fencing'] });
  assert.equal(output.details.results.length, 1);
  fs.appendFileSync(safe(vault, output.details.results[0].path), '\nChanged');
  await assert.rejects(aggregate.execute('', { query: 'fencing' }), { code: 'CONFLICT' });
});

test('merge unions sources, preserves stable labels, removes self relation and rewrites dependencies', t => {
  const { vault } = fixture(t);
  const p = createProposal(vault, { items: [item({ title: '租约', related: ['item:2'], sources: [{ kind: 'document', name: 'lease', content: 'Lease may expire' }] }), item({ title: '暂停', related: ['item:1'], tags: ['pause'], sources: [{ kind: 'document', name: 'pause', content: 'A pause exceeds TTL' }] }), item({ title: '存储', related: ['item:2'] })] });
  const merged = editProposal(vault, p.id, p.revision, [{ op: 'merge', labels: [1, 2], into: 1, content: '租约过期后恢复的旧持有者仍可能写入。' }]);
  assert.deepEqual(merged.items.map(i => i.label), [1, 2, 3]);
  assert.equal(merged.items[1].state, 'discarded');
  assert.equal(merged.items[0].sourceCount, 2);
  assert.equal(merged.items[0].related.length, 0);
  assert.equal(merged.items[2].related[0].link, 'item:1');
  assert.throws(() => applyProposal(vault, p.id, p.revision, [1, 3]), { code: 'STALE_REVISION' });
  const receipt = applyProposal(vault, p.id, merged.revision, [1, 3]);
  assert.equal(receipt.pages.length, 2);
  assert.equal(showPage(vault, '租约').props.sources.length, 2);
  assert(showPage(vault, '存储').props.related[0].includes('|租约'));
});

test('discarded dependencies, cross-domain relations and comparator changes are handled', t => {
  const { vault } = fixture(t);
  const source = [{ kind: 'document', name: 'original', content: 'The storage rejects a lower token.' }];
  assert.equal(fidelityIssues('拒绝非递增 token', source)[0].code, 'COMPARATOR_CHANGED');
  const p = createProposal(vault, { items: [item({ content: '拒绝非递增 token', sources: source }), item({ title: '依赖', related: ['item:1'] })] });
  assert.throws(() => applyProposal(vault, p.id, p.revision, [1]), { code: 'FIDELITY_REVIEW' });
  const edited = editProposal(vault, p.id, p.revision, [{ label: 1, set: { content: '拒绝比已见最大 token 更小的请求。' } }, { label: 2, set: { state: 'discarded' } }]);
  applyProposal(vault, p.id, edited.revision, [1]);
  const cross = createProposal(vault, { items: [item({ title: 'Beta知识', project: 'Beta', related: ['projects/Alpha/同步架构'] })] });
  const crossReceipt = applyProposal(vault, cross.id, cross.revision, [1]);
  assert.equal(crossReceipt.pages.length, 1);
});

test('merge redirects path and aliased wiki references, not only item labels', t => {
  const { vault } = fixture(t);
  const p = createProposal(vault, { items: [item({ title: '一', related: ['[[projects/Alpha/二|二]]'] }), item({ title: '二' }), item({ title: '三', related: ['projects/Alpha/二.md'] })] });
  const merged = editProposal(vault, p.id, p.revision, [{ op: 'merge', labels: [1, 2], into: 1, content: '合并内容' }]);
  assert.equal(merged.items[0].related.length, 0);
  assert.equal(merged.items[2].related[0].link, 'item:1');
  applyProposal(vault, p.id, merged.revision, [1, 3]);
});

test('one batch section supplement observes total budget and subsequent calls fail', async t => {
  const { vault } = fixture(t);
  add(vault, [item({ content: '## First\n服务端同步。\n## Second\n最终决定：使用 fencing token。' })]);
  const p = showPage(vault, '同步架构');
  const [aggregate] = knowledgeTools(vault, { discovered: new Map([[p.path, p.hash]]), maxCalls: 1, budgetChars: 200 });
  const supplement = await aggregate.execute('', { reads: [{ path: p.path, sections: [2, 3] }] });
  assert(supplement.details.results[0].content.includes('fencing token'));
  assert(supplement.details.supplementBudgetRemaining >= 0);
  assert.equal(supplement.details.budget.used, 200 - supplement.details.supplementBudgetRemaining);
  await assert.rejects(aggregate.execute('', { query: '同步' }), { code: 'EVIDENCE_BUDGET' });
});

test('clarifying lower versus non-increasing does not falsely block a correct proposal', () => {
  const sources = [{ kind: 'document', name: 'original', content: 'Reject lower token.' }];
  assert.deepEqual(fidelityIssues('较低 token 不等同于非递增 token；应拒绝比已见最大值更小的 token。', sources), []);
});
