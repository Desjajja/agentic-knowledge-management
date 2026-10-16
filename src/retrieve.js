import { check, pages } from './storage.js';
import { withLock } from './transaction.js';

export const RETRIEVER_VERSION = 'bm25-fields-v2';
const stop = new Set('的 了 是 在 与 和 及 或 我 你 它 吗 呢 啊 这 那 什么 怎么 如何 为什么 是否 哪些 一个 一些 可以 应该 需要 进行 关于 区别 之间 分别 这里 那里 时候'.split(' '));
export function tokenize(text) {
  // Small, inspectable vocabulary normalization for the product's own terms.
  const normalized = String(text).normalize('NFKC').toLowerCase().replace(/笔记/g, '知识页面');
  const tokens = normalized.replace(/[\p{Script=Han}]+/gu, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...run];
    // Isolated meaningful characters remain searchable; characters inside a
    // sentence must not admit unrelated documents just because they share 的/是.
    if (chars.length === 1 && !stop.has(chars[0])) tokens.push(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens.filter(t => !stop.has(t));
}
const frequencies = tokens => { const f = new Map(); for (const t of tokens) f.set(t, (f.get(t) ?? 0) + 1); return f; };
function arrayText(value) { return Array.isArray(value) ? value.join(' ') : String(value ?? ''); }
export function rank(documents, query, { k = 5, project, domain = project, mode = 'fields', minMatched } = {}) {
  check(typeof query === 'string' && query.trim() && query.length <= 8000, 'Query must contain 1–8000 characters');
  check(Number.isSafeInteger(k) && k >= 1 && k <= 100, 'k must be 1–100');
  check(['fields', 'bm25'].includes(mode), 'Unknown retrieval mode');
  if (minMatched !== undefined) check(Number.isSafeInteger(minMatched) && minMatched >= 1 && minMatched <= 100, 'minMatched must be 1–100');
  const terms = [...new Set(tokenize(query))];
  const selected = domain ? documents.filter(d => (d.domain ?? d.project) === domain) : documents;
  if (!terms.length || !selected.length) return [];
  const weights = mode === 'fields' ? { title: 3, aliases: 3, tags: 2, body: 1 } : { body: 1 };
  const docs = selected.map(d => {
    const values = { title: d.title, aliases: arrayText(d.props?.aliases), tags: arrayText(d.props?.tags), body: mode === 'bm25' ? `${d.title}\n${d.body}` : d.body };
    return { doc: d, fields: Object.fromEntries(Object.keys(weights).map(f => { const t = tokenize(values[f]); return [f, { freq: frequencies(t), length: t.length }]; })) };
  });
  const avg = Object.fromEntries(Object.keys(weights).map(f => [f, docs.reduce((s, d) => s + d.fields[f].length, 0) / docs.length || 1]));
  const df = new Map(terms.map(t => [t, docs.filter(d => Object.values(d.fields).some(f => f.freq.has(t))).length]));
  // Keep the low-level ranker recall-oriented for compatibility. Evidence
  // aggregation opts into the stricter multi-term gate below, where a noisy
  // candidate is more harmful than a slightly lower recall.
  const requiredMatches = minMatched ?? 1;
  return docs.map(({ doc, fields }) => {
    let score = 0;
    const matched = [];
    for (const term of terms) {
      let tf = 0;
      for (const [field, weight] of Object.entries(weights)) {
        const value = fields[field];
        tf += weight * (value.freq.get(term) ?? 0) / (0.25 + 0.75 * value.length / avg[field]);
      }
      if (tf) {
        score += Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5)) * (tf * 2.2) / (tf + 1.2);
        matched.push(term);
      }
    }
    return { ...doc, score, matched };
  }).filter(d => d.score > 0 && d.matched.length >= requiredMatches).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, k);
}
export function snippet(doc, terms) {
  const lines = doc.text.split('\n');
  let best = Math.max(0, doc.bodyStartLine - 1), count = -1;
  for (let i = best; i < lines.length; i++) {
    const tokens = new Set(tokenize(lines[i]));
    const hits = terms.filter(t => tokens.has(t)).length;
    if (hits > count) { best = i; count = hits; }
  }
  const start = Math.max(doc.bodyStartLine - 1, best - 1), end = Math.min(lines.length, best + 2);
  return { text: lines.slice(start, end).join('\n').slice(0, 1600), startLine: start + 1, endLine: end };
}
export function retrieve(vault, query, options = {}) {
  return withLock(vault, () => {
    const result = rank(pages(vault), query, options).map(d => ({ id: d.id, title: d.title, domain: d.domain ?? d.project, project: d.domain ?? d.project, path: d.path, score: d.score, hash: d.hash, citation: `[[${d.path.slice(0, -3)}|${d.title}]]`, snippet: snippet(d, d.matched), sources: d.props.source_refs ?? d.props.sources ?? [] }));
    return { retriever: RETRIEVER_VERSION, query, results: result };
  });
}
