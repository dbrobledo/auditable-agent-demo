import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveLimiter, AdmissionError } from '../src/control/limiter.js';

test('never admits more than the current limit', async () => {
  const limiter = new AdaptiveLimiter({ initialLimit: 3, maxLimit: 3, reserveForPriority: 0 });
  const tokens = await Promise.all([
    limiter.acquire(),
    limiter.acquire(),
    limiter.acquire(),
  ]);
  assert.equal(limiter.inFlight, 3);

  let fourthAdmitted = false;
  const fourth = limiter.acquire().then((t) => {
    fourthAdmitted = true;
    return t;
  });
  await tick();
  assert.equal(fourthAdmitted, false, 'fourth request must queue, not be admitted');

  tokens[0].success(10);
  await fourth;
  assert.equal(fourthAdmitted, true);
});

test('sheds rather than queues when the admission deadline passes', async () => {
  const limiter = new AdaptiveLimiter({ initialLimit: 1, maxLimit: 1, reserveForPriority: 0 });
  await limiter.acquire();

  // A real timer, not AbortSignal.timeout(): that one is unref'd and would let
  // the test runner's event loop drain out from under us.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);

  await assert.rejects(() => limiter.acquire({ signal: controller.signal }), AdmissionError);
  clearTimeout(timer);
  assert.equal(limiter.snapshot().shed, 1);
});

test('bulkhead: a batch flood cannot consume the interactive reservation', async () => {
  // limit 10, 30% reserved => deferred work may occupy at most 7.
  const limiter = new AdaptiveLimiter({ initialLimit: 10, maxLimit: 10, reserveForPriority: 0.3 });

  for (let i = 0; i < 20; i++) void limiter.acquire({ priority: false });
  await tick();

  assert.equal(limiter.inFlight, 7, 'deferred lane capped at the unreserved slice');

  // A user-facing request arriving into that flood is admitted without waiting.
  const token = await resolvesImmediately(limiter.acquire({ priority: true }));
  assert.ok(token, 'interactive request was starved by the batch flood');
  assert.equal(limiter.inFlight, 8);
});

test('priority waiters are served before normal waiters', async () => {
  const limiter = new AdaptiveLimiter({ initialLimit: 1, maxLimit: 1, reserveForPriority: 0 });
  const held = await limiter.acquire();

  const order = [];
  const normal = limiter.acquire({ priority: false }).then((t) => {
    order.push('normal');
    return t;
  });
  await tick();
  const priority = limiter.acquire({ priority: true }).then((t) => {
    order.push('priority');
    return t;
  });
  await tick();
  assert.deepEqual(order, [], 'both are queued behind the held token');

  held.success(5);
  const priorityToken = await priority;
  assert.deepEqual(order, ['priority'], 'priority jumps the queue despite arriving first-come-second');

  priorityToken.success(5);
  await normal;
  assert.deepEqual(order, ['priority', 'normal']);
});

test('AIMD backs off multiplicatively on overload and grows additively on success', () => {
  const limiter = new AdaptiveLimiter({ mode: 'aimd', initialLimit: 10, maxLimit: 100, backoffRatio: 0.5 });

  const token = limiter._grant();
  token.overload(500);
  assert.equal(limiter.limit, 5, 'multiplicative decrease');

  const before = limiter.limit;
  const t2 = limiter._grant();
  t2.success(10);
  assert.ok(limiter.limit > before && limiter.limit < before + 1, 'additive increase is sub-unit');
});

test('a terminal client error does not move the limit', () => {
  const limiter = new AdaptiveLimiter({ mode: 'aimd', initialLimit: 8 });
  const before = limiter.limit;
  limiter._grant().ignore();
  assert.equal(limiter.limit, before, 'a 404 says nothing about vendor capacity');
});

test('gradient mode shrinks on rising latency before any error occurs', () => {
  const limiter = new AdaptiveLimiter({
    mode: 'gradient', initialLimit: 20, minLimit: 1, maxLimit: 100, smoothing: 1,
  });

  // Establish the RTT floor.
  limiter._grant().success(10);
  const afterFast = limiter.limit;

  // Same success status, four times slower. Nothing has errored.
  for (let i = 0; i < 10; i++) limiter._grant().success(40);

  assert.ok(
    limiter.limit < afterFast,
    `expected shrink on latency alone, went ${afterFast} -> ${limiter.limit}`,
  );
});

test('gradient mode recovers when latency returns to the floor', () => {
  const limiter = new AdaptiveLimiter({
    mode: 'gradient', initialLimit: 20, minLimit: 1, maxLimit: 100, smoothing: 1,
  });
  limiter._grant().success(10);
  for (let i = 0; i < 20; i++) limiter._grant().success(60);
  const depressed = limiter.limit;

  for (let i = 0; i < 20; i++) limiter._grant().success(10);
  assert.ok(limiter.limit > depressed, `expected recovery, ${depressed} -> ${limiter.limit}`);
});

test('the limit is clamped to [min, max]', () => {
  const limiter = new AdaptiveLimiter({ mode: 'aimd', initialLimit: 2, minLimit: 2, maxLimit: 4, backoffRatio: 0.1 });
  for (let i = 0; i < 10; i++) limiter._grant().overload(100);
  assert.equal(limiter.limit, 2, 'never below minLimit');
  for (let i = 0; i < 200; i++) limiter._grant().success(1);
  assert.equal(limiter.limit, 4, 'never above maxLimit');
});

test('a token records its outcome at most once', () => {
  const limiter = new AdaptiveLimiter({ mode: 'aimd', initialLimit: 5 });
  const token = limiter._grant();
  assert.equal(limiter.inFlight, 1);
  token.success(10);
  token.success(10);
  token.overload(10);
  assert.equal(limiter.inFlight, 0, 'double-release must not corrupt the in-flight count');
});

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Resolve to the promise's value if it settles this tick, otherwise null. */
async function resolvesImmediately(promise) {
  const pending = Symbol('pending');
  const result = await Promise.race([promise, tick().then(() => pending)]);
  return result === pending ? null : result;
}
