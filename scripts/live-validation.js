// Real provider validation. Credential lives only in process memory.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { init, resolveVault, json, pages } from '../src/storage.js';
import { configureModel, extract, answer } from '../src/pi.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(repo, 'artifacts/live-validation-2026-10-12'));
const root = path.join(output, 'akm-root');
const terminal = readline.createInterface({ input: process.stdin });
const credentialEnv = 'AKM_LIVE_PROVIDER_KEY';
const credential = process.env[credentialEnv] ?? await terminal.question('');
if (!credential.trim()) throw new Error('Missing API credential');
process.env[credentialEnv] = credential;
fs.mkdirSync(output, { recursive: true });
const save = (name, data) => fs.writeFileSync(path.join(output, name), (typeof data === 'string' ? data : json(data)).replaceAll(credential, '[REDACTED]'));
const resume = process.argv.includes('--resume');
const audit = resume ? JSON.parse(fs.readFileSync(path.join(output, 'model-calls.json'), 'utf8')) : [];
const record = stage => result => { audit.push({ stage, ...result }); save('model-calls.json', audit); console.log(json({ stage, ...result })); };
function cli(args) {
  const result = spawnSync(process.execPath, [path.join(repo, 'bin/akm.js'), ...args, '--root', root, '--json'], { cwd: '/tmp', env: process.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.replaceAll(credential, '[REDACTED]'));
  return JSON.parse(result.stdout).data;
}
async function review(proposal, stage) {
  save(`${stage}-proposal.json`, proposal);
  console.log(json({ stage, proposal }));
  // Review occurs outside the model. The validation operator supplies stable labels.
  const selection = await terminal.question('Review proposal, then enter comma-separated labels (or stop): ');
  if (!/^\d+(,\d+)*$/.test(selection.trim())) throw new Error('Stopped before applying proposal');
  const reviewed = cli(['proposal', 'inspect', proposal.id]);
  if (reviewed.revision !== proposal.revision) throw new Error('Proposal changed during review');
  const receipt = cli(['proposal', 'apply', proposal.id, '--revision', reviewed.revision, '--items', selection.trim()]);
  save(`${stage}-receipt.json`, receipt);
  console.log(json({ stage: `${stage}-applied`, receipt }));
  save(`${stage}-pages.json`, pages(vault));
  return receipt;
}
let vault;
try {
  if (!resume) init(root, 'AKM-live-validation');
  vault = resolveVault(root).dir;
  configureModel(root, 'default', { baseUrl: 'https://aigc.sankuai.com/v1/openai/native', model: 'deepseek-v4-flash', apiKeyEnv: credentialEnv, thinkingEnabled: true });
  const original = resume ? null : fs.readFileSync(path.join(repo, 'docs/mvp-validation.md'), 'utf8');
  // Exact extract from the existing validation record, not made-up project facts.
  const document = resume ? fs.readFileSync(path.join(output, 'input-document.md'), 'utf8') : original.slice(0, original.indexOf('## 检索基准'));
  const sourceFile = path.join(vault, 'inbox/AKM-MVP验证记录.md');
  fs.writeFileSync(sourceFile, document);
  save('input-document.md', document);
  if (!resume) {
    const ingested = await extract(root, 'default', vault, fs.readFileSync(sourceFile, 'utf8'), { kind: 'document', name: path.basename(sourceFile), project: 'AKM', timeout: 300000, onResult: record('document-ingest') });
    await review(ingested, '01-document');
  }

  const conversation = { conversation_id: 'akm-real-validation-requirement-2026-10-12', messages: [
    { id: 'u1', role: 'user', content: '你怎么跑的，我都没给你LLM api' },
    { id: 'u2', role: 'user', content: '完整跑一遍，别忽悠我，真的要结合obsidian和LLM做一次真正场景的最小化验证' },
  ] };
  save('input-conversation.json', conversation);
  if (!resume) {
    const updated = await extract(root, 'default', vault, conversation, { kind: 'conversation', project: 'AKM', timeout: 300000, onResult: record('conversation-extraction') });
    await review(updated, '02-conversation');
  }

  const existingPage = JSON.parse(fs.readFileSync(path.join(output, '01-document-receipt.json'), 'utf8')).pages[0];
  const execution = { conversation_id: 'akm-live-execution-2026-10-12', messages: [
    conversation.messages[1],
    { id: 'a1', role: 'assistant', content: `实际执行记录：通过 pi SDK 请求用户提供的 https://aigc.sankuai.com/v1/openai/native/chat/completions，指定模型 deepseek-v4-flash，thinking enabled。文档摄取和对话提取均收到 HTTP 200，生成的提案已经过操作者选择并提交到独立 Obsidian Vault。这是本轮新增的真实模型验证；此前 npm test 的 22 项及 npm run demo 仍是本地模拟/无模型测试。下列 JSON 为已经完成调用的运行记录，不是计划或建议：\n${json(audit.filter(call => ['document-ingest', 'conversation-extraction'].includes(call.stage)))}` },
  ] };
  save('input-update-conversation.json', execution);
  const pendingFile = path.join(output, '03-update-proposal.json');
  const update = resume && fs.existsSync(pendingFile)
    ? cli(['proposal', 'inspect', JSON.parse(fs.readFileSync(pendingFile, 'utf8')).id])
    : await extract(root, 'default', vault, execution, { kind: 'conversation', project: 'AKM', target: existingPage, timeout: 300000, onResult: record('explicit-page-update') });
  if (update.items.some(item => item.state === 'proposed')) await review(update, '03-update');

  const question = 'AKM 的验证是否已经使用真实商业模型？用户对 Obsidian 和 LLM 的最小化验证提出了什么要求？';
  save('04-query.json', cli(['query', '--query', question, '--project', 'AKM', '--k', '5']));
  const response = await answer(root, 'default', vault, question, { project: 'AKM', k: 5, timeout: 300000, onResult: record('retrieval-answer') });
  save('04-answer.json', response);
  console.log(json({ stage: 'answer', ...response }));
  save('summary.json', { completedAt: new Date().toISOString(), executionComplete: true, answerQuality: 'Requires operator review; execution success alone is not answer correctness', root, vault, question, pagePaths: pages(vault).map(p => p.path), modelCalls: audit.length, cliWorkingDirectory: '/tmp' });
  console.log(json({ stage: 'complete', vault, output }));
} catch (error) {
  save('failure.json', { at: new Date().toISOString(), code: error.code, message: error.message });
  console.error(json({ stage: 'failed', code: error.code, message: error.message }).replaceAll(credential, '[REDACTED]'));
  process.exitCode = 1;
} finally { delete process.env[credentialEnv]; terminal.close(); }
