import { useState, useEffect, useRef } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useOnboardingFlow } from "@/ui/hooks/useOnboardingFlow.js";
import { vaultManager } from "@/vault/VaultManager.js";


import { predictAccountAddress } from "@/blockchain/helpers.js";
import { tree, currentIndex, smartAddr } from "@/ui/store.js";
import { storageSet } from "@/utils/storage.js";

import { OnboardingHeader } from "./OnboardingHeader.jsx";
import { CornerTopLeft, CornerBottomRight } from "./OnboardingCorners.jsx";

const REVEAL_COUNTDOWN_SECS = 5;
const STEP = 2;
const TOTAL_STEPS = 3;


async function precomputeSmartAccount() {
  try {
    const sa = await predictAccountAddress();
    smartAddr.value = sa;
    return sa;
  } catch (e) {
    console.warn("[NiceTry] onboarding SA precompute deferred:", e?.message || e);
    return null;
  }
}

function CardShell({ children }) {
  return (
    <div class="w-full h-full flex flex-col gap-6">
      {/* Topbar: label + step counter + progress bars */}
      <div class="w-full flex flex-col gap-2.5 overflow-hidden">
        <div class="w-full flex items-start justify-between font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-muted uppercase tracking-[0.52px] whitespace-nowrap">
          <p>Seed Phrase</p>
          <p>Step {STEP} of {TOTAL_STEPS}</p>
        </div>
        <div class="w-full flex gap-4">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              class={
                "flex-1 h-2 rounded-full " +
                (i < STEP ? "bg-blue" : "bg-text-primary")
              }
            />
          ))}
        </div>
      </div>

      {/* Vanity wrapper with blue corner triangles (Figma 154:2578 / 154:2629) */}
      <div class="flex-1 bg-text-primary flex flex-col w-full min-h-0 overflow-hidden">
        <CornerTopLeft />
        {/* Scrollable so added content (e.g. the Wallet ID backup box)
            never clips the seed grid in the fixed-height popup. */}
        <div class="flex-1 w-full flex flex-col items-center justify-start px-10 py-5 min-h-0 gap-5 overflow-y-auto">
          {children}
        </div>
        <CornerBottomRight />
      </div>
    </div>
  );
}

function WarningIcon() {
  return (
   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">
<path d="M18.1083 15L11.4416 3.33332C11.2962 3.07682 11.0854 2.86347 10.8307 2.71504C10.576 2.56661 10.2864 2.4884 9.99161 2.4884C9.69678 2.4884 9.40724 2.56661 9.1525 2.71504C8.89777 2.86347 8.68697 3.07682 8.54161 3.33332L1.87494 15C1.72801 15.2544 1.65096 15.5432 1.65162 15.8371C1.65227 16.1309 1.73059 16.4194 1.87865 16.6732C2.0267 16.927 2.23923 17.1371 2.49469 17.2823C2.75014 17.4275 3.03945 17.5026 3.33327 17.5H16.6666C16.959 17.4997 17.2462 17.4225 17.4993 17.2761C17.7525 17.1297 17.9626 16.9192 18.1087 16.6659C18.2548 16.4126 18.3316 16.1253 18.3316 15.8329C18.3315 15.5405 18.2545 15.2532 18.1083 15Z" stroke="var(--color-red)" stroke-width="1.66667" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M10 7.5V10.8333" stroke="var(--color-red)" stroke-width="1.66667" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M10 14.167H10.0083" stroke="var(--color-red)" stroke-width="1.66667" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
  );
}

