// Experimental single-profile sphincs-g. Preserve the upstream key domain.
// "ledger" is an internal protocol key, not a claim of hardware protection.
export const SPX_N = 16;
export const SPX_W = 16;
export const SPX_LOG_W = 4;
export const SPX_L = 35;
export const WOTS_SIG_LEN = 560;
const domain = "ledger_prepared_16_20";
const P = Object.freeze({
  key: "ledger", domain, domainBytes: new TextEncoder().encode(domain),
  std: true, compactHmsg: true, q: null,
  h: 20, d: 5, subtreeH: 4, a: 9, k: 19, w: 16, logW: 4, l: 35, m: 24,
  leavesPerSubtree: 16, forsLeaves: 512,
  forsOff: 16, forsPerTree: 160, htOff: 3056,
  wotsSigLen: 560, htTreeAuthLen: 64, htLayerLen: 624, sigLen: 6176,
  preparedSlotCapacity: 16, signTimeoutMs: 120000,
});
export const SPHINCS_PARAM_SETS = Object.freeze({ ledger: P });
export const DEFAULT_SPHINCS_PARAM_KEY = "ledger";
export const SPHINCS_PROFILE_ORDER = Object.freeze(["ledger"]);
export function getSphincsParams(profile) {
  if (profile == null || profile === "ledger" || profile === "sphincs-g" || profile === P) return P;
  throw new Error("This test build supports only sphincs-g (compact H_msg).");
}
export function sphincsParamsBySigLen(len) { return len === P.sigLen ? P : null; }
