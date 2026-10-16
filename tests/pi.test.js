import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { answer, configureModel, extract, runPi } from '../src/pi.js';
import { applyProposal, createProposal } from '../src/knowledge.js';
import { readJSON, safe, listFiles } from '../src/storage.js';
import { fixture, item } from './helpers.js';

async function endpoint(t, response) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : {} });
    const result = response(requests.at(-1));
    if (result === 'hang') return;
    if (result === 'error') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'private-test-secret', type: 'invalid_request_error' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: requests.at(-1).body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (typeof result === 'object') {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: result.name, arguments: JSON.stringify(result.args) } }] });
      emit({}, 'tool_calls');
    } else { emit({ role: 'assistant', content: result }); emit({}, 'stop'); }
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
function credential(t) {
  const name = 'AKM_TEST_PROVIDER_KEY';
  const old = process.env[name]; process.env[name] = 'test-key';
  t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
  return name;
}

test('real pi SDK calls compatible endpoint, isolates workspaces and scopes knowledge tools', async t => {
  const { root, vault } = fixture(t);
  const apiKeyEnv = credential(t);
  const remote = await endpoint(t, req => req.body.model === 'model-a' ? JSON.stringify({ items: [item({ sources: undefined })] }) : 'workspace B answer');
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model-a', apiKeyEnv });
  configureModel(root, 'second', { baseUrl: remote.url, model: 'model-b', apiKeyEnv });
  const modelsBefore = fs.readFileSync(safe(root, 'workspaces/default/.pi/models.json'), 'utf8');
  const p = await extract(root, 'default', vault, '服务端负责同步。', { kind: 'document', name: 'architecture.md', timeout: 10000 });
  assert.equal(listFiles(vault, 'projects').length, 0);
  assert.equal(p.items[0].project, 'Alpha');
  applyProposal(vault, p.id, p.revision, [1]);
  const answerResult = await answer(root, 'second', vault, '服务端同步', { timeout: 10000 });
  assert.equal(answerResult.answer, 'workspace B answer');
  assert.equal(answerResult.evidence.results[0].title, '同步架构');
  assert.equal(remote.requests.length, 2);
  assert(remote.requests.every(r => r.path === '/v1/chat/completions' && r.auth === 'Bearer test-key'));
  assert(!remote.requests[0].body.tools || remote.requests[0].body.tools.length === 0);
  assert.deepEqual(remote.requests[1].body.tools.map(t => t.function.name).sort(), ['akm_read', 'akm_retrieve_evidence', 'akm_search']);
  assert.deepEqual(remote.requests.map(r => r.body.model), ['model-a', 'model-b']);
  assert.equal(fs.readFileSync(safe(root, 'workspaces/default/.pi/models.json'), 'utf8'), modelsBefore);
  assert(!modelsBefore.includes('test-key'));
  assert.equal(readJSON(safe(root, 'workspaces/default/workspace.json')).model, 'model-a');
  assert.equal(readJSON(safe(root, 'workspaces/second/workspace.json')).model, 'model-b');
});

test('conversation extraction stores only supporting messages after selected apply', async t => {
  const { root, vault } = fixture(t);
  const apiKeyEnv = credential(t);
  const remote = await endpoint(t, () => JSON.stringify({ items: [{ ...item(), source_message_ids: ['m2'] }] }));
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv });
  const conversation = { conversation_id: 'conv-1', messages: [{ id: 'm1', role: 'user', content: 'unrelated private-topic' }, { id: 'm2', role: 'user', content: '服务端负责同步。' }] };
  const p = await extract(root, 'default', vault, conversation, { kind: 'conversation', timeout: 10000 });
  applyProposal(vault, p.id, p.revision, [1]);
  const raw = listFiles(vault, '.raw').map(p => fs.readFileSync(safe(vault, p), 'utf8')).join('\n');
  assert(raw.includes('m2'));
  assert(!raw.includes('private-topic'));
  assert(!raw.includes('m1'));
});

