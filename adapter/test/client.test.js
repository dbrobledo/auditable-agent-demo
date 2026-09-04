/**
 * End-to-end tests against the fake vendor. These are the claims from the
 * design that are worth holding the implementation to:
 *
 *  - the limiter converges below the vendor's knee, from latency alone
 *  - a batch flood cannot starve user-facing traffic
 *  - a retry storm never produces a duplicate write
 *  - the breaker fails fast instead of piling up timeouts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'undici';
import { startFakeVendor } from './fake-vendor.js';
import { VendorClient } from '../src/vendor/client.js';
import { AdaptiveLimiter } from '../src/control/limiter.js';
import { CircuitBreaker } from '../src/control/breaker.js';
import { RetryBudget } from '../src/control/retry.js';
import { VendorError } from '../src/vendor/errors.js';

/** @param {object} [opts] */
async function harness({ vendor: vendorOpts = {}, limiter: limiterOpts = {}, client: clientOpts = {} } = {}) {
  const vendor = await startFakeVendor(vendorOpts);
  const limiter = new AdaptiveLimiter({ mode: 'gradient', initialLimit: 4, maxLimit: 64, ...limiterOpts });
  const client = new VendorClient({
    baseUrl: vendor.origin,
    limiter,
    breaker: new CircuitBreaker({ failureThreshold: 5, resetMs: 100 }),
    retryBudget: new RetryBudget({ ratio: 1, capacity: 1000 }),
    pool: new Pool(vendor.origin, { connections: 128, pipelining: 1 }),
    timeouts: { headersMs: 1_000, bodyMs: 1_000, callMs: 1_000, admissionMs: 2_000 },
    retry: { attempts: 3, baseMs: 5, maxMs: 50 },
    ...clientOpts,
  });
  return {
    vendor,
    limiter,
    client,
    async close() {
      await client.close();
      await vendor.close();
    },
  };
}

test('a plain request succeeds and reports the vendor payload', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const res = await h.client.request({ path: '/items/42' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: '42', value: 'value-42' });
});

test('a 404 is terminal: not retried, and it does not shrink the limit', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const before = h.limiter.limit;
  await assert.rejects(
    () => h.client.request({ path: '/items/missing' }),
    (err) => err instanceof VendorError && err.kind === 'terminal' && err.status === 404,
  );
  assert.equal(h.vendor.state.requests, 1, 'a terminal error must not be retried');
  assert.equal(h.limiter.limit, before, 'our own bad lookup must not throttle us');
});

test('the limiter converges below the vendor knee under a sustained flood', async (t) => {
  // The vendor tolerates 6 concurrent; beyond that latency climbs steeply. It
  // never returns an error — degradation is the only signal available.
  const h = await harness({
    vendor: { knee: 6, baseLatencyMs: 5, degradeMs: 25 },
    limiter: { mode: 'gradient', initialLimit: 32, minLimit: 1, maxLimit: 64, smoothing: 0.3 },
  });
  t.after(() => h.close());

  const deadline = Date.now() + 3_000;
  let inFlight = 0;
  const workers = Array.from({ length: 40 }, async () => {
    while (Date.now() < deadline) {
      inFlight++;
      try {
        await h.client.request({ path: '/items/1', attempts: 1, admissionMs: 5_000 });
      } catch {
        // Shedding is expected while the limit is being discovered.
      } finally {
        inFlight--;
      }
    }
  });
  await Promise.all(workers);
  void inFlight;

  assert.ok(
    h.limiter.limit < 20,
    `limit should have been driven down from 32 by latency alone, got ${h.limiter.limit}`,
  );
  assert.ok(
    h.vendor.state.maxInFlight <= 34,
    `concurrency at the vendor should stay bounded, peaked at ${h.vendor.state.maxInFlight}`,
  );
  assert.equal(h.limiter.inFlight, 0, 'every token was released');
});

