import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, metrics, runBenchmark, validateDataset } from '../src/benchmark.js';
import { fixture } from './helpers.js';

const dataset = fileURLToPath(new URL('../benchmarks/retrieve-v1.json', import.meta.url));
test('metric calculations with multiple relevant documents and graded relevance', () => {
  const r = metrics(['wrong', 'a', 'b'], { a: 3, b: 1, c: 1 }, 3);
  assert.equal(r.recall, 2 / 3);
  assert.equal(r.mrr, 1 / 2);
  assert(r.ndcg > 0 && r.ndcg < 1);
  assert.deepEqual(metrics([], {}, 3), { emptyCorrect: 1 });
  assert.deepEqual(metrics(['wrong'], {}, 3), { emptyCorrect: 0 });
});
test('fixed fixture produces repeatable quality and metadata improves baseline', () => {
  const a = runBenchmark(dataset), b = runBenchmark(dataset);
  assert.deepEqual(a.metrics, b.metrics);
  assert.deepEqual(a.perQuery, b.perQuery);
  const basic = runBenchmark(dataset, { mode: 'bm25' });
  assert(a.groups.aliases.recall > basic.groups.aliases.recall);
  assert.equal(a.groups['project-filter'].recall, 1);
  assert.equal(compare(a, a).passed, true);
  assert.equal(compare(basic, a).passed, false);
  assert.throws(() => compare(a, { ...b, datasetHash: 'different' }), { code: 'BASELINE_MISMATCH' });
});
test('CLI exits nonzero on regression and stores diagnostic report', t => {
  const { root } = fixture(t);
  const baseline = path.join(root, 'baseline.json'), output = path.join(root, 'result.json');
  runBenchmark(dataset, { output: baseline });
  const cmd = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/akm.js', import.meta.url)), 'benchmark', '--dataset', dataset, '--baseline', baseline, '--output', output, '--mode', 'bm25', '--json'], { encoding: 'utf8' });
  assert.equal(cmd.status, 2, cmd.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output)).comparison.passed, false);
});

test('malformed baseline cannot silently weaken regression gates', () => {
  const current = runBenchmark(dataset);
  for (const mutate of [
    b => { b.perQuery = []; },
    b => { b.metrics.recall = -1; },
    b => { b.metrics.ndcg = 1.5; },
    b => { b.perQuery[1].id = b.perQuery[0].id; },
    b => { b.groups.aliases.queries++; },
    b => { b.perQuery[0].mrr = 0; },
  ]) {
    const baseline = structuredClone(current); mutate(baseline);
    assert.throws(() => compare(current, baseline), { code: 'BASELINE_MISMATCH' });
  }
});
