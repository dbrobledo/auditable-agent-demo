import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryBudget, withRetry } from '../src/control/retry.js';
import { VendorError } from '../src/vendor/errors.js';

const isRetryable = (err) => err instanceof VendorError && err.kind === 'retryable';
const retryable = () => new VendorError('boom', { kind: 'retryable' });
const indeterminate = () => new VendorError('timeout', { kind: 'indeterminate' });
const terminal = () => new VendorError('bad request', { kind: 'terminal', status: 400 });

test('retries a retryable failure and returns the eventual success', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw retryable();
      return 'ok';
    },
    { attempts: 5, baseMs: 0, isRetryable },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('NEVER retries an indeterminate write', async () => {
  // The whole point: a timed-out POST may already have landed. Retrying it is
  // how a retry policy turns into a duplicate-record generator.
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw indeterminate(); }, { attempts: 5, baseMs: 0, isRetryable }),
    (err) => err.kind === 'indeterminate',
  );
  assert.equal(calls, 1, 'indeterminate outcomes must be handed to reconciliation, not retried');
});

test('does not retry a terminal error', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw terminal(); }, { attempts: 5, baseMs: 0, isRetryable }),
    (err) => err.status === 400,
  );
  assert.equal(calls, 1);
});

test('stops at the attempt limit and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw retryable(); }, { attempts: 3, baseMs: 0, isRetryable }),
    VendorError,
  );
  assert.equal(calls, 3);
});

test('uses full jitter: the delay is uniform over [0, cap], not a fixed curve', async () => {
  const delays = [];
  // random() = 1 gives the top of the range, which must equal the cap.
  await assert.rejects(() => withRetry(
    async () => { throw retryable(); },
    {
      attempts: 4,
      baseMs: 100,
      maxMs: 10_000,
      isRetryable,
      random: () => 1,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    },
  ));
  assert.deepEqual(delays, [100, 200, 400], 'cap doubles per attempt');

  const lows = [];
  await assert.rejects(() => withRetry(
    async () => { throw retryable(); },
    { attempts: 3, baseMs: 100, isRetryable, random: () => 0, onRetry: ({ delayMs }) => lows.push(delayMs) },
  ));
  assert.deepEqual(lows, [0, 0], 'the bottom of the range is zero — that is what makes it full jitter');
});

test('honours a server-directed Retry-After over the computed backoff', async () => {
  const delays = [];
  await assert.rejects(() => withRetry(
    async () => { throw new VendorError('slow down', { kind: 'retryable', retryAfterMs: 5_000 }); },
    {
      attempts: 2,
      baseMs: 100,
      maxMs: 60_000,
      isRetryable,
      random: () => 0,
      retryAfterMs: (err) => err.retryAfterMs,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    },
  ));
  assert.deepEqual(delays, [5_000]);
});

test('the retry budget caps retries as a fraction of traffic', async () => {
  const budget = new RetryBudget({ ratio: 0.1, capacity: 3 });

  // Three failing calls drain the initial burst; each call only earns back 0.1.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => withRetry(
      async () => { throw retryable(); },
      { attempts: 2, baseMs: 0, budget, isRetryable },
    ));
  }
  assert.equal(budget.snapshot().granted, 3);

  let calls = 0;
  await assert.rejects(() => withRetry(
    async () => { calls++; throw retryable(); },
    { attempts: 5, baseMs: 0, budget, isRetryable },
  ));
  assert.equal(calls, 1, 'budget exhausted: a vendor brownout cannot multiply our offered load');
  assert.ok(budget.snapshot().denied > 0);
});

test('the budget refills from successful traffic', () => {
  const budget = new RetryBudget({ ratio: 0.1, capacity: 5 });
  budget.tokens = 0;
  for (let i = 0; i < 10; i++) budget.recordCall();
  assert.ok(budget.tryConsume(), '10 calls at 10% earn one retry');
  assert.equal(budget.tryConsume(), false);
});

test('an abort during backoff unwinds instead of sleeping on', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    () => withRetry(
      async () => { throw retryable(); },
      { attempts: 5, baseMs: 10_000, isRetryable, signal: controller.signal, random: () => 1 },
    ),
    { name: 'AbortedError' },
  );
  clearTimeout(timer);
});
