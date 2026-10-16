import { check, hash, json } from './storage.js';

export function sourceChunks(text, { maxChars = 24000, maxChunks = 12 } = {}) {
  const paragraphs = text.split(/\n\s*\n/), chunks = [];
  let chunk = '';
  for (const paragraph of paragraphs) {
    if (chunk && chunk.length + paragraph.length + 2 > maxChars) { chunks.push(chunk); chunk = ''; }
    for (let offset = 0; offset < paragraph.length; offset += maxChars) {
      const part = paragraph.slice(offset, offset + maxChars);
      if (chunk && chunk.length + part.length + 2 > maxChars) { chunks.push(chunk); chunk = ''; }
      chunk += (chunk ? '\n\n' : '') + part;
    }
  }
  if (chunk) chunks.push(chunk);
  check(chunks.length <= maxChunks, 'Source exceeds task budget; split the source into smaller documents', 'SOURCE_BUDGET');
  return chunks;
}
export function sourceKey(input, kind, project, target) {
  return hash(json({ version: 3, input, kind, project: project ?? null, target: target ?? null }));
}
export function criticalNotices(text) {
  const paragraphs = text.split(/\n\s*\n/);
  return paragraphs.filter(p => /rebuttal|not.*peer.review|未经.*同行评审|反驳|勘误|erratum|correction|update.*20\d\d|20\d\d.*update/i.test(p)).slice(0, 4);
}
export function fidelityIssues(content, sources) {
  const original = sources.filter(s => s.kind !== 'manual').map(s => s.content).join('\n');
  const issues = [];
  const comparisonText = content.replace(/[^。；\n]*不(?:等于|等同于)[^。；\n]*非递增[^。；\n]*/g, '').replace(/[^.;\n]*not equivalent[^.;\n]*non.increasing[^.;\n]*/gi, '');
  if (/gone backwards|lower token|lower.*token|更小.*令牌|小于|less than|below/i.test(original) && /non.increasing|非递增|不大于|小于等于|less than or equal/i.test(comparisonText)) issues.push({ code: 'COMPARATOR_CHANGED', message: '更小与非递增不是同一条件；请对照来源修正或明确解释。' });
  if (criticalNotices(original).length && !/反驳|争议|修订|rebuttal|peer.review|correction|update/i.test(content)) issues.push({ code: 'SOURCE_QUALIFIER_MISSING', message: '来源含修订或争议说明，提案尚未体现。' });
  return issues;
}

// Stable original offsets remain valid across chunking; Markdown headings are ordinary source data.
export function documentChunks(text, { maxChars = 24000, maxChunks = 12 } = {}) {
  const chunks = [], paragraphs = [...text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)];
  let parts = [], size = 0;
  for (const [index, match] of paragraphs.entries()) {
    for (let offset = 0; offset < match[0].length; offset += maxChars) {
      const content = match[0].slice(offset, offset + maxChars);
      if (size + content.length > maxChars && parts.length) { chunks.push(parts); parts = []; size = 0; }
      parts.push({ id: `p${index + 1}:${Math.floor(offset / maxChars) + 1}`, paragraphId: `p${index + 1}`, start: match.index + offset, end: match.index + offset + content.length, text: content });
      size += content.length;
    }
  }
  if (parts.length) chunks.push(parts);
  check(chunks.length && chunks.length <= maxChunks, 'Source exceeds task budget; split the source', 'SOURCE_BUDGET');
  return chunks;
}
