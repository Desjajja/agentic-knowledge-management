// Read-only live retrieval evaluation. Credentials arrive on stdin, never in artifacts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { configureModel, answer, runPi } from '../src/pi.js';
import { resolveVault, json, pages } from '../src/storage.js';
import { retrieveEvidence, evidenceForModel } from '../src/evidence.js';
import { knowledgeTools } from '../src/pi-tools.js';

const out = path.resolve('artifacts/query-paths-2026-10-15');
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-query-eval-'));
const live = resolveVault(path.join(os.homedir(), '.akm'));
const vault = path.join(root, 'vaults/default');
fs.cpSync(live.dir, vault, { recursive: true, filter: p => !['.raw', '.vault-meta', 'runs'].includes(path.basename(p)) });
fs.mkdirSync(path.join(vault, '.vault-meta/transactions'), { recursive: true });
fs.mkdirSync(path.join(root, 'workspaces/default'), { recursive: true });
fs.writeFileSync(path.join(root, 'config.json'), json({ schema: 1, defaultVault: live.manifest.id, defaultWorkspace: 'default' }));
fs.writeFileSync(path.join(root, 'workspaces/default/workspace.json'), json({ schema: 1, activeVaultId: live.manifest.id, vaultId: live.manifest.id }));
const input = readline.createInterface({ input: process.stdin });
const key = (await input.question('')).trim();
input.close();
process.env.AKM_EVALUATION_KEY = key;
const save = (name, value) => fs.writeFileSync(path.join(out, `${name}.json`), json(value).replaceAll(key, '[REDACTED]'));
const before = pages(live.dir).map(p => [p.path, p.hash]);
configureModel(root, 'default', { baseUrl: 'https://aigc.sankuai.com/v1/openai/native', model: 'deepseek-v4-flash', apiKeyEnv: 'AKM_EVALUATION_KEY', thinkingEnabled: true });
const cases = [
  { id: 'q1-price', query: '为什么永续合约用标记价格而不是最新成交价判断强平？', expected: ['永续合约基础与三价体系', '保证金模式与强平清算数学'] },
  { id: 'q2-arbitrage', query: '跨交易所资金费率套利怎样保持 Delta 中性，仍有哪些风险？', expected: ['顶级交易员模型与套利做市策略', '资金费率机制与定价模型'] },
  { id: 'q3-inventory', query: 'Avellaneda-Stoikov 中库存为正时，保留价格怎么调整？', expected: ['顶级交易员模型与套利做市策略'] },
  { id: 'q4-vpin', query: 'VPIN 上升时做市程序应该怎样调整挂单？', expected: ['顶级交易员模型与套利做市策略'] },
  { id: 'q5-music-negative', query: '和弦第一转位与第二转位的低音分别是什么？', expected: [], negative: true },
  { id: 'q6-english', query: 'Funding Rate Arbitrage liquidation basis risk', expected: ['顶级交易员模型与套利做市策略', '资金费率机制与定价模型'] },
  { id: 'q7-zero', query: 'quasarzygomatic987654', expected: [], negative: true },
];
const summary = { date: '2026-10-15', model: 'deepseek-v4-flash', vault: live.manifest.name, snapshot: before, retrieval: [], answers: [] };
try {
  for (const c of cases) {
    const started = Date.now();
    // Execute the installed CLI from an unrelated cwd; no domain hint.
    const run = spawnSync(path.join(os.homedir(), '.local/bin/akm'), ['retrieve', '--query', c.query, '--json'], { cwd: os.tmpdir(), encoding: 'utf8' });
    const result = JSON.parse(run.stdout || run.stderr);
    save(c.id, result);
    const titles = result.data?.results?.map(p => p.title) ?? [];
    summary.retrieval.push({ ...c, exit: run.status, elapsedMs: Date.now() - started, titles, relevantHits: c.expected.filter(t => titles.includes(t)), negativeClean: c.negative ? titles.length === 0 : undefined });
  }
  save('summary', summary);
  for (const c of [cases[1], cases[4], cases[6]]) {
    const calls = [], trace = [], started = Date.now();
    try {
      const result = await answer(root, 'default', vault, c.query, { timeout: 90000, onResult: r => calls.push(r), onTrace: t => trace.push(t) });
      save(`${c.id}-answer`, { query: c.query, result, calls, trace });
      summary.answers.push({ id: c.id, ok: true, elapsedMs: Date.now() - started, answer: result.answer, tools: calls.flatMap(r => r.tools), requests: calls.reduce((n, r) => n + r.requestCount, 0) });
    } catch (error) {
      save(`${c.id}-answer`, { query: c.query, error: { code: error.code, message: error.message }, calls, trace });
      summary.answers.push({ id: c.id, ok: false, code: error.code, elapsedMs: Date.now() - started });
    }
    save('summary', summary);
    console.log(json(summary.answers.at(-1)));
  }
  // Diagnostic setup: initial evidence is deliberately short. Production uses 24000.
  const query = cases[2].query;
  const evidence = retrieveEvidence(vault, query, { budgetChars: 600, k: 1 });
  const trace = [], calls = [], discovered = new Map(evidence.results.map(p => [p.path, p.hash]));
  const tools = knowledgeTools(vault, { discovered, maxCalls: 1, onTrace: t => trace.push(t) });
  try {
    const response = await runPi(root, 'default', `只根据证据回答中文问题并引用原文。若证据截断或缺少所需公式，应先补齐再回答。优先批量补证。问题：${query}\n证据：${json(evidenceForModel(evidence))}`, { timeout: 90000, customTools: tools, maxRequests: 2, maxToolRounds: 1, onResult: r => calls.push(r), onTrace: t => trace.push(t) });
    save('bounded-tool-diagnostic', { diagnosticOnly: true, query, initialEvidence: evidence, response, calls, trace });
    summary.boundedDiagnostic = { ok: true, tools: calls.flatMap(r => r.tools), response };
  } catch (error) {
    summary.boundedDiagnostic = { ok: false, code: error.code, tools: calls.flatMap(r => r.tools) };
    save('bounded-tool-diagnostic', { diagnosticOnly: true, error: { code: error.code, message: error.message }, calls, trace });
  }
  summary.liveNotesUnchanged = json(before) === json(pages(live.dir).map(p => [p.path, p.hash]));
  save('summary', summary);
  console.log(json(summary));
} finally {
  delete process.env.AKM_EVALUATION_KEY;
  fs.rmSync(root, { recursive: true, force: true });
}
