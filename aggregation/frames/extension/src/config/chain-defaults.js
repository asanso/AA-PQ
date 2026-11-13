/* ═══════════════════════════════════════════════════════════════════
   chain-defaults.js — viem-free chain defaults
   ───────────────────────────────────────────────────────────────────
   This module deliberately avoids importing from viem so it can be
   pulled into bundles where viem is unwanted (the inpage provider
   that runs inside dApp pages, where every byte counts).

   `networks.js` is the SINGLE SOURCE OF TRUTH for everything else
   (factories, RPCs, bundlers, explorers). It re-exports the
   constants from this file so the chain-id default is defined ONCE.
   ═══════════════════════════════════════════════════════════════════ */

import frame from '../aggregated-frame/deployment.json';
import aa from '../erc4337/network.json';

/** The build's only network. An active aggregated-frame profile selects it;
    otherwise it is Daisugi, chain 1337, as pinned by the ERC-4337 profile. */
const identity = frame.active ? frame : aa;
export const NETWORK_IDENTITY = Object.freeze({ chainId: identity.chainId, genesisHash: identity.genesisHash });
/** The ERC-4337 contracts are pinned to Daisugi; another network has none. */
export const ERC4337_AVAILABLE = aa.chainId === identity.chainId && aa.genesisHash === identity.genesisHash;

/** Hex chainId used when no chain has been picked yet (or when the
    user hasn't completed onboarding). Update this single value to
    change the default chain everywhere — popup boot, background SW
    boot, dApp-injected provider boot. */
export const DEFAULT_CHAIN_ID = "0x" + NETWORK_IDENTITY.chainId.toString(16);
