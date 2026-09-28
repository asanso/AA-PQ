// Experimental sphincs-g software signer. Upstream Sphincs-G commit
// bea9447d45a4ac78bb2d8bc3d3f91a794c773881; algorithm body imported unchanged.
// Only the compact ledger_prepared_16_20 parameter set is exposed here.
// This is NOT hardware signing and does not implement prepared-slot protection.
// See docs/daisugi-testnet.md for provenance and limitations.

import { keccak256 } from "./keccak.js";
import {
  keccakBatchActive,
  keccakBatchBegin,
  keccakBatchRun,
} from "./keccak-batch.js";
import { concatBytes, hex2bytes, bytes2hex, u32BE } from "../utils/bytes.js";

/* High-resolution clock for the sign-phase profiling logs below. Falls back
   to Date.now() where performance.now() is unavailable. */
const _now = () =>
  typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
const _ms = (t) => (_now() - t).toFixed(0);

/* ── Parameters ───────────────────────────────────────────────────────
   Structural constants (identical in every set) come from
   sphincs-params.js; the per-set values (h, d, h', a, k, target_sum and
   the signature-layout offsets) travel in the `P` param-set object
   threaded through every function below. */
import {
  SPX_N,
  SPX_W,
  SPX_LOG_W,
  SPX_L,
  WOTS_SIG_LEN,
  getSphincsParams,
  sphincsParamsBySigLen,
} from "./sphincs-params.js";

export {
  SPX_N,
  SPX_W,
  SPX_LOG_W,
  SPX_L,
  getSphincsParams,
  SPHINCS_PARAM_SETS,
  DEFAULT_SPHINCS_PARAM_KEY,
} from "./sphincs-params.js";

/* Signature byte offsets: R at 0, FORS secrets right after; the rest
   (P.forsAuthOff, P.htOff, …) are per-set and live in P. */
const R_OFF = 0;
const FORS_SECRETS_OFF = SPX_N; // 16

/* ADRS types */
const TYPE_WOTS_HASH = 0;
const TYPE_WOTS_PK = 1;
const TYPE_TREE = 2;
const TYPE_FORS_TREE = 3;
const TYPE_FORS_ROOTS = 4;

/* ── Tagged-domain PRF salts (off-chain only; mirror fors.js style) ── */
const SK_SEED_TAG = new TextEncoder().encode("sphincs+c:sk-seed:v1");
const PK_SEED_TAG = new TextEncoder().encode("sphincs+c:pk-seed:v1");
const WOTS_SK_TAG = new TextEncoder().encode("sphincs+c:wots-sk:v1");
const FORS_SK_TAG = new TextEncoder().encode("sphincs+c:fors-sk:v1");
const R_TAG = new TextEncoder().encode("sphincs+c:r:v1");

/* ── Byte helpers ─────────────────────────────────────────────────── */

function topN(b) {
  return b.subarray(0, SPX_N);
}

/* 32-byte word with a 16-byte value flush in the TOP half (low 16 zero) —
   the EVM "N_MASK" representation. */
function word16(v16) {
  const out = new Uint8Array(32);
  out.set(v16.subarray(0, SPX_N), 0);
  return out;
}

/* 32-byte word holding a uint32 in the LOW 4 bytes (big-endian) — how the
   WOTS+C `count` is fed to the message hash (mstore of the integer). */
function wordU32Low(n) {
  const out = new Uint8Array(32);
  out.set(u32BE(n >>> 0), 28);
  return out;
}

function writeU32BE(buf, off, v) {
  buf[off + 0] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

function bytesToBigIntBE(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function u128BE(bn) {
  const out = new Uint8Array(16);
  let v = BigInt(bn) & ((1n << 128n) - 1n);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/* Build a 32-byte ADRS. `tree` is a Number for the "+C" sets (< 2^20,
   low u32 of the 96-bit field) or a BigInt for the standard set (up to
   2^54 — written as u64 into bytes 8..16 of the tree field; byte-
   identical to the Number path for values < 2^32). */
function adrs(layer, tree, type, w1, w2, w3) {
  const a = new Uint8Array(32);
  writeU32BE(a, 0, layer >>> 0);
  if (typeof tree === "bigint") {
    writeU32BE(a, 8, Number(tree >> 32n));
    writeU32BE(a, 12, Number(tree & 0xffffffffn));
  } else {
    writeU32BE(a, 12, tree >>> 0); // low 32 bits of the 96-bit tree field
  }
  writeU32BE(a, 16, type >>> 0);
  writeU32BE(a, 20, w1 >>> 0);
  writeU32BE(a, 24, w2 >>> 0);
  writeU32BE(a, 28, w3 >>> 0);
  return a;
}

/* 8-byte big-endian encoding of a BigInt (standard set's tree indices in
   the secret-key PRF inputs — the "+C" sets keep their u32 encoding). */
function u64BE(bn) {
  const out = new Uint8Array(8);
  let v = BigInt(bn) & ((1n << 64n) - 1n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/* Tweakable hash T(adrs, payload words) → 16-byte node. */
function T(pkSeed16, adrs32, ...payloadWords) {
  return topN(keccak256(concatBytes(word16(pkSeed16), adrs32, ...payloadWords)));
}

/* ── H_msg ────────────────────────────────────────────────────────── */
const HMSG_PAD = (() => {
  const b = new Uint8Array(32);
  b.fill(0xff);
  return b;
})();

function hMsg(P, pkSeed16, pkRoot16, R16, message32) {
  if (P.compactHmsg) {
    return keccak256(
      concatBytes(HMSG_PAD, R16, pkSeed16, pkRoot16, message32),
    );
  }
  return keccak256(
    concatBytes(word16(pkSeed16), word16(pkRoot16), word16(R16), message32, HMSG_PAD),
  ); // 32 bytes (NOT masked)
}

/* Decode the hypertree leaf index + FORS leaf indices from an H_msg digest.
   htIdx = (digest >> k·a) & (2^h-1); FORS field i = (digest >> i·a) & (2^a-1). */
function decodeDigest(P, digest32) {
  const d = bytesToBigIntBE(digest32);
  const htIdx = Number((d >> BigInt(P.k * P.a)) & ((1n << BigInt(P.h)) - 1n));
  const fields = new Array(P.k);
  for (let i = 0; i < P.k; i++) {
    fields[i] = Number((d >> BigInt(i * P.a)) & ((1n << BigInt(P.a)) - 1n));
  }
  return { htIdx, fields };
}

/* ── Secret-key PRFs (signer's free choice; deterministic from seed) ── */

function wotsSk(skSeed32, layer, tree, keypair, chain) {
  return topN(
    keccak256(
      concatBytes(
        skSeed32,
        WOTS_SK_TAG,
        u32BE(layer),
        typeof tree === "bigint" ? u64BE(tree) : u32BE(tree),
        u32BE(keypair),
        u32BE(chain),
      ),
    ),
  );
}

function forsSk(skSeed32, idxTree0, idxLeaf0, forsTree, leafIdx) {
  return topN(
    keccak256(
      concatBytes(
        skSeed32,
        FORS_SK_TAG,
        typeof idxTree0 === "bigint" ? u64BE(idxTree0) : u32BE(idxTree0),
        u32BE(idxLeaf0),
        u32BE(forsTree),
        u32BE(leafIdx),
      ),
    ),
  );
}

/* ── WOTS⁺ ────────────────────────────────────────────────────────── */

/* Advance a chain value from position `from` to position `to` (to ≤ w-1=7),
   applying F at hash_address = from..to-1. */
function wotsChain(pkSeed16, layer, tree, keypair, chain, val16, from, to) {
  let v = val16;
  for (let p = from; p < to; p++) {
    v = T(pkSeed16, adrs(layer, tree, TYPE_WOTS_HASH, keypair, chain, p), word16(v));
  }
  return v;
}

/* WOTS⁺ public key (compressed) for keypair (layer, tree, keypair). */
function wotsPk(skSeed32, pkSeed16, layer, tree, keypair) {
  const ends = [];
  for (let i = 0; i < SPX_L; i++) {
    const sk = wotsSk(skSeed32, layer, tree, keypair, i);
    ends.push(word16(wotsChain(pkSeed16, layer, tree, keypair, i, sk, 0, SPX_W - 1)));
  }
  return T(pkSeed16, adrs(layer, tree, TYPE_WOTS_PK, keypair, 0, 0), ...ends);
}

/* ── Merkle subtree (height h') — leaves are WOTS public keys ──────── */

/* Build a subtree and return its leaves (16-byte each). */
function subtreeLeaves(P, skSeed32, pkSeed16, layer, tree) {
  const leaves = new Array(P.leavesPerSubtree);
  for (let j = 0; j < P.leavesPerSubtree; j++) {
    leaves[j] = wotsPk(skSeed32, pkSeed16, layer, tree, j);
  }
  return leaves;
}

/* Reduce subtree leaves → { root, auth } for the given leaf. TREE ADRS:
   type=2, word1=0, word2=height, word3=tree_index. */
function subtreeRootAuth(P, pkSeed16, layer, tree, leaves, leafIdx) {
  let level = leaves;
  let idx = leafIdx;
  const auth = [];
  for (let h = 0; h < P.subtreeH; h++) {
    auth.push(level[idx ^ 1]);
    const next = new Array(level.length >> 1);
    for (let p = 0; p < next.length; p++) {
      next[p] = T(
        pkSeed16,
        adrs(layer, tree, TYPE_TREE, 0, h + 1, p),
        word16(level[2 * p]),
        word16(level[2 * p + 1]),
      );
    }
    level = next;
    idx >>= 1;
  }
  return { root: level[0], auth };
}

/* ── FORS ─────────────────────────────────────────────────────────── */

/* Build FORS tree `forsTree` (height a) for instance (idxTree0, idxLeaf0)
   and return { root, auth } for `revealIdx`. Builds level-by-level keeping
   only the current level to bound memory. */
export function forsTreeRootAuth(P, skSeed32, pkSeed16, idxTree0, idxLeaf0, forsTree, revealIdx) {
  // Leaves: H(sk) under FORS_TREE leaf ADRS (height 0, word3 = (i<<a)|leafIdx).
  let level = new Array(P.forsLeaves);
  for (let j = 0; j < P.forsLeaves; j++) {
    const sk = forsSk(skSeed32, idxTree0, idxLeaf0, forsTree, j);
    level[j] = T(
      pkSeed16,
      adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, 0, (forsTree << P.a) | j),
      word16(sk),
    );
  }
  let idx = revealIdx;
  const auth = [];
  for (let h = 0; h < P.a; h++) {
    auth.push(level[idx ^ 1]);
    const next = new Array(level.length >> 1);
    for (let p = 0; p < next.length; p++) {
      // word3 = (forsTree << (a-1-h)) | parentIdx
      next[p] = T(
        pkSeed16,
        adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, h + 1, (forsTree << (P.a - 1 - h)) | p),
        word16(level[2 * p]),
        word16(level[2 * p + 1]),
      );
    }
    level = next;
    idx >>= 1;
  }
  return { root: level[0], auth };
}

/* FORS leaf hash for a single revealed secret (used for the forced-zero
   last tree, treated as leaf 0 of tree K-1). */
function forsLeafHash(P, pkSeed16, idxTree0, idxLeaf0, forsTree, leafIdx, sk16) {
  return T(
    pkSeed16,
    adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, 0, (forsTree << P.a) | leafIdx),
    word16(sk16),
  );
}

/* Compress K FORS roots → forsPk. FORS_ROOTS ADRS: type=4, word1=idxLeaf0. */
function forsCompress(pkSeed16, idxTree0, idxLeaf0, roots) {
  return T(
    pkSeed16,
    adrs(0, idxTree0, TYPE_FORS_ROOTS, idxLeaf0, 0, 0),
    ...roots.map(word16),
  );
}

/* ── Parallel building blocks (used by sphincsSignAsync + the worker) ─────
   Each is a self-contained, side-effect-free slice of the sign work, using
   the SAME hashes/ADRS as the monolithic functions above, so distributing
   the work yields a byte-identical signature. */

/* Build ONE FORS subtree of height `sh` (the `sub`-th block of 2^sh leaves of
   FORS tree `forsTree`) and return its root + the within-subtree auth path for
   the local reveal index. Splitting a height-A FORS tree into 2^(A-sh) of
   these + forsCombineTop() reproduces forsTreeRootAuth() exactly — the node
   ADRS uses GLOBAL indices, identical to the monolithic build. */
export function forsSubtree(P, skSeed32, pkSeed16, idxTree0, idxLeaf0, forsTree, sh, sub, localReveal) {
  const base = sub << sh; // global leaf offset of this subtree
  const n = 1 << sh;
  let level = new Array(n);
  for (let j = 0; j < n; j++) {
    const gj = base + j; // global leaf index
    const sk = forsSk(skSeed32, idxTree0, idxLeaf0, forsTree, gj);
    level[j] = T(
      pkSeed16,
      adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, 0, (forsTree << P.a) | gj),
      word16(sk),
    );
  }
  let idx = localReveal;
  const auth = [];
  for (let h = 0; h < sh; h++) {
    auth.push(level[idx ^ 1]);
    const L = h + 1; // global level
    const globalBase = sub << (sh - L); // global node-index offset at level L
    const next = new Array(level.length >> 1);
    for (let p = 0; p < next.length; p++) {
      const gp = globalBase + p; // global node index at level L
      next[p] = T(
        pkSeed16,
        adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, L, (forsTree << (P.a - 1 - h)) | gp),
        word16(level[2 * p]),
        word16(level[2 * p + 1]),
      );
    }
    level = next;
    idx >>= 1;
  }
  return { root: level[0], auth }; // auth has `sh` entries
}

