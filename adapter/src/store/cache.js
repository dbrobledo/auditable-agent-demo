/**
 * Cache-aside with stale-while-revalidate (RFC 5861) and request collapsing.
 *
 * On the interactive lane this is the highest-leverage component in the
 * adapter, because it is one of the only two things here that *removes* vendor
 * calls rather than reshaping them (the other is write coalescing).
 *
 * Three states per key:
 *   fresh   Within freshMs. Served directly, no vendor call.
 *   stale   Past freshMs but within staleMs. Served immediately, and a single
 *           background refresh is kicked off. The user never waits on the
 *           vendor, and a vendor outage degrades to "slightly old data" rather
 *           than an error.
 *   miss    Absent or past staleMs. The only case that blocks on the vendor,
 *           and even then N concurrent misses collapse into one call.
 *
 * The default store is an in-process Map with an LRU bound. The interface is
 * deliberately tiny (get/set/delete) so a shared Redis/Elasticache store drops
 * in unchanged when you scale past one instance.
 */

import { createSingleflight } from '../control/singleflight.js';

export class MemoryStore {
  /** @param {object} [opts] @param {number} [opts.maxEntries] */
  constructor({ maxEntries = 10_000 } = {}) {
    this.maxEntries = maxEntries;
    /** @type {Map<string, {value: any, storedAt: number}>} */
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Refresh recency for the LRU eviction below.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key, entry) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  delete(key) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}

export class CacheAside {
  /**
   * @param {object} [opts]
   * @param {MemoryStore} [opts.store]
   * @param {number} [opts.freshMs]
   * @param {number} [opts.staleMs]   Total lifetime; must exceed freshMs.
   * @param {number} [opts.negativeMs] Lifetime for a null result. Caching "not
   *   found" matters: without it, lookups for things that do not exist are the
   *   traffic that never benefits from a cache at all.
   * @param {() => number} [opts.now]
   * @param {(err: unknown, key: string) => void} [opts.onRefreshError]
   */
  constructor({
    store = new MemoryStore(),
    freshMs = 30_000,
    staleMs = 300_000,
    negativeMs = 5_000,
    now = Date.now,
    onRefreshError = null,
  } = {}) {
    if (staleMs < freshMs) throw new RangeError('staleMs must be >= freshMs');
    this.store = store;
    this.freshMs = freshMs;
    this.staleMs = staleMs;
    this.negativeMs = negativeMs;
    this.now = now;
    this.onRefreshError = onRefreshError;
    this.singleflight = createSingleflight();
    this.stats = { hitFresh: 0, hitStale: 0, miss: 0, refreshes: 0, refreshErrors: 0 };
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} loader
   * @returns {Promise<{value: T, state: 'fresh'|'stale'|'miss'}>}
   */
  async get(key, loader) {
    const entry = this.store.get(key);
    const age = entry ? this.now() - entry.storedAt : Infinity;
    const freshFor = entry?.value == null ? this.negativeMs : this.freshMs;

    if (entry && age <= freshFor) {
      this.stats.hitFresh++;
      return { value: entry.value, state: 'fresh' };
    }

    if (entry && age <= this.staleMs) {
      this.stats.hitStale++;
      this._refreshInBackground(key, loader);
      return { value: entry.value, state: 'stale' };
    }

    this.stats.miss++;
    const value = await this.singleflight.run(key, async () => {
      const loaded = await loader();
      this.store.set(key, { value: loaded, storedAt: this.now() });
      return loaded;
    });
    return { value, state: 'miss' };
  }

  /**
   * Kick off at most one refresh per key. Errors are swallowed by design: the
   * caller already has a usable stale value, and a failing refresh must not
   * turn a served request into an error.
   */
  _refreshInBackground(key, loader) {
    if (this.singleflight.has(key)) return;
    this.stats.refreshes++;
    void this.singleflight
      .run(key, async () => {
        const loaded = await loader();
        this.store.set(key, { value: loaded, storedAt: this.now() });
        return loaded;
      })
      .catch((err) => {
        this.stats.refreshErrors++;
        this.onRefreshError?.(err, key);
      });
  }

  /** Drop a key, e.g. after we write through to the vendor. */
  invalidate(key) {
    this.store.delete(key);
  }

  snapshot() {
    return { ...this.stats, size: this.store.size, inflight: this.singleflight.size };
  }
}
