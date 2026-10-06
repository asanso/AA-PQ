/* ═══════════════════════════════════════════════════════════════════
   EditNetwork — /network-edit/:chainId page
   ───────────────────────────────────────────────────────────────────
   Reached from the ⋮ menu on a row in NetworkSwitcher. Lets the user, per
   chain:
     - rename the chain (display label only — stored in nt_customChainNames,
       applied everywhere via getNetwork's withOverrides)
     - set a custom RPC endpoint (stored in nt_customRpc; replaces the built-in endpoint)

   Confirm validates the RPC (format → live eth_chainId test via the
   background, CORS-exempt → chainId must match this network) before
   persisting, then bumps chainOverridesVersion so the rename/endpoint take
   effect live, and returns to /network. Cancel discards.

   This is a full route (SubPageShell), NOT a modal — mirrors the other
   dashboard sub-screens. Cancel/Confirm live in the pinned footer.
   ═══════════════════════════════════════════════════════════════════ */

import { useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import {
  getNetwork,
  getCanonicalNetworkName,
  getCustomRpc,
  setCustomRpc,
  getCustomChainName,
  setCustomChainName,
} from "@/config/networks.js";
import { resetPublicClient } from "@/blockchain/client.js";
import { chainOverridesVersion } from "@/ui/store.js";
import { SubPageShell, SectionLabel } from "./SubPageShell.jsx";

function EditGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

const inputClass =
  "w-full px-3 py-2.5 rounded-[8px] bg-bg-hover border border-border " +
  "text-text-primary type-body-md placeholder:text-text-muted outline-none " +
  "focus:border-blue";

export function EditNetwork({ params }) {
  const [, navigate] = useLocation();
  const chainIdHex = params?.chainId;
  const net = getNetwork(chainIdHex);
  const canonical = getCanonicalNetworkName(chainIdHex);
  const defaultRpc = net?.rpcUrl || "";

  const storedRpc = getCustomRpc(chainIdHex) || "";
  const storedName = getCustomChainName(chainIdHex) || "";

  const [name, setName] = useState(storedName || canonical || "");
  const [rpc, setRpc] = useState(storedRpc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const goBack = () => navigate("/network");

  async function confirm() {
    if (busy) return;
    setError(null);
    const nameVal = name.trim();
    const rpcVal = rpc.trim();

    // Cheap format checks up front (before any network round-trip).
    if (rpcVal && !/^https?:\/\//i.test(rpcVal)) {
      setError("RPC URL must start with http:// or https://");
      return;
    }

    setBusy(true);
    try {
      // Validate a NEW custom RPC before committing — a bad endpoint
      // shouldn't be saved. Only test when it actually changed.
      if (rpcVal && rpcVal !== storedRpc) {
        const res = await chrome.runtime.sendMessage({
          type: "TEST_RPC_URL",
          url: rpcVal,
        });
        if (!res?.ok) {
          setError(`Couldn't reach that RPC: ${res?.error || "unknown error"}`);
          setBusy(false);
          return;
        }
        const got = parseInt(res.chainId, 16);
        const want = net?.networkId;
        if (Number.isFinite(want) && got !== want) {
          setError(
            `That RPC serves chain ${got}, but this network is ${want} (${canonical}).`,
          );
          setBusy(false);
          return;
        }
      }

      // Persist endpoints (empty → clear → back to defaults) and rebuild
      // the memoized clients so the changes take effect immediately.
      await setCustomRpc(chainIdHex, rpcVal || null);
      resetPublicClient(chainIdHex);

      // Persist name (the setter clears it when empty or equal to the
      // canonical name).
      await setCustomChainName(chainIdHex, nameVal);

      // Re-resolve chain metadata everywhere without a chain switch.
      chainOverridesVersion.value++;

      goBack();
    } catch (e) {
      setError(e?.message || "Failed to save.");
      setBusy(false);
    }
  }

  const footer = (
    <div class="flex gap-2">
      <button
        type="button"
        onClick={goBack}
        disabled={busy}
        class="flex-1 py-2.5 rounded-[8px] bg-bg-hover border border-border text-text-muted type-label-button cursor-pointer hover:text-text-primary transition-colors duration-150 disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={confirm}
        disabled={busy}
        class="flex-1 py-2.5 rounded-[8px] bg-blue text-primary-50 type-label-button cursor-pointer hover:brightness-110 transition-[filter] duration-150 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Confirm"}
      </button>
    </div>
  );

  if (!net) {
    return (
      <SubPageShell icon={<EditGlyph />} title="Edit network" onBack={goBack}>
        <div class="w-full px-4 pb-4 pt-6">
          <p class="type-body-md text-error-400">Unknown network.</p>
        </div>
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      icon={<EditGlyph />}
      title="Edit network"
      subtitle={canonical || chainIdHex}
      onBack={goBack}
      backDisabled={busy}
      footer={footer}
    >
      <div class="w-full px-4 pb-4 flex flex-col">
        {/* ── Chain name ─────────────────────────────────────────── */}
        <SectionLabel>chain name</SectionLabel>
        <input
          type="text"
          spellcheck={false}
          placeholder={canonical || "Network name"}
          value={name}
          onInput={(e) => { setName(e.currentTarget.value); setError(null); }}
          class={inputClass}
        />
        <p class="type-label-caption text-text-muted mt-1.5 pl-1">
          Display label only. Leave as “{canonical}” to keep the default.
        </p>

        {/* ── RPC endpoint ───────────────────────────────────────── */}
        <SectionLabel>rpc endpoint</SectionLabel>
        <input
          type="url"
          inputMode="url"
          spellcheck={false}
          placeholder={defaultRpc || "https://your-node.example/rpc"}
          value={rpc}
          onInput={(e) => { setRpc(e.currentTarget.value); setError(null); }}
          class={inputClass}
        />
        <div class="flex items-start gap-2 mt-1.5">
          <p class="flex-1 type-label-caption text-text-muted pl-1 break-all">
            Used for all network requests. Leave empty to use the local development RPC.
          </p>
          <button
            type="button"
            onClick={() => { setRpc(""); setError(null); }}
            disabled={busy || !rpc.trim()}
            class="shrink-0 type-label-caption text-blue-hover cursor-pointer hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-default"
          >
            Use default
          </button>
        </div>

        {error && (
          <p class="type-body-md text-error-400 mt-3 break-all">{error}</p>
        )}
      </div>
    </SubPageShell>
  );
}
