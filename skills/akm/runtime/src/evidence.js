import { check, hash, json, pages } from './storage.js';
import { rank, tokenize, snippet, RETRIEVER_VERSION } from './retrieve.js';
import { withLock } from './transaction.js';

export function sections(page) {
  const lines = page.body.split('\n'), starts = [0];
  for (let i = 1; i < lines.length; i++) if (/^#{1,6} /.test(lines[i])) starts.push(i);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? lines.length, text: lines.slice(start, starts[i + 1] ?? lines.length).join('\n') }));
}
export function retrieveEvidence(vault, query, { project, domain = project, queries = [], k = 5, budgetChars = 24000, perPageChars = 12000, excludePaths = [] } = {}) {
  check(Number.isSafeInteger(k) && k >= 1 && k <= 100, 'Invalid result count');
  check(Array.isArray(queries) && queries.length <= 2 && queries.every(q => typeof q === 'string' && q.trim()), 'At most two extra queries');
  check(Number.isSafeInteger(budgetChars) && budgetChars >= 200 && budgetChars <= 128000, 'Invalid evidence budget');
  check(Number.isSafeInteger(perPageChars) && perPageChars >= 200 && perPageChars <= 64000, 'Invalid per-page budget');
  const variants = [...new Set([query, ...queries])];
  return withLock(vault, () => {
    const corpus = pages(vault).filter(p => !excludePaths.includes(p.path)), candidates = new Map();
    for (const variant of variants) {
      const termCount = tokenize(variant).length;
      // Short queries often contain one decisive title term. Require multiple
      // independent matches only for longer natural-language questions, where
      // a single common word is a reliable noise signal.
      const minMatched = termCount >= 4 ? 2 : 1;
      rank(corpus, variant, { domain, k: Math.min(100, k * 3), minMatched }).forEach((page, i) => {
      const prior = candidates.get(page.path) ?? { page, score: 0 };
      prior.score += 1 / (60 + i + 1); candidates.set(page.path, prior);
      });
    }
    const ordered = [...candidates.values()].sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path));
    // Diversify softly: second same-source page follows first pages from other sources.
    const selected = [], deferred = [], origins = new Set();
    for (const entry of ordered) {
      const refs = entry.page.props.source_refs ?? entry.page.props.sources ?? [entry.page.path];
      const origin = (Array.isArray(refs) ? refs : [refs]).slice().sort().join('|');
      (origins.has(origin) ? deferred : selected).push(entry); origins.add(origin);
    }
    const chosen = [...selected, ...deferred].slice(0, k), terms = new Set(tokenize(variants.join(' ')));
    let remaining = budgetChars;
    const results = [];
    for (const { page, score } of chosen) {
      const parts = sections(page);
      const scored = parts.map((part, i) => ({ ...part, i, score: tokenize(part.text).reduce((n, t) => n + (terms.has(t) ? 1 : 0), 0), guard: /definit|informal|thesis|定义|概念|scope|范围|caveat|limit|限制|争议|rebuttal|update|更新|revision|修订|histor|历史/i.test(part.text.split('\n').slice(0, 2).join(' ')) }));
      let cap = Math.min(perPageChars, remaining);
      const passages = [];
      const take = part => {
        if (cap <= 0 || passages.some(p => p.section === part.i)) return;
        const text = part.text.slice(0, cap);
        passages.push({ section: part.i, startLine: page.bodyStartLine + part.start, endLine: page.bodyStartLine + part.start + text.split('\n').length - 1, text, truncated: text.length < part.text.length });
        cap -= text.length; remaining -= text.length;
      };
      if (page.body.length <= cap) scored.forEach(take);
      else {
        // Definitions and revision/dispute sections compete with matching sections, not only the prefix.
        const best = scored.slice().sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 2);
        const guards = scored.filter(p => p.guard && !best.includes(p));
        // Put short critical sections first so a large matching section cannot consume their budget.
        const fullCap = cap;
        cap = Math.floor(fullCap * 0.3);
        guards.sort((a, b) => a.text.length - b.text.length).forEach(take);
        cap += fullCap - Math.floor(fullCap * 0.3);
        best.forEach(take);
      }
      passages.sort((a, b) => a.startLine - b.startLine);
      const omittedSections = scored.filter(p => !passages.some(x => x.section === p.i)).map(p => ({ startLine: page.bodyStartLine + p.start, endLine: page.bodyStartLine + p.end - 1 }));
      const truncated = omittedSections.length > 0 || passages.some(p => p.truncated);
      const content = passages.map(p => p.text).join('\n\n');
      const sectionCatalog = parts.slice(0,128).map((part, section) => ({ section, heading: part.text.split('\n').find(line=>line.trim())?.slice(0,120) ?? '', startLine: page.bodyStartLine + part.start, endLine: page.bodyStartLine + part.end - 1 }));
      results.push({ id: page.id, title: page.title, domain: page.domain ?? page.project, project: page.domain ?? page.project, path: page.path, hash: page.hash, score, citation: `[[${page.path.slice(0, -3)}|${page.title}]]`, sources: page.props.source_refs ?? page.props.sources ?? [], content, passages, sectionCatalog, sectionCatalogTruncated: parts.length > 128, contentTruncated: truncated, omittedSections, snippet: snippet(page, [...terms]) });
    }
    return { retriever: RETRIEVER_VERSION + '+evidence-v2', query, queries: variants, snapshotId: hash(json(results.map(p => [p.path, p.hash]))), results, retrievalState: results.length ? 'candidates_found' : 'no_candidates', budget: { unit: 'characters-not-tokens', limit: budgetChars, used: budgetChars - remaining }, budgetExhausted: remaining === 0 };
  });
}

// Keep compatibility fields in artifacts, but send each passage only once to an agent.
export function evidenceForModel(evidence) {
  return { ...evidence, results: evidence.results.map(({ content, snippet, ...page }) => page.passages ? page : { ...page, content, snippet }) };
}
