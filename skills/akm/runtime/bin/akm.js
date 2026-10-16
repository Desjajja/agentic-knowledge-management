#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AkmError, atomicWrite, id, check, createVault, importVault, init, json, projects, readJSON, resolveVault, rootDir, safe, vaultList, setActiveVault, activeVaultStatus } from '../src/storage.js';
import { domainList, domainSearch, domainShow } from '../src/domain.js';
import { applyProposal, createProposal, editProposal, inspectProposal, showPage } from '../src/knowledge.js';
import { sumUsage } from '../src/telemetry.js';
import { retrieveEvidence, evidenceForModel } from '../src/evidence.js';
import { retrieve } from '../src/retrieve.js';
import { recover } from '../src/transaction.js';
import { runBenchmark } from '../src/benchmark.js';
import { answer, configureModel, extract } from '../src/pi.js';

const help = `AKM 0.1 — local knowledge management (Node >=22.19)

akm init [--name default] [--vault-path /absolute/path/to/obsidian-vault]
akm vault list | akm vault create --name NAME | akm vault use NAME/ID
akm status | akm domain list | akm domain show --name NAME | akm domain search --query TEXT
akm model configure --base-url URL --model ID --api-key-env ENV [--workspace default] [--thinking-enabled] [--fallback-models ID,ID]
akm proposal create --input items.json
akm proposal inspect ID
akm proposal edit ID --revision HASH --input edits.json
akm proposal apply ID --revision HASH --items 1,2
akm propose --file document.md | --input conversation.json
akm retrieve --query TEXT [--input variants.json] [--budget 24000] [--answer]
akm review ID --revision HASH --input edits.json
akm commit ID --revision HASH --items 1,2
akm ingest --file document.md [--project NAME] [--page EXISTING_PAGE]
akm extract-conversation --input conversation.json [--project NAME] [--page EXISTING_PAGE]
akm show --page "projects/Project/Title"
akm query --query TEXT [--project NAME] [--k 5] [--mode fields|bm25] [--answer]
akm operation recover [--clear-stale-lock]
akm benchmark --dataset FILE [--output FILE] [--baseline FILE] [--mode fields|bm25]

Global: --root DIRECTORY (default AKM_HOME or ~/.akm), --vault NAME/ID,
        --workspace NAME, --json, --help
No async/export in MVP. Every apply requires the reviewed revision and labels.
`;
const options = Object.fromEntries(['root', 'name', 'vault', 'vault-path', 'workspace', 'base-url', 'model', 'fallback-models', 'api-key-env', 'input', 'revision', 'items', 'file', 'project', 'domain', 'page', 'query', 'k', 'mode', 'dataset', 'output', 'baseline', 'tolerance', 'timeout', 'budget'].map(k => [k, { type: 'string' }]));
for (const name of ['json', 'help', 'answer', 'clear-stale-lock', 'thinking-enabled', 'force']) options[name] = { type: 'boolean' };
let taskLedger;
let jsonOutput = process.argv.includes('--json');
function inputFile(file) { check(file, '--input is required'); return readJSON(path.resolve(file)); }
function pretty(data) {
  const label = link => /^item:\d+$/.test(link) ? `[${link.slice(5)}] ${data.items?.find(i => i.label === Number(link.slice(5)))?.title ?? '待处理关联'}` : link.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|').at(-1).split('/').at(-1);
  if (data.answer) return data.answer;
  if (data.projects) return data.projects.map(p => p.name).join('\n');
  if (data.items) return `待确认知识：\n\n${data.items.map(i => `[${i.label}] ${i.title}${i.state !== 'proposed' ? ` (${i.state})` : ''}\n${i.content}\n领域：${i.domain ?? i.project}${i.newDomain || i.newProject ? ' [新创建]' : ''}\n${i.tags.length ? `标签：${i.tags.map(t => `#${t}`).join(' ')}\n` : ''}${i.aliases.length ? `别名：${i.aliases.join('；')}\n` : ''}${i.related.length ? `相关：${i.related.map(r => label(r.link) + (r.state === 'missing' ? ' [未找到]' : r.state === 'proposed' ? ' [新创建]' : '')).join('；')}\n` : ''}动作：${i.action === 'create' ? '新增' : '更新'}${i.issues?.length ? `\n待核查：${i.issues.map(x => x.message).join('；')}` : ''}${i.before ? `\n原正文（更新将替换）：\n${i.before}` : ''}`).join('\n\n')}\n`;
  if (data.results) return data.results.length ? data.results.map((r, i) => `[${i + 1}] ${r.title} (${r.project})\n${r.passages?.map(p => p.text).join('\n\n') ?? r.content ?? r.snippet.text}`).join('\n\n') : '没有找到相关证据。';
  return json(data);
}
try {
  const { values: v, positionals: args } = parseArgs({ options, allowPositionals: true });
  jsonOutput = !!v.json;
  if (v.help || !args.length) { process.stdout.write(help); process.exit(0); }
  const root = rootDir(v.root);
  const [command, subcommand, target] = args;
  let data;
  if (command === 'init') data = v['vault-path'] ? importVault(root, v['vault-path'], v.name) : init(root, v.name);
  else if (command === 'status') data = activeVaultStatus(root, v.workspace);
  else if (command === 'benchmark') {
    check(v.dataset, '--dataset is required');
    data = runBenchmark(v.dataset, { k: v.k ? Number(v.k) : 3, mode: v.mode, output: v.output, baseline: v.baseline, tolerance: v.tolerance ? Number(v.tolerance) : 0 });
    if (data.comparison && !data.comparison.passed) process.exitCode = 2;
  } else if (command === 'model' && subcommand === 'configure') data = configureModel(root, v.workspace, { baseUrl: v['base-url'], model: v.model, apiKeyEnv: v['api-key-env'], thinkingEnabled: !!v['thinking-enabled'], fallback: v['fallback-models'] ? v['fallback-models'].split(',') : [] });
  else if (command === 'vault' && subcommand === 'list') data = { vaults: vaultList(root) };
  else if (command === 'vault' && subcommand === 'create') data = createVault(root, v.name);
  else if (command === 'vault' && subcommand === 'use') data = setActiveVault(root, target ?? v.vault, v.workspace);
  else if (command === 'domain' && subcommand === 'list') { const { dir: vault } = resolveVault(root, undefined, v.workspace); data = { domains: domainList(vault) }; }
  else if (command === 'domain' && subcommand === 'show') { const { dir: vault } = resolveVault(root, undefined, v.workspace); data = domainShow(vault, v.name ?? target); }
  else if (command === 'domain' && subcommand === 'search') { const { dir: vault } = resolveVault(root, undefined, v.workspace); data = { domains: domainSearch(vault, v.query) }; }
  else {
    check(!v.vault, 'Knowledge commands use the active Vault; run akm vault use first', 'ACTIVE_VAULT_ONLY');
    const { dir: vault } = resolveVault(root, undefined, v.workspace);
    const ledgerPath = safe(vault, `.akm/runs/${id('task')}.json`);
    const started = Date.now(), runs = [];
    const hooks = { onResult: value => { runs.push(value); taskLedger = { path: ledgerPath, started, value: { schema: 1, command, status: 'running', runs, usage: sumUsage(runs), knownUsage: sumUsage(runs.map(r => ({ usage: r.knownUsage }))), requestCount: runs.reduce((n,r) => n+r.requestCount,0), elapsedMs: Date.now() - started } }; atomicWrite(ledgerPath, json(taskLedger.value)); } }; 
    if (command === 'project' && subcommand === 'list') data = { projects: projects(vault) };
    else if (command === 'proposal' && subcommand === 'create') data = createProposal(vault, inputFile(v.input));
    else if (command === 'proposal' && subcommand === 'inspect') data = inspectProposal(vault, target);
    else if ((command === 'proposal' && subcommand === 'edit') || command === 'review') data = editProposal(vault, command === 'review' ? subcommand : target, v.revision, inputFile(v.input).edits);
    else if ((command === 'proposal' && subcommand === 'apply') || command === 'commit') {
      check(v.items && /^\d+(,\d+)*$/.test(v.items), '--items must be comma-separated labels');
      data = applyProposal(vault, command === 'commit' ? subcommand : target, v.revision, v.items.split(',').map(Number));
    } else if (command === 'operation' && subcommand === 'recover') data = recover(vault, { clearStaleLock: v['clear-stale-lock'] });
    else if (command === 'show') data = showPage(vault, v.page ?? '');
    else if (command === 'retrieve') {
      data = v.answer ? await answer(root, v.workspace, vault, v.query, { project: v.domain ?? v.project, domain: v.domain ?? v.project, k: v.k ? Number(v.k) : 5, ...hooks, timeout: v.timeout ? Number(v.timeout) : undefined }) : retrieveEvidence(vault, v.query, { project: v.domain ?? v.project, domain: v.domain ?? v.project, k: v.k ? Number(v.k) : 5, queries: v.input ? inputFile(v.input).queries : [], budgetChars: v.budget ? Number(v.budget) : 24000 });
    } else if (command === 'query') {
      data = v.answer ? await answer(root, v.workspace, vault, v.query, { project: v.domain ?? v.project, domain: v.domain ?? v.project, k: v.k ? Number(v.k) : 5, ...hooks, timeout: v.timeout ? Number(v.timeout) : undefined }) : retrieve(vault, v.query, { project: v.domain ?? v.project, domain: v.domain ?? v.project, k: v.k ? Number(v.k) : 5, mode: v.mode });
    } else if (command === 'ingest' || (command === 'propose' && v.file)) {
      check(v.file && ['.md', '.txt'].includes(path.extname(v.file).toLowerCase()), 'MVP supports .md/.txt only');
      // Relative document paths are Vault-relative, independent of the caller cwd.
      const file = path.isAbsolute(v.file) ? v.file : safe(vault, v.file);
      check(fs.statSync(file).size <= 2 * 1024 * 1024, 'Document exceeds 2 MiB');
      data = await extract(root, v.workspace, vault, fs.readFileSync(file, 'utf8'), { kind: 'document', name: path.basename(file), project: v.domain ?? v.project, domain: v.domain ?? v.project, target: v.page, force: !!v.force, ...hooks, timeout: v.timeout ? Number(v.timeout) : undefined });
    } else if (command === 'extract-conversation' || (command === 'propose' && v.input)) data = await extract(root, v.workspace, vault, inputFile(v.input), { kind: 'conversation', project: v.domain ?? v.project, domain: v.domain ?? v.project, target: v.page, force: !!v.force, ...hooks, timeout: v.timeout ? Number(v.timeout) : undefined });
    else throw new AkmError('UNKNOWN_COMMAND', 'Unknown command; run akm --help');
  }
  if (command === 'retrieve' && !v.answer) data = evidenceForModel(data);
  if (taskLedger) atomicWrite(taskLedger.path, json({ ...taskLedger.value, elapsedMs: Date.now() - taskLedger.started, status: 'completed' }));
  process.stdout.write(jsonOutput ? json({ schema: 1, ok: true, data }) : `${pretty(data)}\n`);
} catch (error) {
  if (taskLedger) atomicWrite(taskLedger.path, json({ ...taskLedger.value, elapsedMs: Date.now() - taskLedger.started, status: error.code ?? 'failed' }));
  const code = error instanceof AkmError ? error.code : 'IO_ERROR';
  const message = error.message;
  process.stderr.write(json({ schema: 1, ok: false, error: { code, message } }));
  process.exitCode = 1;
}