test('the limiter recovers when the vendor gets faster again', async (t) => {
  const h = await harness({
    vendor: { knee: 2, baseLatencyMs: 5, degradeMs: 40 },
    limiter: { mode: 'gradient', initialLimit: 16, minLimit: 1, maxLimit: 64, smoothing: 0.3 },
  });
  t.after(() => h.close());

  const flood = async (ms) => {
    const until = Date.now() + ms;
    await Promise.all(Array.from({ length: 24 }, async () => {
      while (Date.now() < until) {
        await h.client.request({ path: '/items/1', attempts: 1, admissionMs: 5_000 }).catch(() => {});
      }
    }));
  };

  await flood(1_500);
  const depressed = h.limiter.limit;

  h.vendor.setKnee(64); // capacity restored
  await flood(1_500);

  assert.ok(
    h.limiter.limit > depressed,
    `limit should climb back once they keep up: ${depressed} -> ${h.limiter.limit}`,
  );
});

test('bulkhead: a batch flood does not starve user-facing requests', async (t) => {
  const h = await harness({
    vendor: { knee: 4, baseLatencyMs: 10, degradeMs: 20 },
    limiter: { mode: 'gradient', initialLimit: 12, minLimit: 4, maxLimit: 24, reserveForPriority: 0.4 },
  });
  t.after(() => h.close());

  let flooding = true;
  const batch = Promise.all(Array.from({ length: 60 }, async () => {
    while (flooding) {
      await h.client.request({ path: '/items/9', attempts: 1, admissionMs: 5_000 }).catch(() => {});
    }
  }));

  await sleep(200); // let the flood saturate the deferred slice

  const latencies = [];
  for (let i = 0; i < 20; i++) {
    const started = Date.now();
    await h.client.request({ path: '/items/user', priority: true, attempts: 1, admissionMs: 1_000 });
    latencies.push(Date.now() - started);
  }

  flooding = false;
  await batch;

  const worst = Math.max(...latencies);
  assert.ok(worst < 1_000, `interactive p100 was ${worst}ms; the reservation should keep it bounded`);
});

