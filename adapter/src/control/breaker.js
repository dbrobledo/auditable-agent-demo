/**
 * Circuit breaker.
 *
 * The limiter throttles us down to a trickle when the vendor is struggling; the
 * breaker stops us entirely when it is down. Without it, every request pays a
 * full timeout before failing, and our own request threads pile up waiting on a
 * dependency we already know is broken.
 *
 * Repeated trips back off exponentially, so a vendor that is down for an hour
 * does not get probed every five seconds for an hour.
 */

export class BreakerOpenError extends Error {
  /** @param {number} retryAfterMs */
  constructor(retryAfterMs) {
    super('circuit open');
    this.name = 'BreakerOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold] Consecutive failures before opening.
   * @param {number} [opts.resetMs]          Time open before the first probe.
   * @param {number} [opts.maxResetMs]       Ceiling for the backed-off open time.
   * @param {number} [opts.halfOpenMax]      Concurrent probes allowed when half-open.
   * @param {() => number} [opts.now]
   * @param {(state: string) => void} [opts.onStateChange]
   */
  constructor({
    failureThreshold = 5,
    resetMs = 5_000,
    maxResetMs = 60_000,
    halfOpenMax = 1,
    now = Date.now,
    onStateChange = null,
  } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetMs = resetMs;
    this.maxResetMs = maxResetMs;
    this.halfOpenMax = halfOpenMax;
    this.now = now;
    this.onStateChange = onStateChange;

    /** @type {'closed'|'open'|'half-open'} */
    this._state = 'closed';
    this._consecutiveFailures = 0;
    this._consecutiveTrips = 0;
    this._openedAt = 0;
    this._probesInFlight = 0;
  }

  get state() {
    this._maybeHalfOpen();
    return this._state;
  }

  /** Milliseconds until the next probe is allowed. 0 when not open. */
  get retryAfterMs() {
    if (this._state !== 'open') return 0;
    return Math.max(0, this._openTimeMs() - (this.now() - this._openedAt));
  }

  _openTimeMs() {
    const backed = this.resetMs * 2 ** Math.max(0, this._consecutiveTrips - 1);
    return Math.min(this.maxResetMs, backed);
  }

  _maybeHalfOpen() {
    if (this._state === 'open' && this.now() - this._openedAt >= this._openTimeMs()) {
      this._transition('half-open');
      this._probesInFlight = 0;
    }
  }

  /**
   * Ask permission to make a call. Throws BreakerOpenError when the circuit is
   * open, carrying how long to wait — callers on the deferred lane can back off
   * by exactly that much instead of guessing.
   */
  assertPass() {
    this._maybeHalfOpen();
    if (this._state === 'open') throw new BreakerOpenError(this.retryAfterMs);
    if (this._state === 'half-open') {
      if (this._probesInFlight >= this.halfOpenMax) {
        throw new BreakerOpenError(this.retryAfterMs || this.resetMs);
      }
      this._probesInFlight++;
    }
  }

  onSuccess() {
    if (this._state === 'half-open') {
      this._probesInFlight = Math.max(0, this._probesInFlight - 1);
      this._consecutiveTrips = 0;
      this._transition('closed');
    }
    this._consecutiveFailures = 0;
  }

  onFailure() {
    if (this._state === 'half-open') {
      // The probe failed: straight back to open, with a longer wait.
      this._probesInFlight = Math.max(0, this._probesInFlight - 1);
      this._trip();
      return;
    }
    this._consecutiveFailures++;
    if (this._consecutiveFailures >= this.failureThreshold) this._trip();
  }

  _trip() {
    this._consecutiveTrips++;
    this._openedAt = this.now();
    this._consecutiveFailures = 0;
    this._transition('open');
  }

  /** @param {'closed'|'open'|'half-open'} next */
  _transition(next) {
    if (this._state === next) return;
    this._state = next;
    this.onStateChange?.(next);
  }

  snapshot() {
    return {
      state: this._state,
      consecutiveFailures: this._consecutiveFailures,
      consecutiveTrips: this._consecutiveTrips,
      retryAfterMs: this.retryAfterMs,
    };
  }
}
