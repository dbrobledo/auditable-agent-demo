/**
 * Minimal metrics registry — counters, gauges and a fixed-bucket histogram.
 *
 * Deliberately dependency-free and small: the point is that the numbers that
 * decide whether this adapter is working (the adaptive limit, shed count, and
 * arrival vs drain rate) are exported from day one, not bolted on after the
 * first incident. Swap `toPrometheus()` for whatever your scrape target is.
 */

const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

export class Metrics {
  constructor() {
    /** @type {Map<string, number>} */
    this._counters = new Map();
    /** @type {Map<string, () => number>} */
    this._gauges = new Map();
    /** @type {Map<string, {buckets: number[], counts: number[], sum: number, count: number}>} */
    this._histograms = new Map();
  }

  /** @param {string} name @param {Record<string, string>} [labels] @param {number} [by] */
  increment(name, labels = {}, by = 1) {
    const key = seriesKey(name, labels);
    this._counters.set(key, (this._counters.get(key) ?? 0) + by);
  }

  /** Register a gauge read on demand, e.g. the limiter's current limit. */
  gauge(name, fn, labels = {}) {
    this._gauges.set(seriesKey(name, labels), fn);
  }

  /** @param {string} name @param {number} value @param {Record<string, string>} [labels] */
  observe(name, value, labels = {}) {
    const key = seriesKey(name, labels);
    let h = this._histograms.get(key);
    if (!h) {
      h = { buckets: DEFAULT_BUCKETS_MS, counts: new Array(DEFAULT_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0 };
      this._histograms.set(key, h);
    }
    let i = h.buckets.findIndex((b) => value <= b);
    if (i === -1) i = h.buckets.length;
    h.counts[i]++;
    h.sum += value;
    h.count++;
  }

  /**
   * Approximate quantile from bucket counts. Good enough for alerting; if you
   * need exact tail latency, ship the histogram to a real backend.
   * @param {string} name @param {number} q @param {Record<string, string>} [labels]
   */
  quantile(name, q, labels = {}) {
    const h = this._histograms.get(seriesKey(name, labels));
    if (!h || h.count === 0) return null;
    const target = q * h.count;
    let cumulative = 0;
    for (let i = 0; i < h.counts.length; i++) {
      cumulative += h.counts[i];
      if (cumulative >= target) return h.buckets[i] ?? Infinity;
    }
    return Infinity;
  }

  snapshot() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, v] of this._counters) out[k] = v;
    for (const [k, fn] of this._gauges) out[k] = fn();
    for (const [k, h] of this._histograms) {
      out[`${k}::count`] = h.count;
      out[`${k}::sum`] = h.sum;
    }
    return out;
  }

  toPrometheus() {
    const lines = [];
    for (const [k, v] of this._counters) lines.push(`${k} ${v}`);
    for (const [k, fn] of this._gauges) lines.push(`${k} ${fn()}`);
    for (const [k, h] of this._histograms) {
      let cumulative = 0;
      for (let i = 0; i < h.buckets.length; i++) {
        cumulative += h.counts[i];
        lines.push(`${withLabel(k, 'le', String(h.buckets[i]))} ${cumulative}`);
      }
      lines.push(`${withLabel(k, 'le', '+Inf')} ${h.count}`);
      lines.push(`${k}_sum ${h.sum}`);
      lines.push(`${k}_count ${h.count}`);
    }
    return lines.join('\n');
  }
}

/** @param {string} name @param {Record<string, string>} labels */
function seriesKey(name, labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return name;
  return `${name}{${keys.map((k) => `${k}="${labels[k]}"`).join(',')}}`;
}

/** @param {string} key @param {string} label @param {string} value */
function withLabel(key, label, value) {
  const pair = `${label}="${value}"`;
  if (!key.includes('{')) return `${key}_bucket{${pair}}`;
  const [name, rest] = key.split('{');
  return `${name}_bucket{${rest.slice(0, -1)},${pair}}`;
}
