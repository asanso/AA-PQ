/* ═══════════════════════════════════════════════════════════════════
   keccak-batch.js — batch Keccak-256 via the Rust WASM kernel
   ───────────────────────────────────────────────────────────────────
   One WASM call digests up to ~32k equal-length messages, removing the
   per-hash JS↔WASM boundary cost that dominates SPHINCS⁺ sign time.
   Two embedded binaries (rust/keccak-batch): SIMD ×2 preferred, scalar
   fallback if SIMD fails validation. keccak256() in keccak.js is NOT
   touched — callers opt in explicitly via this module.

   Usage (hot loops):
     await keccakBatchInit();                    // once per JS context
     if (keccakBatchActive()) {
       const { view, stride } = keccakBatchBegin(msgLen, count);
       // write message i at view[i*stride .. i*stride+msgLen)
       const digests = keccakBatchRun();         // Uint8Array(count*32)
       // COPY out what you keep: views are reused by the next Begin/Run
     }

   The kernel uses STATIC buffers (linear memory never grows), so views
   never detach; they are still invalidated logically by the next
   Begin/Run, hence the copy-before-next-call rule.
   ═══════════════════════════════════════════════════════════════════ */

import {
  KECCAK_BATCH_WASM_SCALAR_B64,
  KECCAK_BATCH_WASM_SIMD_B64,
} from "./keccak-batch-wasm.js";

const RATE = 136; // Keccak-256 rate (bytes per block)

let _initPromise = null;
let _kernel = null; // { batch, inBuf, outBuf, capacity, simd }
let _pending = null; // { blocks, count } set by Begin, consumed by Run

/** Own base64 decoder so tests run in Node and workers alike. */
function b64ToBytes(b64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function instantiate(b64) {
  const { instance } = await WebAssembly.instantiate(b64ToBytes(b64), {});
  const ex = instance.exports;
  const capacity = ex.in_capacity();
  const mem = new Uint8Array(ex.memory.buffer);
  return {
    batch: ex.batch,
    // static buffers: memory never grows, these views stay valid for the
    // lifetime of the instance
    inBuf: mem.subarray(ex.in_ptr(), ex.in_ptr() + capacity),
    outBuf: mem.subarray(ex.out_ptr(), ex.out_ptr() + (capacity / RATE) * 32),
    capacity,
    simd: ex.is_simd() === 1,
  };
}

/**
 * Idempotent, never throws. Tries the SIMD build first (Chrome ≥91 always
 * has SIMD; scalar fallback is for robustness), then scalar, then gives up
 * — in which case keccakBatchActive() stays false and callers keep using
 * the plain per-hash path, bit-identical.
 * @returns {Promise<{active: boolean, simd: boolean}>}
 */
export async function keccakBatchInit() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      _kernel = await instantiate(KECCAK_BATCH_WASM_SIMD_B64);
    } catch (_) {
      try {
        _kernel = await instantiate(KECCAK_BATCH_WASM_SCALAR_B64);
      } catch (_) {
        _kernel = null;
      }
    }
    return { active: _kernel !== null, simd: _kernel ? _kernel.simd : false };
  })();
  return _initPromise;
}

/** True once init succeeded in this JS context. */
export function keccakBatchActive() {
  return _kernel !== null;
}

/** Bytes each message occupies in the batch buffer (whole keccak blocks). */
export function keccakBatchStride(msgLen) {
  return (Math.floor(msgLen / RATE) + 1) * RATE;
}

/** Max messages of msgLen per single batch call (chunking is the caller's). */
export function keccakBatchCapacity(msgLen) {
  return Math.floor(_kernel.capacity / keccakBatchStride(msgLen));
}

/**
 * Prepare a batch of `count` messages of exactly `msgLen` bytes: zero the
 * region and PRE-stamp the Ethereum keccak padding (0x01 … 0x80) for every
 * slot, so hot loops only write raw message bytes.
 * @returns {{view: Uint8Array, stride: number}} zero-copy view over WASM
 *   memory; write message i at view[i*stride .. i*stride+msgLen)
 */
export function keccakBatchBegin(msgLen, count) {
  const stride = keccakBatchStride(msgLen);
  if (count < 1 || count * stride > _kernel.capacity) {
    throw new Error(`keccak-batch: ${count}×${msgLen}B exceeds capacity`);
  }
  const view = _kernel.inBuf.subarray(0, count * stride);
  view.fill(0);
  for (let i = 0, base = 0; i < count; i++, base += stride) {
    view[base + msgLen] = 0x01;
    view[base + stride - 1] |= 0x80; // |= : msgLen === stride-1 → 0x81
  }
  _pending = { blocks: stride / RATE, count };
  return { view, stride };
}

/**
 * Run the batch prepared by the last Begin.
 * @returns {Uint8Array} zero-copy view of count×32 digest bytes — valid
 *   only until the next Begin/Run; copy out anything you keep.
 */
export function keccakBatchRun() {
  const { blocks, count } = _pending;
  _kernel.batch(blocks, count);
  return _kernel.outBuf.subarray(0, count * 32);
}

/**
 * One-shot convenience for non-hot call sites: `flat` holds `count`
 * messages of msgLen bytes packed contiguously. Returns a FRESH copy of
 * the digests (count×32), safe to hold.
 */
export function keccakBatch(flat, msgLen, count) {
  const { view, stride } = keccakBatchBegin(msgLen, count);
  for (let i = 0; i < count; i++) {
    view.set(flat.subarray(i * msgLen, (i + 1) * msgLen), i * stride);
  }
  return new Uint8Array(keccakBatchRun());
}

/**
 * TEST-ONLY: reset the singleton and force a specific build so the
 * differential suite exercises BOTH kernels through the real Begin/Run
 * code path. Never call from production code.
 * @param {"simd"|"scalar"} variant
 * @returns {Promise<boolean>} whether the loaded kernel is the SIMD one
 */
export async function __setKeccakBatchVariantForTest(variant) {
  _kernel = await instantiate(
    variant === "simd" ? KECCAK_BATCH_WASM_SIMD_B64 : KECCAK_BATCH_WASM_SCALAR_B64,
  );
  _pending = null;
  _initPromise = Promise.resolve({ active: true, simd: _kernel.simd });
  return _kernel.simd;
}