test('invalid model JSON, missing credentials and provider failures never write knowledge', async t => {
  const { root, vault } = fixture(t);
  const apiKeyEnv = credential(t);
  const remote = await endpoint(t, req => req.body.model === 'error-model' ? 'error' : 'not JSON');
  configureModel(root, 'default', { baseUrl: remote.url, model: 'invalid', apiKeyEnv });
  await assert.rejects(() => extract(root, 'default', vault, 'source', { kind: 'document', timeout: 10000 }), { code: 'INVALID_MODEL_OUTPUT' });
  assert.equal(listFiles(vault, 'projects').length, 0);
  assert.equal(listFiles(vault, '.vault-meta/proposals').length, 0);
  configureModel(root, 'default', { baseUrl: remote.url, model: 'error-model', apiKeyEnv });
  await assert.rejects(() => runPi(root, 'default', 'prompt', { timeout: 10000 }), e => e.code === 'MODEL_ERROR' && !e.message.includes('private-test-secret'));
  delete process.env[apiKeyEnv];
  await assert.rejects(() => runPi(root, 'default', 'prompt'), { code: 'MISSING_CREDENTIAL' });
});

test('pi call aborts a stalled compatible endpoint', async t => {
  const { root } = fixture(t);
  const apiKeyEnv = credential(t);
  const remote = await endpoint(t, () => 'hang');
  configureModel(root, 'default', { baseUrl: remote.url, model: 'hang-model', apiKeyEnv });
  await assert.rejects(() => runPi(root, 'default', 'prompt', { timeout: 100 }), { code: 'MODEL_TIMEOUT' });
});

test('explicit pi update receives the full old page, preserves metadata and sends thinking override', async t => {
  const { root, vault } = fixture(t);
  const apiKeyEnv = credential(t);
  const original = createProposal(vault, { items: [item({ content: '服务端负责同步。\n\n' + '背景说明。\n\n'.repeat(25) + '必须保留：客户端重连先恢复服务端状态。', aliases: ['重连方案'] })] });
  applyProposal(vault, original.id, original.revision, [1]);
  const target = original.items[0].target;
  const remote = await endpoint(t, () => JSON.stringify({ items: [item({ action: 'update', target, content: '服务端负责同步。客户端重连先恢复服务端状态。新增真实验证要求。', aliases: ['重连方案'] })] }));
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv, thinkingEnabled: true });
  const audits = [];
  const traces = [];
  const proposal = await extract(root, 'default', vault, '新增真实验证要求。', { kind: 'document', target, timeout: 10000, onResult: value => audits.push(value), onTrace: value => traces.push(value) });
  const prompt = JSON.stringify(remote.requests[0].body.messages);
  assert(prompt.includes('必须保留：客户端重连先恢复服务端状态。'));
  assert(prompt.includes('重连方案'));
  assert(prompt.includes('requestedUpdateTarget'));
  assert.deepEqual(remote.requests[0].body.thinking, { type: 'enabled' });
  assert.equal(proposal.items[0].target, target);
  assert.equal(audits[0].httpStatus, 200);
  assert.equal(audits[0].requestedModel, 'model');
  assert(!JSON.stringify(audits).includes('test-key'));
  assert(!JSON.stringify(audits).includes('headers'));
  assert.deepEqual(traces.map(trace => trace.phase), ['request', 'response']);
  assert(traces[0].prompt.includes('必须保留：客户端重连先恢复服务端状态。'));
  assert.equal(JSON.parse(traces[1].text).items[0].target, target);
  assert(!JSON.stringify(traces).includes('test-key'));
  assert(!JSON.stringify(traces).includes('authorization'));
});

test('an external edit during pi generation rejects the stale model proposal', async t => {
  const { root, vault } = fixture(t);
  const apiKeyEnv = credential(t);
  const original = createProposal(vault, { items: [item()] });
  applyProposal(vault, original.id, original.revision, [1]);
  const target = original.items[0].target;
  const file = safe(vault, target);
  const remote = await endpoint(t, () => {
    fs.appendFileSync(file, '\nObsidian 用户补充的重要知识。\n');
    return JSON.stringify({ items: [item({ action: 'update', target })] });
  });
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv });
  await assert.rejects(() => extract(root, 'default', vault, '更新同步架构。', { kind: 'document', target, timeout: 10000 }), { code: 'CONFLICT' });
  assert(fs.readFileSync(file, 'utf8').includes('Obsidian 用户补充的重要知识。'));
  assert.equal(listFiles(vault, '.vault-meta/proposals').length, 1);
});

