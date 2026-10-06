/* ═══════════════════════════════════════════════════════════════════
   sphincs-fors.worker.js — run one SPHINCS⁺ sign sub-task off-thread
   ───────────────────────────────────────────────────────────────────
   The pool (sphincs-pool.js) fans the keccak-heavy slices of a signature
   out across these workers. Each task is dispatched by `kind` through the
   SAME runSphincsTask() the in-process pool uses, so a worker result is
   bit-identical to the sequential one:

     kind "wots"   → { leavesFlat }          (a range of WOTS public keys)
     kind "rgrind" → { found, tries, R16 }    (a counter chunk for the +C grind)
     kind "fors"   → { root, authFlat }       (one FORS subtree + its auth path)

   Output typed-array buffers are transferred back to avoid a copy.
   ═══════════════════════════════════════════════════════════════════ */

import { runSphincsTask } from "./sphincs.js";
import { ensureWasmKeccak } from "./keccak.js";
import { keccakBatchInit } from "./keccak-batch.js";

// Best-effort WASM upgrade — must NOT block task handling: a top-level await
// here would delay onmessage registration, and if WASM init ever stalls the
// worker would never process its queued tasks (pool hangs forever). Instead we
// kick it off in the background; keccak256() reads the active impl per call, so
// in-flight tasks switch to WASM the moment it's ready (~100ms), and until then
// run on @noble (bit-identical). No await ⇒ no hang.
ensureWasmKeccak().catch(() => {});
// Same rationale for the batch kernel: fire-and-forget. runSphincsTask()
// dispatches per call via keccakBatchActive(), so tasks pick the batched
// path the moment the kernel is ready and the per-hash path until then —
// bit-identical either way.
keccakBatchInit().catch(() => {});

self.onmessage = (e) => {
  const { id } = e.data;
  try {
    const out = runSphincsTask(e.data);
    // Collect transferable buffers from the result for a zero-copy return.
    const transfer = [];
    if (out.leavesFlat) transfer.push(out.leavesFlat.buffer);
    if (out.root) transfer.push(out.root.buffer);
    if (out.authFlat) transfer.push(out.authFlat.buffer);
    if (out.R16) transfer.push(out.R16.buffer);
    self.postMessage({ id, ...out }, transfer);
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
