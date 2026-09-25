/* ═══════════════════════════════════════════════════════════════════
   useOnboardingFlow — in-memory state shared between onboarding steps
   ───────────────────────────────────────────────────────────────────
   The onboarding has several screens that need to share data:

     password      — typed in CreatePassword, used by ShowSeed to actually
                     call vaultManager.createNewVault
     phrase        — returned by createNewVault, shown in ShowSeed
     smartAddress  — filled after deploy, shown in FinalStep

   Kept in module-scope signals rather than the main store because:
     - This data lives only during onboarding; it's not worth polluting
       the global store with it
     - It's security-sensitive (password + phrase in plaintext): we want
       a single point where we `reset()` everything at flow completion
     - wouter's navigation doesn't pass props between routes by default

   IMPORTANT: `reset()` is called automatically when the user reaches the
   final step (FinalStep.onComplete). It zeros out password and phrase
   from memory. If the user aborts mid-flow by closing the tab, the
   page unloads and JS memory is freed anyway.
   ═══════════════════════════════════════════════════════════════════ */

import { signal } from "@preact/signals";
import { DEFAULT_CHAIN_ID } from "@/config/networks.js";

const password = signal("");
const phrase = signal("");
const chainId = signal(DEFAULT_CHAIN_ID);
const smartAddress = signal("");
// "create" | "import" — which branch are we in
const branch = signal("create");

export function useOnboardingFlow() {
  return {
    get password()     { return password.value; },
    set password(v)    { password.value = v; },
    get phrase()       { return phrase.value; },
    set phrase(v)      { phrase.value = v; },
    get chainId()      { return chainId.value; },
    set chainId(v)     { chainId.value = v; },
    get smartAddress() { return smartAddress.value; },
    set smartAddress(v){ smartAddress.value = v; },
    get branch()       { return branch.value; },
    set branch(v)      { branch.value = v; },

    /** Zero sensitive data. Called at end of flow. */
    reset() {
      password.value = "";
      phrase.value = "";
      chainId.value = DEFAULT_CHAIN_ID;
      smartAddress.value = "";
      branch.value = "create";
    },
  };
}
