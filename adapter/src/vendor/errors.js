/**
 * Failure classification.
 *
 * The distinction this file exists for: a timeout is not a failure, it is an
 * *unknown outcome*. For a GET that is irrelevant — just ask again. For a POST
 * against a vendor with no idempotency-key support it is the difference between
 * a retry and a duplicate record.
 *
 * Four kinds:
 *   success        2xx.
 *   retryable      Safe to try again; the vendor did not act, or acting twice
 *                  is harmless.
 *   terminal       Our fault or a permanent no. Retrying will never help.
 *   indeterminate  We do not know whether the vendor applied the change. Never
 *                  retried automatically: the caller must read back by
 *                  correlation id, or route the job to reconciliation.
 *
 * Supplying an idempotency key the vendor honours collapses `indeterminate`
 * into `retryable`. That is the entire value of idempotency keys, and the
 * reason to keep asking the vendor for them.
 */

/** @typedef {'success'|'retryable'|'terminal'|'indeterminate'} FailureKind */

export class VendorError extends Error {
  /**
   * @param {string} message
   * @param {object} info
   * @param {FailureKind} info.kind
   * @param {number} [info.status]
   * @param {number} [info.retryAfterMs]
   * @param {string} [info.correlationId]
   * @param {unknown} [info.cause]
   * @param {string} [info.body]
   */
  constructor(message, { kind, status, retryAfterMs, correlationId, cause, body }) {
    super(message, { cause });
    this.name = 'VendorError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.correlationId = correlationId;
    this.body = body;
  }
}

/** Transport-level error codes that mean "no response was received". */
const NO_RESPONSE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** Undici / AbortSignal errors that mean "we gave up waiting". */
const TIMEOUT_NAMES = new Set(['TimeoutError', 'AbortError', 'HeadersTimeoutError', 'BodyTimeoutError']);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);

/**
 * @param {object} args
 * @param {number} [args.status]        HTTP status, when a response arrived.
 * @param {any} [args.error]            Transport error, when one did not.
 * @param {boolean} [args.idempotent]   True for GET/HEAD/PUT/DELETE by contract.
 * @param {boolean} [args.hasIdempotencyKey] True if the vendor honours our key.
 * @returns {FailureKind}
 */
export function classify({ status, error, idempotent = false, hasIdempotencyKey = false }) {
  const safeToRepeat = idempotent || hasIdempotencyKey;

  if (error) {
    const code = error.code;
    const name = error.name;

    if (TIMEOUT_NAMES.has(name) || TIMEOUT_CODES.has(code)) {
      // We stopped listening. The vendor may well have processed it.
      return safeToRepeat ? 'retryable' : 'indeterminate';
    }
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
      // The request never reached them; safe to repeat regardless of method.
      return 'retryable';
    }
    if (NO_RESPONSE_CODES.has(code)) {
      // A reset mid-flight could have happened after they applied the change.
      return safeToRepeat ? 'retryable' : 'indeterminate';
    }
    return safeToRepeat ? 'retryable' : 'indeterminate';
  }

  if (status === undefined) return 'terminal';
  if (status >= 200 && status < 300) return 'success';

  if (status === 408) return safeToRepeat ? 'retryable' : 'indeterminate';
  if (status === 425 || status === 429) return 'retryable';

  if (status >= 500) {
    // 502/503 from a gateway usually means the request was refused before the
    // application saw it, but "usually" is not a guarantee we can act on for a
    // write, and this vendor's degradation shows up as exactly these codes.
    if (status === 501 || status === 505) return 'terminal';
    return safeToRepeat ? 'retryable' : 'indeterminate';
  }

  // 4xx: our request is wrong, or the answer is a permanent no.
  return 'terminal';
}

/**
 * Should this outcome push the concurrency limit down?
 *
 * Only signals about *their* capacity count. A 404 or a validation error says
 * nothing about how much load they can take, and letting those shrink the limit
 * would throttle us for our own bugs.
 *
 * @param {object} args
 * @param {number} [args.status]
 * @param {any} [args.error]
 * @returns {boolean}
 */
export function isOverloadSignal({ status, error }) {
  if (error) {
    const code = error.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return false;
    return true; // timeouts, resets, socket errors: back off.
  }
  if (status === undefined) return false;
  return status === 429 || status === 408 || (status >= 500 && status !== 501 && status !== 505);
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date).
 * @param {string|null|undefined} value
 * @param {() => number} [now]
 * @returns {number|undefined} milliseconds
 */
export function parseRetryAfter(value, now = Date.now) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now());
}
