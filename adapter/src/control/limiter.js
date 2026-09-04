/**
 * Adaptive concurrency limiter.
 *
 * The vendor publishes no rate limit and degrades in *latency* before it starts
 * erroring, so a fixed concurrency constant is a guess that is wrong at every
 * hour of the day. This limiter discovers the safe concurrency continuously,
 * the way TCP discovers a path's capacity.
 *
 * Two algorithms, selected by `mode`:
 *
 *   'aimd'     Additive increase, multiplicative decrease. Grows by roughly +1
 *              per `limit` successes, cuts by `backoffRatio` on overload.
 *              Simple, well understood, reacts only once things go wrong.
 *
 *   'gradient' Netflix-style latency gradient. Compares current RTT against the
 *              best RTT ever seen; when responses get slower the limit shrinks
 *              proportionally, *before* any error is returned. This is the one
 *              that matches a vendor whose failure mode is degradation.
 *
 * Bulkhead: `reserveForPriority` carves out a slice of the limit that only
 * priority (interactive, user-waiting) work may occupy, so a batch flood can
 * never starve live traffic.
 */

/** Thrown when admission could not be granted before the caller's deadline. */
export class AdmissionError extends Error {
  /** @param {string} message */
  constructor(message = 'not admitted before deadline') {
    super(message);
    this.name = 'AdmissionError';
  }
}

/**
 * @typedef {object} LimiterToken
 * @property {(rttMs: number) => void} success   Call succeeded in rttMs.
 * @property {(rttMs: number) => void} overload  Vendor pushed back (timeout, 5xx, 429).
 * @property {() => void} ignore                 Outcome says nothing about capacity (e.g. 400/404).
 */

