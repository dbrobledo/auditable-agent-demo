/**
 * Small abort/deadline helpers. Everything that waits in this codebase waits
 * through one of these, so a shutdown or a blown deadline can always unwind it.
 */

/** Thrown when a wait is cut short by an AbortSignal. */
export class AbortedError extends Error {
  /** @param {string} message @param {unknown} [reason] */
  constructor(message, reason) {
    super(message);
    this.name = 'AbortedError';
    this.reason = reason;
  }
}

/**
 * Sleep that can be cut short by a signal.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError('sleep aborted', signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    /** @type {() => void} */
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError('sleep aborted', signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait for `promise`, but give up early if `signal` aborts.
 *
 * The underlying work is NOT cancelled — that is deliberate. A caller who has
 * run out of deadline should stop waiting, but a shared in-flight vendor call
 * (see singleflight) must still finish so the cache gets filled for everyone
 * else. Cancellation of the work itself is the caller's business, via a signal
 * passed into the work.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AbortedError('aborted', signal.reason));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AbortedError('aborted', signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * A deadline signal, optionally combined with a caller-supplied signal.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {AbortSignal}
 */
export function deadlineSignal(ms, signal) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
