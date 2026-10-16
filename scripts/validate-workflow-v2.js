// Isolated real-provider validation. Key enters stdin/env, never a file or argv.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { init, resolveVault, pages, json, readJSON, listFiles, hash } from '../src/storage.js';
import { editProposal, applyProposal, showPage } from '../src/knowledge.js';
import { answer, configureModel, extract, runPi } from '../src/pi.js';
import { retrieve } from '../src/retrieve.js';
import { knowledgeTools } from '../src/pi-tools.js';
const repo = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(repo, 'artifacts/workflow-v2-2026-10-12');
fs.mkdirSync(output, { recursive: true });
const rl = readline.createInterface({ input: process.stdin });
const keyName = 'AKM_V2_PROVIDER_KEY';
const key = process.env[keyName] ?? await rl.question('');
process.env[keyName] = key;
const mode = process.argv[2] ?? 'scenario';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (file, value) => { const p = path.join(output, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, (typeof value === 'string' ? value : json(value)).replaceAll(key, '[REDACTED]')); };
const callsFile = path.join(output, 'model-calls.json');
let rateLimitDetected = false;
const calls = fs.existsSync(callsFile) ? readJSON(callsFile) : [];
function hooks(stage) {
  let trace = 0; const attempt = Date.now();
  return { timeout: 300000, onTrace: value => write(`trace/${stage}-${attempt}-${++trace}-${value.phase}.json`, value), onResult: value => { if (['rate_limit','quota_or_billing'].includes(value.failureKind)) rateLimitDetected = true; calls.push({ stage, at: new Date().toISOString(), ...value }); write('model-calls.json', calls); console.log(json({ stage, status: value.status, requests: value.requestCount, tokens: value.usage.totalTokens, ms: value.elapsedMs })); } };
}
const configure = root => configureModel(root, 'default', { baseUrl: 'https://aigc.sankuai.com/v1/openai/native', model: 'deepseek-v4-flash', apiKeyEnv: keyName, thinkingEnabled: true });
async function approve(vault, p, stage) {
  write(`${stage}/proposal-original.json`, p);
  console.log(json({ stage: `${stage}-review`, proposal: p }));
  const command = (await rl.question('Review: labels OR edits.json labels: ')).trim().split(/\s+/);
  if (command.length === 2) { p = editProposal(vault, p.id, p.revision, readJSON(path.join(output, command[0])).edits); write(`${stage}/proposal-reviewed.json`, p); console.log(json({ stage: `${stage}-reviewed`, proposal: p })); }
  const labels = command.at(-1);
  if (!/^\d+(,\d+)*$/.test(labels)) throw new Error('Review stopped');
  const receipt = applyProposal(vault, p.id, p.revision, labels.split(',').map(Number));
  write(`${stage}/receipt.json`, receipt);
  return { p, receipt };
}
async function scenario() {
  const root = path.join(output, 'scenario-root');
  if (!fs.existsSync(path.join(root, 'config.json'))) init(root, 'workflow-validation');
  configure(root); const vault = resolveVault(root).dir;
  const conversation = { conversation_id: 'architecture-review-v2', messages: [
    { id: 'm1', role: 'user', content: '我们讨论订单项目的缓存、故障恢复和发布流程，请把这三个主题分别整理，保留关键条件。' },
    { id: 'm2', role: 'assistant', content: '建议客户端缓存作为最终事实来源，TTL 固定为30分钟，断网时照常确认交易。' },
    { id: 'm3', role: 'user', content: '拒绝客户端作为事实来源，也不允许断网确认交易。服务端状态才是事实来源。' },
    { id: 'm4', role: 'user', content: '先试试TTL 5分钟，服务端事件到达后再刷新缓存。' },
    { id: 'm5', role: 'assistant', content: '故障恢复可以先显示旧状态，再等下一次定期刷新。' },
    { id: 'm6', role: 'user', content: '不同意。重连必须先从服务端恢复完整状态，再处理有序事件。缓存不能用于判断是否已成交。' },
    { id: 'm7', role: 'user', content: '撤回固定TTL 5分钟的方案。最终确认缓存仅辅助展示，以服务端版本号和事件失效为准。事件丢失或乱序时重新拉取完整状态。' },
    { id: 'm8', role: 'assistant', content: '发布时可以直接覆盖所有实例，也许简单一些。' },
    { id: 'm9', role: 'user', content: '发布流程暂定灰度5%后观察10分钟；这是待评估建议，不是最终决定。' },
    { id: 'm10', role: 'user', content: '确认前面的服务端状态、事件失效和重连恢复决定。不要把被拒绝的助手建议或已撤回的TTL作为当前方案。' },
  ] };
  write('scenario-input/conversation.json', conversation);
  const convReceipt = path.join(output, 'conversation/receipt.json');
  if (!fs.existsSync(convReceipt)) await approve(vault, await extract(root, 'default', vault, conversation, { kind: 'conversation', project: '订单系统', ...hooks('conversation') }), 'conversation');
  const document = fs.readFileSync(path.join(repo, 'artifacts/distributed-systems-2026-10-12/inputs/s2.md'), 'utf8');
  write('scenario-input/locking.md', document);
  const documentReceipt = path.join(output, 'document/receipt.json');
  if (!fs.existsSync(documentReceipt)) await approve(vault, await extract(root, 'default', vault, document, { kind: 'document', name: 'How to do distributed locking', project: '分布式系统', ...hooks('document') }), 'document');
  const count = calls.length, pageCount = pages(vault).length;
  const reused = await extract(root, 'default', vault, document, { kind: 'document', name: 'renamed-copy.md', project: '分布式系统', ...hooks('duplicate') });
  write('duplicate.json', { reused, callsBefore: count, callsAfter: calls.length, pagesBefore: pageCount, pagesAfter: pages(vault).length });
  if (!reused.reused || calls.length !== count || pages(vault).length !== pageCount) throw new Error('Duplicate ingestion failed');
  if (!fs.existsSync(path.join(output, 'update/receipt.json'))) {
    const target = readJSON(convReceipt).pages[0];
    const updateInput = { conversation_id: 'architecture-review-v2-followup', messages: [{ id: 'm11', role: 'user', content: '补充最终决定：缓存展示必须同时显示对应服务端版本号；重连恢复失败时显示状态未知，禁止用旧缓存判断成交。原先服务端为事实来源、事件失效和TTL撤回等决定继续有效。' }] };
    write('scenario-input/update.json', updateInput);
    await approve(vault, await extract(root, 'default', vault, updateInput, { kind: 'conversation', project: '订单系统', target, ...hooks('update') }), 'update');
    write('update/page-after.json', showPage(vault, target));
  }
  const questions = [
    ['conversation-retrieve', '最终采用了固定5分钟 TTL 吗？断网和重连时，如何确认订单是否已成交？恢复失败及缓存版本如何展示？', '订单系统'],
    ['document-retrieve', 'fencing token 相同的请求也必须被拒绝吗？检查发生在哪端？这篇文章后来有没有争议或修订？', '分布式系统'],
    ['missing-fact', '这篇锁文章中作者生产集群性能测试的精确吞吐是多少？', '分布式系统'],
  ];
  for (const [stage, query, project] of questions) {
    if (fs.existsSync(path.join(output, `${stage}.json`))) continue;
    const result = await answer(root, 'default', vault, query, { project, ...hooks(stage) });
    write(`${stage}.json`, result); console.log(json({ stage, answer: result.answer }));
  }
  const cli = path.join(repo, 'bin/akm.js');
  const result = spawnSync(process.execPath, [cli, 'retrieve', '--project', '订单系统', '--query', '重连', '--json'], { cwd: '/tmp', env: { ...process.env, AKM_HOME: root }, encoding: 'utf8' });
  write('external-cwd.json', { cwd: '/tmp', status: result.status, stdout: JSON.parse(result.stdout), stderr: result.stderr });
  if (result.status || !JSON.parse(result.stdout).data.results.length) throw new Error('Cross-cwd discovery failed');
  const movedRoot = path.join(output, 'moved-root');
  if (!fs.existsSync(movedRoot)) fs.cpSync(root, movedRoot, { recursive: true });
  const moved = spawnSync(process.execPath, [cli, 'retrieve', '--query', '重连', '--json'], { cwd: '/tmp', env: { ...process.env, AKM_HOME: movedRoot }, encoding: 'utf8' });
  write('migration.json', { status: moved.status, evidence: JSON.parse(moved.stdout).data });
  if (moved.status) throw new Error('Folder migration failed');
  write('scenario-corpus.json', pages(vault));
}
async function chunked() {
  const root = path.join(output, 'chunked-root');
  if (!fs.existsSync(path.join(root, 'config.json'))) init(root, 'chunked-validation');
  configure(root); const vault = resolveVault(root).dir;
  const source = ['s1','s2'].map(id => fs.readFileSync(path.join(repo, `artifacts/distributed-systems-2026-10-12/inputs/${id}.md`), 'utf8')).join('\n\n---\n\n');
  write('source.md', source);
  const proposal = await extract(root, 'default', vault, source, {kind:'document',name:'Kleppmann CAP and locking essays',project:'分布式系统',...hooks('chunked-extract')});
  write('proposal.json', proposal);
  console.log(json({stage:'chunked-proposal',coverage:proposal.sourceCoverage,items:proposal.items.map(i=>({label:i.label,title:i.title,issues:i.issues}))}));
}
async function evaluate() {
  const questions = readJSON(path.join(repo, 'artifacts/distributed-systems-2026-10-12/questions.json')).queries;
  const roots = {};
  for (const [label, original] of Object.entries({ english: 'artifacts/distributed-systems-2026-10-12/akm-root', chinese: 'artifacts/ux-validation-2026-10-12/akm-root' })) {
    const root = path.join(output, `${label}-root`);
    if (!fs.existsSync(root)) fs.cpSync(path.join(repo, original), root, { recursive: true });
    configure(root); roots[label] = root;
    write(`${label}/corpus.json`, pages(resolveVault(root).dir));
  }
  const tasks = Object.entries(roots).flatMap(([label, root]) => questions.map(question => ({ label, root, question })));
  for (let i = 0; i < tasks.length; i += 1) {
    if (rateLimitDetected) { console.log('Provider limited; waiting 60 seconds before next task'); await pause(60000); rateLimitDetected = false; }
    const results = await Promise.allSettled(tasks.slice(i, i + 1).map(async ({ label, root, question }) => {
      const stage = `${label}-${question.id}`, file = `${label}/${question.id}.json`;
      if (fs.existsSync(path.join(output, file))) return;
      const started = Date.now();
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await answer(root, 'default', resolveVault(root).dir, question.text, { project: question.project ?? '分布式系统', k: 3, ...hooks(stage + (attempt ? `-retry${attempt}` : '')) }); break; }
        catch (error) { if (!rateLimitDetected || attempt === 2) throw error; console.log('Rate/quota refusal; bounded retry in 60 seconds'); await pause(60000); rateLimitDetected = false; }
      }
      write(file, { question, elapsedMs: Date.now() - started, ...result });
    }));
    await pause(5000);
    results.forEach((r, n) => { if (r.status === 'rejected') write(`failures/${tasks[i + n].label}-${tasks[i + n].question.id}.json`, { code: r.reason.code, message: r.reason.message }); });
  }
  // Same frozen English corpus, same provider, 2 natural questions x 5 interleaved repeats x 3 strategies.
  const root = roots.english, vault = resolveVault(root).dir, strategies = ['A', 'B', 'C'];
  for (let repeat = 0; repeat < 5; repeat++) for (const question of questions.filter(q => ['q01', 'q03'].includes(q.id))) {
    const ordered = strategies.slice(repeat % 3).concat(strategies.slice(0, repeat % 3));
    // Sequential interleaving prevents concurrent-request contention in latency comparison.
    for (const strategy of ordered) {
      if (rateLimitDetected) { console.log('Provider limited; waiting 60 seconds before next task'); await pause(60000); rateLimitDetected = false; }
      await pause(5000);
      const stage = `abc-${question.id}-${repeat + 1}-${strategy}`, file = `abc/${stage}.json`;
      if (fs.existsSync(path.join(output, file))) continue;
      const started = Date.now(), h = hooks(stage);
      try {
        let result;
        if (strategy === 'C') result = await answer(root, 'default', vault, question.text, { project: '分布式系统', k: 3, ...h });
        else {
          const selected = strategy === 'A' ? pages(vault) : retrieve(vault, question.text, { project: '分布式系统', k: 3 }).results.map(p => showPage(vault, p.path));
          const evidence = selected.map(p => ({ path: p.path, hash: p.hash, title: p.title, citation: `[[${p.path.slice(0,-3)}|${p.title}]]`, content: strategy === 'A' ? p.body : p.body.slice(0,4000), contentTruncated: strategy === 'B' && p.body.length > 4000 }));
          const discovered = new Map(evidence.map(p => [p.path, p.hash]));
          const tools = strategy === 'B' ? knowledgeTools(vault, { project: '分布式系统', discovered, onTrace: h.onTrace }).filter(t => t.name !== 'akm_retrieve_evidence') : [];
          const text = await runPi(root, 'default', `Answer in concise Simplified Chinese using only provided evidence and tool results. Read missing required passages; say when evidence is insufficient. Preserve comparisons, author attribution and later corrections. Cite exact provided wiki citations. QUESTION=${json(question.text)}\nEVIDENCE=${json(evidence)}`, { ...h, customTools: tools, maxRequests: 4 });
          result = { answer: text, evidence };
        }
        write(file, { question, repeat: repeat + 1, strategy, elapsedMs: Date.now() - started, ...result });
      } catch (e) { write(`failures/${stage}.json`, { code: e.code, message: e.message }); }
    }
  }
  write('evaluation-complete.json', { calls: calls.length, completedAt: new Date().toISOString(), caveat: 'No correctness inferred from HTTP success; manually review answers and source fidelity separately. A uses all pages, B top3 prefix and free tools, C diversified top3 aggregated passages.' });
}
try { if (mode === 'scenario') await scenario(); else if (mode === 'evaluate') await evaluate(); else if (mode === 'chunked') await chunked(); else throw new Error('Unknown mode'); }
catch (e) { write(`${mode}-failure.json`, { code: e.code, message: e.message }); console.error(json({ code: e.code, message: e.message })); process.exitCode = 1; }
finally { delete process.env[keyName]; rl.close(); }