export class AdaptiveLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.initialLimit]
   * @param {number} [opts.minLimit]
   * @param {number} [opts.maxLimit]
   * @param {'aimd'|'gradient'} [opts.mode]
   * @param {number} [opts.backoffRatio]   Multiplicative decrease factor on overload.
   * @param {number} [opts.reserveForPriority] Fraction of the limit reserved for priority work.
   * @param {number} [opts.smoothing]      Gradient mode: EWMA weight for limit changes.
   * @param {number} [opts.rttMinDrift]    Gradient mode: how fast the RTT floor is allowed to rise.
   * @param {(limit: number, reason: string) => void} [opts.onChange]
   */
  constructor({
    initialLimit = 4,
    minLimit = 1,
    maxLimit = 200,
    mode = 'aimd',
    backoffRatio = 0.8,
    reserveForPriority = 0.3,
    smoothing = 0.2,
    rttMinDrift = 0.001,
    onChange = null,
  } = {}) {
    if (minLimit < 1) throw new RangeError('minLimit must be >= 1');
    if (maxLimit < minLimit) throw new RangeError('maxLimit must be >= minLimit');
    if (reserveForPriority < 0 || reserveForPriority >= 1) {
      throw new RangeError('reserveForPriority must be in [0, 1)');
    }

    this.mode = mode;
    this.minLimit = minLimit;
    this.maxLimit = maxLimit;
    this.backoffRatio = backoffRatio;
    this.reserveForPriority = reserveForPriority;
    this.smoothing = smoothing;
    this.rttMinDrift = rttMinDrift;
    this.onChange = onChange;

    this.limit = clamp(initialLimit, minLimit, maxLimit);
    this.inFlight = 0;
    /** @type {number|null} Best RTT observed; the gradient's reference point. */
    this.rttMin = null;

    /** @type {Array<{resolve: (t: LimiterToken) => void, reject: (e: Error) => void, detach: () => void}>} */
    this._priorityQueue = [];
    /** @type {Array<{resolve: (t: LimiterToken) => void, reject: (e: Error) => void, detach: () => void}>} */
    this._normalQueue = [];

    this.stats = {
      admitted: 0,
      shed: 0,
      overloads: 0,
    };
  }

  /** Concurrency a request of this class is allowed to occupy. */
  _capacityFor(priority) {
    if (priority) return Math.max(1, Math.floor(this.limit));
    // Normal work may only use the unreserved portion, so the reserved slice is
    // always there when a user-facing request arrives.
    return Math.max(1, Math.floor(this.limit * (1 - this.reserveForPriority)));
  }

  /**
   * Acquire a slot. Resolves with a token whose outcome method MUST be called
   * exactly once, or the slot leaks.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.priority] Interactive work waiting on a user.
   * @param {AbortSignal} [opts.signal] Admission deadline. On abort we shed
   *   rather than queue — queuing behind a slow vendor on a user-facing path is
   *   exactly what this adapter exists to prevent.
   * @returns {Promise<LimiterToken>}
   */
  acquire({ priority = false, signal } = {}) {
    if (signal?.aborted) {
      this.stats.shed++;
      return Promise.reject(new AdmissionError('aborted before admission'));
    }

    if (this.inFlight < this._capacityFor(priority)) {
      return Promise.resolve(this._grant());
    }

    return new Promise((resolve, reject) => {
      const queue = priority ? this._priorityQueue : this._normalQueue;
      /** @type {{resolve: any, reject: any, detach: () => void}} */
      const waiter = {
        resolve,
        reject,
        detach: () => {
          const i = queue.indexOf(waiter);
          if (i !== -1) queue.splice(i, 1);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      const onAbort = () => {
        waiter.detach();
        this.stats.shed++;
        reject(new AdmissionError('not admitted before deadline'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  }

  /** @returns {LimiterToken} */
  _grant() {
    this.inFlight++;
    this.stats.admitted++;
    let settled = false;
    const finish = (fn) => (/** @type {number} */ rttMs) => {
      if (settled) return;
      settled = true;
      this.inFlight--;
      fn(rttMs);
      this._pump();
    };
    return {
      success: finish((rttMs) => this._onSuccess(rttMs)),
      overload: finish((rttMs) => this._onOverload(rttMs)),
      ignore: finish(() => {}),
    };
  }

  /** Hand freed capacity to waiters, priority lane first. */
  _pump() {
    for (const [queue, priority] of [
      [this._priorityQueue, true],
      [this._normalQueue, false],
    ]) {
      while (queue.length > 0 && this.inFlight < this._capacityFor(priority)) {
        const waiter = queue.shift();
        waiter.detach();
        waiter.resolve(this._grant());
      }
    }
  }

  /** @param {number} rttMs */
  _onSuccess(rttMs) {
    if (Number.isFinite(rttMs) && rttMs >= 0) this._recordRtt(rttMs);

    if (this.mode === 'gradient' && this.rttMin !== null && Number.isFinite(rttMs)) {
      // gradient < 1 means "slower than the best we have seen" => shrink.
      const gradient = clamp(this.rttMin / Math.max(rttMs, 1e-6), 0.5, 1);
      // The sqrt term is headroom: it lets the limit probe upward while the
      // vendor is keeping pace, and is swamped by the gradient once it is not.
      const target = this.limit * gradient + Math.sqrt(this.limit);
      this._setLimit(this.limit * (1 - this.smoothing) + target * this.smoothing, 'gradient');
      return;
    }

    // AIMD: +1 per `limit` successes.
    this._setLimit(this.limit + 1 / this.limit, 'aimd-increase');
  }

  /** @param {number} rttMs */
  _onOverload(rttMs) {
    this.stats.overloads++;
    // Deliberately not smoothed and not gradient-mediated: backing off from an
    // overloaded dependency is the one thing worth doing abruptly.
    this._setLimit(this.limit * this.backoffRatio, 'overload');
    void rttMs;
  }

  /** @param {number} rttMs */
  _recordRtt(rttMs) {
    if (this.rttMin === null || rttMs < this.rttMin) {
      this.rttMin = rttMs;
      return;
    }
    // Let the floor drift up very slowly, so a vendor that is permanently
    // slower than it once was does not pin the limiter at minLimit forever.
    this.rttMin += (rttMs - this.rttMin) * this.rttMinDrift;
  }

  /** @param {number} next @param {string} reason */
  _setLimit(next, reason) {
    const clamped = clamp(next, this.minLimit, this.maxLimit);
    if (clamped === this.limit) return;
    this.limit = clamped;
    this.onChange?.(clamped, reason);
    this._pump();
  }

  /** Snapshot for metrics. A limit pinned at minLimit is an alarm, not a detail. */
  snapshot() {
    return {
      limit: this.limit,
      inFlight: this.inFlight,
      queuedPriority: this._priorityQueue.length,
      queuedNormal: this._normalQueue.length,
      rttMin: this.rttMin,
      ...this.stats,
    };
  }
}

/** @param {number} n @param {number} lo @param {number} hi */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
