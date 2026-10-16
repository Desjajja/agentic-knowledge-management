import { check, json } from './storage.js';
import { showPage } from './knowledge.js';
import { retrieve } from './retrieve.js';
import { retrieveEvidence, sections, evidenceForModel } from './evidence.js';

// Vault-scoped tools: no shell or writes, and page reads must follow discovery.
export function knowledgeTools(vault, { project, domain = project, discovered = new Map(), onRead, onTrace, maxCalls = Infinity, budgetChars = 48000 } = {}) {
  let calls = 0, remaining = budgetChars;
  const begin = () => check(++calls <= maxCalls && remaining >= 200, 'Evidence supplement budget exhausted', 'EVIDENCE_BUDGET');
  const result = value => ({ content: [{ type: 'text', text: json(value) }], details: value });
  return [
    {
      name: 'akm_retrieve_evidence', label: '聚合知识证据',
      description: 'Prefer this to repeated search/read. Batch up to three query variants and optional discovered section reads, returning cited original passages in one call. Use only section IDs from sectionCatalog; never guess IDs from line numbers. When unsure, omit reads and search by query. Only the selected domain. Truncation is not evidence of absence.',
      parameters: { type: 'object', properties: { reads: { type: 'array', maxItems: 8, items: { type: 'object', properties: { path: { type: 'string' }, sections: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 8 } }, required: ['path', 'sections'], additionalProperties: false } }, query: { type: 'string' }, queries: { type: 'array', items: { type: 'string' }, maxItems: 2 } }, additionalProperties: false },
      execute: async (_id, { query, queries = [], reads = [] }) => {
        begin();
        const callBudget = remaining;
        check(typeof query === 'string' && query.trim() || reads.length, 'Query or section reads required');
        check(Array.isArray(reads) && reads.length <= 8, 'Invalid section reads');
        const grouped = new Map();
        for (const read of reads) {
          check(discovered.has(read.path), 'Discover a page before section reads', 'PAGE_NOT_DISCOVERED');
          check(Array.isArray(read.sections) && read.sections.length <= 8 && read.sections.every(Number.isSafeInteger), 'Invalid section selection');
          grouped.set(read.path, [...new Set([...(grouped.get(read.path) ?? []), ...read.sections])]);
        }
        // Explicit section reads take precedence over a second search result for
        // the same page. Group repeated paths before spending evidence budget.
        const evidence = query ? retrieveEvidence(vault, query, { domain, queries, excludePaths: [...grouped.keys()], budgetChars: Math.min(24000, remaining) }) : { results: [], budget: { used: 0 }, retrievalState: 'candidates_found' };
        remaining -= evidence.budget.used;
        for (const [readPath, requestedSections] of grouped) {
          const read = { path: readPath, sections: requestedSections };
          check(discovered.has(read.path), 'Discover a page before section reads', 'PAGE_NOT_DISCOVERED');
          const page = showPage(vault, read.path);
          check((!domain || page.domain === domain) && page.hash === discovered.get(read.path), 'Evidence changed during task', 'CONFLICT');
          check(Array.isArray(read.sections) && read.sections.length <= 8 && read.sections.every(Number.isSafeInteger), 'Invalid section selection');
          const all = sections(page), passages = [];
          for (const index of [...new Set(read.sections)]) {
            check(all[index], `Unknown section; available IDs: ${all.map((_,i)=>i).slice(0,128).join(',')}`);
            const part = all[index], text = part.text.slice(0, remaining);
            if (!text) { if (!remaining) break; else continue; }
            passages.push({ section: index, startLine: page.bodyStartLine + part.start, endLine: page.bodyStartLine + part.start + text.split('\n').length - 1, text, truncated: text.length < part.text.length });
            remaining -= text.length;
          }
          evidence.results.push({ path: page.path, title: page.title, project: page.project, hash: page.hash, citation: `[[${page.path.slice(0,-3)}|${page.title}]]`, passages, content: passages.map(p => p.text).join('\n\n'), contentTruncated: passages.length < all.length || passages.some(p => p.truncated) });
        }
        evidence.budget = { unit: 'characters-not-tokens', limit: callBudget, used: callBudget - remaining };
        evidence.budgetExhausted = remaining === 0;
        evidence.retrievalState = evidence.results.length ? 'candidates_found' : 'no_candidates';
        evidence.supplementBudgetRemaining = remaining;
        for (const page of evidence.results) {
          check(!discovered.has(page.path) || discovered.get(page.path) === page.hash, 'Evidence changed during task', 'CONFLICT');
          discovered.set(page.path, page.hash);
        }
        await onTrace?.({ phase: 'tool', tool: 'akm_retrieve_evidence', evidence });
        return { content: [{ type: 'text', text: json(evidenceForModel(evidence)) }], details: evidence };
      },
    },
    {
      name: 'akm_search', label: '搜索知识库',
      description: 'Search the selected knowledge domain. Returns short snippets; use akm_read to verify full evidence. Try Chinese and original technical terms when needed.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false },
      execute: async (_id, { query, k = 5 }) => {
        begin();
        const evidence = retrieve(vault, query, { domain, k });
        const callBudget = remaining;
        for (const page of evidence.results) { page.snippet.text = page.snippet.text.slice(0, remaining); remaining -= page.snippet.text.length; }
        evidence.budget = { unit: 'characters-not-tokens', limit: callBudget, used: callBudget - remaining };
        evidence.budgetExhausted = remaining === 0;
        for (const page of evidence.results) { check(!discovered.has(page.path) || discovered.get(page.path) === page.hash, 'Evidence changed during task', 'CONFLICT'); discovered.set(page.path, page.hash); }
        await onTrace?.({ phase: 'tool', tool: 'akm_search', query, evidence });
        return result(evidence);
      },
    },
    {
      name: 'akm_read', label: '读取知识页',
      description: 'Read a discovered page in bounded chunks (offset in characters, max 8000). Continue while contentTruncated is true; snippets alone may omit later revisions.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8000 } }, required: ['path'], additionalProperties: false },
      execute: async (_id, { path, offset = 0, limit = 8000 }) => {
        begin();
        check(discovered.has(path), 'Search for a page before reading it', 'PAGE_NOT_DISCOVERED');
        const page = showPage(vault, path);
        check(!domain || page.domain === domain, 'Page is outside selected domain');
        check(page.hash === discovered.get(path), 'Evidence changed after discovery', 'CONFLICT');
        check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 8000, 'Invalid read bounds');
        const content = page.body.slice(offset, offset + Math.min(limit, remaining));
        remaining -= content.length;
        const value = { path, title: page.title, hash: page.hash, citation: `[[${page.path.slice(0, -3)}|${page.title}]]`, content, offset, nextOffset: offset + content.length, contentTruncated: offset + content.length < page.body.length };
        onRead?.(page, value);
        await onTrace?.({ phase: 'tool', tool: 'akm_read', ...value });
        return result(value);
      },
    },
  ];
}