/* Combine the 2^(a-sh) subtree roots (one per `sub`, in order) into the FORS
   tree root, collecting the top auth path (levels sh..a-1) for `revealIdx`.
   Returns { root, topAuth } where topAuth has (a-sh) entries. */
function forsCombineTop(P, pkSeed16, idxTree0, idxLeaf0, forsTree, sh, subtreeRoots, revealIdx) {
  let level = subtreeRoots; // global level sh, indices 0..2^(a-sh)-1
  let idx = revealIdx >> sh;
  const topAuth = [];
  for (let h = sh; h < P.a; h++) {
    topAuth.push(level[idx ^ 1]);
    const next = new Array(level.length >> 1);
    for (let p = 0; p < next.length; p++) {
      next[p] = T(
        pkSeed16,
        adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, h + 1, (forsTree << (P.a - 1 - h)) | p),
        word16(level[2 * p]),
        word16(level[2 * p + 1]),
      );
    }
    level = next;
    idx >>= 1;
  }
  return { root: level[0], topAuth };
}

/* Build WOTS⁺ public keys [from, to) for subtree (layer, tree), packed flat
   (16 B each). A range of subtreeLeaves(); combined on the main thread. */
export function wotsPkRange(skSeed32, pkSeed16, layer, tree, from, to) {
  const out = new Uint8Array((to - from) * SPX_N);
  for (let k = from; k < to; k++) {
    const pk = wotsPk(skSeed32, pkSeed16, layer, tree, k);
    out.set(pk.subarray(0, SPX_N), (k - from) * SPX_N);
  }
  return out;
}

/* Scan R-grind counters [start, start+count) for the first one whose H_msg
   zeroes the forced FORS field (i = K-1). Returns { tries, R16 } or null.
   Disjoint chunks across workers parallelise the grind; the caller takes the
   smallest `tries` for a deterministic R. */
export function rgrindChunk(P, skSeed32, pkSeed16, pkRoot16, message32, start, count) {
  const R0 = bytesToBigIntBE(topN(keccak256(concatBytes(skSeed32, R_TAG, message32))));
  for (let t = start; t < start + count; t++) {
    const R16 = u128BE(R0 + BigInt(t));
    const dec = decodeDigest(P, hMsg(P, pkSeed16, pkRoot16, R16, message32));
    if (dec.fields[P.k - 1] === 0) return { tries: t, R16 };
  }
  return null;
}

/* ── Batched variants (Rust WASM keccak-batch kernel) ─────────────────
   Byte-identical twins of the hot functions above: same hashes, same
   ADRS, same scan order — only computed ~32k per WASM call instead of
   one per call. runSphincsTask()/sphincsSignAsync() dispatch to these
   when keccakBatchActive(); otherwise the originals run, so the batch
   kernel is never a single point of failure. sphincsSign() (sync) never
   uses them — it is the pure oracle. Pattern: keccakBatchBegin() zeroes
   the region and pre-stamps padding, loops write only raw bytes. */

const BATCH_CAP_1BLK = 32768; // messages ≤135 B per batch call (4 MiB / 136)

/* forsSubtree() twin. Leaves in two passes (forsSk 68 B → leaf-T 96 B in
   chunks of 32k), then one 128 B batch per Merkle level. Nodes live in
   flat 16 B/entry buffers; auth entries are copied out (levels are
   consumed by the next batch). */
function forsSubtreeBatched(P, skSeed32, pkSeed16, idxTree0, idxLeaf0, forsTree, sh, sub, localReveal) {
  const base = sub << sh;
  const n = 1 << sh;
  let level = new Uint8Array(n * SPX_N);
  const skTop = new Uint8Array(Math.min(n, BATCH_CAP_1BLK) * SPX_N);

  for (let c0 = 0; c0 < n; c0 += BATCH_CAP_1BLK) {
    const c = Math.min(BATCH_CAP_1BLK, n - c0);
    // pass A — forsSk: skSeed32 ‖ FORS_SK_TAG(20) ‖ 4×u32  (68 B)
    {
      const { view, stride } = keccakBatchBegin(68, c);
      for (let j = 0, off = 0; j < c; j++, off += stride) {
        view.set(skSeed32, off);
        view.set(FORS_SK_TAG, off + 32);
        writeU32BE(view, off + 52, idxTree0);
        writeU32BE(view, off + 56, idxLeaf0);
        writeU32BE(view, off + 60, forsTree);
        writeU32BE(view, off + 64, base + c0 + j);
      }
      const d = keccakBatchRun();
      for (let j = 0; j < c; j++) skTop.set(d.subarray(j * 32, j * 32 + SPX_N), j * SPX_N);
    }
    // pass B — leaf-T: word16(pkSeed) ‖ adrs ‖ word16(sk)  (96 B)
    {
      const { view, stride } = keccakBatchBegin(96, c);
      for (let j = 0, off = 0; j < c; j++, off += stride) {
        view.set(pkSeed16.subarray(0, SPX_N), off);
        writeU32BE(view, off + 44, idxTree0); // adrs+12: tree
        writeU32BE(view, off + 48, TYPE_FORS_TREE); // adrs+16: type
        writeU32BE(view, off + 52, idxLeaf0); // adrs+20: word1
        writeU32BE(view, off + 60, (forsTree << P.a) | (base + c0 + j)); // adrs+28: word3
        view.set(skTop.subarray(j * SPX_N, (j + 1) * SPX_N), off + 64);
      }
      const d = keccakBatchRun();
      for (let j = 0; j < c; j++) {
        level.set(d.subarray(j * 32, j * 32 + SPX_N), (c0 + j) * SPX_N);
      }
    }
  }

  // Merkle levels — word16(pkSeed) ‖ adrs ‖ word16(left) ‖ word16(right) (128 B)
  let idx = localReveal;
  let nodes = n;
  const auth = [];
  for (let h = 0; h < sh; h++) {
    auth.push(level.slice((idx ^ 1) * SPX_N, (idx ^ 1) * SPX_N + SPX_N));
    const half = nodes >> 1;
    const L = h + 1;
    const globalBase = sub << (sh - L);
    const next = new Uint8Array(half * SPX_N);
    for (let p0 = 0; p0 < half; p0 += BATCH_CAP_1BLK) {
      const c = Math.min(BATCH_CAP_1BLK, half - p0);
      const { view, stride } = keccakBatchBegin(128, c);
      for (let j = 0, off = 0; j < c; j++, off += stride) {
        const p = p0 + j;
        view.set(pkSeed16.subarray(0, SPX_N), off);
        writeU32BE(view, off + 44, idxTree0);
        writeU32BE(view, off + 48, TYPE_FORS_TREE);
        writeU32BE(view, off + 52, idxLeaf0);
        writeU32BE(view, off + 56, L); // adrs+24: word2 = level
        writeU32BE(view, off + 60, (forsTree << (P.a - 1 - h)) | (globalBase + p));
        view.set(level.subarray(2 * p * SPX_N, (2 * p + 1) * SPX_N), off + 64);
        view.set(level.subarray((2 * p + 1) * SPX_N, (2 * p + 2) * SPX_N), off + 96);
      }
      const d = keccakBatchRun();
      for (let j = 0; j < c; j++) next.set(d.subarray(j * 32, j * 32 + SPX_N), (p0 + j) * SPX_N);
    }
    level = next;
    nodes = half;
    idx >>= 1;
  }
  return { root: level.slice(0, SPX_N), auth };
}

