/**
 * Request collapsing (single-flight).
 *
 * When a popular cache key expires, every concurrent request for it misses at
 * once and stampedes the vendor. Collapsing means N concurrent callers for the
 * same key produce exactly one vendor call and N awaits of its result.
 *
 * Against a dependency that degrades under concurrency this is one of the
 * cheapest wins available: it removes calls rather than reshaping them.
 *
 * Note on cancellation: a caller who gives up (deadline blown) detaches from
 * the shared promise via `raceSignal`, but the underlying call keeps running so
 * the cache still gets filled for everyone behind it. See util/abort.js.
 */

export function createSingleflight() {
  /** @type {Map<string, {promise: Promise<any>, subscribers: number}>} */
  const inflight = new Map();

  return {
    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(key, fn) {
      const existing = inflight.get(key);
      if (existing) {
        existing.subscribers++;
        return existing.promise;
      }

      const entry = { promise: /** @type {Promise<any>} */ (null), subscribers: 1 };
      // Start inside a resolved chain so a synchronous throw in `fn` becomes a
      // rejected promise rather than escaping past the bookkeeping below.
      entry.promise = Promise.resolve()
        .then(fn)
        .finally(() => {
          if (inflight.get(key) === entry) inflight.delete(key);
        });
      inflight.set(key, entry);
      return entry.promise;
    },

    /** @param {string} key */
    has(key) {
      return inflight.has(key);
    },

    get size() {
      return inflight.size;
    },

    /** How many callers are currently sharing the call for `key`. */
    subscribers(key) {
      return inflight.get(key)?.subscribers ?? 0;
    },
  };
}