export function ShowSeed() {
  const [, navigate] = useLocation();
  const flow = useOnboardingFlow();

  const [revealed, setRevealed] = useState(!!flow.phrase); // already revealed if returning
  const [loading, setLoading] = useState(!flow.phrase);
  const [error, setError] = useState("");
  const [finalizing, setFinalizing] = useState(false);
  const [countdown, setCountdown] = useState(REVEAL_COUNTDOWN_SECS);
  const mounted = useRef(false);
  const saPrecompute = useRef(null); // Promise<saAddress|null>

  /* ── Create vault on first mount, if not already done ────────── */
  useEffect(() => {
    // StrictMode would fire this twice in dev; guard with a ref.
    if (mounted.current) return;
    mounted.current = true;

    // Pin the active chain to the onboarding flow's chain (default
    // Sepolia) so the background SA computation targets the right chain.
    globalThis.__NT_CHAIN_ID = flow.chainId;

    const kickoffPrecompute = () => {
      if (!saPrecompute.current) saPrecompute.current = precomputeSmartAccount();
    };

    if (flow.phrase) {
      // Returning to this screen — the vault already exists.
      setLoading(false);
      kickoffPrecompute();
      return;
    }

    if (!flow.password) {
      // User arrived here without setting a password (manually typed URL?)
      navigate("/create/password");
      return;
    }

    (async () => {
      try {
        // In-memory only — the vault is committed to disk in finalize()
        // when the user confirms the backup. Refreshing before that point
        // loses the in-memory mnemonic and restarts the flow, instead of
        // leaving a half-configured vault on disk.
        const mnemonic = await vaultManager.createNewVault(flow.password, {
          persist: false,
        });
        flow.phrase = mnemonic;

        // Hydrate the global signals as the legacy flow does.
        const root = vaultManager.getHdKeyring().getRoot();
        currentIndex.value = 0;

        // Tell the background the session has started (keeps the
        // auto-lock timer fresh).
        chrome.runtime.sendMessage({ type: "SESSION_START" }).catch?.(() => {});

        setLoading(false);

        // Start the SA / Merkle computation now so it's ready by the time
        // the seed countdown ends — there's no chain-selection step.
        kickoffPrecompute();
      } catch (e) {
        setError(e.message || String(e));
        setLoading(false);
      }
    })();
  }, []);

  /* ── Countdown when revealed ─────────────────────────────────── */
  useEffect(() => {
    if (!revealed) return;
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [revealed, countdown]);

  async function finalize() {
    if (finalizing) return;
    setFinalizing(true);
    setError("");
    try {
      const cid = flow.chainId; // Daisugi is the only configured chain.
      globalThis.__NT_CHAIN_ID = cid;
      // Pin the signing profile and chain for the wallet and background.
      await storageSet("nt_chainId", cid);

      let sa = null;
      try {
        sa = await (saPrecompute.current || precomputeSmartAccount());
      } catch {}

      if (sa) {
        // setSmartAccountAddress persists the vault + mirrors the SA.
        await vaultManager.setSmartAccountAddress(sa, cid);
      } else {
        // Commit the vault even if the SA couldn't be predicted (offline)
        // — the dashboard resolves + persists it on first unlock.
        await vaultManager.persist();
      }
      currentIndex.value = 0;

      flow.smartAddress = sa || "";
      navigate("/create/done");
    } catch (e) {
      setError(e?.message || String(e));
      setFinalizing(false);
    }
  }

  const words = flow.phrase ? flow.phrase.trim().split(/\s+/) : [];
  const seedRows = Math.ceil(words.length / 3) || 4;

  if (error) {
    return (
      <CardShell>
        <div class="flex-1 w-full flex flex-col items-center justify-center gap-4 text-center">
          <h1 class="font-['Poppins'] font-bold text-[25px] leading-[1.2] text-red">
            Vault creation failed
          </h1>
          <p class="font-['Poppins'] text-[13px] leading-[1.6] text-text-dim">{error}</p>
          <div class="w-full border-2 border-blue p-1.5 transition-colors duration-150 has-[button:hover:not(:disabled)]:border-blue-hover has-[:disabled]:opacity-50">
            <button
              type="button"
              onClick={() => navigate("/create/password")}
              class="w-full bg-blue flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-pointer transition-colors duration-150 hover:bg-primary-600 disabled:hover:bg-blue disabled:cursor-not-allowed"
            >
              Back
            </button>
          </div>
        </div>
      </CardShell>
    );
  }

  if (loading) {
    return (
      <CardShell>
        <div class="flex-1 w-full flex items-center justify-center font-['Poppins'] text-[13px] text-text-dim">
          Creating vault…
        </div>
      </CardShell>
    );
  }

  /* Before the reveal the CTA is the second way to unhide the phrase (the
     other is the overlay on the grid), so it must stay enabled — otherwise
     it reads "Reveal and Backup" while refusing the click. */
  const buttonDisabled = revealed && (countdown > 0 || finalizing);
  const buttonText = !revealed
    ? "Reveal and Backup"
    : finalizing
      ? "Finalizing…"
      : countdown > 0
        ? `Please wait (${countdown}s)`
        : "Backup Seed Phrase";

  return (
    <CardShell>
      {/* Header: logo + title + subtitle (shared OnboardingHeader) */}
      <OnboardingHeader
        title="Backup Seed Phrase"

      />

      {/* Warning banner */}
      <div class="w-full bg-red/10 border border-red rounded-lg flex gap-3 items-center p-[13px]">
        <div class="size-5 shrink-0">
          <WarningIcon />
        </div>
        <div class="flex-1 min-w-0 flex flex-col gap-1 text-red text-[13px] leading-[1.6] font-['Poppins']">
          <p class="font-bold">Never share this phrase</p>
          <p>
            Anyone with this phrase controls your wallet and all funds.
            For security, manual transcription is required.
          </p>
        </div>
      </div>

      {/* Seed grid (with click-to-reveal overlay when hidden) */}
      <div class="relative w-full border border-blue rounded-[12px] overflow-hidden">
        <div class="w-full flex flex-col gap-2.5 p-5">
          {Array.from({ length: seedRows }).map((_, row) => (
            <div key={row} class="w-full flex items-center justify-between">
              {Array.from({ length: 3 }).map((_, col) => {
                const i = row * 3 + col;
                const word = words[i] || "";
                return (
                  <div
                    key={col}
                    class="flex-1 min-w-0 flex items-center justify-center gap-2"
                  >
                    <p class="w-5 font-['Poppins'] text-[13px] leading-[1.2] text-border">
                      {i + 1}.
                    </p>
                    <p class="flex-1 min-w-0 font-['Poppins'] text-[13px] leading-[1.2] text-blue">
                      {word}
                    </p>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {!revealed && (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            class="absolute -inset-px backdrop-blur-[7px] bg-bg-card/70 flex items-center justify-center font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-pointer"
          >
            Click To Reveal
          </button>
        )}
      </div>

      {/* CTA */}
      <div class="w-full border-2 border-blue p-1.5 transition-colors duration-150 has-[button:hover:not(:disabled)]:border-blue-hover has-[:disabled]:opacity-50">
        <button
          type="button"
          disabled={buttonDisabled}
          onClick={revealed ? finalize : () => setRevealed(true)}
          class="w-full bg-blue flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-pointer transition-colors duration-150 hover:bg-primary-600 disabled:hover:bg-blue disabled:cursor-not-allowed"
        >
          {buttonText}
        </button>
      </div>
    </CardShell>
  );
}
