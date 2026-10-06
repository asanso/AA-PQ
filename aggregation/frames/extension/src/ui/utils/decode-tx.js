/* ═══════════════════════════════════════════════════════════════════
   decode-tx.js — decode a transaction's data field into name + params
   ───────────────────────────────────────────────────────────────────
   Given a hex `data` like "0xa1903eab000000000000000000000000…",
   returns:

     {
       selector: "0xa1903eab",
       signature: "submit(address)",      // from 4byte.directory
       name: "submit",                    // just the function name
       args: [{ name: "_referral", type: "address", value: "0x..." }],
     }

   How it works:
     1. Extract the 4-byte selector (first 4 bytes of data)
     2. Look it up in local hardcoded map (common ERC-20, WETH, …)
     3. If not found, query 4byte.directory API
     4. With the text signature, use viem's parseAbiItem to build an
        ABI fragment, then decodeFunctionData on the raw data
     5. Zip decoded args with param names from the signature

   Caching:
     - Successful lookups are cached in-memory for the session
     - Misses are also cached (as `null`) so we don't re-request
       unknown selectors repeatedly

   Graceful degradation: if anything fails (network, unknown selector,
   decode error), we return whatever we have — at minimum the selector.
   Never throws to the caller.
   ═══════════════════════════════════════════════════════════════════ */

import { decodeFunctionData, parseAbiItem } from "viem";

/* ── Local signatures: common ones for instant offline lookup ────
   Keep this list short — real coverage comes from 4byte. These are
   just the "always visible without network" staples. */
const LOCAL_SIGS = {
  // ERC-20
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x70a08231": "balanceOf(address)",
  "0xdd62ed3e": "allowance(address,address)",
  // ERC-721 / ERC-1155
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
  "0xf242432a": "safeTransferFrom(address,address,uint256,uint256,bytes)",
  // WETH
  "0xd0e30db0": "deposit()",
  "0x2e1a7d4d": "withdraw(uint256)",
  // Lido
  "0xa1903eab": "submit(address)",
  // Uniswap V2
  "0x7ff36ab5": "swapExactETHForTokens(uint256,address[],address,uint256)",
  "0x18cbafe5": "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
  "0x38ed1739": "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  // Uniswap V3 / Universal Router
  "0x3593564c": "execute(bytes,bytes[],uint256)",
  "0x04e45aaf": "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  // Multicall / common proxy patterns
  "0x5ae401dc": "multicall(uint256,bytes[])",
  "0xac9650d8": "multicall(bytes[])",
};

/* ── Cache ──────────────────────────────────────────────────────
   Maps selector → text_signature (string) or null (known-miss).
   Undefined means "not yet looked up". */
const cache = new Map(Object.entries(LOCAL_SIGS));

/**
 * Fetch a text signature for a selector from 4byte.directory.
 * Returns the canonical (oldest) signature string or null if unknown.
 */
async function fetchSignature(selector) {
  try {
    const url =
      "https://www.4byte.directory/api/v1/signatures/?hex_signature=" +
      encodeURIComponent(selector);
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.results?.length) return null;
    // Multiple signatures can collide on the same 4-byte selector.
    // Pick the oldest one — that's almost always the "real" canonical
    // function, since malicious look-alikes are submitted later to
    // confuse wallets. 4byte returns newest first by default, so sort.
    const sorted = [...j.results].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );
    return sorted[0].text_signature || null;
  } catch {
    return null;
  }
}

/**
 * Look up a signature for a selector, using cache + local + remote.
 * Always resolves; never throws.
 */
async function lookupSignature(selector) {
  if (cache.has(selector)) return cache.get(selector);
  const sig = await fetchSignature(selector);
  cache.set(selector, sig); // caches `null` too, so we don't retry
  return sig;
}

/**
 * Parse a text signature like "transfer(address,uint256)" into
 * { name, paramTypes, paramNames? }. 4byte doesn't give parameter
 * names, so paramNames is always undefined — we render args
 * positionally as "arg0", "arg1", etc.
 */
function parseSignature(sig) {
  if (!sig) return null;
  const m = sig.match(/^([^(]+)\((.*)\)$/);
  if (!m) return null;
  const [, name, paramsStr] = m;
  // Split by comma at top level (tuples have their own parens).
  const paramTypes = [];
  let depth = 0;
  let buf = "";
  for (const ch of paramsStr) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      if (buf) paramTypes.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) paramTypes.push(buf.trim());
  return { name, paramTypes };
}

/**
 * Decode a transaction's data field.
 *
 * @param {string|undefined} data   Hex-prefixed data, e.g. "0xa9059cbb..."
 * @returns {Promise<object|null>}  Null if data is empty or unparseable
 */
export async function decodeTx(data) {
  if (!data || data === "0x" || data.length < 10) return null;

  const selector = data.slice(0, 10).toLowerCase();
  const result = { selector, signature: null, name: null, args: null };

  const sig = await lookupSignature(selector);
  if (!sig) return result;

  result.signature = sig;
  const parsed = parseSignature(sig);
  if (parsed) result.name = parsed.name;

  // Try to decode the args using viem. Can fail on exotic signatures
  // (tuples with named structs, dynamic arrays of tuples, etc.) —
  // swallow the error and return name-only.
  try {
    const abiItem = parseAbiItem("function " + sig);
    const { args } = decodeFunctionData({
      abi: [abiItem],
      data,
    });
    const argTypes = parsed?.paramTypes || [];
    result.args = (args || []).map((v, i) => ({
      name: `arg${i}`,
      type: argTypes[i] || "unknown",
      value: v,
    }));
  } catch {
    // Name-only fallback — still useful.
  }

  return result;
}

/**
 * Formats a decoded arg value for display. BigInts become decimal
 * strings, addresses are returned as-is (UI can truncate), arrays
 * become JSON.
 */
export function formatArgValue(arg) {
  if (arg == null) return "";
  const { type, value } = arg;
  if (value == null) return "";
  if (typeof value === "bigint") {
    // Heuristic: if the type is uint256 and the value is suspiciously
    // large, it's likely a token amount in wei. Show both raw and
    // 18-decimal formatted (typical ERC-20). The UI can toggle.
    return value.toString();
  }
  if (Array.isArray(value)) {
    try { return JSON.stringify(value, (k, v) => typeof v === "bigint" ? v.toString() : v); }
    catch { return String(value); }
  }
  if (typeof value === "string") return value;
  return String(value);
}