/* wotsPkRange() twin. Per keypair chunk: one 68 B batch for the 43 chain
   secrets, then the 7 chain steps in LOCKSTEP (public-key chains always
   run all w-1 steps — no divergence), each step one 96 B batch over
   chunk×43 values, closed by one 1440 B compress batch per chunk. */
function wotsPkRangeBatched(skSeed32, pkSeed16, layer, tree, from, to) {
  const out = new Uint8Array((to - from) * SPX_N);
  const KP_CHUNK = 512; // 512×43 = 22016 ≤ 32768
  for (let k0 = from; k0 < to; k0 += KP_CHUNK) {
    const kc = Math.min(KP_CHUNK, to - k0);
    const m = kc * SPX_L;
    const vals = new Uint8Array(m * SPX_N);
    // chain secrets — skSeed32 ‖ WOTS_SK_TAG(20) ‖ 4×u32 (68 B)
    {
      const { view, stride } = keccakBatchBegin(68, m);
      for (let k = 0, off = 0; k < kc; k++) {
        for (let i = 0; i < SPX_L; i++, off += stride) {
          view.set(skSeed32, off);
          view.set(WOTS_SK_TAG, off + 32);
          writeU32BE(view, off + 52, layer);
          writeU32BE(view, off + 56, tree);
          writeU32BE(view, off + 60, k0 + k);
          writeU32BE(view, off + 64, i);
        }
      }
      const d = keccakBatchRun();
      for (let j = 0; j < m; j++) vals.set(d.subarray(j * 32, j * 32 + SPX_N), j * SPX_N);
    }
    // 7 lockstep chain steps — word16(pkSeed) ‖ adrs(...,p) ‖ word16(v) (96 B)
    for (let p = 0; p < SPX_W - 1; p++) {
      const { view, stride } = keccakBatchBegin(96, m);
      for (let k = 0, j = 0, off = 0; k < kc; k++) {
        for (let i = 0; i < SPX_L; i++, j++, off += stride) {
          view.set(pkSeed16.subarray(0, SPX_N), off);
          writeU32BE(view, off + 32, layer);
          writeU32BE(view, off + 44, tree);
          // adrs+16: type = TYPE_WOTS_HASH = 0 (already zero)
          writeU32BE(view, off + 52, k0 + k); // word1 = keypair
          writeU32BE(view, off + 56, i); // word2 = chain
          writeU32BE(view, off + 60, p); // word3 = hash address
          view.set(vals.subarray(j * SPX_N, (j + 1) * SPX_N), off + 64);
        }
      }
      const d = keccakBatchRun();
      for (let j = 0; j < m; j++) vals.set(d.subarray(j * 32, j * 32 + SPX_N), j * SPX_N);
    }
    // compress — word16(pkSeed) ‖ adrs(TYPE_WOTS_PK) ‖ 43×word16(end) (1440 B)
    {
      const { view, stride } = keccakBatchBegin(32 + 32 + SPX_L * 32, kc);
      for (let k = 0, off = 0; k < kc; k++, off += stride) {
        view.set(pkSeed16.subarray(0, SPX_N), off);
        writeU32BE(view, off + 32, layer);
        writeU32BE(view, off + 44, tree);
        writeU32BE(view, off + 48, TYPE_WOTS_PK);
        writeU32BE(view, off + 52, k0 + k); // word1 = keypair
        for (let i = 0; i < SPX_L; i++) {
          view.set(vals.subarray((k * SPX_L + i) * SPX_N, (k * SPX_L + i + 1) * SPX_N), off + 64 + i * 32);
        }
      }
      const d = keccakBatchRun();
      for (let k = 0; k < kc; k++) {
        out.set(d.subarray(k * 32, k * 32 + SPX_N), (k0 - from + k) * SPX_N);
      }
    }
  }
  return out;
}

/* rgrindChunk() twin. Windows of 4096 counters, one 160 B (2-block) batch
   per window; digests checked in ascending counter order so the first hit
   is the SAME counter the scalar scan finds. */
function rgrindChunkBatched(P, skSeed32, pkSeed16, pkRoot16, message32, start, count) {
  const R0 = bytesToBigIntBE(topN(keccak256(concatBytes(skSeed32, R_TAG, message32))));
  const WIN = 4096;
  /* fields[K-1] = bits [(k-1)·a, k·a) of the BE digest (bit 0 = LSB of byte
     31). Read just the covering bytes as a BE integer and shift/mask —
     the span is ≤ a + 7 ≤ 27 bits for every set, so plain 32-bit ops. */
  const bitLo = (P.k - 1) * P.a;
  const loByte = 31 - (bitLo >> 3); // rightmost byte of the field
  const hiByte = 31 - ((bitLo + P.a - 1) >> 3); // leftmost byte of the field
  const shift = bitLo & 7;
  const mask = (1 << P.a) - 1;
  for (let w0 = start; w0 < start + count; w0 += WIN) {
    const wc = Math.min(WIN, start + count - w0);
    const { view, stride } = keccakBatchBegin(160, wc);
    for (let j = 0, off = 0; j < wc; j++, off += stride) {
      view.set(pkSeed16.subarray(0, SPX_N), off);
      view.set(pkRoot16.subarray(0, SPX_N), off + 32);
      view.set(u128BE(R0 + BigInt(w0 + j)), off + 64);
      view.set(message32, off + 96);
      view.set(HMSG_PAD, off + 128);
    }
    const d = keccakBatchRun();
    for (let j = 0, o = 0; j < wc; j++, o += 32) {
      let w = 0;
      for (let b = hiByte; b <= loByte; b++) w = (w << 8) | d[o + b];
      if (((w >>> shift) & mask) === 0) {
        return { tries: w0 + j, R16: u128BE(R0 + BigInt(w0 + j)) };
      }
    }
  }
  return null;
}

/* grindWotsCount() twin. Windows of 2048 counters, one 128 B batch per
   window, digit sums checked in ascending order (deterministic minimum);
   same 5M safety bound. The winning digest is COPIED out (the view is
   reused by the next batch). */
function grindWotsCountBatched(P, pkSeed16, wotsAdrs, currentNode16) {
  const WIN = 2048;
  for (let base = 0; ; base += WIN) {
    const { view, stride } = keccakBatchBegin(128, WIN);
    for (let j = 0, off = 0; j < WIN; j++, off += stride) {
      view.set(pkSeed16.subarray(0, SPX_N), off);
      view.set(wotsAdrs, off + 32);
      view.set(currentNode16.subarray(0, SPX_N), off + 64);
      writeU32BE(view, off + 124, base + j); // wordU32Low: u32 in low 4 bytes
    }
    const d = keccakBatchRun();
    for (let j = 0; j < WIN; j++) {
      const dj = d.subarray(j * 32, (j + 1) * 32);
      if (wotsDigitSum(dj) === P.targetSum) {
        return { count: base + j, d: new Uint8Array(dj) };
      }
    }
    if (base > GRIND_WOTS_BOUND) throw new Error("grindWotsCount: no counter found");
  }
}

/* ═══ Standard set (P.std — SLH-DSA-128s geometry) ═══════════════════
   The "standard" profile keeps this wallet's primitives (keccak256
   tweakable hash T, 32-byte uncompressed ADRS, tagged PRFs) but follows
   FIPS-205 for everything the "+C" sets replaced with grinding:

     · H_msg digest split (md ‖ idx_tree ‖ idx_leaf, byte-aligned,
       base_2b MSB-first) — decodeDigestStd()
     · WOTS with the len2=3 checksum chains (w=16, l=35) instead of the
       ground counter — wotsDigitsStd(); no count field in the signature
     · no R grind, no forced-zero FORS tree: R is the plain PRF value and
       ALL k FORS trees ship [secret ‖ auth]

   Tree indices span h−h' = 54 bits, so this path runs tree addresses as
   BigInt end-to-end (adrs()/wotsSk()/forsSk() widen transparently).
   forsTreeRootAuth/subtreeRootAuth/forsCompress are reused as-is; the
   WOTS leaf builder differs (w/l) so it has a Std twin. No batched
   twins: a full sign is only ~2.1M hashes — the per-hash WASM path is
   already sub-second. The JS sphincsVerifyStd below is the reference
   the on-chain verifier for this set must mirror. */

/* H_msg split — MIRRORS SphincsPlus128sVerifier.verifyPlus128s: the same
   bit-offset convention as the "+C" sets, just with a 63-bit hypertree
   index. FORS field i = bits [i·a, (i+1)·a) of the digest (LSB-first);
   htIdx = (digest >> k·a) & (2^h − 1), from which idx_leaf = htIdx mod 2^h'
   and idx_tree = htIdx >> h'. (NOT the FIPS byte split — the deployed
   verifier defines the convention.) */
