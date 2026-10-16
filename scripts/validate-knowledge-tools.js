import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { runPi } from '../src/pi.js';
import { knowledgeTools } from '../src/pi-tools.js';
import { readJSON, resolveVault, json } from '../src/storage.js';
const root = path.resolve('artifacts/distributed-systems-2026-10-12/akm-root');
const config = readJSON(path.join(root, 'workspaces/default/workspace.json'));
const input = readline.createInterface({ input: process.stdin });
const key = (await input.question('')).trim();
process.env[config.apiKeyEnv] = key;
const trace = []; const reads = [];
try {
  const customTools = knowledgeTools(resolveVault(root).dir, { project: '分布式系统', onTrace: event => trace.push(event), onRead: (_page, chunk) => reads.push(chunk) });
  const response = await runPi(root, 'default', '请用中文简短回答：classic SI 与 generalized SI 的区别是否会改变它们与 serializability 的强弱关系？先调用 akm_search 搜索 Snapshot Isolation；再用 akm_read 按每段最多 2000 字符读取这篇页面，直到 contentTruncated 为 false，之后根据实际读到的证据回答并引用可点击的中文短标签。', { customTools, timeout: 300000, onTrace: event => trace.push(event) });
  if (!trace.some(e => e.tool === 'akm_search') || !reads.length || reads.at(-1).contentTruncated) throw new Error('Model did not complete the required tool read loop');
  const output = { answer: response, toolCalls: trace.filter(e => e.phase === 'tool').length, readChunks: reads.length, trace };
  fs.writeFileSync(path.resolve('artifacts/ux-validation-2026-10-12/real-tool-loop.json'), json(output).replaceAll(key, '[REDACTED]'));
  console.log(json({ toolCalls: output.toolCalls, readChunks: output.readChunks, answer: response }));
} finally { delete process.env[config.apiKeyEnv]; input.close(); }
