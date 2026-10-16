// Credential is read from stdin and never persisted. This sends a real request.
import fs from 'node:fs';
import readline from 'node:readline/promises';
const input = readline.createInterface({ input: process.stdin });
const key = await input.question('');
input.close();
const started = Date.now();
try {
  const response = await fetch('https://aigc.sankuai.com/v1/openai/native/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '仅回复：AKM连接成功' }], thinking: { type: 'enabled' }, stream: false, max_tokens: 4096 }), signal: AbortSignal.timeout(60000) });
  const value = await response.json();
  const summary = { status: response.status, model: value.model, id: value.id, content: value.choices?.[0]?.message?.content, finishReason: value.choices?.[0]?.finish_reason, usage: value.usage, latencyMs: Date.now() - started };
  fs.writeFileSync('/tmp/akm-live-probe.json', JSON.stringify(summary, null, 2).replaceAll(key, '[REDACTED]'));
  console.log(JSON.stringify(summary).replaceAll(key, '[REDACTED]'));
} catch (e) { console.log(JSON.stringify({ error: e.name, message: e.message })); process.exitCode = 1; }
