import { vaultManager } from "@/vault/VaultManager.js";

import { getSmartAccountAddress } from "@/blockchain/helpers.js";

import { refreshBalances } from "./useBalance.js";
import {
  accounts as accountsSignal,
  activeAccountIndex as activeAccountIndexSignal,
  currentIndex,
  smartAddr,
  tree,
  chainId,
} from "@/ui/store.js";

/* Refresh the reactive account list + active index from the vault. Call
   after unlock and after any create/switch/rename. */
export function refreshAccountsSignal() {
  try {
    accountsSignal.value = vaultManager.getAccountList();
    activeAccountIndexSignal.value = vaultManager.getActiveAccountIndex();
  } catch {
    /* vault locked — leave defaults */
  }
}

/* Re-point the active-account view signals at `index`. Pure local
   hydration first (instant), then a background SA resolution for fresh
   accounts that have never been deployed/cached. */
export async function hydrateActiveAccount(index) {
  const account=index ?? vaultManager.getActiveAccountIndex();
  smartAddr.value='';
  const sa=await getSmartAccountAddress(account);
  if(vaultManager.isUnlocked() && vaultManager.getActiveAccountIndex()===account) {
    smartAddr.value=sa;refreshAccountsSignal();refreshBalances().catch(()=>{});
  }
  return sa;
}

export function useAccounts() {
  return {
    get list() {
      return accountsSignal.value;
    },
    get activeIndex() {
      return activeAccountIndexSignal.value;
    },

    /* Create a new account from the same seed and switch to it. */
    async create(name) {
      const { index } = await vaultManager.addAccount(name);
      refreshAccountsSignal();
      await this.switch(index);
      return index;
    },

    /* Switch the active account. */
    async switch(index) {
      if (index === vaultManager.getActiveAccountIndex()) {
        refreshAccountsSignal();
        return index;
      }
      await vaultManager.setActiveAccount(index); // persists + re-mirrors SA
      activeAccountIndexSignal.value = index;
      await hydrateActiveAccount(index);
      refreshAccountsSignal();
      // Balance isn't reactive to smartAddr; refresh it for the new SA.
      refreshBalances().catch(() => {});

      /* Tell the background the active account changed so the dApp
         provider reports the new smart account. The clear-text mirror
         is already updated by setActiveAccount → _persistVault. */
      try {
        chrome.runtime.sendMessage({
          type: "ACTIVE_ACCOUNT_CHANGED",
          account: smartAddr.value || null,
        });
      } catch {}
      return index;
    },

    async rename(index, name) {
      await vaultManager.renameAccount(index, name);
      refreshAccountsSignal();
    },

    /* Hide an account from the list (keys stay derivable). If it's the
       active account, switch to another visible account first so the
       dashboard never points at a hidden account. */
    async hide(index) {
      if (index === vaultManager.getActiveAccountIndex()) {
        const other = vaultManager
          .getAccountList()
          .find((a) => a.index !== index && !a.hidden);
        if (!other) throw new Error("Cannot hide the only visible account");
        await this.switch(other.index);
      }
      await vaultManager.setAccountHidden(index, true);
      refreshAccountsSignal();
    },

    async unhide(index) {
      await vaultManager.setAccountHidden(index, false);
      refreshAccountsSignal();
    },

    async setPinned(index, pinned) {
      await vaultManager.setAccountPinned(index, pinned);
      refreshAccountsSignal();
    },

    /* Drop an imported / pending account. If it was the active one
       the vault picks a sensible fallback; we then re-hydrate so the
       Dashboard doesn't point at a missing slot. */
  };
}
