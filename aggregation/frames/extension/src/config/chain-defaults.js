/* ═══════════════════════════════════════════════════════════════════
   chain-defaults.js — viem-free chain defaults
   ───────────────────────────────────────────────────────────────────
   This module deliberately avoids importing from viem so it can be
   pulled into bundles where viem is unwanted (the inpage provider
   that runs inside dApp pages, where every byte counts).

   `networks.js` is the SINGLE SOURCE OF TRUTH for everything else
   (factories, RPCs, explorers). It re-exports the
   constants from this file so the chain-id default is defined ONCE.
   ═══════════════════════════════════════════════════════════════════ */

import native from '../native-frame/native-deployment.json';

/** The build's only network: the one an active native profile pins. A build without one (tests, the dev server) has
    no network, chain ID 0, and offers no account. */
const identity = native.active ? native : { chainId: 0, genesisHash: null };
export const NETWORK_IDENTITY = Object.freeze({ chainId: identity.chainId, genesisHash: identity.genesisHash });
/** Native frame accounts exist only where a verified native profile pins this network. */
export const NATIVE_AVAILABLE = native.active === true;

/** Hex chainId used when no chain has been picked yet (or when the
    user hasn't completed onboarding). Update this single value to
    change the default chain everywhere — popup boot, background SW
    boot, dApp-injected provider boot. */
export const DEFAULT_CHAIN_ID = "0x" + NETWORK_IDENTITY.chainId.toString(16);
