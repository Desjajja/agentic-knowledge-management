// Controlled fault injection against the installed pi SDK; no real provider involved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { json } from '../src/storage.js';

const out = path.resolve('artifacts/query-paths-2026-10-15');
fs.mkdirSync(out, { recursive: true });
const results = [];
for (const spec of [
  { id: 'retry-disabled-503', enabled: false, failures: 1, status: 503 },
  { id: 'retry-enabled-503-recovery', enabled: true, failures: 1, status: 503 },
  { id: 'retry-enabled-persistent-503', enabled: true, failures: 20, status: 503 },
  { id: 'retry-enabled-401', enabled: true, failures: 20, status: 401 },
]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-retry-'));
  let requests = 0;
  const events = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain without storing headers or payload */ }
    requests++;
    if (requests <= spec.failures) {
      res.writeHead(spec.status, { 'Content-Type': 'application/json' });
      res.end(json({ error: { message: spec.status === 401 ? 'Unauthorized' : 'Service temporarily unavailable', type: 'test_error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const delta of [{ role: 'assistant', content: '重试恢复成功' }, {}]) {
      res.write(`data: ${JSON.stringify({ id: 'test', model: 'retry-test', choices: [{ index: 0, delta, finish_reason: delta.content ? null : 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(tmp, 'models.json'), json({ providers: { probe: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-only', models: [{ id: 'retry-test', reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 1024, compat: { supportsStore: false } }] } } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(tmp, 'auth.json'), modelsPath: path.join(tmp, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'Reply briefly.', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({ cwd: tmp, agentDir: tmp, model: runtime.getModel('probe', 'retry-test'), modelRuntime: runtime, resourceLoader, tools: [], sessionManager: SessionManager.inMemory(tmp), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: spec.enabled, maxRetries: 2, baseDelayMs: 10, provider: { maxRetries: 0 } } }) });
  session.subscribe(event => { if (event.type.startsWith('auto_retry')) events.push({ type: event.type, attempt: event.attempt, success: event.success, delayMs: event.delayMs }); });
  const started = Date.now();
  let timer;
  try {
    await Promise.race([session.prompt('ping'), new Promise((_, reject) => { timer = setTimeout(() => { void session.abort(); reject(new Error('test timeout')); }, 15000); })]);
    const last = session.messages.filter(m => m.role === 'assistant').at(-1);
    results.push({ ...spec, requests, elapsedMs: Date.now() - started, stopReason: last?.stopReason, answer: session.getLastAssistantText(), events, providerSwitched: false });
  } catch (error) {
    results.push({ ...spec, requests, elapsedMs: Date.now() - started, error: error.message, events });
  } finally {
    clearTimeout(timer); session.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true });
  }
}
fs.writeFileSync(path.join(out, 'retry-fault-injection.json'), json({ sdk: '@earendil-works/pi-coding-agent@1.1.0', syntheticEndpoint: true, productionChanged: false, results }));
console.log(json(results));