test('answer evidence includes later decisions beyond the best lexical snippet', async t => {
  const { root, vault } = fixture(t);
  const apiKeyEnv = credential(t);
  const old = '验证没有使用真实商业模型，真实商业模型尚未验证。';
  const latest = '后续真实模型验证：pi 请求提供的 API，文档摄取和对话提取均收到 HTTP 200。';
  const proposal = createProposal(vault, { items: [item({ content: old + '\n\n' + '先前的历史背景。\n\n'.repeat(12) + latest })] });
  applyProposal(vault, proposal.id, proposal.revision, [1]);
  const remote = await endpoint(t, () => '引用更新后的证据。');
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv });
  const response = await answer(root, 'default', vault, '验证是否使用真实商业模型', { timeout: 10000 });
  assert(!response.evidence.results[0].snippet.text.includes(latest));
  assert(response.evidence.results[0].content.includes(latest));
  assert.equal(response.evidence.results[0].contentTruncated, false);
  assert(JSON.stringify(remote.requests[0].body.messages).includes(latest));
});

test('pi cannot guess an update target outside its full-page context', async t => {
  const { root, vault } = fixture(t);
  const apiKeyEnv = credential(t);
  const original = createProposal(vault, { items: [item(), item({ title: 'Unseen', content: 'Unrelated astronomy details', tags: ['astronomy'], aliases: [] })] });
  applyProposal(vault, original.id, original.revision, [1, 2]);
  const target = original.items[1].target;
  const remote = await endpoint(t, () => JSON.stringify({ items: [item({ title: 'Unseen', action: 'update', target })] }));
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv });
  await assert.rejects(() => extract(root, 'default', vault, '服务端同步', { kind: 'document', timeout: 10000 }), { code: 'INVALID_MODEL_OUTPUT' });
  assert.equal(listFiles(vault, '.vault-meta/proposals').length, 1);
});

 test('pi executes bounded knowledge read and answers from the follow-up evidence', async t => {
  const { root, vault } = fixture(t);
  const apiKeyEnv = credential(t);
  const latest = '最终更新：架构使用 fencing token 保护存储。';
  const proposal = createProposal(vault, { items: [item({ content: '旧同步架构。\n' + '历史背景。'.repeat(2700) + '\n' + latest })] });
  applyProposal(vault, proposal.id, proposal.revision, [1]);
  const remote = await endpoint(t, req => req.body.messages.some(m => m.role === 'tool') ? '中文回答：存储服务校验 fencing token。' : { name: 'akm_read', args: { path: proposal.items[0].target, offset: 12000, limit: 8000 } });
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv });
  const audits = [];
  const output = await answer(root, 'default', vault, '同步架构', { timeout: 10000, onResult: value => audits.push(value) });
  assert.equal(remote.requests.length, 2);
  assert(!remote.requests[1].body.tools?.length);
  assert(!JSON.stringify(remote.requests[0].body.messages).includes(latest));
  assert(JSON.stringify(remote.requests[1].body.messages).includes(latest));
  assert(output.toolReads[0].content.includes(latest));
  assert.equal(output.toolReads[0].contentTruncated, false);
  assert(output.answer.startsWith('中文回答'));
  assert.equal(audits[0].rounds.length, 2);
  assert.equal(audits[0].usage.totalTokens, 240);
  assert.equal(audits[0].requestCount, 2);
  assert.equal(audits[0].tools.length, 1);
});

test('same document reuses pending and applied proposals without extra model calls', async t => {
  const { root, vault } = fixture(t);
  const remote = await endpoint(t, () => JSON.stringify({ items: [item()] }));
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv: credential(t) });
  const first = await extract(root, 'default', vault, '服务端负责同步。', { kind: 'document', project: 'Alpha' });
  const pending = await extract(root, 'default', vault, '服务端负责同步。', { kind: 'document', project: 'Alpha', name: 'renamed.md' });
  assert(pending.reused);
  assert.equal(pending.id, first.id);
  applyProposal(vault, first.id, first.revision, [1]);
  const applied = await extract(root, 'default', vault, '服务端负责同步。', { kind: 'document', project: 'Alpha' });
  assert.equal(applied.items[0].state, 'applied');
  assert.equal(remote.requests.length, 1);
});