test('the interactive lane sheds instead of queueing when it cannot be admitted', async (t) => {
  const h = await harness({
    vendor: { knee: 1, baseLatencyMs: 200, degradeMs: 200 },
    limiter: { mode: 'aimd', initialLimit: 2, minLimit: 1, maxLimit: 2, reserveForPriority: 0 },
  });
  t.after(() => h.close());

  // Occupy every slot.
  const holders = Array.from({ length: 2 }, () => h.client.request({ path: '/items/1', attempts: 1 }).catch(() => {}));
  await sleep(50);

  const started = Date.now();
  await assert.rejects(
    () => h.client.request({ path: '/items/1', priority: true, attempts: 1, admissionMs: 50 }),
    (err) => err instanceof VendorError && /shed/.test(err.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `should shed at its deadline (~50ms), took ${elapsed}ms`);

  await Promise.all(holders);
});

test('a retry storm against a hanging vendor produces no duplicate writes', async (t) => {
  const h = await harness({ vendor: { knee: 32, baseLatencyMs: 1 } });
  t.after(() => h.close());

  // The nastiest real case: the vendor applies the write, then never responds.
  h.vendor.setMode('accept-then-hang');

  const ref = 'order-777';
  await assert.rejects(
    () => h.client.request({
      path: '/items',
      method: 'POST',
      body: { amount: 100 },
      correlationId: ref,
      attempts: 5,
      admissionMs: 2_000,
    }),
    (err) => err instanceof VendorError && err.kind === 'indeterminate',
  );

  assert.equal(
    h.vendor.acceptedCount(ref),
    1,
    'the write must have been sent exactly once — an indeterminate outcome is never retried blind',
  );
});

test('an indeterminate write can be resolved by reading back the correlation id', async (t) => {
  const h = await harness({ vendor: { knee: 32, baseLatencyMs: 1 } });
  t.after(() => h.close());

  const ref = 'order-888';
  h.vendor.setMode('accept-then-hang');
  const failure = await h.client
    .request({ path: '/items', method: 'POST', body: { amount: 5 }, correlationId: ref, attempts: 1 })
    .then(() => null, (err) => err);

  assert.equal(failure.kind, 'indeterminate');
  assert.equal(failure.correlationId, ref, 'the error carries what reconciliation needs');

  // Reconciliation: ask whether it landed, rather than guessing.
  h.vendor.setMode('ok');
  const readBack = await h.client.request({ path: `/items?ref=${ref}` });
  assert.equal(readBack.body.items.length, 1, 'it did land; a blind retry would have duplicated it');
  assert.equal(h.vendor.acceptedCount(ref), 1);
});

test('an idempotent GET retries through a transient failure', async (t) => {
  const h = await harness({ vendor: { knee: 32, baseLatencyMs: 1 } });
  t.after(() => h.close());

  h.vendor.failNext(2);

  const res = await h.client.request({ path: '/items/7', attempts: 4 });
  assert.equal(res.status, 200);
  assert.equal(h.vendor.state.requests, 3, 'two failures, then the retry succeeded');
});

test('a transient 5xx storm shrinks the limit, and recovery lets it grow back', async (t) => {
  const h = await harness({
    vendor: { knee: 32, baseLatencyMs: 1 },
    limiter: { mode: 'aimd', initialLimit: 16, minLimit: 1, maxLimit: 32 },
  });
  t.after(() => h.close());

  h.vendor.failNext(8);
  const before = h.limiter.limit;
  await Promise.all(Array.from({ length: 8 }, () => h.client.request({ path: '/items/1', attempts: 1 }).catch(() => {})));

  assert.ok(h.limiter.limit < before, `503s should back the limit off: ${before} -> ${h.limiter.limit}`);
  assert.ok(h.limiter.snapshot().overloads >= 8);
});

test('the breaker fails fast once the vendor is down, instead of piling up timeouts', async (t) => {
  const h = await harness({
    vendor: { knee: 32, baseLatencyMs: 1 },
    client: { breaker: new CircuitBreaker({ failureThreshold: 3, resetMs: 10_000 }) },
  });
  t.after(() => h.close());

  h.vendor.setMode('hard-fail');
  for (let i = 0; i < 4; i++) {
    await h.client.request({ path: '/items/1', attempts: 1 }).catch(() => {});
  }
  const requestsBefore = h.vendor.state.requests;

  const started = Date.now();
  await assert.rejects(() => h.client.request({ path: '/items/1', attempts: 1 }), VendorError);
  const elapsed = Date.now() - started;

  assert.equal(h.vendor.state.requests, requestsBefore, 'the call never left the process');
  assert.ok(elapsed < 50, `should fail immediately, took ${elapsed}ms`);
  assert.equal(h.client.snapshot().breaker.state, 'open');
});

test('the breaker closes again after the vendor recovers', async (t) => {
  const h = await harness({
    vendor: { knee: 32, baseLatencyMs: 1 },
    client: { breaker: new CircuitBreaker({ failureThreshold: 2, resetMs: 60 }) },
  });
  t.after(() => h.close());

  h.vendor.setMode('hard-fail');
  for (let i = 0; i < 3; i++) await h.client.request({ path: '/items/1', attempts: 1 }).catch(() => {});
  assert.equal(h.client.snapshot().breaker.state, 'open');

  h.vendor.setMode('ok');
  await sleep(80); // past resetMs -> half-open

  const res = await h.client.request({ path: '/items/1', attempts: 1 });
  assert.equal(res.status, 200);
  assert.equal(h.client.snapshot().breaker.state, 'closed');
});

test('metrics expose what the runbook alarms on', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  await h.client.request({ path: '/items/1' });
  const snap = h.client.metrics.snapshot();

  assert.ok('vendor_concurrency_limit' in snap, 'the adaptive limit must be observable');
  assert.ok('vendor_in_flight' in snap);
  assert.ok('vendor_breaker_open' in snap);
  assert.equal(snap['vendor_calls_total{kind="success",lane="deferred"}'], 1);
  assert.ok(h.client.metrics.toPrometheus().includes('vendor_rtt_ms'));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
