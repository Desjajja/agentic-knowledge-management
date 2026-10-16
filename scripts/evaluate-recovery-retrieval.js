import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveVault, pages, json } from '../src/storage.js';
import { rank } from '../src/retrieve.js';
import { rank as legacy } from '../artifacts/recovery-validation-2026-10-15/legacy-retrieve.js';
const out = path.resolve('artifacts/recovery-validation-2026-10-15');
const vault = resolveVault(path.join(out, 'test-akm')).dir;
let docs;
for (let attempt = 0; attempt < 20; attempt++) {
  try { docs = pages(vault); break; } catch (e) { if (e.code !== 'VAULT_BUSY' || attempt === 19) throw e; await delay(50); }
}
const qs = JSON.parse(fs.readFileSync(path.join(out, 'questions.json')));
const sources = JSON.parse(fs.readFileSync(path.join(out, 'sources.json')));
const sourceIds = doc => sources.filter(s => (doc.props.sources ?? []).includes(s.sha256 ?? s.inputSha256)).map(s => s.id);
const average = array => array.length ? array.reduce((a,b)=>a+b,0)/array.length : null;
const runs = [];
for (const [version, retrieve] of [['legacy', legacy], ['current', rank]]) {
  const perQuery = qs.map(q => {
    const start = performance.now(); const results = retrieve(docs, q.query, { k: 3, domain: q.domain });
    const matched = results.map(p => ({ title: p.title, path: p.path, sources: sourceIds(p), domain: p.domain, score: p.score }));
    const ranks = matched.map(p => p.sources.some(s => q.expectedSources.includes(s)));
    return { ...q, results: matched, elapsedMs: performance.now()-start, sourceHitAt3: q.negative ? undefined : ranks.some(Boolean), reciprocalRank: q.negative ? undefined : ranks.includes(true) ? 1/(ranks.indexOf(true)+1) : 0, emptyCorrect: q.negative ? results.length === 0 : undefined, crossDomainCandidates: results.filter(p => p.domain !== q.expectedDomain).length };
  });
  const summarize = rows => ({ count: rows.length, positive: rows.filter(q=>!q.negative).length, negative: rows.filter(q=>q.negative).length, sourceHitAt3: average(rows.filter(q=>!q.negative).map(q=>Number(q.sourceHitAt3))), mrr: average(rows.filter(q=>!q.negative).map(q=>q.reciprocalRank)), negativeEmptyCorrect: average(rows.filter(q=>q.negative).map(q=>Number(q.emptyCorrect))) });
  runs.push({ version, corpusPages: docs.length, metrics: summarize(perQuery), splits: Object.fromEntries(['development','holdout'].map(split=>[split,summarize(perQuery.filter(q=>q.split===split))])), perQuery });
}
fs.writeFileSync(path.join(out, 'retrieval-evaluation.json'), json({ metricNote: 'Source-level hit@3, not claim support or exhaustive document recall. Questions fixed before running this evaluation; source-label corrections made during source review, before either ranker was evaluated.', runs }));
console.log(json(runs.map(({perQuery,...r})=>r)));