function decodeDigestStd(P, digest32) {
  const d = bytesToBigIntBE(digest32);
  const fields = new Array(P.k);
  for (let i = 0; i < P.k; i++) {
    fields[i] = Number((d >> BigInt(i * P.a)) & ((1n << BigInt(P.a)) - 1n));
  }
  const htIdx = (d >> BigInt(P.k * P.a)) & ((1n << BigInt(P.h)) - 1n);
  const leaf = Number(htIdx & BigInt(P.leavesPerSubtree - 1));
  const treeBig = htIdx >> BigInt(P.subtreeH);
  return { treeBig, leaf, fields };
}

/* WOTS digits of a 16-byte node: len1 = 32 base-w digits (base_2b: high
   nibble of byte 0 first), then the FIPS checksum csum = Σ(w−1−digit),
   left-shifted to the byte boundary and split into len2 logW-bit digits
   MSB-first. */
function wotsDigitsStd(P, node16) {
  const len1 = (SPX_N * 8) / P.logW; // 32
  const len2 = P.l - len1; // 3
  const digits = new Array(P.l);
  for (let i = 0; i < len1; i++) {
    const b = node16[i >> 1];
    digits[i] = i & 1 ? b & (P.w - 1) : b >> P.logW;
  }
  let csum = 0;
  for (let i = 0; i < len1; i++) csum += P.w - 1 - digits[i];
  csum <<= (8 - ((len2 * P.logW) % 8)) % 8; // FIPS alignment shift (here: << 4)
  for (let i = 0; i < len2; i++) {
    digits[len1 + i] = (csum >> ((len2 - i) * P.logW)) & (P.w - 1);
  }
  return digits;
}

/* WOTS⁺ public key, standard chains (l=35, all w−1=15 steps). */
function wotsPkStd(P, skSeed32, pkSeed16, layer, treeBig, keypair) {
  const ends = [];
  for (let i = 0; i < P.l; i++) {
    const sk = wotsSk(skSeed32, layer, treeBig, keypair, i);
    ends.push(word16(wotsChain(pkSeed16, layer, treeBig, keypair, i, sk, 0, P.w - 1)));
  }
  return T(pkSeed16, adrs(layer, treeBig, TYPE_WOTS_PK, keypair, 0, 0), ...ends);
}

function subtreeLeavesStd(P, skSeed32, pkSeed16, layer, treeBig) {
  const leaves = new Array(P.leavesPerSubtree);
  for (let j = 0; j < P.leavesPerSubtree; j++) {
    leaves[j] = wotsPkStd(P, skSeed32, pkSeed16, layer, treeBig, j);
  }
  return leaves;
}

/* Worker-range twin (kind "wots-std"). `treeStr` is the BigInt tree as a
   decimal string — kept clone-safe across every pool implementation. */
export function wotsPkRangeStd(P, skSeed32, pkSeed16, layer, treeStr, from, to) {
  const treeBig = BigInt(treeStr);
  const out = new Uint8Array((to - from) * SPX_N);
  for (let k = from; k < to; k++) {
    const pk = wotsPkStd(P, skSeed32, pkSeed16, layer, treeBig, k);
    out.set(pk.subarray(0, SPX_N), (k - from) * SPX_N);
  }
  return out;
}

/* Sync standard sign — the oracle for the "standard" profile. */
function sphincsSignStd(P, hdPvkBytes, message) {
  const _tAll = _now();
  const message32 = asMessage32(message);
  const { skSeed, pkSeed } = deriveSeeds(P, hdPvkBytes);

  const topLeaves = subtreeLeavesStd(P, skSeed, pkSeed, P.d - 1, 0n);
  const pkRoot = subtreeRootAuth(P, pkSeed, P.d - 1, 0n, topLeaves, 0).root;

  // R: plain PRF — the standard set does not grind.
  const R16 = topN(keccak256(concatBytes(skSeed, R_TAG, message32)));
  const { treeBig, leaf, fields } = decodeDigestStd(P, hMsg(P, pkSeed, pkRoot, R16, message32));

  const blob = new Uint8Array(P.sigLen);
  blob.set(R16, R_OFF);

  // FORS: ALL k trees, [secret ‖ auth] per tree.
  const roots = new Array(P.k);
  for (let i = 0; i < P.k; i++) {
    const off = P.forsOff + i * P.forsPerTree;
    blob.set(forsSk(skSeed, treeBig, leaf, i, fields[i]), off);
    const { root, auth } = forsTreeRootAuth(P, skSeed, pkSeed, treeBig, leaf, i, fields[i]);
    roots[i] = root;
    for (let h = 0; h < P.a; h++) blob.set(auth[h], off + SPX_N + h * SPX_N);
  }
  let currentNode = forsCompress(pkSeed, treeBig, leaf, roots);

  // Hypertree: d layers, WOTS(currentNode digits+checksum) + subtree auth.
  let idxTree = treeBig;
  let idxLeaf = leaf;
  let off = P.htOff;
  for (let layer = 0; layer < P.d; layer++) {
    const digits = wotsDigitsStd(P, currentNode);
    for (let i = 0; i < P.l; i++) {
      const sk = wotsSk(skSeed, layer, idxTree, idxLeaf, i);
      const sig = wotsChain(pkSeed, layer, idxTree, idxLeaf, i, sk, 0, digits[i]);
      blob.set(sig, off + i * SPX_N);
    }
    const leaves =
      layer === P.d - 1
        ? topLeaves
        : subtreeLeavesStd(P, skSeed, pkSeed, layer, idxTree);
    const { root, auth } = subtreeRootAuth(P, pkSeed, layer, idxTree, leaves, idxLeaf);
    const authOff = off + P.wotsSigLen;
    for (let h = 0; h < P.subtreeH; h++) blob.set(auth[h], authOff + h * SPX_N);
    currentNode = root;
    off = authOff + P.htTreeAuthLen;
    idxLeaf = Number(idxTree & BigInt(P.leavesPerSubtree - 1));
    idxTree >>= BigInt(P.subtreeH);
  }

  if (bytes2hex(currentNode) !== bytes2hex(pkRoot)) {
    throw new Error("sphincsSignStd: internal root mismatch (derivation bug)");
  }
  console.log(`[NiceTry sphincs] ═══ TOTAL sphincsSignStd (${P.domain}): ${_ms(_tAll)}ms ═══`);
  return {
    blob,
    sigHex: "0x" + bytes2hex(blob),
    pkSeed,
    pkRoot,
    backupPkSeed: "0x" + bytes2hex(word16(pkSeed)),
    backupPkRoot: "0x" + bytes2hex(word16(pkRoot)),
    R: R16,
  };
}

/* Parallel standard sign — same bytes as sphincsSignStd(): the k FORS
   trees and the d−1 lower subtrees fan out over the pool ("fors-std" /
   "wots-std" tasks); the top subtree comes from keygenTopAsync. */
async function sphincsSignAsyncStd(P, hdPvkBytes, message, pool) {
  const _tAll = _now();
  const message32 = asMessage32(message);
  const W = Math.max(1, pool.size || 1);
  console.log(
    `[NiceTry sphincs‖] ⚡ START SPHINCS+ signature, profile "${P.key}" (${P.domain}, standard) — pool: ${W} workers`,
  );

  const { skSeed, pkSeed, pkRoot, topLeaves } = await keygenTopAsync(P, hdPvkBytes, pool);
  const R16 = topN(keccak256(concatBytes(skSeed, R_TAG, message32)));
  const { treeBig, leaf, fields } = decodeDigestStd(P, hMsg(P, pkSeed, pkRoot, R16, message32));
  const treeStr0 = treeBig.toString();

  const forsTasks = fields.map((reveal, i) => ({
    kind: "fors-std", profile: P.key, skSeed, pkSeed,
    treeStr: treeStr0, idxLeaf0: leaf, forsTree: i, revealIdx: reveal,
  }));
  // Lower-layer subtrees (layers 0..d−2); layer d−1 reuses topLeaves.
  const subTasks = [];
  {
    let t = treeBig;
    for (let layer = 0; layer < P.d - 1; layer++) {
      subTasks.push({
        kind: "wots-std", profile: P.key, skSeed, pkSeed,
        layer, treeStr: t.toString(), from: 0, to: P.leavesPerSubtree,
      });
      t >>= BigInt(P.subtreeH);
    }
  }
  const batch = await pool.runAll([...forsTasks, ...subTasks]);
  const forsRes = batch.slice(0, forsTasks.length);
  const subRes = batch.slice(forsTasks.length);

  const blob = new Uint8Array(P.sigLen);
  blob.set(R16, R_OFF);

  const roots = new Array(P.k);
  for (let i = 0; i < P.k; i++) {
    const off = P.forsOff + i * P.forsPerTree;
    blob.set(forsSk(skSeed, treeBig, leaf, i, fields[i]), off);
    roots[i] = forsRes[i].root;
    blob.set(forsRes[i].authFlat, off + SPX_N);
  }
  let currentNode = forsCompress(pkSeed, treeBig, leaf, roots);

  let idxTree = treeBig;
  let idxLeaf = leaf;
  let off = P.htOff;
  for (let layer = 0; layer < P.d; layer++) {
    const digits = wotsDigitsStd(P, currentNode);
    for (let i = 0; i < P.l; i++) {
      const sk = wotsSk(skSeed, layer, idxTree, idxLeaf, i);
      blob.set(wotsChain(pkSeed, layer, idxTree, idxLeaf, i, sk, 0, digits[i]), off + i * SPX_N);
    }
    let leaves;
    if (layer === P.d - 1) {
      leaves = topLeaves;
    } else {
      const flat = subRes[layer].leavesFlat;
      leaves = new Array(P.leavesPerSubtree);
      for (let j = 0; j < P.leavesPerSubtree; j++) {
        leaves[j] = flat.subarray(j * SPX_N, (j + 1) * SPX_N);
      }
    }
    const { root, auth } = subtreeRootAuth(P, pkSeed, layer, idxTree, leaves, idxLeaf);
    const authOff = off + P.wotsSigLen;
    for (let h = 0; h < P.subtreeH; h++) blob.set(auth[h], authOff + h * SPX_N);
    currentNode = root;
    off = authOff + P.htTreeAuthLen;
    idxLeaf = Number(idxTree & BigInt(P.leavesPerSubtree - 1));
    idxTree >>= BigInt(P.subtreeH);
  }

  if (bytes2hex(currentNode) !== bytes2hex(pkRoot)) {
    throw new Error("sphincsSignAsyncStd: internal root mismatch (derivation bug)");
  }
  console.log(
    `[NiceTry sphincs‖] ✅ SIGNATURE COMPLETE ("${P.key}") in ${((_now() - _tAll) / 1000).toFixed(2)}s (pool ${W} workers)`,
  );
  return {
    blob,
    sigHex: "0x" + bytes2hex(blob),
    pkSeed,
    pkRoot,
    backupPkSeed: "0x" + bytes2hex(word16(pkSeed)),
    backupPkRoot: "0x" + bytes2hex(word16(pkRoot)),
    R: R16,
  };
}

