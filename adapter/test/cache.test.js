import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheAside, MemoryStore } from '../src/store/cache.js';

/** Cache with a clock we control, so no test sleeps waiting for a TTL. */
function makeCache(opts = {}) {
  let now = 0;
  const cache = new CacheAside({ freshMs: 100, staleMs: 1000, negativeMs: 50, now: () => now, ...opts });
  return { cache, advance: (ms) => { now += ms; } };
}

test('a fresh hit does not touch the vendor', async () => {
  const { cache } = makeCache();
  let loads = 0;
  const loader = async () => { loads++; return 'v1'; };

  assert.deepEqual(await cache.get('k', loader), { value: 'v1', state: 'miss' });
  assert.deepEqual(await cache.get('k', loader), { value: 'v1', state: 'fresh' });
  assert.equal(loads, 1);
});

test('stale-while-revalidate serves immediately and refreshes behind the request', async () => {
  const { cache, advance } = makeCache();
  let loads = 0;
  const loader = async () => { loads++; return `v${loads}`; };

  await cache.get('k', loader);
  advance(200); // past fresh, inside stale

  const hit = await cache.get('k', loader);
  assert.equal(hit.state, 'stale');
  assert.equal(hit.value, 'v1', 'the user gets slightly old data instantly, not a vendor round trip');

  await settle();
  assert.equal(loads, 2, 'a refresh ran in the background');
  assert.deepEqual(await cache.get('k', loader), { value: 'v2', state: 'fresh' });
});

test('a failing background refresh never breaks the served request', async () => {
  const errors = [];
  const { cache, advance } = makeCache({ onRefreshError: (err) => errors.push(err) });

  await cache.get('k', async () => 'v1');
  advance(200);

  const hit = await cache.get('k', async () => { throw new Error('vendor down'); });
  assert.deepEqual(hit, { value: 'v1', state: 'stale' }, 'a vendor outage degrades to old data, not an error');

  await settle();
  assert.equal(errors.length, 1);
  assert.equal(cache.snapshot().refreshErrors, 1);
});

test('past the stale window it is a miss again', async () => {
  const { cache, advance } = makeCache();
  await cache.get('k', async () => 'v1');
  advance(1001);
  const hit = await cache.get('k', async () => 'v2');
  assert.deepEqual(hit, { value: 'v2', state: 'miss' });
});

test('concurrent misses collapse into a single load', async () => {
  const { cache } = makeCache();
  let loads = 0;
  const loader = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 5));
    return 'v';
  };

  const results = await Promise.all(Array.from({ length: 25 }, () => cache.get('k', loader)));
  assert.equal(loads, 1, 'no cache stampede');
  assert.ok(results.every((r) => r.value === 'v'));
});

test('negative results are cached, on their own shorter TTL', async () => {
  const { cache, advance } = makeCache();
  let loads = 0;
  const loader = async () => { loads++; return null; };

  await cache.get('missing', loader);
  await cache.get('missing', loader);
  assert.equal(loads, 1, 'lookups for things that do not exist must benefit from the cache too');

  advance(60); // past negativeMs (50) but well inside freshMs (100)
  const hit = await cache.get('missing', loader);
  assert.equal(hit.state, 'stale', 'negative entries expire faster than positive ones');
});

test('invalidate drops a key, e.g. after we write through', async () => {
  const { cache } = makeCache();
  let loads = 0;
  const loader = async () => { loads++; return `v${loads}`; };

  await cache.get('k', loader);
  cache.invalidate('k');
  assert.deepEqual(await cache.get('k', loader), { value: 'v2', state: 'miss' });
});

test('MemoryStore evicts least-recently-used entries', () => {
  const store = new MemoryStore({ maxEntries: 3 });
  for (const k of ['a', 'b', 'c']) store.set(k, { value: k, storedAt: 0 });
  store.get('a');                                  // 'a' becomes most recent
  store.set('d', { value: 'd', storedAt: 0 });     // evicts 'b'

  assert.equal(store.size, 3);
  assert.ok(store.get('a'));
  assert.equal(store.get('b'), undefined);
  assert.ok(store.get('d'));
});

/** Let queued microtasks and the background refresh finish. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
