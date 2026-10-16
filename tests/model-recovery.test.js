import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configureModel, runPi } from '../src/pi.js';
import { fixture } from './helpers.js';

async function setup(t, handler, recovery = {}) {
  const { root } = fixture(t), seen = [], reports = [];
  const key = 'AKM_FAULT_TEST_KEY'; process.env[key] = 'fault-key';
  t.after(() => delete process.env[key]);
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); seen.push(body);
    const result = handler(body, seen.length);
    if (result === 'hang') return;
    if (result.status) { res.writeHead(result.status, { 'content-type': 'application/json', ...(result.headers ?? {}) }); res.end(JSON.stringify({ error: { message: result.message ?? 'fault-secret', type: 'test_error' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'r', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (result.tool) emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: 'probe', arguments: '{}' } }] });
    else emit({ role: 'assistant', content: result.text ?? '成功' });
    if (result.interrupt) { setImmediate(() => res.destroy()); return; }
    emit({}, result.tool ? 'tool_calls' : 'stop');
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  configureModel(root, 'default', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'a', fallback: ['b', 'c'], apiKeyEnv: key, recovery: { baseDelayMs: 0, ...recovery } });
  return { root, seen, reports, call: options => runPi(root, 'default', '测试', { timeout: 5000, onResult: r => reports.push(r), ...options }) };
}

test('503 retries same model once, then falls back; physical retries do not spend logical round', async t => {
  const s = await setup(t, (_, n) => n < 3 ? { status: 503 } : {});
  assert.equal(await s.call({ maxRequests: 1 }), '成功');
  assert.deepEqual(s.seen.map(r => r.model), ['a', 'a', 'b']);
  assert.equal(s.reports[0].logicalRounds, 1);
  assert.equal(s.reports[0].requestCount, 3);
  assert.deepEqual(s.reports[0].requests.map(r => r.recovery), ['retry', 'fallback', undefined]);
  assert.equal(s.reports[0].usageComplete, false);
  assert(!JSON.stringify(s.reports).includes('fault-secret'));
});

test('compatible text payload is scalar and complete leading thinking block is removed', async t => {
  const s=await setup(t,body=>{assert(body.messages.filter(m=>m.role==='user').every(m=>typeof m.content==='string'));assert.equal(body.max_tokens,8192);return {text:'<think>private reasoning</think>\n{"ok":true}'};});
  assert.deepEqual(JSON.parse(await s.call()),{ok:true});
});

for (const [status, message, count] of [[401, 'Unauthorized', 1], [400, 'Invalid argument', 1], [429, 'insufficient_quota', 1], [429, 'model rate limit', 3], [404, 'Model not found', 3], [503, 'unavailable', 6]]) {
  test(`bounded failure ${status} ${message}`, async t => {
    const s = await setup(t, () => ({ status, message }));
    await assert.rejects(s.call(), { code: 'MODEL_ERROR' });
    assert.equal(s.seen.length, count);
    assert(!JSON.stringify(s.reports).includes('fault-key'));
  });
}

test('failure after tool retains tool result and executes tool only once across fallback', async t => {
  const s = await setup(t, (body, n) => n === 1 ? { tool: true } : body.model === 'a' ? { status: 503 } : { text: '证据保留' });
  let calls = 0;
  const tool = { name: 'probe', label: 'probe', description: 'probe', parameters: { type: 'object', properties: {} }, execute: async () => { calls++; return { content: [{ type: 'text', text: 'retained-evidence' }] }; } };
  assert.equal(await s.call({ customTools: [tool], maxRequests: 2, maxToolRounds: 1 }), '证据保留');
  assert.equal(calls, 1);
  assert.equal(s.seen.length, 4);
  assert(s.seen.slice(1).every(r => r.messages.some(m => m.role === 'tool' && m.content.includes('retained-evidence'))));
  assert(s.seen.slice(1).every(r => !r.tools?.length));
});

test('429 respects Retry-After before fallback, deadline prevents early retry', async t => {
  const s = await setup(t, (_, n) => n === 1 ? { status: 429, headers: { 'retry-after': '0.05' }, message: 'model rate limit' } : {});
  assert.equal(await s.call(), '成功');
  assert.equal(s.reports[0].requests[0].retryAfterMs, 50);
  assert.equal(s.reports[0].requests[0].delayMs, 50);
  const blocked = await setup(t, () => ({ status: 429, headers: { 'retry-after': '60' }, message: 'model rate limit' }));
  await assert.rejects(blocked.call({ timeout: 500 }), { code: 'MODEL_ERROR' });
  assert.equal(blocked.seen.length, 1);
});

test('partial tool call from interrupted stream never executes', async t => {
  const s = await setup(t, (_, n) => n === 1 ? { tool: true, interrupt: true } : {});
  let calls = 0;
  await s.call({ customTools: [{ name: 'probe', label: 'probe', description: 'probe', parameters: { type: 'object', properties: {} }, execute: async () => { calls++; return { content: [] }; } }] });
  assert.equal(calls, 0);
  assert.equal(s.seen.length, 2);
});

test('per-attempt timeout advances model and total deadline cancels hanging request', async t => {
  const s = await setup(t, body => body.model === 'a' ? 'hang' : {}, { attemptTimeoutMs: 70, sameModelRetries: 0 });
  assert.equal(await s.call(), '成功');
  assert.deepEqual(s.seen.map(r => r.model), ['a', 'b']);
  const start = Date.now();
  await assert.rejects(s.call({ timeout: 50 }), e => ['MODEL_TIMEOUT', 'MODEL_ERROR'].includes(e.code));
  assert(Date.now() - start < 1000);
});