/* Verify, standard set — mirror of the (future) on-chain verifier: this
   JS is the byte-level reference that contract must match. */
function sphincsVerifyStd(P, pkSeed, pkRoot, message32, sig) {
  const read16 = (o) => sig.subarray(o, o + SPX_N);

  const R16 = read16(R_OFF);
  const { treeBig, leaf, fields } = decodeDigestStd(P, hMsg(P, pkSeed, pkRoot, R16, message32));

  const roots = new Array(P.k);
  for (let i = 0; i < P.k; i++) {
    const reveal = fields[i];
    const off = P.forsOff + i * P.forsPerTree;
    let node = T(
      pkSeed,
      adrs(0, treeBig, TYPE_FORS_TREE, leaf, 0, (i << P.a) | reveal),
      word16(read16(off)),
    );
    let pathIdx = reveal;
    for (let h = 0; h < P.a; h++) {
      const sibling = read16(off + SPX_N + h * SPX_N);
      const parentIdx = pathIdx >> 1;
      const a = adrs(0, treeBig, TYPE_FORS_TREE, leaf, h + 1, (i << (P.a - 1 - h)) | parentIdx);
      node =
        pathIdx & 1
          ? T(pkSeed, a, word16(sibling), word16(node))
          : T(pkSeed, a, word16(node), word16(sibling));
      pathIdx = parentIdx;
    }
    roots[i] = node;
  }
  let currentNode = forsCompress(pkSeed, treeBig, leaf, roots);

  let idxTree = treeBig;
  let idxLeaf = leaf;
  let off = P.htOff;
  for (let layer = 0; layer < P.d; layer++) {
    const digits = wotsDigitsStd(P, currentNode);
    const ends = new Array(P.l);
    for (let i = 0; i < P.l; i++) {
      let val = read16(off + i * SPX_N);
      val = wotsChain(pkSeed, layer, idxTree, idxLeaf, i, val, digits[i], P.w - 1);
      ends[i] = word16(val);
    }
    let node = T(pkSeed, adrs(layer, idxTree, TYPE_WOTS_PK, idxLeaf, 0, 0), ...ends);

    const authOff = off + P.wotsSigLen;
    let mIdx = idxLeaf;
    for (let h = 0; h < P.subtreeH; h++) {
      const sibling = read16(authOff + h * SPX_N);
      const parentIdx = mIdx >> 1;
      const a = adrs(layer, idxTree, TYPE_TREE, 0, h + 1, parentIdx);
      node =
        mIdx & 1
          ? T(pkSeed, a, word16(sibling), word16(node))
          : T(pkSeed, a, word16(node), word16(sibling));
      mIdx = parentIdx;
    }
    currentNode = node;
    off = authOff + P.htTreeAuthLen;
    idxLeaf = Number(idxTree & BigInt(P.leavesPerSubtree - 1));
    idxTree >>= BigInt(P.subtreeH);
  }

  const valid = bytes2hex(currentNode) === bytes2hex(pkRoot);
  return { valid, reason: valid ? "ok" : "root-mismatch" };
}

/* ── Key derivation ───────────────────────────────────────────────── */

/* Per-set root seeds. The set's domain string sits between the tag and the
   HD key, so each parameter set derives an INDEPENDENT keypair — every
   downstream PRF (wotsSk/forsSk/R) is keyed by skSeed/pkSeed, so root-level
   separation is sufficient and no other derivation changes per set.
   Protocol constants: changing a domain changes that profile's keys. */
function deriveSeeds(P, hdPvkBytes) {
  const skSeed = keccak256(concatBytes(SK_SEED_TAG, P.domainBytes, hdPvkBytes)); // 32 B
  const pkSeed = topN(keccak256(concatBytes(PK_SEED_TAG, P.domainBytes, hdPvkBytes))); // 16 B
  return { skSeed, pkSeed };
}

/**
 * Derive the SPHINCS⁺ backup keypair from an HD private key for one
 * parameter set. The public key (pkSeed, pkRoot) is what the SimpleAccount
 * commits to at creation.
 *
 * @param {Uint8Array} hdPvkBytes — 32-byte HD private key (taken at the
 *        account-identity path, chainId 0', so it is seed-only and
 *        device-independent).
 * @param {string|object} [profile] — profile key ("fast" | "default" |
 *        "cheap") or a param-set object; defaults to "default".
 * @returns {{
 *   skSeed: Uint8Array,        // 32 B PRF key (secret)
 *   pkSeed: Uint8Array,        // 16 B public seed
 *   pkRoot: Uint8Array,        // 16 B top-tree root
 *   backupPkSeed: string,      // 0x bytes32 (pkSeed top-aligned)
 *   backupPkRoot: string,      // 0x bytes32 (pkRoot top-aligned)
 * }}
 */
export function sphincsDerive(hdPvkBytes, profile) {
  const P = getSphincsParams(profile);
  const { skSeed, pkSeed } = deriveSeeds(P, hdPvkBytes);

  // pkRoot = root of the TOP subtree (layer D-1, tree 0). Only the top
  // subtree is needed for keygen (2^h' WOTS pks); lower layers are built
  // on demand at sign time. Standard set: its own WOTS leaf builder
  // (w=16/l=35) and BigInt tree address.
  const topLeaves = P.std
    ? subtreeLeavesStd(P, skSeed, pkSeed, P.d - 1, 0n)
    : subtreeLeaves(P, skSeed, pkSeed, P.d - 1, 0);
  const { root: pkRoot } = subtreeRootAuth(P, pkSeed, P.d - 1, P.std ? 0n : 0, topLeaves, 0);

  return {
    skSeed,
    pkSeed,
    pkRoot,
    backupPkSeed: "0x" + bytes2hex(word16(pkSeed)),
    backupPkRoot: "0x" + bytes2hex(word16(pkRoot)),
  };
}

/* ── Grinding helpers (+C) ─────────────────────────────────────────── */

/* Sum of the 43 base-8 digits of a WOTS message digest. */
function wotsDigitSum(d32) {
  const d = bytesToBigIntBE(d32);
  let sum = 0;
  for (let i = 0; i < SPX_L; i++) sum += Number((d >> BigInt(i * SPX_LOG_W)) & 7n);
  return sum;
}

/* Safety bound for the WOTS+C grind: the per-set target sums (196/215/217)
   sit in the upper tail of the digit-sum distribution, so expected tries
   range from ~10³ to ~10⁶; a miss below this bound means a parameter/
   derivation bug, not bad luck. */
const GRIND_WOTS_BOUND = 50_000_000;

/* Find the WOTS+C counter so the message digest's digit sum == target. */
function grindWotsCount(P, pkSeed16, wotsAdrs, currentNode16) {
  for (let count = 0; ; count++) {
    const d = keccak256(
      concatBytes(word16(pkSeed16), wotsAdrs, word16(currentNode16), wordU32Low(count)),
    );
    if (wotsDigitSum(d) === P.targetSum) return { count, d };
    if (count > GRIND_WOTS_BOUND) throw new Error("grindWotsCount: no counter found");
  }
}

/* ── Sign ─────────────────────────────────────────────────────────── */

function asMessage32(message) {
  const m = typeof message === "string" ? hex2bytes(message) : message;
  if (m.length !== 32) throw new Error("sphincsSign: message must be 32 bytes");
  return m;
}

/**
 * Sign a 32-byte message with the SPHINCS⁺ backup key.
 *
 * @param {Uint8Array} hdPvkBytes — 32 B HD private key (identity path).
 * @param {Uint8Array|string} message — 32-byte digest (recovery message).
 * @param {string|object} [profile] — profile key or param set (default "default").
 * @returns {{ blob: Uint8Array, sigHex: string, pkSeed, pkRoot,
 *             backupPkSeed: string, backupPkRoot: string, R: Uint8Array }}
 */
