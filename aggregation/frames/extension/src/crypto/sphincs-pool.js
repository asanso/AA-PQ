/* ═══════════════════════════════════════════════════════════════════
   sphincs-pool.js — Web Worker pool for parallel FORS tree building
   ───────────────────────────────────────────────────────────────────
   Fans the K-1 independent FORS trees of a SPHINCS⁺ signature out across
   a small worker pool (one tree per job). Used by sphincsSignAsync().

   Size = navigator.hardwareConcurrency − 1, clamped to [1, 8] — leave a
   core for the main thread; with ≥6 cores all 6 trees run at once.

   Lazily spawns workers on first use and keeps them warm for subsequent
   signatures. Any worker error rejects its job; the signer then falls back
   to the synchronous path, so a broken pool can never block signing.
   ═══════════════════════════════════════════════════════════════════ */

let _pool = null;

/** Shared singleton pool (workers kept warm across signatures). */
export function getSphincsPool() {
  if (!_pool) _pool = new SphincsPool();
  return _pool;
}

/** True when Web Workers are usable in this context. */
export function workersAvailable() {
  return typeof Worker !== "undefined";
}

class SphincsPool {
  constructor(size) {
    const hc =
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    this.size = Math.max(1, Math.min(size || hc - 1, 8));
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map(); // id → { resolve, reject, worker }
    this.seq = 0;
  }

  _spawn() {
    if (this.workers.length) return;
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(
        new URL("./sphincs-fors.worker.js", import.meta.url),
        { type: "module" },
      );
      w.onmessage = (e) => this._onMessage(w, e.data);
      w.onerror = (e) => this._onError(w, e);
      this.workers.push(w);
      this.idle.push(w);
    }
    console.log(`[NiceTry sphincs-pool] spawned ${this.workers.length} workers`);
  }

  /** Run every task ({kind, ...payload}) concurrently across the pool;
   *  resolves to results in the SAME order as the input. */
  runAll(tasks) {
    this._spawn();
    return Promise.all(tasks.map((t) => this._submit(t)));
  }

  _submit(task) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, worker: null });
      this.queue.push({ id, task });
      this._drain();
    });
  }

  _drain() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const { id, task } = this.queue.shift();
      const p = this.pending.get(id);
      if (p) p.worker = w;
      w.postMessage({ id, ...task });
    }
  }

  _onMessage(w, data) {
    const p = this.pending.get(data.id);
    if (p) {
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(`FORS worker: ${data.error}`));
      else p.resolve(data);
    }
    this.idle.push(w);
    this._drain();
  }

  _onError(w, e) {
    // Reject whatever job this worker was running, then recycle it.
    for (const [id, p] of this.pending) {
      if (p.worker === w) {
        this.pending.delete(id);
        p.reject(e?.error || new Error("FORS worker crashed"));
      }
    }
    if (!this.idle.includes(w)) this.idle.push(w);
    this._drain();
  }

  terminate() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
    _pool = null;
  }
}
