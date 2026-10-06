/* ═══════════════════════════════════════════════════════════════════
   keccak.js — keccak256 with an optional WASM fast path
   ───────────────────────────────────────────────────────────────────
   Default impl is pure-JS @noble (always available, synchronous). After a
   one-time async init, ensureWasmKeccak() swaps the impl to hash-wasm's
   WebAssembly Keccak-256 (bit-identical, ~12× faster for our small inputs),
   which dominates SPHINCS⁺ sign cost. keccak256() stays synchronous, so all
   call sites are unchanged; they just transparently use whichever impl is
   active. If WASM is unavailable (CSP, load failure) we stay on @noble — the
   crypto is identical either way, only slower.
   ═══════════════════════════════════════════════════════════════════ */

import { keccak_256 } from "@noble/hashes/sha3";

let _impl = keccak_256; // default: pure-JS, synchronous, always works
let _wasmPromise = null;

/** Synchronous Keccak-256 → 32-byte Uint8Array. Routes to WASM once enabled. */
export function keccak256(data) {
  return _impl(data);
}

/**
 * Idempotent: instantiate hash-wasm's Keccak-256 once and route keccak256() to
 * it. Returns true if WASM is active, false if it fell back to @noble. Safe to
 * call in any context (main thread or a Worker); each context gets its own
 * WASM instance. Never throws — on failure keccak256 keeps using @noble.
 */
export async function ensureWasmKeccak() {
  if (_wasmPromise) return _wasmPromise;
  _wasmPromise = (async () => {
    try {
      const { createKeccak } = await import("hash-wasm");
      const k = await createKeccak(256);
      // digest("binary") returns a FRESH Uint8Array per call (verified), so
      // held outputs are never aliased/overwritten by later calls.
      _impl = (data) => {
        k.init();
        k.update(data);
        return k.digest("binary");
      };
      return true;
    } catch (_) {
      _impl = keccak_256;
      return false;
    }
  })();
  return _wasmPromise;
}

/** True if the WASM impl is currently active (after a successful ensure). */
export function isWasmKeccakActive() {
  return _impl !== keccak_256;
}