export function sphincsSign(hdPvkBytes, message, profile) {
  const P = getSphincsParams(profile);
  if (P.std) return sphincsSignStd(P, hdPvkBytes, message);
  const _tAll = _now();
  const message32 = asMessage32(message);
  console.log(
    "[NiceTry sphincs] 🐢 START SYNCHRONOUS SPHINCS+ signature (slow " +
      "fallback/oracle path: 1 thread, one keccak per call — the fast path is " +
      "sphincsSignAsync with a worker pool and Rust batch kernel)",
  );

  const _tDerive = _now();
  const { skSeed, pkSeed, pkRoot, backupPkSeed, backupPkRoot } =
    sphincsDerive(hdPvkBytes, P);
  console.log(`[NiceTry sphincs] 1. keygen (derive top subtree): ${_ms(_tDerive)}ms`);

  // ── Grind R until the forced-zero FORS field (i = K-1) is zero ──────
  const _tR = _now();
  let R0 = bytesToBigIntBE(
    topN(keccak256(concatBytes(skSeed, R_TAG, message32))),
  );
  let R16, digest, dec;
  let _rTries = 0;
  for (let tries = 0; ; tries++) {
    _rTries = tries + 1;
    R16 = u128BE(R0 + BigInt(tries));
    digest = hMsg(P, pkSeed, pkRoot, R16, message32);
    dec = decodeDigest(P, digest);
    if (dec.fields[P.k - 1] === 0) break;
    if (tries > 200_000_000) throw new Error("sphincsSign: R grind exhausted");
  }
  console.log(`[NiceTry sphincs] 2. R grind (forced-zero FORS field): ${_ms(_tR)}ms, ${_rTries} tries`);
  const { htIdx, fields } = dec;

  const blob = new Uint8Array(P.sigLen);
  blob.set(R16, R_OFF);

  // ── FORS ────────────────────────────────────────────────────────
  const _tFors = _now();
  const idxLeaf0 = htIdx & (P.leavesPerSubtree - 1);
  const idxTree0 = htIdx >> P.subtreeH;
  const roots = new Array(P.k);

  for (let i = 0; i < P.k - 1; i++) {
    const _tTree = _now();
    const treeIdx = fields[i];
    const sk = forsSk(skSeed, idxTree0, idxLeaf0, i, treeIdx);
    blob.set(sk, FORS_SECRETS_OFF + i * SPX_N);
    const { root, auth } = forsTreeRootAuth(
      P,
      skSeed,
      pkSeed,
      idxTree0,
      idxLeaf0,
      i,
      treeIdx,
    );
    roots[i] = root;
    for (let h = 0; h < P.a; h++) {
      blob.set(auth[h], P.forsAuthOff + i * P.forsAuthPerTree + h * SPX_N);
    }
    console.log(`[NiceTry sphincs]    · FORS tree ${i + 1}/${P.k - 1} (h=${P.a}, ${P.forsLeaves} leaves): ${_ms(_tTree)}ms`);
  }
  // Last tree (forced-zero): reveal leaf 0's secret; its root IS the leaf hash.
  {
    const i = P.k - 1;
    const sk = forsSk(skSeed, idxTree0, idxLeaf0, i, 0);
    blob.set(sk, FORS_SECRETS_OFF + i * SPX_N);
    roots[i] = forsLeafHash(P, pkSeed, idxTree0, idxLeaf0, i, 0, sk);
  }

  let currentNode = forsCompress(pkSeed, idxTree0, idxLeaf0, roots);
  console.log(`[NiceTry sphincs] 3. FORS total (${P.k - 1} trees built + compress): ${_ms(_tFors)}ms`);

  // ── Hypertree ─────────────────────────────────────────────────────
  const _tHt = _now();
  let idxTree = htIdx;
  let off = P.htOff;
  for (let layer = 0; layer < P.d; layer++) {
    const _tLayer = _now();
    const idxLeaf = idxTree & (P.leavesPerSubtree - 1);
    idxTree = idxTree >> P.subtreeH;

    const wotsAdrs = adrs(layer, idxTree, TYPE_WOTS_HASH, idxLeaf, 0, 0);
    const _tGrind = _now();
    const { count, d } = grindWotsCount(P, pkSeed, wotsAdrs, currentNode);
    const _grindMs = _ms(_tGrind);
    const dBig = bytesToBigIntBE(d);

    // WOTS signature: each chain hashed `digit` times from its secret.
    for (let i = 0; i < SPX_L; i++) {
      const digit = Number((dBig >> BigInt(i * SPX_LOG_W)) & 7n);
      const sk = wotsSk(skSeed, layer, idxTree, idxLeaf, i);
      const sig = wotsChain(pkSeed, layer, idxTree, idxLeaf, i, sk, 0, digit);
      blob.set(sig, off + i * SPX_N);
    }
    // count (4-byte big-endian) at countOff
    writeU32BE(blob, off + WOTS_SIG_LEN, count);

    // Merkle auth path of leaf idxLeaf in this subtree.
    const _tSub = _now();
    const leaves = subtreeLeaves(P, skSeed, pkSeed, layer, idxTree);
    const { root, auth } = subtreeRootAuth(P, pkSeed, layer, idxTree, leaves, idxLeaf);
    const _subMs = _ms(_tSub);
    const authOff = off + WOTS_SIG_LEN + 4;
    for (let h = 0; h < P.subtreeH; h++) {
      blob.set(auth[h], authOff + h * SPX_N);
    }

    currentNode = root;
    off = authOff + P.htTreeAuthLen;
    console.log(`[NiceTry sphincs]    · HT layer ${layer + 1}/${P.d}: ${_ms(_tLayer)}ms (WOTS+C grind ${_grindMs}ms/count=${count}, subtree ${P.leavesPerSubtree} leaves ${_subMs}ms)`);
  }
  console.log(`[NiceTry sphincs] 4. hypertree total (${P.d} layers): ${_ms(_tHt)}ms`);

  // Sanity: the reconstructed top root must equal pkRoot (keygen).
  if (bytes2hex(currentNode) !== bytes2hex(pkRoot)) {
    throw new Error("sphincsSign: internal root mismatch (derivation bug)");
  }

  console.log(`[NiceTry sphincs] ═══ TOTAL sphincsSign: ${_ms(_tAll)}ms ═══`);
  return {
    blob,
    sigHex: "0x" + bytes2hex(blob),
    pkSeed,
    pkRoot,
    backupPkSeed,
    backupPkRoot,
    R: R16,
  };
}

/* Parallel-sign tuning lives in the param set (P.forsSplitS, P.rgrindChunk):
   each height-a FORS tree is built as 2^S subtrees of height (a − S), then
   combined, so >K-1 units of work spread over the pool; rgrindChunk counters
   are scanned per rgrind task, sized so one pool round covers ~2× the
   expected 2^a tries. Perf only — never affects signature bytes. */

function rangeChunks(total, n) {
  const per = Math.max(1, Math.ceil(total / n));
  const out = [];
  for (let s = 0; s < total; s += per) out.push({ from: s, to: Math.min(s + per, total) });
  return out;
}

function assembleLeaves(P, results, ranges) {
  const leaves = new Array(P.leavesPerSubtree);
  for (let r = 0; r < ranges.length; r++) {
    const { from, to } = ranges[r];
    const flat = results[r].leavesFlat;
    for (let k = from; k < to; k++) {
      leaves[k] = flat.subarray((k - from) * SPX_N, (k - from + 1) * SPX_N);
    }
  }
  return leaves;
}

/* In-process pool: runs each task synchronously on the main thread. Used as
   the no-Worker fallback and as a deterministic test harness (same code path
   as the real worker pool, so it validates the parallel ORCHESTRATION). */
function inlineForsPool() {
  return {
    size: 1,
    runAll: async (tasks) => tasks.map(runSphincsTask),
  };
}

/* Execute one parallel task by kind. The Web Worker (sphincs-fors.worker.js)
   runs the identical switch; keep the two in sync. Each task carries the
   profile key (t.profile) so the worker resolves the same param set. */
export function runSphincsTask(t) {
  const P = getSphincsParams(t.profile);
  const batched = keccakBatchActive();
  if (t.kind === "fors") {
    const { root, auth } = (batched ? forsSubtreeBatched : forsSubtree)(
      P, t.skSeed, t.pkSeed, t.idxTree0, t.idxLeaf0, t.forsTree, t.sh, t.sub, t.localReveal,
    );
    const rootFlat = new Uint8Array(SPX_N);
    rootFlat.set(root.subarray(0, SPX_N));
    const authFlat = new Uint8Array(t.sh * SPX_N);
    for (let h = 0; h < t.sh; h++) authFlat.set(auth[h].subarray(0, SPX_N), h * SPX_N);
    return { root: rootFlat, authFlat };
  }
  if (t.kind === "wots") {
    return {
      leavesFlat: (batched ? wotsPkRangeBatched : wotsPkRange)(
        t.skSeed, t.pkSeed, t.layer, t.tree, t.from, t.to,
      ),
    };
  }
  if (t.kind === "rgrind") {
    const r = (batched ? rgrindChunkBatched : rgrindChunk)(
      P, t.skSeed, t.pkSeed, t.pkRoot, t.message32, t.start, t.count,
    );
    return r ? { found: true, tries: r.tries, R16: r.R16 } : { found: false };
  }
  /* Standard-set kinds (scalar only — no batched twins; tree as string). */
  if (t.kind === "wots-std") {
    return {
      leavesFlat: wotsPkRangeStd(P, t.skSeed, t.pkSeed, t.layer, t.treeStr, t.from, t.to),
    };
  }
  if (t.kind === "fors-std") {
    const { root, auth } = forsTreeRootAuth(
      P, t.skSeed, t.pkSeed, BigInt(t.treeStr), t.idxLeaf0, t.forsTree, t.revealIdx,
    );
    const rootFlat = new Uint8Array(SPX_N);
    rootFlat.set(root.subarray(0, SPX_N));
    const authFlat = new Uint8Array(P.a * SPX_N);
    for (let h = 0; h < P.a; h++) authFlat.set(auth[h].subarray(0, SPX_N), h * SPX_N);
    return { root: rootFlat, authFlat };
  }
  throw new Error(`runSphincsTask: unknown kind ${t.kind}`);
}

/* Keygen: build the hypertree's TOP subtree (layer D-1, tree 0) with its
   2,048 WOTS⁺ public keys spread over the pool, and reduce them to pkRoot.
   Shared by sphincsDeriveAsync() and sphincsSignAsync() — the signer keeps
   `topLeaves` to avoid recomputing the same subtree later. */
