# Throughput adapter

Control-plane for talking to a third-party SaaS that is slower than us, offers
REST only, publishes no rate limit, and degrades under load rather than
returning a clean `429`.

**This directory is unrelated to the Python demo at the repository root.** It is
self-contained and can be lifted into its own service repo as-is.

```bash
npm install
npm test        # 62 tests, no network, no AWS
```

## The one thing to read first

An adapter cannot manufacture throughput. It reshapes *bursts* into a rate the
vendor survives, contains their failures so they cannot become ours, and removes
*redundant* calls. If our sustained arrival rate exceeds their sustained
capacity, a queue in front of them just grows — we would have traded an outage
for a backlog.

So the first task is arithmetic, not code:

| Symbol | Meaning | How to get it |
| --- | --- | --- |
| `μ` | Their sustained capacity | Ramp concurrency 1→2→4→8… in **their sandbox with written permission**, holding each step for minutes. The knee is where p99 rises superlinearly. |
| `λ` | Our arrival rate | Per operation, mean and peak, from our own logs. |
| `L` | Concurrency needed to serve `λ` | Little's Law: `L = λW`, at their measured latency `W`. |

If `L` exceeds the knee, the gap is what call reduction and the contract have to
close. Everything in this directory buys time and safety; only caching, write
coalescing and dedupe change that arithmetic.

## What is here

| Module | Role |
| --- | --- |
| `src/control/limiter.js` | Adaptive concurrency limiter (AIMD and latency-gradient) with a bulkhead reservation |
| `src/control/breaker.js` | Circuit breaker with exponential re-open backoff |
| `src/control/retry.js` | Full-jitter backoff and a retry budget |
| `src/control/singleflight.js` | Request collapsing |
| `src/vendor/errors.js` | Failure classification — `retryable` / `terminal` / `indeterminate` |
| `src/vendor/client.js` | The single call site for the vendor; composes all of the above |
| `src/store/cache.js` | Cache-aside with stale-while-revalidate and negative caching |
| `src/obs/metrics.js` | Counters, gauges, histogram, Prometheus text |
| `test/fake-vendor.js` | A vendor that degrades with concurrency — the fixture everything is tested against |

### Composition order

```
withRetry(              <- sleeps BETWEEN attempts, holding no token
  breaker.assertPass()  <- fail fast when they are down
  limiter.acquire()     <- wait for a slot, or shed if out of deadline
  pool.request()        <- the call, under its own deadline
)
```

The retry loop sits outside the limiter deliberately: sleeping while holding a
concurrency token burns a slot of the vendor's scarce capacity doing nothing.

### Two lanes, one budget

The vendor's concurrency is the scarce resource. Everything else is policy about
who gets it. `reserveForPriority` (default 30%) carves out a slice only
interactive, user-waiting work may occupy, so a nightly batch cannot starve live
traffic. Interactive callers pass `priority: true`, `attempts: 1`, and an
`admissionMs` derived from their remaining request budget — when the slot does
not arrive in time they **shed** (serve stale, or `503` with `Retry-After`)
rather than queue. Queuing user-facing work behind a saturated vendor is the
failure this adapter exists to prevent.

### Why the limiter watches latency

This vendor gets slow before it gets loud. AIMD only reacts once calls are
already failing; the gradient mode compares current RTT against the best RTT
seen and shrinks proportionally, so we back off during degradation rather than
after it. `mode: 'gradient'` is the default in `VendorClient`. `mode: 'aimd'` is
the simpler fallback if the gradient behaviour ever proves too twitchy against
real traffic.

`test/client.test.js` holds the limiter to this: it is flooded with 40 workers
against a vendor whose knee is 6 and which **never returns an error**, and the
limit is required to fall from 32 on latency alone.

### Why a timeout is not a failure

A timed-out `POST` against a vendor with no idempotency-key support may or may
not have landed. Retrying it blind is how a retry policy becomes a
data-corruption engine. Such outcomes are classified `indeterminate` and are
**never** retried automatically. `VendorClient` stamps `x-correlation-id` on
every write so reconciliation can ask "did this land?" instead of guessing; if
the vendor echoes it into any searchable field, the read-back closes the loop.

Set `vendorHonoursIdempotencyKey: true` only once the vendor confirms support in
writing — it collapses `indeterminate` into `retryable`, which is the entire
value of idempotency keys and the main reason to keep asking them for it.

## Decisions that must not be lost

**The concurrency limit is per-process.** With `N` instances the vendor sees
`N × limit`. The current choice is: **fix the instance count and size each
limiter at `global / N`.** It is simple and honest, and it is also the failure
that silently reappears the day someone scales the deployment — if instances
become elastic, replace `AdaptiveLimiter` with a shared token bucket in
Redis/DynamoDB before that happens.

**Every vendor call must go through `VendorClient`.** One stray `fetch()`
elsewhere in the codebase and the limit, the breaker and the retry budget stop
meaning anything.

## Not built yet

Phases 4–6 of the design, which need the vendor's real endpoint shapes and an
AWS account, so there is nothing here that could be tested honestly:

- Deferred lane: jobs store, SQS producer/consumer, `202` + job-status API,
  FIFO `MessageGroupId` for per-entity ordering, DLQ and reconciler.
- HTTP server and routing (`server.js`, `worker.js`, the lane modules).
- Call reduction: conditional GETs, write coalescing, content-hash dedupe.

The primitives above are what those phases compose; none of them need changing
to add the queue.

## What to alarm on

- **Oldest-message-age per queue** — not depth. Age is the SLI that maps to user
  pain.
- **λ vs μ per lane.** Sustained `λ > μ` is *the* alarm: the adapter is masking a
  capacity gap that will not close on its own.
- `vendor_concurrency_limit` pinned at `minLimit` — a silent degradation
  otherwise.
- `vendor_shed_total`, breaker state transitions, `vendor_retries_total`.
- Size of the indeterminate set and the DLQ. Anything above zero is a
  correctness incident, not a performance one.

## Testing rules

Load-test `test/fake-vendor.js`, never the vendor's production tenant. The
fixture reproduces their actual failure mode — latency rising with concurrency,
503s past a hard knee, and an `accept-then-hang` mode that applies a write and
then never responds, which is the case that generates duplicates in a naive
integration.
