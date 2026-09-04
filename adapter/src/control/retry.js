/**
 * Retry with full jitter and a retry budget.
 *
 * Two rules that most integrations get wrong:
 *
 * 1. Full jitter, not "exponential backoff plus a bit of noise". Synchronised
 *    clients retrying on the same curve re-converge into the same spike that
 *    knocked the vendor over.
 *
 * 2. A budget. Unbounded per-request retries mean a vendor brownout multiplies
 *    our offered load by the attempt count at exactly the moment they can least
 *    afford it — the classic retry storm. The budget caps retries as a fraction
 *    of overall traffic, so degradation stays linear.
 *
 * What is retryable is decided in vendor/errors.js, not here. Notably an
 * `indeterminate` outcome is never retried by this function: a timed-out
 * non-idempotent write may or may not have landed, and retrying it blind is how
 * a retry policy becomes a data-corruption engine.
 */

import { sleep } from '../util/abort.js';

export class RetryBudget {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ratio]    Retries earned per call (0.1 = 10% of traffic).
   * @param {number} [opts.capacity] Burst allowance.
   */
  constructor({ ratio = 0.1, capacity = 10 } = {}) {
    this.ratio = ratio;
    this.capacity = capacity;
    // Start full so a low-traffic system can still retry its first failure.
    this.tokens = capacity;
    this.stats = { granted: 0, denied: 0 };
  }

  /** Record an initial attempt; earns fractional retry budget. */
  recordCall() {
    this.tokens = Math.min(this.capacity, this.tokens + this.ratio);
  }

  /** @returns {boolean} true if a retry may proceed. */
  tryConsume() {
    // Epsilon because the refill is fractional: ten additions of 0.1 land on
    // 0.9999999999999999, which would silently deny a retry that was earned.
    if (this.tokens < 1 - 1e-9) {
      this.stats.denied++;
      return false;
    }
    this.tokens = Math.max(0, this.tokens - 1);
    this.stats.granted++;
    return true;
  }

  snapshot() {
    return { tokens: this.tokens, ...this.stats };
  }
}

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {object} opts
 * @param {number} [opts.attempts]      Total attempts including the first.
 * @param {number} [opts.baseMs]
 * @param {number} [opts.maxMs]
 * @param {RetryBudget} [opts.budget]
 * @param {AbortSignal} [opts.signal]
 * @param {(err: unknown) => boolean} opts.isRetryable
 * @param {(err: unknown) => number|undefined} [opts.retryAfterMs] Server-directed wait.
 * @param {(info: {attempt: number, delayMs: number, err: unknown}) => void} [opts.onRetry]
 * @param {() => number} [opts.random]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, {
  attempts = 3,
  baseMs = 100,
  maxMs = 10_000,
  budget,
  signal,
  isRetryable,
  retryAfterMs,
  onRetry,
  random = Math.random,
}) {
  budget?.recordCall();

  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1) break;
      if (!isRetryable(err)) break;
      if (budget && !budget.tryConsume()) break;

      // Full jitter: uniform in [0, cap]. If the vendor told us how long to
      // wait, honour it and add jitter on top rather than replacing it.
      const cap = Math.min(maxMs, baseMs * 2 ** attempt);
      const directed = retryAfterMs?.(err);
      const delayMs = directed != null
        ? Math.min(maxMs, directed + random() * baseMs)
        : random() * cap;

      onRetry?.({ attempt, delayMs, err });
      await sleep(delayMs, signal);
    }
  }
  throw lastErr;
}
