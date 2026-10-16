import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AkmError, atomicWrite, check, hash, json, readJSON } from './storage.js';
import { rank, RETRIEVER_VERSION } from './retrieve.js';

export function validateDataset(data) {
  check(data.schema === 1 && Array.isArray(data.documents) && Array.isArray(data.queries) && data.documents.length && data.queries.length, 'Invalid benchmark dataset');
  const docs = new Set(data.documents.map(d => d.id));
  check(docs.size === data.documents.length && data.documents.every(d => typeof d.id === 'string' && typeof d.title === 'string' && typeof d.body === 'string' && typeof d.project === 'string'), 'Invalid benchmark documents');
  check(new Set(data.queries.map(q => q.id)).size === data.queries.length, 'Duplicate query IDs');
  for (const q of data.queries) {
    check(typeof q.id === 'string' && typeof q.text === 'string' && q.text.trim() && q.relevance && typeof q.relevance === 'object' && !Array.isArray(q.relevance), 'Invalid benchmark query');
    for (const [doc, grade] of Object.entries(q.relevance)) {
      check(docs.has(doc) && Number.isInteger(grade) && grade >= 1 && grade <= 3, `Invalid judgment: ${q.id}/${doc}`);
      check(!q.project || data.documents.find(d => d.id === doc).project === q.project, `Judgment outside project filter: ${q.id}`);
    }
  }
}
export function metrics(ids, relevance, k) {
  const ranked = ids.slice(0, k), relevant = Object.keys(relevance);
  if (!relevant.length) return { emptyCorrect: ids.length === 0 ? 1 : 0 };
  const hit = ranked.filter(d => relevance[d]).length;
  const first = ranked.findIndex(d => relevance[d]);
  const gain = (grade, i) => (2 ** grade - 1) / Math.log2(i + 2);
  const dcg = ranked.reduce((s, d, i) => s + gain(relevance[d] ?? 0, i), 0);
  const ideal = Object.values(relevance).sort((a, b) => b - a).slice(0, k).reduce((s, grade, i) => s + gain(grade, i), 0);
  return { recall: hit / relevant.length, mrr: first < 0 ? 0 : 1 / (first + 1), ndcg: dcg / ideal };
}
function aggregate(rows) {
  const average = key => { const values = rows.map(r => r[key]).filter(x => x !== undefined); return values.length ? values.reduce((s, x) => s + x, 0) / values.length : null; };
  return { queries: rows.length, recall: average('recall'), mrr: average('mrr'), ndcg: average('ndcg'), emptyCorrect: average('emptyCorrect') };
}
function validateBaseline(current, baseline) {
  const fail = message => check(false, message, 'BASELINE_MISMATCH');
  if (!Array.isArray(baseline.perQuery) || baseline.perQuery.length !== current.perQuery.length || !baseline.groups) fail('Incomplete baseline queries/groups');
  if (new Set(baseline.perQuery.map(q => q.id)).size !== baseline.perQuery.length) fail('Duplicate baseline query IDs');
  for (const q of current.perQuery) {
    const b = baseline.perQuery.find(x => x.id === q.id);
    if (!b || b.group !== q.group || !Array.isArray(b.ranked) || b.ranked.length > current.k || !b.ranked.every(x => typeof x === 'string') || new Set(b.ranked).size !== b.ranked.length) fail(`Invalid baseline query: ${q.id}`);
    for (const key of ['recall', 'mrr', 'ndcg', 'emptyCorrect']) {
      if (q[key] === undefined ? b[key] !== undefined : !(Number.isFinite(b[key]) && b[key] >= 0 && b[key] <= 1)) fail(`Invalid baseline query metric: ${q.id}.${key}`);
    }
  }
  const checkAggregate = (a, b, rows, label) => {
    if (!b || a.queries !== b.queries) fail(`Baseline query count mismatch: ${label}`);
    const calculated = aggregate(rows);
    for (const key of ['recall', 'mrr', 'ndcg', 'emptyCorrect']) {
      if (a[key] === null) { if (b[key] !== null) fail(`Invalid null baseline metric: ${label}.${key}`); }
      else if (!Number.isFinite(b[key]) || b[key] < 0 || b[key] > 1 || Math.abs(b[key] - calculated[key]) > 1e-12) fail(`Invalid baseline metric: ${label}.${key}`);
    }
  };
  checkAggregate(current.metrics, baseline.metrics, baseline.perQuery, 'overall');
  if (json(Object.keys(current.groups).sort()) !== json(Object.keys(baseline.groups).sort())) fail('Baseline group mismatch');
  for (const [group, value] of Object.entries(current.groups)) checkAggregate(value, baseline.groups[group], baseline.perQuery.filter(q => q.group === group), group);
}
export function compare(current, baseline, tolerance = 0) {
  check(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 1, 'tolerance must be 0–1');
  check(current.datasetHash === baseline.datasetHash && current.k === baseline.k && current.schema === baseline.schema && baseline.metrics && baseline.perQuery, 'Baseline dataset/protocol mismatch', 'BASELINE_MISMATCH');
  validateBaseline(current, baseline);
  const regressions = [];
  const compareMetrics = (prefix, a, b) => {
    for (const key of ['recall', 'mrr', 'ndcg', 'emptyCorrect']) {
      check(a[key] === null ? b[key] === null : Number.isFinite(b[key]), `Invalid baseline metric: ${prefix}.${key}`, 'BASELINE_MISMATCH');
      if (a[key] !== null && a[key] < b[key] - tolerance - 1e-12) regressions.push({ group: prefix, metric: key, baseline: b[key], current: a[key] });
    }
  };
  compareMetrics('overall', current.metrics, baseline.metrics);
  for (const [group, value] of Object.entries(current.groups)) {
    check(baseline.groups?.[group], `Missing baseline group: ${group}`, 'BASELINE_MISMATCH');
    compareMetrics(group, value, baseline.groups[group]);
  }
  return { passed: regressions.length === 0, tolerance, regressions, perQueryChanges: current.perQuery.filter(q => {
    const b = baseline.perQuery.find(x => x.id === q.id);
    return !b || json(b.ranked) !== json(q.ranked);
  }).map(q => ({ id: q.id, ranked: q.ranked, baseline: baseline.perQuery.find(x => x.id === q.id)?.ranked })) };
}
export function runBenchmark(datasetFile, { k = 3, output, baseline, tolerance = 0, mode = 'fields', rounds = 5, minMatched } = {}) {
  const data = readJSON(datasetFile);
  validateDataset(data);
  check(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 100, 'rounds must be 1–100');
  const documents = data.documents.map(d => ({ ...d, path: `${d.project}/${d.id}.md`, props: { aliases: d.aliases ?? [], tags: d.tags ?? [] } }));
  const durations = [], rows = [];
  for (const q of data.queries) {
    const opts = { k, project: q.project, mode, ...(minMatched === undefined ? {} : { minMatched: Number(minMatched) }) };
    rank(documents, q.text, opts); // warmup; report ranking-only, not I/O or LLM latency
    let results;
    for (let r = 0; r < rounds; r++) {
      const start = performance.now(); results = rank(documents, q.text, opts); durations.push(performance.now() - start);
    }
    const ranked = results.map(d => d.id);
    rows.push({ id: q.id, group: q.group ?? 'default', ranked, ...metrics(ranked, q.relevance, k) });
  }
  durations.sort((a, b) => a - b);
  const report = { schema: 1, dataset: data.name, datasetHash: hash(json(data)), retriever: RETRIEVER_VERSION, retrieverCodeHash: hash(fs.readFileSync(new URL('./retrieve.js', import.meta.url))), mode, k, minMatched: minMatched === undefined ? null : Number(minMatched), metrics: aggregate(rows), groups: Object.fromEntries([...new Set(rows.map(r => r.group))].map(g => [g, aggregate(rows.filter(r => r.group === g))])), perQuery: rows, latency: { kind: 'ranking-only-ms', rounds, p50: durations[Math.floor(durations.length * 0.5)], p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] }, environment: { node: process.version, platform: process.platform } };
  if (baseline) report.comparison = compare(report, readJSON(baseline), tolerance);
  if (output) atomicWrite(output, json(report));
  return report;
}
