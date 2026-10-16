import fs from 'node:fs';
import path from 'node:path';
import { activeVaultStatus, json, pages, resolveVault, setActiveVault } from '../src/storage.js';
import { retrieveEvidence } from '../src/evidence.js';
import { runBenchmark } from '../src/benchmark.js';
import { withTestVault } from './test-vault-session.js';

const out = path.resolve('artifacts/real-corpus-2026-10-16');
const root = path.join(out, 'akm');
const dataset = path.join(out, 'retrieve-real-v1.json');
// Make the transition observable: previous selection is a separate copy, test
// selection is the vault used for every retrieval below, and finally restores.
setActiveVault(root, 'test-vault');
const before = activeVaultStatus(root);
const report = await withTestVault({ root, testVault: 'test' }, async ({ active, vault }) => {
  const data = JSON.parse(fs.readFileSync(dataset, 'utf8'));
  const checks = [
    { query: 'QUIC stream flow control', domain: '网络协议', expect: true },
    { query: 'leader election log replication', domain: '分布式系统', expect: true },
    { query: 'photosynthesis chloroplast', expect: false },
  ];
  const retrieval = checks.map(c => {
    const result = retrieveEvidence(vault, c.query, { domain: c.domain, k: 3 });
    return { ...c, titles: result.results.map(x => x.title), ok: c.expect ? result.results.length > 0 : result.results.length === 0 };
  });
  const defaultRun = runBenchmark(dataset, { k: 3 });
  const strictRun = runBenchmark(dataset, { k: 3, minMatched: 2 });
  return { activeVault: active.vault.name, pageCount: pages(vault).length, retrieval, thresholdComparison: { default: defaultRun.metrics, minMatched2: strictRun.metrics } };
});
const after = activeVaultStatus(root);
const final = { before: before.vault.name, after: after.vault.name, restored: before.vault.id === after.vault.id, ...report };
fs.writeFileSync(path.join(out, 'validation.json'), json(final));
console.log(json(final));