test('chunked extraction consolidates repeated concepts and preserves the original source tail', async t => {
  const { root, vault } = fixture(t);
  const remote = await endpoint(t, req => JSON.stringify(req.body.messages).includes('RECONCILE_DRAFTS') ? JSON.stringify({ groups: [{ labels: [1, 2], content: '服务端同步的前半段。补充 TAIL-FACT' }] }) : JSON.stringify({ items: [item({ content: JSON.stringify(req.body.messages).includes('TAIL-FACT') ? '服务端同步。TAIL-FACT' : '服务端同步的前半段。' })] }));
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv: credential(t) });
  const input = '服务端同步。'.repeat(4500) + '\n\nTAIL-FACT';
  const p = await extract(root, 'default', vault, input, { kind: 'document', project: 'Alpha' });
  assert.equal(p.items.length, 1);
  assert(p.items[0].content.includes('TAIL-FACT'));
  assert.equal(remote.requests.length, 3);
  applyProposal(vault, p.id, p.revision, [1]);
  assert(listFiles(vault, '.raw').some(file => fs.readFileSync(safe(vault, file), 'utf8') === input));
});

test('model cannot switch the selected project and oversized conversation makes zero requests', async t => {
  const { root, vault } = fixture(t);
  const remote = await endpoint(t, () => JSON.stringify({ items: [item({ project: 'Beta' })] }));
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv: credential(t) });
  await assert.rejects(extract(root, 'default', vault, 'source', { kind: 'document', project: 'Alpha' }), { code: 'INVALID_MODEL_OUTPUT' });
  await assert.rejects(extract(root, 'default', vault, { messages: [{ id: 'm1', role: 'user', content: 'a'.repeat(49000) }] }, { kind: 'conversation' }), { code: 'SOURCE_BUDGET' });
  assert.equal(remote.requests.length, 1);
});

test('mixed selected and fallback chunk supports survive reconciliation', async t => {
  const { root, vault } = fixture(t); let chunk = 0;
  const remote = await endpoint(t, req => {
    if (JSON.stringify(req.body.messages).includes('RECONCILE_DRAFTS')) return JSON.stringify({ groups: [{ labels: [1, 2], content: '服务端同步与尾部修正。' }] });
    chunk++;
    return JSON.stringify({ items: [item({ content: chunk === 1 ? '服务端同步。' : '尾部修正。', ...(chunk === 2 ? { source_paragraph_ids: ['p1:2', 'p2:1'] } : {}) })] });
  });
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv: credential(t) });
  const p = await extract(root, 'default', vault, '服务端同步。'.repeat(4500) + '\n\n尾部修正。', { kind: 'document', project: 'Alpha' });
  const { getProposal } = await import('../src/knowledge.js');
  const support = getProposal(vault, p.id).items[0].sources[0].support;
  assert(support.spans.some(p => p.id === 'p1:1'));
  assert(support.spans.some(p => p.id === 'p2:1'));
  assert.equal(support.granularity, 'includes-processed-chunk-fallback');
});

test('answer returns supplemental aggregate evidence supporting newly discovered citations', async t => {
  const { root, vault } = fixture(t);
  const p = createProposal(vault, { items: [item({ title: 'Alpha note', content: 'initial-term' }), item({ title: 'Beta note', content: 'supplement-term' })] });
  applyProposal(vault, p.id, p.revision, [1, 2]);
  const remote = await endpoint(t, req => req.body.messages.some(m => m.role === 'tool') ? '补充证据：[[projects/Alpha/Beta note|Beta note]]' : { name: 'akm_retrieve_evidence', args: { query: 'supplement-term' } });
  configureModel(root, 'default', { baseUrl: remote.url, model: 'model', apiKeyEnv: credential(t) });
  const result = await answer(root, 'default', vault, 'initial-term', { k: 1 });
  assert.equal(result.supplements[0].evidence.results[0].title, 'Beta note');
  assert(result.supplements[0].evidence.results[0].passages.length);
  assert(!remote.requests[1].body.tools?.length);
});

test('unexecuted provider tool protocol is not published as a successful answer', async t => {
  const { root, vault } = fixture(t);
  const p = createProposal(vault, { items: [item()] }); applyProposal(vault,p.id,p.revision,[1]);
  const remote = await endpoint(t, () => '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="akm_search">');
  configureModel(root,'default',{baseUrl:remote.url,model:'model',apiKeyEnv:credential(t)});
  await assert.rejects(answer(root,'default',vault,'同步'),{code:'INVALID_MODEL_OUTPUT'});
});
