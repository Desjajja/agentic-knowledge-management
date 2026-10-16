// Keep provider totals intact: reasoning/cache fields can be subsets, not additions.
export function sumUsage(rounds) {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'];
  return Object.fromEntries(fields.map(field => [field, rounds.length && rounds.every(r => Number.isFinite(r.usage?.[field])) ? rounds.reduce((n, r) => n + r.usage[field], 0) : null]));
}
export function usageRounds(messages) {
  return messages.filter(m => m.role === 'assistant').map((m, i) => ({ round: i + 1, model: m.model, stopReason: m.stopReason, usage: m.usage?.totalTokens > 0 ? m.usage : null }));
}
