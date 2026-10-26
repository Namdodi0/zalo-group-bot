/**
 * @param {number[]} values
 * @param {number} p 0..1
 */
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/**
 * @param {{startedAt?: number, limit?: number, now?: () => number}} [options]
 */
export function createMetrics(options = {}) {
  const startedAt = options.startedAt ?? Date.now();
  const limit = options.limit ?? 200;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, number>} */
  const counters = new Map();
  /** @type {Map<string, number[]>} */
  const latencies = new Map();

  /** @param {string} name @param {number} [value] */
  function inc(name, value = 1) {
    counters.set(name, (counters.get(name) ?? 0) + value);
  }

  /** @param {string} name @param {number} ms */
  function observe(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    let bucket = latencies.get(name);
    if (!bucket) {
      bucket = [];
      latencies.set(name, bucket);
    }
    bucket.push(ms);
    if (bucket.length > limit) bucket.shift();
  }

  /**
   * @param {{service: string, ms: number, ok: boolean, status?: number}} req
   */
  function recordRequest(req) {
    inc(`http.${req.service}.calls`);
    if (!req.ok) inc(`http.${req.service}.errors`);
    observe(`http.${req.service}`, req.ms);
  }

  /** @param {string} name */
  function get(name) {
    return counters.get(name) ?? 0;
  }

  function snapshot() {
    /** @type {Record<string, {count:number,p50:number,p95:number,max:number}>} */
    const latency = {};
    for (const [name, values] of latencies) {
      latency[name] = {
        count: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        max: Math.round(Math.max(...values)),
      };
    }
    return {
      uptimeSec: Math.round((now() - startedAt) / 1000),
      counters: Object.fromEntries(counters),
      latency,
    };
  }

  return { inc, observe, recordRequest, get, snapshot, startedAt };
}

export const __test__ = { percentile };