async function keygenTopAsync(P, hdPvkBytes, pool) {
  const { skSeed, pkSeed } = deriveSeeds(P, hdPvkBytes);
  /* Task granularity: at least one range per worker, but cap ranges at
     ~16k leaves each so a huge top subtree (cheap set: 2^18 leaves) load-
     balances instead of pinning one giant range per worker. */
  const nRanges = Math.max(
    Math.max(1, pool.size || 1),
    Math.ceil(P.leavesPerSubtree / 16384),
  );
  const ranges = rangeChunks(P.leavesPerSubtree, nRanges);
  const res = await pool.runAll(
    ranges.map((r) =>
      P.std
        ? { kind: "wots-std", profile: P.key, skSeed, pkSeed, layer: P.d - 1, treeStr: "0", from: r.from, to: r.to }
        : { kind: "wots", profile: P.key, skSeed, pkSeed, layer: P.d - 1, tree: 0, from: r.from, to: r.to },
    ),
  );
  const topLeaves = assembleLeaves(P, res, ranges);
  const pkRoot = subtreeRootAuth(P, pkSeed, P.d - 1, P.std ? 0n : 0, topLeaves, 0).root;
  return { skSeed, pkSeed, pkRoot, topLeaves };
}

/**
 * Off-thread twin of sphincsDerive(): same return shape, same bytes, but the
 * ~0.7M keccak of the top-subtree keygen run on the worker pool instead of
 * freezing the caller's thread. Pass no pool (or one without runAll) to get
 * the synchronous in-process fallback.
 *
 * @param {Uint8Array} hdPvkBytes 32-byte HD identity-path private key.
 * @param {object} [opts]
 * @param {{ size:number, runAll:(tasks:Array)=>Promise<Array> }} [opts.pool]
 * @returns {Promise<{ skSeed, pkSeed, pkRoot, backupPkSeed, backupPkRoot }>}
 */
export async function sphincsDeriveAsync(hdPvkBytes, { pool, profile } = {}) {
  const P = getSphincsParams(profile);
  if (!pool || typeof pool.runAll !== "function") pool = inlineForsPool();
  const _t = _now();
  const { skSeed, pkSeed, pkRoot } = await keygenTopAsync(P, hdPvkBytes, pool);
  console.log(
    `[NiceTry sphincs‖] keygen backup commitment (${P.domain}) — ${P.leavesPerSubtree} ` +
      `WOTS keys across ${Math.max(1, pool.size || 1)} workers: ${_ms(_t)}ms`,
  );
  return {
    skSeed,
    pkSeed,
    pkRoot,
    backupPkSeed: "0x" + bytes2hex(word16(pkSeed)),
    backupPkRoot: "0x" + bytes2hex(word16(pkRoot)),
  };
}

/**
 * Maximally-parallel SPHINCS⁺ sign — byte-identical output to sphincsSign(),
 * but EVERY keccak-heavy phase is distributed over the worker pool:
 *   - keygen top subtree  → 2048 WOTS pks split into pool.size ranges
 *   - R grind             → disjoint counter chunks, smallest hit wins
 *   - FORS (K-1 trees)    → each split into 2^S subtrees, all built at once,
 *                           together with the hypertree's bottom subtree
 *   - hypertree top subtree is reused from keygen (no recompute)
 * The cheap, inherently-sequential bits (WOTS+C grind, WOTS sig, combines)
 * stay on the main thread.
 *
 * Same primitives as the sync path ⇒ identical bytes; callers SHOULD still gate
 * on sphincsVerify() (cheap) and fall back to sphincsSign() on any failure.
 *
 * @param {Uint8Array} hdPvkBytes 32-byte HD identity-path private key.
 * @param {Uint8Array|string} message 32-byte digest.
 * @param {object} [opts]
 * @param {{ size:number, runAll:(tasks:Array)=>Promise<Array> }} [opts.pool]
 *        Worker pool; if omitted an in-process pool runs tasks sequentially.
 * @param {string|object} [opts.profile] profile key or param set (default "default").
 * @returns {Promise<{ blob, sigHex, pkSeed, pkRoot, backupPkSeed, backupPkRoot, R }>}
 */
export async function sphincsSignAsync(hdPvkBytes, message, { pool, profile } = {}) {
  const P = getSphincsParams(profile);
  if (!pool || typeof pool.runAll !== "function") pool = inlineForsPool();
  if (P.std) return sphincsSignAsyncStd(P, hdPvkBytes, message, pool);
  const _tAll = _now();
  const message32 = asMessage32(message);
  const W = Math.max(1, pool.size || 1);
  console.log(
    `[NiceTry sphincs‖] ⚡ START SPHINCS+ signature, profile "${P.key}" (${P.domain}) — ` +
      `pool: ${W} workers · Rust batch kernel (main thread): ${
        keccakBatchActive() ? "ACTIVE ✅" : "inactive → per-hash"
      }`,
  );

  // ── 1. Keygen top subtree (layer D-1, tree 0) — leaves in parallel ──────
  const _tKey = _now();
  const { skSeed, pkSeed, pkRoot, topLeaves } = await keygenTopAsync(P, hdPvkBytes, pool);
  const backupPkSeed = "0x" + bytes2hex(word16(pkSeed));
  const backupPkRoot = "0x" + bytes2hex(word16(pkRoot));
  console.log(
    `[NiceTry sphincs‖] ① keygen — hypertree TOP subtree: ${P.leavesPerSubtree} ` +
      `WOTS keys (distributed across ${W} workers): ${_ms(_tKey)}ms`,
  );

  // ── 2. R grind — disjoint counter chunks, smallest qualifying try wins ──
  const _tR = _now();
  let R16 = null, rTries = 0, baseOffset = 0;
  while (R16 === null) {
    const tasks = [];
    for (let k = 0; k < W; k++) {
      tasks.push({ kind: "rgrind", profile: P.key, skSeed, pkSeed, pkRoot, message32, start: baseOffset + k * P.rgrindChunk, count: P.rgrindChunk });
    }
    const res = await pool.runAll(tasks);
    let best = null;
    for (const r of res) if (r && r.found && (best === null || r.tries < best.tries)) best = r;
    if (best) { R16 = best.R16; rTries = best.tries + 1; }
    else baseOffset += W * P.rgrindChunk;
    if (baseOffset > 200_000_000) throw new Error("sphincsSignAsync: R grind exhausted");
  }
  const { htIdx, fields } = decodeDigest(P, hMsg(P, pkSeed, pkRoot, R16, message32));
  console.log(
    `[NiceTry sphincs‖] ② R grind — find a counter that clears the forced FORS ` +
      `field: ${rTries.toLocaleString()} attempts × 2 keccak each: ${_ms(_tR)}ms`,
  );

  const blob = new Uint8Array(P.sigLen);
  blob.set(R16, R_OFF);
  const idxLeaf0 = htIdx & (P.leavesPerSubtree - 1);
  const idxTree0 = htIdx >> P.subtreeH;

  // ── 3. FORS subtrees + hypertree bottom subtree — ALL in one parallel batch ─
  const _tFors = _now();
  const forsSubtreeH = P.a - P.forsSplitS;
  const forsSubtrees = 1 << P.forsSplitS;
  const forsSubtreeMask = (1 << forsSubtreeH) - 1;
  const forsTasks = [];
  for (let i = 0; i < P.k - 1; i++) {
    const reveal = fields[i];
    const localReveal = reveal & forsSubtreeMask;
    for (let sub = 0; sub < forsSubtrees; sub++) {
      forsTasks.push({ kind: "fors", profile: P.key, skSeed, pkSeed, idxTree0, idxLeaf0, forsTree: i, sh: forsSubtreeH, sub, localReveal });
    }
  }
  /* Hypertree bottom subtree = (layer 0, tree htIdx>>subtreeH = idxTree0).
     With d=1 (cheap set) the bottom subtree IS the top subtree just built by
     keygen (idxTree0 is necessarily 0) — reuse it instead of rebuilding. */
  const needBottom = P.d > 1;
  const botRanges = needBottom ? rangeChunks(P.leavesPerSubtree, W) : [];
  const botTasks = botRanges.map((r) => ({ kind: "wots", profile: P.key, skSeed, pkSeed, layer: 0, tree: idxTree0, from: r.from, to: r.to }));

  const batch = await pool.runAll([...forsTasks, ...botTasks]);
  const forsRes = batch.slice(0, forsTasks.length);
  const botRes = batch.slice(forsTasks.length);
  const bottomLeaves = needBottom ? assembleLeaves(P, botRes, botRanges) : topLeaves;

  // Assemble FORS: per tree, combine its subtree roots + splice the auth path.
  const roots = new Array(P.k);
  for (let i = 0; i < P.k - 1; i++) {
    const reveal = fields[i];
    blob.set(forsSk(skSeed, idxTree0, idxLeaf0, i, reveal), FORS_SECRETS_OFF + i * SPX_N);
    const revealSub = reveal >> forsSubtreeH;
    const subRoots = new Array(forsSubtrees);
    let revealAuthFlat = null;
    for (let sub = 0; sub < forsSubtrees; sub++) {
      const r = forsRes[i * forsSubtrees + sub];
      subRoots[sub] = r.root;
      if (sub === revealSub) revealAuthFlat = r.authFlat;
    }
    const { root, topAuth } = forsCombineTop(P, pkSeed, idxTree0, idxLeaf0, i, forsSubtreeH, subRoots, reveal);
    roots[i] = root;
    const authBase = P.forsAuthOff + i * P.forsAuthPerTree;
    for (let h = 0; h < forsSubtreeH; h++) {
      blob.set(revealAuthFlat.subarray(h * SPX_N, (h + 1) * SPX_N), authBase + h * SPX_N);
    }
    for (let h = 0; h < P.forsSplitS; h++) {
      blob.set(topAuth[h], authBase + (forsSubtreeH + h) * SPX_N);
    }
  }
  // Last tree (forced-zero): reveal leaf 0's secret; its root IS the leaf hash.
  {
    const i = P.k - 1;
    const sk = forsSk(skSeed, idxTree0, idxLeaf0, i, 0);
    blob.set(sk, FORS_SECRETS_OFF + i * SPX_N);
    roots[i] = forsLeafHash(P, pkSeed, idxTree0, idxLeaf0, i, 0, sk);
  }
  let currentNode = forsCompress(pkSeed, idxTree0, idxLeaf0, roots);
  console.log(
    `[NiceTry sphincs‖] ③ FORS — ${P.k - 1} trees with ${P.forsLeaves} leaves in ${
      (P.k - 1) * forsSubtrees
    } parallel subtrees` +
      (needBottom ? ` + hypertree BOTTOM subtree` : ` (bottom = top, reused)`) +
      `: ${_ms(_tFors)}ms`,
  );

  // ── 4. Hypertree — precomputed leaves (bottom ‖, top reused); cheap WOTS ──
  const _tHt = _now();
  let idxTree = htIdx;
  let off = P.htOff;
  for (let layer = 0; layer < P.d; layer++) {
    const idxLeaf = idxTree & (P.leavesPerSubtree - 1);
    idxTree = idxTree >> P.subtreeH;

    const wotsAdrs = adrs(layer, idxTree, TYPE_WOTS_HASH, idxLeaf, 0, 0);
    const { count, d } = (keccakBatchActive() ? grindWotsCountBatched : grindWotsCount)(
      P, pkSeed, wotsAdrs, currentNode,
    );
    const dBig = bytesToBigIntBE(d);

    for (let i = 0; i < SPX_L; i++) {
      const digit = Number((dBig >> BigInt(i * SPX_LOG_W)) & 7n);
      const sk = wotsSk(skSeed, layer, idxTree, idxLeaf, i);
      const sig = wotsChain(pkSeed, layer, idxTree, idxLeaf, i, sk, 0, digit);
      blob.set(sig, off + i * SPX_N);
    }
    writeU32BE(blob, off + WOTS_SIG_LEN, count);

    const leaves =
      layer === 0
        ? bottomLeaves
        : layer === P.d - 1 && idxTree === 0
          ? topLeaves
          : subtreeLeaves(P, skSeed, pkSeed, layer, idxTree);
    const { root, auth } = subtreeRootAuth(P, pkSeed, layer, idxTree, leaves, idxLeaf);
    const authOff = off + WOTS_SIG_LEN + 4;
    for (let h = 0; h < P.subtreeH; h++) {
      blob.set(auth[h], authOff + h * SPX_N);
    }
    currentNode = root;
    off = authOff + P.htTreeAuthLen;
  }
  console.log(
    `[NiceTry sphincs‖] ④ hypertree — ${P.d} layers: WOTS+C grind + signature for 43 ` +
      `chains + Merkle paths (leaves already prepared in ① and ③): ${_ms(_tHt)}ms`,
  );

  // Sanity: the reconstructed top root must equal pkRoot (keygen).
  if (bytes2hex(currentNode) !== bytes2hex(pkRoot)) {
    throw new Error("sphincsSignAsync: internal root mismatch (derivation bug)");
  }

  {
    const totMs = _now() - _tAll;
    /* Rough fixed-phase hash count for the log: FORS forest + top subtree
       (+ bottom when d>1), then the R grind on top. */
    const wotsPerLeaf = SPX_L * SPX_W; // secrets + w-1 chain steps + compress ≈ l·w
    const subtrees = needBottom ? 2 : 1;
    const totHashes =
      (P.k - 1) * P.forsLeaves * 2 +
      subtrees * P.leavesPerSubtree * wotsPerLeaf +
      rTries * 2;
    console.log(
      `[NiceTry sphincs‖] ✅ SIGNATURE COMPLETE ("${P.key}") in ${(totMs / 1000).toFixed(2)}s — ` +
        `≈${(totHashes / 1e6).toFixed(1)}M keccak → ~${Math.round(
          (totMs * 1e6) / totHashes,
        )} effective ns/hash (pool ${W} workers, batch ${
          keccakBatchActive() ? "ON" : "OFF"
        } on the main thread)`,
    );
  }
  return {
    blob,
    sigHex: "0x" + bytes2hex(blob),
    pkSeed,
    pkRoot,
    backupPkSeed,
    backupPkRoot,
    R: R16,
  };
}

