import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleflight } from '../src/control/singleflight.js';

test('collapses concurrent callers for the same key into one call', async () => {
  const sf = createSingleflight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const loader = async () => {
    calls++;
    await gate;
    return 'value';
  };

  const results = Promise.all(Array.from({ length: 50 }, () => sf.run('k', loader)));
  assert.equal(sf.subscribers('k'), 50);

  release();
  assert.deepEqual(await results, Array(50).fill('value'));
  assert.equal(calls, 1, '50 concurrent misses must produce exactly one vendor call');
});

test('different keys do not collapse into each other', async () => {
  const sf = createSingleflight();
  let calls = 0;
  await Promise.all(['a', 'b', 'c'].map((k) => sf.run(k, async () => { calls++; return k; })));
  assert.equal(calls, 3);
});

test('the entry is cleared once settled, so the next call goes through', async () => {
  const sf = createSingleflight();
  let calls = 0;
  const loader = async () => { calls++; return calls; };

  assert.equal(await sf.run('k', loader), 1);
  assert.equal(sf.size, 0, 'no leak after settling');
  assert.equal(await sf.run('k', loader), 2);
});

test('a rejection reaches every sharer and clears the entry', async () => {
  const sf = createSingleflight();
  let calls = 0;
  const loader = async () => {
    calls++;
    throw new Error('vendor down');
  };

  const attempts = [sf.run('k', loader), sf.run('k', loader), sf.run('k', loader)];
  const settled = await Promise.allSettled(attempts);
  assert.equal(calls, 1);
  assert.ok(settled.every((r) => r.status === 'rejected' && r.reason.message === 'vendor down'));
  assert.equal(sf.size, 0, 'a failed call must not pin the key');
});

test('a synchronous throw in the loader becomes a rejection, not an escape', async () => {
  const sf = createSingleflight();
  await assert.rejects(() => sf.run('k', () => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(sf.size, 0);
});
