import { computed } from "@preact/signals";
import {
  chainId,
  activeAccountIndex as activeAccountIndexSignal,
  chainOverridesVersion,
} from "@/ui/store.js";
import { getNetwork, NETWORKS, listVisibleNetworks } from "@/config/networks.js";
import { storageSet } from "@/utils/storage.js";
import { hydrateActiveAccount, refreshAccountsSignal } from "./useAccounts.js";
import { refreshBalances } from "./useBalance.js";
import { vaultManager } from "@/vault/VaultManager.js";

const network = computed(() => {
  // Subscribe to override bumps so a rename / custom-RPC change re-resolves
  // the active network metadata without a chain switch.
  chainOverridesVersion.value;
  return getNetwork(chainId.value);
});

export function useNetwork() {
  return { get chainId(){return chainId.value;},network,all:NETWORKS,get list(){return listVisibleNetworks();},
    async switchChain(id){ if(!NETWORKS[id])throw Error('Only Daisugi is supported.'); return id; },
    setChain(id){if(!NETWORKS[id])throw Error('Only Daisugi is supported.');chainId.value=id;globalThis.__NT_CHAIN_ID=id;}
  };
}