/* ── Verify (mirror of SphincsVerifier.verify) ─────────────────────────
   Faithful JS transcription of the on-chain assembly. Used for local
   self-tests; the AUTHORITATIVE check is the deployed contract. Returns
   { valid, reason }. `profile` picks the param set; when omitted it is
   inferred from the signature length (unique per set). */
export function sphincsVerify(pkSeedHex, pkRootHex, message, sigInput, profile) {
  const pkSeedW = typeof pkSeedHex === "string" ? hex2bytes(pkSeedHex) : pkSeedHex;
  const pkRootW = typeof pkRootHex === "string" ? hex2bytes(pkRootHex) : pkRootHex;
  const message32 = asMessage32(message);
  const sig = typeof sigInput === "string" ? hex2bytes(sigInput) : sigInput;

  const P = profile != null ? getSphincsParams(profile) : sphincsParamsBySigLen(sig.length);
  if (!P || sig.length !== P.sigLen)
    return { valid: false, reason: "Invalid sig length" };
  // Non-canonical public key (low 128 bits must be zero).
  for (let k = SPX_N; k < 32; k++) {
    if (pkSeedW[k] !== 0 || pkRootW[k] !== 0)
      return { valid: false, reason: "Invalid public key" };
  }
  const pkSeed = topN(pkSeedW);
  const pkRoot = topN(pkRootW);

  if (P.std) return sphincsVerifyStd(P, pkSeed, pkRoot, message32, sig);

  const read16 = (o) => sig.subarray(o, o + SPX_N);

  const R16 = read16(R_OFF);
  const digest = hMsg(P, pkSeed, pkRoot, R16, message32);
  const { htIdx, fields } = decodeDigest(P, digest);

  if (fields[P.k - 1] !== 0) return { valid: false, reason: "forced-zero" };

  const idxLeaf0 = htIdx & (P.leavesPerSubtree - 1);
  const idxTree0 = htIdx >> P.subtreeH;
  const roots = new Array(P.k);

  for (let i = 0; i < P.k - 1; i++) {
    const treeIdx = fields[i];
    const secret = read16(FORS_SECRETS_OFF + i * SPX_N);
    let node = T(
      pkSeed,
      adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, 0, (i << P.a) | treeIdx),
      word16(secret),
    );
    let pathIdx = treeIdx;
    const authPtr = P.forsAuthOff + i * P.forsAuthPerTree;
    for (let h = 0; h < P.a; h++) {
      const sibling = read16(authPtr + h * SPX_N);
      const parentIdx = pathIdx >> 1;
      const a = adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, h + 1, (i << (P.a - 1 - h)) | parentIdx);
      node =
        pathIdx & 1
          ? T(pkSeed, a, word16(sibling), word16(node))
          : T(pkSeed, a, word16(node), word16(sibling));
      pathIdx = parentIdx;
    }
    roots[i] = node;
  }
  {
    const i = P.k - 1;
    const secret = read16(FORS_SECRETS_OFF + i * SPX_N);
    roots[i] = T(
      pkSeed,
      adrs(0, idxTree0, TYPE_FORS_TREE, idxLeaf0, 0, i << P.a),
      word16(secret),
    );
  }

  let currentNode = forsCompress(pkSeed, idxTree0, idxLeaf0, roots);

  let idxTree = htIdx;
  let off = P.htOff;
  for (let layer = 0; layer < P.d; layer++) {
    const idxLeaf = idxTree & (P.leavesPerSubtree - 1);
    idxTree = idxTree >> P.subtreeH;

    const wotsAdrs = adrs(layer, idxTree, TYPE_WOTS_HASH, idxLeaf, 0, 0);
    const countOff = off + WOTS_SIG_LEN;
    const count =
      (sig[countOff] << 24) |
      (sig[countOff + 1] << 16) |
      (sig[countOff + 2] << 8) |
      sig[countOff + 3];
    const d = keccak256(
      concatBytes(word16(pkSeed), wotsAdrs, word16(currentNode), wordU32Low(count >>> 0)),
    );
    if (wotsDigitSum(d) !== P.targetSum)
      return { valid: false, reason: "digit-sum" };
    const dBig = bytesToBigIntBE(d);

    const ends = new Array(SPX_L);
    for (let i = 0; i < SPX_L; i++) {
      const digit = Number((dBig >> BigInt(i * SPX_LOG_W)) & 7n);
      let val = read16(off + i * SPX_N);
      // verifier hashes (w-1 - digit) more steps from hash_address = digit..6
      val = wotsChain(pkSeed, layer, idxTree, idxLeaf, i, val, digit, SPX_W - 1);
      ends[i] = word16(val);
    }
    const wotsPkNode = T(pkSeed, adrs(layer, idxTree, TYPE_WOTS_PK, idxLeaf, 0, 0), ...ends);

    const authOff = countOff + 4;
    let node = wotsPkNode;
    let mIdx = idxLeaf;
    for (let h = 0; h < P.subtreeH; h++) {
      const sibling = read16(authOff + h * SPX_N);
      const parentIdx = mIdx >> 1;
      const a = adrs(layer, idxTree, TYPE_TREE, 0, h + 1, parentIdx);
      node =
        mIdx & 1
          ? T(pkSeed, a, word16(sibling), word16(node))
          : T(pkSeed, a, word16(node), word16(sibling));
      mIdx = parentIdx;
    }
    currentNode = node;
    off = authOff + P.htTreeAuthLen;
  }

  const valid = bytes2hex(currentNode) === bytes2hex(pkRoot);
  return { valid, reason: valid ? "ok" : "root-mismatch" };
}

export const SPHINCS_SIG_LEN = 6176;
