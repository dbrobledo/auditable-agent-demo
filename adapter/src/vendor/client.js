/**
 * The single call site for the vendor.
 *
 * Everything we send them goes through here, which is what makes the
 * concurrency limit, the breaker and the retry budget actually mean something —
 * one bypassing `fetch()` elsewhere in the codebase and the guarantees are
 * gone. Treat this as an anti-corruption layer too: vendor status codes and
 * payload quirks stop here and do not leak into our domain.
 *
 * Composition order matters:
 *
 *   withRetry(                <- sleeps BETWEEN attempts, holding nothing
 *     breaker.assertPass()    <- fail fast when they are down
 *     limiter.acquire()       <- wait for a slot, or shed if out of deadline
 *     pool.request()          <- the actual call, under its own deadline
 *   )
 *
 * The retry loop sits outside the limiter on purpose: sleeping while holding a
 * concurrency token would burn a slot of the vendor's scarce capacity doing
 * nothing.
 */

import { Pool } from 'undici';
import { AdaptiveLimiter, AdmissionError } from '../control/limiter.js';
import { CircuitBreaker, BreakerOpenError } from '../control/breaker.js';
import { RetryBudget, withRetry } from '../control/retry.js';
import { VendorError, classify, isOverloadSignal, parseRetryAfter } from './errors.js';
import { Metrics } from '../obs/metrics.js';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

