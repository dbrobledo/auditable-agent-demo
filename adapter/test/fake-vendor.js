/**
 * A stand-in for the third-party SaaS that reproduces its actual failure mode:
 * no published rate limit, latency that climbs with concurrency, and 5xx/hangs
 * once pushed past a knee.
 *
 * This is the fixture every test in this directory runs against, and it is the
 * only thing we load-test. Never point a load test at the vendor's production
 * tenant.
 *
 * It also records every write it accepted, keyed by our correlation id, which
 * is what lets a test assert "no duplicates under a retry storm" rather than
 * just "it didn't crash".
 */

import { createServer } from 'node:http';
import { once } from 'node:events';

/**
 * @param {object} [opts]
 * @param {number} [opts.knee]          Concurrency beyond which latency grows.
 * @param {number} [opts.baseLatencyMs]
 * @param {number} [opts.degradeMs]     Added latency per request over the knee.
 * @param {number} [opts.hardKnee]      Concurrency beyond which it returns 503.
 */
export async function startFakeVendor({
  knee = 4,
  baseLatencyMs = 10,
  degradeMs = 15,
  hardKnee = Infinity,
} = {}) {
  const state = {
    knee,
    baseLatencyMs,
    degradeMs,
    hardKnee,
    /** @type {'ok'|'hard-fail'|'accept-then-hang'} */
    mode: 'ok',
    /** Fail exactly this many more requests, then behave. Deterministic
     *  transient failures, so retry tests do not race a wall clock. */
    failNextCount: 0,
    inFlight: 0,
    maxInFlight: 0,
    requests: 0,
    /** @type {Map<string, {id: string, count: number}>} Writes keyed by correlation id. */
    accepted: new Map(),
    nextId: 1,
  };

  const server = createServer(async (req, res) => {
    state.inFlight++;
    state.requests++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);

    try {
      const over = Math.max(0, state.inFlight - state.knee);
      const latency = state.baseLatencyMs + over * state.degradeMs;

      if (state.mode === 'hard-fail') {
        await delay(latency);
        return send(res, 503, { error: 'service unavailable' });
      }
      if (state.failNextCount > 0) {
        state.failNextCount--;
        await delay(latency);
        return send(res, 503, { error: 'transient' });
      }
      if (state.inFlight > state.hardKnee) {
        await delay(latency);
        return send(res, 503, { error: 'overloaded' });
      }

      const url = new URL(req.url, 'http://vendor.local');

      if (req.method === 'GET' && url.pathname === '/items') {
        // Read-back by correlation id: the escape hatch that turns an
        // indeterminate write into a knowable one.
        await delay(latency);
        const ref = url.searchParams.get('ref');
        const hit = ref ? state.accepted.get(ref) : undefined;
        return send(res, 200, { items: hit ? [{ id: hit.id, ref }] : [] });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/items/')) {
        const id = url.pathname.slice('/items/'.length);
        await delay(latency);
        if (id === 'missing') return send(res, 404, { error: 'not found' });
        return send(res, 200, { id, value: `value-${id}` });
      }

      if (req.method === 'POST' && url.pathname === '/items') {
        const body = await readJson(req);
        const ref = req.headers['x-correlation-id'] ?? body?.ref;

        // Record the write BEFORE the latency, so 'accept-then-hang' models the
        // nastiest real case: they applied it, we never heard back.
        let record = ref ? state.accepted.get(ref) : undefined;
        const isDuplicate = Boolean(record);
        if (ref) {
          if (record) record.count++;
          else {
            record = { id: `item-${state.nextId++}`, count: 1 };
            state.accepted.set(ref, record);
          }
        }

        if (state.mode === 'accept-then-hang') {
          // Never respond. The client's deadline fires and classifies this as
          // indeterminate — which it genuinely is.
          return;
        }

        await delay(latency);
        return send(res, isDuplicate ? 200 : 201, { id: record?.id ?? `item-${state.nextId++}`, ref, duplicate: isDuplicate });
      }

      await delay(latency);
      return send(res, 404, { error: 'no such route' });
    } catch {
      if (!res.writableEnded) send(res, 500, { error: 'fixture error' });
    } finally {
      state.inFlight--;
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    /** @param {'ok'|'hard-fail'|'accept-then-hang'} mode */
    setMode(mode) {
      state.mode = mode;
    },
    /** Raise or lower the capacity the fixture pretends to have. */
    setKnee(next) {
      state.knee = next;
    },
    /** Fail the next `n` requests with a 503, then recover. */
    failNext(n) {
      state.failNextCount = n;
    },
    /** Number of times a logical write (by correlation id) was accepted. */
    acceptedCount(ref) {
      return state.accepted.get(ref)?.count ?? 0;
    },
    /** Distinct logical writes recorded. */
    get distinctWrites() {
      return state.accepted.size;
    },
    async close() {
      // Destroy sockets too: 'accept-then-hang' leaves requests open forever.
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    },
  };
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
