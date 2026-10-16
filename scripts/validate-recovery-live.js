// Actual API validation. Credential arrives on stdin; all persistent state is
// under an isolated artifacts root. Never changes the user's AKM_HOME.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { configureModel, runPi, extract, answer } from '../src/pi.js';
import { init, resolveVault, pages, json, activeVaultStatus, setActiveVault } from '../src/storage.js';
import { applyProposal, inspectProposal, showPage, editProposal } from '../src/knowledge.js';
import { retrieveEvidence, evidenceForModel } from '../src/evidence.js';
import { knowledgeTools } from '../src/pi-tools.js';

const out = path.resolve('artifacts/recovery-validation-2026-10-15');
const mode = process.argv[2] ?? 'probe';
const root = path.join(out, ['answers', 'tools'].includes(mode) ? `test-${mode}` : 'test-akm');
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join(root, 'config.json'))) init(root, 'test-vault');
// Every live validation explicitly selects the isolated test Vault, then
// restores the previous selection even when the provider or a tool fails.
const previousActive = activeVaultStatus(root);
const testVaultName = previousActive.vault.name === 'test-vault' ? 'test-vault' : 'test';
setActiveVault(root, testVaultName);
const confirmedTest = activeVaultStatus(root);
if (confirmedTest.vault.name !== testVaultName) throw new Error(`Test Vault was not activated: ${testVaultName}`);
const vault = resolveVault(root, confirmedTest.vault.id).dir;
const input = readline.createInterface({ input: process.stdin });
const key = (await input.question('')).trim(); input.close();
if (!key) throw new Error('Credential required on stdin');
process.env.AKM_VALIDATION_KEY = key;
const save = (name, value) => {
  const file = path.join(out, `${name}.json`); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json(value).replaceAll(key, '[REDACTED]'));
};
const baseUrl = 'https://aigc.sankuai.com/v1/openai/native';
const models = ['DeepSeek-V3-FRIDAY', 'LongCat-Flash-Chat', 'MiniMax-M2.7'];
const configure = (workspace, model, fallback = []) => configureModel(root, workspace, { baseUrl, model, fallback, apiKeyEnv: 'AKM_VALIDATION_KEY', recovery: { attemptTimeoutMs: 30000 } });
const snapshot = () => {
  const liveRoot = path.join(os.homedir(), '.akm');
  const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? walk(file) : [file];
  }) : [];
  return walk(path.join(liveRoot, 'vaults')).sort().map(file => [path.relative(liveRoot, file), fs.statSync(file).size, fs.statSync(file).mtimeMs]);
};
async function recorded(id, fn) {
  const calls = [], trace = [], started = Date.now();
  const hooks = { timeout: 120000, onResult: value => calls.push(value), onTrace: value => trace.push(value) };
  let record;
  try { record = { id, ok: true, result: await fn(hooks), calls, trace }; }
  catch (e) { record = { id, ok: false, error: { code: e.code ?? e.name, message: e.message }, calls, trace }; }
  record.elapsedMs = Date.now() - started; save(`runs/${id}`, record);
  console.log(json({ id, ok: record.ok, elapsedMs: record.elapsedMs, models: calls.flatMap(c => c.requests.map(r => [r.model, r.httpStatus, r.failureKind])), error: record.error }));
  return record;
}
const before = snapshot();
save('production-before', before);
try {
  if (mode === 'diagnostic') {
    const res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: json({ model: models[0], messages: [{ role: 'user', content: '只回复：连接成功' }], stream: false }), signal: AbortSignal.timeout(30000) });
    const data = await res.json();
    const diagnostic = { status: res.status, error: { code: data.error?.code, type: data.error?.type, message: String(data.error?.message ?? data.message ?? '').slice(0, 600) }, model: data.model, text: data.choices?.[0]?.message?.content };
    save('primary-diagnostic', diagnostic); console.log(json(diagnostic).replaceAll(key, '[REDACTED]'));
    configure('diagnostic', models[0]);
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      if (args[1]?.body) save('primary-sdk-payload', JSON.parse(args[1].body));
      const response = await original(...args);
      if (response.status >= 400) {
        const body = await response.clone().json().catch(() => ({}));
        const error = { status: response.status, message: String(body.error?.message ?? body.message ?? '').slice(0, 600) };
        save('primary-sdk-diagnostic', error); console.log(json(error).replaceAll(key, '[REDACTED]'));
      }
      return response;
    };
    try { await recorded('primary-sdk-diagnostic', hooks => runPi(root, 'diagnostic', '只回复连接成功', { ...hooks, maxRequests: 1 })); }
    finally { globalThis.fetch = original; }
  } else if (mode === 'probe') {
    const results = [];
    for (const [index, model] of models.entries()) {
      const workspace = `probe-${index}`; configure(workspace, model);
      for (const kind of ['plain', 'json', 'tools']) {
        let executions = 0;
        const customTools = kind === 'tools' ? [{ name: 'read_probe', label: '读取测试值', description: '读取测试值，必须读取后才能回答。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { executions++; return { content: [{ type: 'text', text: '随机测试值是 akm-probe-7319' }] }; } }] : [];
        const prompts = { plain: '只回复：连接成功', json: '只返回 JSON，不要代码块：{"ok":true,"language":"中文"}', tools: '调用 read_probe 获取测试值，然后只输出该值。' };
        const record = await recorded(`probe-${index}-${kind}`, async hooks => {
          const text = await runPi(root, workspace, prompts[kind], { ...hooks, timeout: 70000, customTools, maxRequests: kind === 'tools' ? 2 : 1 });
          return { text, executions, valid: kind === 'tools' ? executions === 1 && text.includes('akm-probe-7319') : kind === 'json' ? JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')).ok === true : text.includes('连接成功') };
        });
        results.push({ model, kind, ok: record.ok, valid: record.result?.valid }); save('compatibility', results);
      }
    }
  } else if (mode === 'ingest') {
    configure('default', models[0], models.slice(1));
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'sources.json')));
    const ledgerFile = path.join(out, 'ingestion.json');
    const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile)) : [];
    for (const source of manifest.filter(s => s.ok)) {
      if (ledger.some(r => r.source === source.id && r.ok)) continue;
      const text = fs.readFileSync(path.join(out, 'inputs', source.file), 'utf8');
      const r = await recorded(`ingest-${source.id}`, hooks => extract(root, 'default', vault, text, { ...hooks, kind: 'document', name: source.file, project: source.domain }));
      // Store drafts for a separate human/agent review pass; do not auto-commit.
      ledger.push({ source: source.id, ok: r.ok, proposal: r.result?.id, revision: r.result?.revision, itemCount: r.result?.items?.length });
      save('ingestion', ledger);
    }
  } else if (mode === 'answers') {
    configure('default', models[0], models.slice(1));
    const cases = JSON.parse(fs.readFileSync(path.join(out, 'questions.json'))).filter(q => q.answerTest);
    for (const q of cases) await recorded(`answer-${q.id}`, hooks => answer(root, 'default', vault, q.query, { ...hooks, project: q.domain, k: 3 }));
  } else if (mode === 'workflow') {
    configure('default', models[0], models.slice(1));
    const conversation = { conversation_id: 'isolated-design-review', messages: [
      { id: 'u1', role: 'user', content: '音乐练习安排：之前考虑每天练两个小时，但取消这个方案。' },
      { id: 'a1', role: 'assistant', content: '建议每天 90 分钟并购买新钢琴。' },
      { id: 'u2', role: 'user', content: '最终决定：每天练习 25 分钟，前 10 分钟练 C 大调三和弦转位，后 15 分钟练视唱。暂不购买新钢琴。' },
    ] };
    const p = await recorded('conversation-propose', hooks => extract(root, 'default', vault, conversation, { ...hooks, kind: 'conversation', project: '音乐理论' }));
    if (p.ok) save('conversation-pending', inspectProposal(vault, p.result.id));
    const target = pages(vault).find(p => p.domain === '音乐理论' && /三和弦/.test(p.title));
    if (target) {
      const update = '本次审阅补充：仅以 C 大三和弦为例，原位最低音 C，第一转位最低音 E，第二转位最低音 G。转位由最低音决定，不由最高音决定。其他既有事实继续保留。';
      const r = await recorded('document-update-propose', hooks => extract(root, 'default', vault, update, { ...hooks, kind: 'document', name: 'reviewed-inversion-example.md', target: target.path, project: '音乐理论' }));
      if (r.ok) save('update-pending', inspectProposal(vault, r.result.id));
    }
  } else if (mode === 'tools') {
    configure('default', models[0], models.slice(1));
    const query = '为什么租约过期后仍需要 fencing token，token 在哪一侧检查？';
    const evidence = retrieveEvidence(vault, query, { k: 1, budgetChars: 600 });
    const discovered = new Map(evidence.results.map(p => [p.path, p.hash]));
    await recorded('natural-supplement-tool', hooks => runPi(root, 'default', `根据本地证据回答，缺少关键证据时补查。回答中文并给出引用。问题：${query}\n初始证据：${json(evidenceForModel(evidence))}`, { ...hooks, customTools: knowledgeTools(vault, { discovered, maxCalls: 1, onTrace: hooks.onTrace }), maxRequests: 2, maxToolRounds: 1 }));
  } else throw new Error(`Unknown mode: ${mode}`);
} finally {
  setActiveVault(root, previousActive.vault.id);
  const restored = activeVaultStatus(root);
  if (restored.vault.id !== previousActive.vault.id) throw new Error('Active Vault restoration failed');
  delete process.env.AKM_VALIDATION_KEY;
  const after = snapshot(); save('production-check', { unchanged: json(before) === json(after), beforeCount: before.length, afterCount: after.length });
}