export class VendorClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {AdaptiveLimiter} [opts.limiter]
   * @param {CircuitBreaker} [opts.breaker]
   * @param {RetryBudget} [opts.retryBudget]
   * @param {Metrics} [opts.metrics]
   * @param {import('undici').Pool} [opts.pool]  Injectable for tests.
   * @param {object} [opts.timeouts]
   * @param {number} [opts.timeouts.headersMs]
   * @param {number} [opts.timeouts.bodyMs]
   * @param {number} [opts.timeouts.callMs]      Whole-call deadline.
   * @param {number} [opts.timeouts.admissionMs] How long we will queue for a slot.
   * @param {object} [opts.retry]
   * @param {number} [opts.retry.attempts]
   * @param {number} [opts.retry.baseMs]
   * @param {number} [opts.retry.maxMs]
   * @param {(headers: Record<string,string>) => Record<string,string>} [opts.auth]
   * @param {boolean} [opts.vendorHonoursIdempotencyKey] Set true only once they
   *   confirm it in writing — it changes how timed-out writes are treated.
   */
  constructor({
    baseUrl,
    limiter = new AdaptiveLimiter({ mode: 'gradient' }),
    breaker = new CircuitBreaker(),
    retryBudget = new RetryBudget(),
    metrics = new Metrics(),
    pool,
    timeouts = {},
    retry = {},
    auth = (h) => h,
    vendorHonoursIdempotencyKey = false,
  }) {
    this.baseUrl = baseUrl;
    this.limiter = limiter;
    this.breaker = breaker;
    this.retryBudget = retryBudget;
    this.metrics = metrics;
    this.auth = auth;
    this.vendorHonoursIdempotencyKey = vendorHonoursIdempotencyKey;

    this.timeouts = {
      headersMs: timeouts.headersMs ?? 10_000,
      bodyMs: timeouts.bodyMs ?? 10_000,
      callMs: timeouts.callMs ?? 15_000,
      admissionMs: timeouts.admissionMs ?? 2_000,
    };
    this.retry = {
      attempts: retry.attempts ?? 3,
      baseMs: retry.baseMs ?? 100,
      maxMs: retry.maxMs ?? 5_000,
    };

    this.pool = pool ?? new Pool(baseUrl, {
      // Keep-alive matters more than usual here: a TLS handshake per call
      // against a slow vendor is pure waste. Size the pool a little above the
      // limiter's ceiling — the semaphore is the control, the pool is a
      // backstop against a bug in the semaphore.
      connections: Math.ceil(limiter.maxLimit * 1.2),
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
      headersTimeout: this.timeouts.headersMs,
      bodyTimeout: this.timeouts.bodyMs,
    });

    metrics.gauge('vendor_concurrency_limit', () => this.limiter.limit);
    metrics.gauge('vendor_in_flight', () => this.limiter.inFlight);
    metrics.gauge('vendor_breaker_open', () => (this.breaker.state === 'closed' ? 0 : 1));
  }

  /**
   * @param {object} req
   * @param {string} req.path
   * @param {string} [req.method]
   * @param {unknown} [req.body]           JSON-serialised when present.
   * @param {Record<string,string>} [req.headers]
   * @param {boolean} [req.priority]       True for user-facing, latency-bound work.
   * @param {string} [req.idempotencyKey]
   * @param {string} [req.correlationId]   Stamped so a timed-out write can be read back.
   * @param {AbortSignal} [req.signal]
   * @param {number} [req.attempts]        Override; interactive lane should pass 1.
   * @param {number} [req.admissionMs]     Override; interactive lane passes its remaining budget.
   * @returns {Promise<{status: number, headers: Record<string,any>, body: any}>}
   */
  async request({
    path,
    method = 'GET',
    body,
    headers = {},
    priority = false,
    idempotencyKey,
    correlationId,
    signal,
    attempts,
    admissionMs,
  }) {
    const upper = method.toUpperCase();
    const idempotent = IDEMPOTENT_METHODS.has(upper);
    const hasIdempotencyKey = Boolean(idempotencyKey) && this.vendorHonoursIdempotencyKey;
    const lane = priority ? 'interactive' : 'deferred';

    return withRetry(
      () => this._attempt({
        path, method: upper, body, headers, priority, idempotencyKey, correlationId,
        signal, idempotent, hasIdempotencyKey, lane,
        admissionMs: admissionMs ?? this.timeouts.admissionMs,
      }),
      {
        attempts: attempts ?? this.retry.attempts,
        baseMs: this.retry.baseMs,
        maxMs: this.retry.maxMs,
        budget: this.retryBudget,
        signal,
        isRetryable: (err) => err instanceof VendorError && err.kind === 'retryable',
        retryAfterMs: (err) => (err instanceof VendorError ? err.retryAfterMs : undefined),
        onRetry: ({ err }) => {
          this.metrics.increment('vendor_retries_total', {
            lane,
            status: String(/** @type {VendorError} */ (err).status ?? 'transport'),
          });
        },
      },
    );
  }

  /** One attempt: breaker, admission, call, classification. */
  async _attempt(ctx) {
    const { lane, priority, idempotent, hasIdempotencyKey } = ctx;

    try {
      this.breaker.assertPass();
    } catch (err) {
      if (err instanceof BreakerOpenError) {
        this.metrics.increment('vendor_breaker_rejections_total', { lane });
        // Retryable, but with the wait the breaker itself dictates. The
        // interactive lane passes attempts:1 so it fails fast instead.
        throw new VendorError('circuit open', { kind: 'retryable', retryAfterMs: err.retryAfterMs, cause: err });
      }
      throw err;
    }

    let token;
    try {
      token = await this.limiter.acquire({
        priority,
        signal: AbortSignal.any([
          AbortSignal.timeout(ctx.admissionMs),
          ...(ctx.signal ? [ctx.signal] : []),
        ]),
      });
    } catch (err) {
      if (err instanceof AdmissionError) {
        // Shedding is the designed behaviour, not an anomaly: we refuse to
        // queue user-facing work behind a saturated vendor.
        this.metrics.increment('vendor_shed_total', { lane });
        throw new VendorError('shed: no capacity within deadline', {
          kind: 'retryable',
          retryAfterMs: this.retry.baseMs,
          cause: err,
        });
      }
      throw err;
    }

    const startedAt = performance.now();
    let status;
    let transportError;
    let responseHeaders = {};
    let responseBody;

    try {
      const res = await this.pool.request({
        path: ctx.path,
        method: ctx.method,
        headers: this._headers(ctx),
        body: ctx.body === undefined ? undefined : JSON.stringify(ctx.body),
        signal: AbortSignal.any([
          AbortSignal.timeout(this.timeouts.callMs),
          ...(ctx.signal ? [ctx.signal] : []),
        ]),
        headersTimeout: this.timeouts.headersMs,
        bodyTimeout: this.timeouts.bodyMs,
      });
      status = res.statusCode;
      responseHeaders = res.headers;
      // Always drain: an undrained body holds the connection out of the pool.
      responseBody = await readBody(res.body);
    } catch (err) {
      transportError = err;
    }

    const rttMs = performance.now() - startedAt;
    const kind = classify({ status, error: transportError, idempotent, hasIdempotencyKey });

    this.metrics.observe('vendor_rtt_ms', rttMs, { lane });
    this.metrics.increment('vendor_calls_total', { lane, kind });

    if (kind === 'success') {
      token.success(rttMs);
      this.breaker.onSuccess();
      return { status, headers: responseHeaders, body: responseBody };
    }

    if (isOverloadSignal({ status, error: transportError })) {
      token.overload(rttMs);
      this.breaker.onFailure();
    } else {
      // A 400 or 404 says nothing about their capacity. Letting it shrink the
      // limit would throttle us for our own bugs.
      token.ignore();
      if (kind !== 'terminal') this.breaker.onFailure();
    }

    throw new VendorError(
      transportError ? `vendor transport error: ${transportError.message}` : `vendor responded ${status}`,
      {
        kind,
        status,
        retryAfterMs: parseRetryAfter(responseHeaders['retry-after']),
        correlationId: ctx.correlationId,
        cause: transportError,
        body: typeof responseBody === 'string' ? responseBody.slice(0, 512) : undefined,
      },
    );
  }

  _headers(ctx) {
    /** @type {Record<string,string>} */
    const h = { accept: 'application/json', ...ctx.headers };
    if (ctx.body !== undefined) h['content-type'] = 'application/json';
    if (ctx.idempotencyKey) h['idempotency-key'] = ctx.idempotencyKey;
    // Stamp our correlation id even when they ignore the header: if they echo
    // it into any searchable field, a timed-out write becomes recoverable
    // instead of indeterminate.
    if (ctx.correlationId) h['x-correlation-id'] = ctx.correlationId;
    return this.auth(h);
  }

  async close() {
    await this.pool.close();
  }

  snapshot() {
    return {
      limiter: this.limiter.snapshot(),
      breaker: this.breaker.snapshot(),
      retryBudget: this.retryBudget.snapshot(),
    };
  }
}

/** @param {any} body */
async function readBody(body) {
  const text = await body.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
