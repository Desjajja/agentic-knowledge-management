// Controlled pi-host comparison. This is not an external Codex trigger test.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { configureModel, runPi } from '../src/pi.js';
import { json, resolveVault } from '../src/storage.js';
import { retrieveEvidence, evidenceForModel } from '../src/evidence.js';
const out = path.resolve('artifacts/recovery-validation-2026-10-15');
const directed = process.argv[2] === 'directed';
const contextual = process.argv[2] === 'contextual';
const resultPrefix = directed ? 'adapter-directed' : contextual ? 'adapter-contextual' : 'adapter';
const root = path.join(out, 'test-akm'), vault = resolveVault(root).dir;
const armRoots = Object.fromEntries(['native-tool', 'skill-cli'].map(arm => {
  const copy = path.join(out, `${resultPrefix}-vault-${arm}`);
  if (!fs.existsSync(copy)) fs.cpSync(root, copy, { recursive: true });
  return [arm, copy];
}));
const input = readline.createInterface({ input: process.stdin });
const key = (await input.question('')).trim(); input.close(); process.env.AKM_ADAPTER_KEY = key;
const workspace = `comparison-${resultPrefix}`;
configureModel(root, workspace, { baseUrl: 'https://aigc.sankuai.com/v1/openai/native', model: 'LongCat-Flash-Chat', fallback: ['MiniMax-M2.7'], apiKeyEnv: 'AKM_ADAPTER_KEY', recovery: { attemptTimeoutMs: 20000 } });
const questions = JSON.parse(fs.readFileSync(path.join(out, 'questions.json')));
const positives = [0, 2, 4, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 38, 42, 47].map(index => ({ id: questions[index].id, prompt: questions[index].query, expected: true }));
const controls = ['把 hello 翻译成中文。', '计算 17 乘以 23。', '请写三句生日祝福。', '把“明天开会”改写得礼貌一些。', '只回复：收到。', '将这三个词按字母顺序排序：pear apple banana。', '不要查资料，给“夏天”造一个句子。', '把这段文字中的空格去掉：a b c。'].map((prompt, i) => ({ id: `control-${i+1}`, prompt, expected: false }));
const contextualPrompts = [
  { id:'memory-lock', prompt:'我之前整理过 Martin 对分布式锁的文章。按我保存的那版内容，存储服务器究竟拒绝更小还是小于等于的 fencing token？', expected:true },
  { id:'memory-inversion', prompt:'我之前存的音乐材料里有一个 inversion。那篇讲的是和弦最低音转位，还是 TnI 音级反演？', expected:true },
  { id:'memory-stats', prompt:'我之前归档的 NIST 材料，对柯西分布的位置度量推荐均值还是中位数？别混成一般正态数据的结论。', expected:true },
];
const prompts = directed ? positives.slice(0,3).map(q=>({...q,prompt:`请检索我本地已经归档的资料，并根据证据回答：${q.prompt}`})) : contextual ? contextualPrompts : [...positives, ...controls];
fs.writeFileSync(path.join(out, `${resultPrefix}-prompts.json`), json(prompts));
const parameters = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const textResult = data => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : json(data) }] });
const tasks = [];
for (let repeat = 1; repeat <= 3; repeat++) for (const q of prompts) for (const arm of ['native-tool', 'skill-cli']) tasks.push({ ...q, repeat, arm });
fs.mkdirSync(path.join(out, `${resultPrefix}-runs`), { recursive: true });
async function execute(task) {
  const file = path.join(out, `${resultPrefix}-runs`, `${task.id}-${task.repeat}-${task.arm}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  const calls = [], observed = [], traces = []; let loaded = false;
  const armRoot = armRoots[task.arm], armVault = resolveVault(armRoot).dir;
  const tool = task.arm === 'native-tool' ? {
    name: 'akm_retrieve', label: '本地知识检索', parameters,
    description: '查询个人已归档知识：分布式系统、音乐理论、统计学。一次返回引用与原文证据。无需模型自行记忆这些知识。只读。',
    execute: async (_id, { query }) => { observed.push('retrieve'); return textResult(evidenceForModel(retrieveEvidence(armVault, query, { k: 3, budgetChars: 12000 }))); },
  } : {
    name: 'akm_cli', label: 'AKM 检索命令', parameters,
    description: '执行 AKM skill 所述的 retrieve 命令，参数为 query。先读取 skill 才能使用。只读，目录由宿主固定。',
    execute: async (_id, { query }) => {
      if (!loaded) return textResult({ error: 'Read skill first' });
      observed.push('retrieve');
      const result = spawnSync(process.execPath, [path.resolve('bin/akm.js'), 'retrieve', '--root', armRoot, '--query', query, '--k', '3', '--budget', '12000', '--json'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000 });
      if (result.status) throw new Error('Isolated CLI failed');
      return textResult(JSON.parse(result.stdout).data);
    },
  };
  const skill = { name: 'read_skill', label: '读取技能', description: 'akm: Use when a local Obsidian-compatible knowledge vault can improve an answer, or when summarizing conversations and ingesting Markdown/TXT documents into a reviewed knowledge base. Available knowledge: 分布式系统、音乐理论、统计学。读取使用说明，不执行检索。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { loaded = true; observed.push('skill-read'); return textResult(fs.readFileSync(path.resolve('skills/akm/SKILL.md'), 'utf8')); } };
  const started = Date.now(); let result;
  try {
    const answer = await runPi(root, workspace, task.prompt, { timeout: 70000, maxRequests: 5, maxToolRounds: 4, systemPrompt: '你是中文个人工作助理。根据用户问题自行决定是否使用可用资源；使用资料时引用工具提供的真实引用，证据不足则说明。工具均只读并固定为本次测试资料，禁止写入或访问其他目录。', customTools: task.arm === 'native-tool' ? [tool] : [skill, tool], onResult: r => calls.push(r), onTrace: t => traces.push(t) });
    result = { ...task, ok: true, answer };
  } catch (error) { result = { ...task, ok: false, error: { code: error.code, message: error.message } }; }
  Object.assign(result, { observed, triggered: observed.includes('retrieve'), calls, traces, elapsedMs: Date.now()-started });
  fs.writeFileSync(file, json(result).replaceAll(key, '[REDACTED]'));
  console.log(JSON.stringify({ id: task.id, arm: task.arm, repeat: task.repeat, ok: result.ok, triggered: result.triggered, expected: task.expected, elapsedMs: result.elapsedMs }));
  return result;
}
try {
  const results = [];
  // Bound concurrency to avoid manufacturing gateway overload in an efficiency test.
  for (let i = 0; i < tasks.length; i += 2) {
    results.push(...await Promise.all(tasks.slice(i, i+2).map(execute)));
    fs.writeFileSync(path.join(out, `${resultPrefix}-results.json`), json(results.map(({ traces, calls, answer, ...r }) => ({ ...r, usage: calls.map(c => c.usage), models: calls.flatMap(c => c.requests.map(r => r.model)), tools: calls.flatMap(c => c.tools) }))));
  }
} finally { delete process.env.AKM_ADAPTER_KEY; }
