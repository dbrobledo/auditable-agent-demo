import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, BreakerOpenError } from '../src/control/breaker.js';

/** A breaker with a clock we control, so no test sleeps. */
function makeBreaker(opts = {}) {
  let now = 0;
  const breaker = new CircuitBreaker({ now: () => now, ...opts });
  return { breaker, advance: (ms) => { now += ms; }, at: () => now };
}

test('opens after the failure threshold and rejects without calling through', () => {
  const { breaker } = makeBreaker({ failureThreshold: 3, resetMs: 1000 });

  for (let i = 0; i < 3; i++) {
    breaker.assertPass();
    breaker.onFailure();
  }

  assert.equal(breaker.state, 'open');
  assert.throws(() => breaker.assertPass(), BreakerOpenError);
});

test('a success resets the consecutive failure count', () => {
  const { breaker } = makeBreaker({ failureThreshold: 3 });
  breaker.onFailure();
  breaker.onFailure();
  breaker.onSuccess();
  breaker.onFailure();
  breaker.onFailure();
  assert.equal(breaker.state, 'closed', 'failures must be consecutive to trip');
});

test('half-opens after resetMs and closes on a successful probe', () => {
  const { breaker, advance } = makeBreaker({ failureThreshold: 1, resetMs: 1000 });
  breaker.onFailure();
  assert.equal(breaker.state, 'open');

  advance(999);
  assert.throws(() => breaker.assertPass(), BreakerOpenError);

  advance(2);
  assert.equal(breaker.state, 'half-open');
  breaker.assertPass();
  breaker.onSuccess();
  assert.equal(breaker.state, 'closed');
});

test('half-open admits only one probe at a time', () => {
  const { breaker, advance } = makeBreaker({ failureThreshold: 1, resetMs: 100, halfOpenMax: 1 });
  breaker.onFailure();
  advance(101);

  breaker.assertPass();
  assert.throws(() => breaker.assertPass(), BreakerOpenError, 'second probe must be refused');
});

test('a failed probe re-opens with exponentially longer waits', () => {
  const { breaker, advance } = makeBreaker({ failureThreshold: 1, resetMs: 100, maxResetMs: 10_000 });

  breaker.onFailure();                 // trip 1 -> open for 100ms
  assert.equal(breaker.retryAfterMs, 100);

  advance(101);
  breaker.assertPass();
  breaker.onFailure();                 // failed probe -> trip 2 -> 200ms
  assert.equal(breaker.retryAfterMs, 200);

  advance(201);
  breaker.assertPass();
  breaker.onFailure();                 // trip 3 -> 400ms
  assert.equal(breaker.retryAfterMs, 400);
});

test('the backed-off open time is capped', () => {
  const { breaker, advance } = makeBreaker({ failureThreshold: 1, resetMs: 100, maxResetMs: 500 });
  for (let i = 0; i < 10; i++) {
    breaker.onFailure();
    advance(1000);
    if (breaker.state === 'half-open') breaker.assertPass();
  }
  breaker.onFailure();
  assert.equal(breaker.retryAfterMs, 500);
});

test('recovery resets the backoff, so the next outage starts short again', () => {
  const { breaker, advance } = makeBreaker({ failureThreshold: 1, resetMs: 100 });
  breaker.onFailure();
  advance(101);
  breaker.assertPass();
  breaker.onFailure();          // now backed off to 200ms
  advance(201);
  breaker.assertPass();
  breaker.onSuccess();          // recovered
  assert.equal(breaker.state, 'closed');

  breaker.onFailure();
  assert.equal(breaker.retryAfterMs, 100, 'backoff resets after a clean recovery');
});
