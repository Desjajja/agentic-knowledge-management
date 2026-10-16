import { setTimeout as delay } from 'node:timers/promises';
import { check } from './storage.js';

export function recoveryPolicy(value = {}) {
  const policy = { sameModelRetries: 1, baseDelayMs: 500, attemptTimeoutMs: 20000, maxAttempts: 6, ...value };
  for (const [key, low, high] of [['sameModelRetries', 0, 2], ['baseDelayMs', 0, 10000], ['attemptTimeoutMs', 50, 300000], ['maxAttempts', 1, 12]]) {
    check(Number.isSafeInteger(policy[key]) && policy[key] >= low && policy[key] <= high, `Invalid recovery ${key}`);
  }
  return policy;
}

// Classify privately; never persist arbitrary provider error bodies.
export function classifyFailure(message, status) {
  const text = String(message ?? '');
  status ??= Number(text.match(/\b(400|401|402|403|404|408|409|422|429|500|502|503|504)\b/)?.[1]) || undefined;
  if (status === 401 || status === 403 || /unauthorized|invalid.*api.?key|authentication/i.test(text)) return { kind: 'authentication', action: 'stop', status };
  if (status === 402 || /insufficient_quota|billing|balance|credit|shared.?quota|global.?quota|account.*quota|余额不足|欠费|共享.*配额|全局.*配额|账户.*额度/i.test(text)) return { kind: 'quota_or_billing', action: 'stop', status };
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) return { kind: 'rate_limit', action: 'fallback', status };
  if (status === 404 || /model.*(not found|not exist|unavailable)|tool.*(unsupported|not support)/i.test(text)) return { kind: 'model_compatibility', action: 'fallback', status };
  if (status === 408 || /timeout|timed out|abort/i.test(text)) return { kind: 'timeout', action: 'fallback', status };
  if ([500, 502, 503, 504].includes(status) || /fetch|network|connect|socket|terminated|premature|overload|stream.*(interrupt|closed|incomplete)/i.test(text)) return { kind: 'transient', action: 'retry', status };
  return { kind: status === 400 || status === 422 ? 'invalid_request' : 'unknown', action: 'stop', status };
}

// One invocation is one logical assistant step. Only a successful stream is
// exposed to pi's tool scheduler: partial calls from failed attempts cannot run.
export function recoveringStream({ stream, createStream, models, policy, deadline, attempts, onAttempt }) {
  policy = recoveryPolicy(policy);
  let selected = 0;
  return async (_model, context, options = {}) => {
    const output = createStream();
    let retry = 0;
    while (true) {
      const model = models[selected];
      const controller = new AbortController();
      const remaining = deadline - Date.now();
      const entry = { attempt: attempts.length + 1, model: model.id, startedAt: Date.now(), httpStatus: undefined, usage: null };
      attempts.push(entry);
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted || remaining <= 0) abort();
      const timer = setTimeout(abort, Math.max(1, Math.min(policy.attemptTimeoutMs, remaining)));
      let events = [], result;
      try {
        await onAttempt?.(entry);
        const trackedFetch = async (...args) => {
          const response = await (options.fetch ?? globalThis.fetch)(...args);
          entry.httpStatus = response.status;
          const value = response.headers.get('retry-after');
          if (value) {
            const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
            if (Number.isFinite(ms)) entry.retryAfterMs = Math.max(0, ms);
          }
          return response;
        };
        const inner = await stream(model, context, { ...options, fetch: trackedFetch, signal: controller.signal, maxRetries: 0, timeoutMs: Math.min(policy.attemptTimeoutMs, Math.max(1, remaining)) });
        for await (const event of inner) events.push(event);
        result = await inner.result();
      } catch (error) {
        result = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'error', errorMessage: String(error.message), timestamp: entry.startedAt };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      }
      entry.elapsedMs = Date.now() - entry.startedAt;
      delete entry.startedAt;
      entry.stopReason = result.stopReason;
      // Only explicit provider usage is trustworthy, not estimated token counts.
      if (entry.usageAvailable && result.usage?.totalTokens > 0) entry.usage = result.usage;
      if (!['error', 'aborted'].includes(result.stopReason)) {
        entry.outcome = 'completed';
        for (const event of events) output.push(event);
        output.end(result);
        return output;
      }
      const failure = classifyFailure(controller.signal.aborted ? 'timeout' : result.errorMessage, entry.httpStatus);
      Object.assign(entry, { failureKind: failure.kind, httpStatus: failure.status, outcome: 'failed' });
      const canContinue = !options.signal?.aborted && Date.now() < deadline && attempts.length < policy.maxAttempts;
      let wait = 0;
      if (canContinue && failure.action === 'retry' && retry < policy.sameModelRetries) {
        retry++;
        wait = Math.max(policy.baseDelayMs * 2 ** (retry - 1), entry.retryAfterMs ?? 0);
        entry.recovery = 'retry';
      } else if (canContinue && failure.action !== 'stop' && selected + 1 < models.length) {
        selected++;
        retry = 0;
        entry.recovery = 'fallback';
        wait = failure.kind === 'rate_limit' ? (entry.retryAfterMs ?? 0) : 0;
      } else entry.recovery = 'stop';
      // Do not shorten a server's Retry-After and immediately hammer another model.
      if (Date.now() + wait >= deadline) entry.recovery = 'stop';
      if (entry.recovery === 'stop') {
        output.push({ type: 'error', reason: result.stopReason === 'aborted' ? 'aborted' : 'error', error: result });
        output.end(result);
        return output;
      }
      entry.delayMs = wait;
      try { if (wait) await delay(wait, undefined, { signal: options.signal }); }
      catch { output.push({ type: 'error', reason: 'aborted', error: result }); output.end(result); return output; }
    }
  };
}
