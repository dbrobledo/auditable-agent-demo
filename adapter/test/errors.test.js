import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isOverloadSignal, parseRetryAfter } from '../src/vendor/errors.js';

test('2xx is success', () => {
  for (const status of [200, 201, 202, 204]) {
    assert.equal(classify({ status }), 'success');
  }
});

test('4xx is terminal — retrying our own bad request never helps', () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(classify({ status, idempotent: true }), 'terminal');
  }
});

test('429 is retryable regardless of method', () => {
  assert.equal(classify({ status: 429, idempotent: false }), 'retryable');
});

test('a 5xx on a GET is retryable but on a POST is indeterminate', () => {
  assert.equal(classify({ status: 503, idempotent: true }), 'retryable');
  assert.equal(
    classify({ status: 503, idempotent: false }),
    'indeterminate',
    'we cannot know whether they applied the write before failing',
  );
});

test('a timeout on a POST is indeterminate, not a failure', () => {
  const err = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  assert.equal(classify({ error: err, idempotent: true }), 'retryable');
  assert.equal(classify({ error: err, idempotent: false }), 'indeterminate');
});

test('a connection that was never established is always retryable', () => {
  const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  assert.equal(
    classify({ error: refused, idempotent: false }),
    'retryable',
    'the request never reached them, so it cannot have been applied',
  );
});

test('an honoured idempotency key collapses indeterminate into retryable', () => {
  const err = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  assert.equal(classify({ error: err, idempotent: false, hasIdempotencyKey: false }), 'indeterminate');
  assert.equal(
    classify({ error: err, idempotent: false, hasIdempotencyKey: true }),
    'retryable',
    'this is the entire value of idempotency keys',
  );
});

test('only capacity signals push the concurrency limit down', () => {
  assert.equal(isOverloadSignal({ status: 429 }), true);
  assert.equal(isOverloadSignal({ status: 503 }), true);
  assert.equal(isOverloadSignal({ status: 500 }), true);
  assert.equal(isOverloadSignal({ error: { name: 'TimeoutError' } }), true);

  assert.equal(isOverloadSignal({ status: 200 }), false);
  assert.equal(isOverloadSignal({ status: 404 }), false, 'a 404 says nothing about their capacity');
  assert.equal(isOverloadSignal({ status: 400 }), false, 'do not throttle ourselves for our own bug');
  assert.equal(isOverloadSignal({ error: { code: 'ECONNREFUSED' } }), false);
});

test('Retry-After is parsed as seconds or as an HTTP date', () => {
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter('nonsense'), undefined);

  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', () => now), 30_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2025 00:00:00 GMT', () => now), 0, 'never negative');
});
