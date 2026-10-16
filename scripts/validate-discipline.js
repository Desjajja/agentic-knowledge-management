// Public-source ingestion and real LLM retrieval evaluation. No credentials on disk.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { init, resolveVault, pages, json, listFiles, readJSON } from '../src/storage.js';
import { createProposal, inspectProposal, editProposal, applyProposal } from '../src/knowledge.js';
import { retrieve } from '../src/retrieve.js';
import { configureModel, extract, answer } from '../src/pi.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repo, 'artifacts/distributed-systems-2026-10-12');
const root = path.join(output, 'akm-root');
const project = '分布式系统';
const input = readline.createInterface({ input: process.stdin });
const keyName = 'AKM_DISCIPLINE_PROVIDER_KEY';
const key = process.env[keyName] ?? await input.question('');
if (!key.trim()) throw new Error('Missing API credential');
process.env[keyName] = key;
const write = (relative, value) => {
  const file = path.join(output, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (typeof value === 'string' ? value : json(value)).replaceAll(key, '[REDACTED]'));
};
const auditFile = path.join(output, 'model-calls.json');
const audit = fs.existsSync(auditFile) ? readJSON(auditFile) : [];
function hooks(stage) {
  return {
    timeout: 300000,
    onTrace: value => write(`trace/${stage}-${value.phase}.json`, { stage, at: new Date().toISOString(), ...value }),
    onResult: value => { audit.push({ stage, at: new Date().toISOString(), ...value }); write('model-calls.json', audit); console.log(json({ stage, httpStatus: value.httpStatus, totalTokens: value.usage?.totalTokens, elapsedMs: value.elapsedMs })); },
  };
}
try {
  if (!fs.existsSync(path.join(root, 'config.json'))) init(root, 'distributed-systems');
  const vault = resolveVault(root).dir;
  configureModel(root, 'default', { baseUrl: 'https://aigc.sankuai.com/v1/openai/native', model: 'deepseek-v4-flash', apiKeyEnv: keyName, thinkingEnabled: true });
  const sources = readJSON(path.join(output, 'sources.json'));
  for (const source of sources) {
    const stage = `ingest-${source.id}`;
    const receiptPath = path.join(output, `ingest/${source.id}-receipt.json`);
    if (fs.existsSync(receiptPath)) continue;
    const document = fs.readFileSync(path.join(output, 'inputs', source.inputFile), 'utf8');
    fs.writeFileSync(path.join(vault, 'inbox', source.inputFile), document);
    write(`ingest/${source.id}-retrieval-before.json`, retrieve(vault, document.slice(0, 8000), { k: 5 }));
    write(`ingest/${source.id}-pages-before.json`, pages(vault));
    const proposalPath = path.join(output, `ingest/${source.id}-proposal-original.json`);
    let proposal;
    if (fs.existsSync(proposalPath)) proposal = inspectProposal(vault, readJSON(proposalPath).id);
    else {
      try { if (fs.existsSync(path.join(output, `trace/${stage}-response.json`))) { const saved = new Error('Recover saved model response after failed validation'); saved.code = 'INVALID_INPUT'; throw saved; } proposal = await extract(root, 'default', vault, document, { kind: 'document', name: source.title, project, ...hooks(stage) }); }
      catch (error) {
        write(`ingest/${source.id}-validation-failure.json`, { code: error.code, message: error.message });
        const responseFile = path.join(output, `trace/${stage}-response.json`);
        if (error.code !== 'INVALID_INPUT' || !fs.existsSync(responseFile)) throw error;
        const raw = readJSON(responseFile).text;
        const data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
        const repairs = [];
        for (const [index, item] of data.items.entries()) {
          const original = { title: item.title, tags: item.tags };
          item.title = item.title.replace(/[:/\\?*"<>|]/g, ' - ');
          item.tags = item.tags.map(tag => tag.replace(/\s+/g, '-'));
          repairs.push({ label: index + 1, original, repaired: { title: item.title, tags: item.tags }, reason: 'Structural compatibility only; model body unchanged' });
          if (item.action === 'update' && !readJSON(path.join(output, `trace/${stage}-request.json`)).prompt.includes(item.target)) throw error;
          item.sources = [{ kind: 'document', name: source.title, content: document }];
        }
        write(`ingest/${source.id}-structural-recovery.json`, { repairs, responseFile: `trace/${stage}-response.json` });
        proposal = createProposal(vault, data);
      }
    }
    if (!fs.existsSync(proposalPath)) write(`ingest/${source.id}-proposal-original.json`, proposal);
    console.log(json({ stage: 'review', source: { id: source.id, title: source.title, url: source.finalUrl }, proposal }));
    const command = (await input.question('Enter labels to apply, "edit filename.json labels", or stop: ')).trim();
    let labelsText = command;
    if (command.startsWith('edit ')) {
      const [, file, labels] = command.split(' ');
      proposal = editProposal(vault, proposal.id, proposal.revision, readJSON(path.join(output, file)).edits);
      labelsText = labels;
      write(`ingest/${source.id}-reviewed.json`, proposal);
    }
    if (!/^\d+(,\d+)*$/.test(labelsText ?? '')) throw new Error('Operator stopped before apply');
    const receipt = applyProposal(vault, proposal.id, proposal.revision, labelsText.split(',').map(Number));
    write(`ingest/${source.id}-receipt.json`, receipt);
    write(`ingest/${source.id}-pages-after.json`, pages(vault));
    console.log(json({ stage: 'applied', source: source.id, pages: receipt.pages }));
  }

  const questions = readJSON(path.join(output, 'questions.json')).queries;
  // Freeze the corpus before any answers. Queries and gold source facts were fixed first.
  write('corpus-snapshot.json', pages(vault));
  for (const question of questions) {
    const rawPath = path.join(output, `queries/${question.id}-retrieval.json`);
    if (!fs.existsSync(rawPath)) {
      const started = Date.now();
      const evidence = retrieve(vault, question.text, { project: question.project ?? project, k: 3 });
      write(`queries/${question.id}-retrieval.json`, { question, elapsedMs: Date.now() - started, evidence });
    }
  }
  // Parallel independent model answers; each owns a fresh, tool-free pi session.
  for (let index = 0; index < questions.length; index += 2) {
    const batch = questions.slice(index, index + 2);
    const results = await Promise.allSettled(batch.map(async question => {
      const answerPath = path.join(output, `queries/${question.id}-answer.json`);
      if (fs.existsSync(answerPath)) return;
      const started = Date.now();
      const result = await answer(root, 'default', vault, question.text, { project: question.project ?? project, k: 3, ...hooks(`answer-${question.id}`) });
      write(`queries/${question.id}-answer.json`, { question, elapsedMs: Date.now() - started, ...result });
      console.log(json({ stage: 'answered', query: question.id, evidencePages: result.evidence.results.map(page => page.path), answer: result.answer }));
    }));
    for (let offset = 0; offset < results.length; offset++) {
      const result = results[offset];
      if (result.status === 'rejected') write(`queries/${batch[offset].id}-failure.json`, { code: result.reason.code, message: result.reason.message });
    }
  }
  const corpus = pages(vault);
  for (const relative of listFiles(output)) {
    if (relative.endsWith('.png')) continue;
    if (fs.readFileSync(path.join(output, relative)).includes(Buffer.from(key))) throw new Error('Credential found in output');
  }
  const failures = listFiles(output, 'queries').filter(file => file.endsWith('-failure.json'));
  write('execution-summary.json', { completedAt: new Date().toISOString(), project, vault, sources: sources.length, pages: corpus.length, queries: questions.length, modelCalls: audit.length, failures, credentialScanPassed: true, correctness: 'Awaiting human source/evidence/answer evaluation; HTTP success is not correctness' });
  console.log(json({ stage: 'execution-finished', sources: sources.length, pages: corpus.length, queries: questions.length, failures }));
} catch (error) {
  write('execution-failure.json', { at: new Date().toISOString(), code: error.code, message: error.message });
  console.error(json({ stage: 'execution-failed', code: error.code, message: error.message }).replaceAll(key, '[REDACTED]'));
  process.exitCode = 1;
} finally { delete process.env[keyName]; input.close(); }
