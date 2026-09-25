import { getSmartAccountAddress } from '@/blockchain/helpers.js';
import { useEffect, useState, useRef } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useOnboardingFlow } from "@/ui/hooks/useOnboardingFlow.js";
import { vaultManager } from "@/vault/VaultManager.js";








import { storageSet } from "@/utils/storage.js";
import { truncateAddress } from "@/utils/format.js";

import { tree, currentIndex, smartAddr, mode as modeSignal } from "@/ui/store.js";
import { OnboardingHeader } from "./OnboardingHeader.jsx";
import { CornerTopLeft, CornerBottomRight } from "./OnboardingCorners.jsx";

const STEP = 3;
const TOTAL_STEPS = 4;


const NONCE_WINDOW = 10;

function CardShell({ children }) {
  return (
    <div class="w-full h-full flex flex-col gap-6">
      <div class="w-full flex flex-col gap-2.5 overflow-hidden">
        <div class="w-full flex items-start justify-between font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-muted uppercase tracking-[0.52px] whitespace-nowrap">
          <p>Recovering</p>
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

      <div class="flex-1 bg-text-primary flex flex-col w-full min-h-0 overflow-hidden">
        <CornerTopLeft />
        <div class="flex-1 w-full flex flex-col items-center justify-between px-10 py-5 min-h-0 gap-5">
          {children}
        </div>
        <CornerBottomRight />
      </div>
    </div>
  );
}

/* Loading badge (Figma 536:1768) — an 80px Primary/20 disc holding a
   48px spinning arc. */
function Spinner() {
  return (
    <div class="size-20 rounded-full bg-blue/20 flex items-center justify-center shrink-0">
      <svg
        class="size-12"
        viewBox="0 0 24 24"
        fill="none"
        style={{ animation: "nt-spin 1s linear infinite" }}
      >
        <path
          d="M12 3a9 9 0 1 0 9 9"
          stroke="var(--color-blue)"
          stroke-width="3"
          stroke-linecap="round"
        />
      </svg>
    </div>
  );
}

function CheckCircleIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="46" height="46" viewBox="0 0 46 46" fill="none">
      <path d="M41.5262 19.0479C42.3961 23.3171 41.7761 27.7554 39.7697 31.6228C37.7633 35.4901 34.4917 38.5528 30.5005 40.3C26.5093 42.0471 22.0398 42.3732 17.8372 41.2239C13.6347 40.0745 9.95321 37.5192 7.40671 33.984C4.8602 30.4488 3.60261 26.1474 3.84364 21.7972C4.08467 17.447 5.80976 13.311 8.73123 10.0787C11.6527 6.84651 15.594 4.71351 19.8977 4.03546C24.2015 3.35741 28.6077 4.17528 32.3814 6.35269" stroke="var(--color-blue)" stroke-width="4.7619" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M17.1436 20.9528L22.8578 26.6671L41.9055 7.61951" stroke="var(--color-blue)" stroke-width="4.7619" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="46" height="46" viewBox="0 0 20 20" fill="none">
      <path d="M18.1083 15L11.4416 3.33332C11.2962 3.07682 11.0854 2.86347 10.8307 2.71504C10.576 2.56661 10.2864 2.4884 9.99161 2.4884C9.69678 2.4884 9.40724 2.56661 9.1525 2.71504C8.89777 2.86347 8.68697 3.07682 8.54161 3.33332L1.87494 15C1.72801 15.2544 1.65096 15.5432 1.65162 15.8371C1.65227 16.1309 1.73059 16.4194 1.87865 16.6732C2.0267 16.927 2.23923 17.1371 2.49469 17.2823C2.75014 17.4275 3.03945 17.5026 3.33327 17.5H16.6666C16.959 17.4997 17.2462 17.4225 17.4993 17.2761C17.7525 17.1297 17.9626 16.9192 18.1087 16.6659C18.2548 16.4126 18.3316 16.1253 18.3316 15.8329C18.3315 15.5405 18.2545 15.2532 18.1083 15Z" stroke="var(--color-red)" stroke-width="1.66667" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M10 7.5V10.8333" stroke="var(--color-red)" stroke-width="1.66667" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M10 14.167H10.0083" stroke="var(--color-red)" stroke-width="1.66667" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  );
}

export function ImportScanning() {
  const [, navigate] = useLocation();
  const flow = useOnboardingFlow();

  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const started = useRef(false);

  /* Progress is logged to the console only — the on-screen step log was
     removed in favour of the clean finalize card (Figma 536:1752). The
     second `type` argument is kept so existing call sites stay valid. */
  function addStep(msg) {
    console.debug("[recovery]", msg);
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!flow.password || !flow.phrase) {
      navigate("/import/seed");
      return;
    }

    (async () => {
      try {
        globalThis.__NT_CHAIN_ID=flow.chainId;
        await storageSet('nt_chainId',flow.chainId);
        await vaultManager.restoreVault(flow.password,flow.phrase);
        setRecovering(true);
        const address=await getSmartAccountAddress();
        smartAddr.value=address;flow.smartAddress=address;setDone(true);
      } catch (e) {
        addStep(`Error: ${e.message || String(e)}`, "err");
        setError(e.message || String(e));
      }
    })();
  }, []);

  const headerIcon = error ? (
    <div class="size-20 rounded-full bg-red/15 flex items-center justify-center shrink-0">
      <WarningIcon />
    </div>
  ) : done ? (
    <div class="size-20 rounded-full bg-blue/40 flex items-center justify-center shrink-0">
      <CheckCircleIcon />
    </div>
  ) : (
    <Spinner />
  );

  const headerTitle = error
    ? "Recovery Failed"
    : done
      ? "Recovery Complete"
      : "Recovering Wallet";

  const headerSubtitle = error
    ? "We could not restore this wallet. Check the log below."
    : done
      ? "Your wallet has been restored from the seed phrase."
      : recovering
        ? "Deriving your SPHINCS-G account…"
        : "Restoring your SPHINCS-G account…";

  return (
    <div class="w-full h-full flex flex-col">
      <style>{`@keyframes nt-spin { to { transform: rotate(360deg); } }`}</style>

      <CardShell>
        {/* Spinner + title + subtitle, vertically centred in the card
            (Figma 536:1767). The verbose step log was removed. */}
        <div class="flex-1 w-full flex flex-col items-center justify-center min-h-0">
          <OnboardingHeader
            title={headerTitle}
            subtitle={headerSubtitle}
            icon={headerIcon}
          />
        </div>

        {/* Button wrapper (Figma 536:2468), pinned to the card bottom:
              loading → disabled "Please be patient"
              done    → active CTA to the final step
              error   → a way back to the seed step */}
        <div class="w-full flex flex-col items-center gap-3">
          {error ? (
            <button
              type="button"
              onClick={() => navigate("/import/seed")}
              class="w-full bg-transparent border-2 border-bg-primary flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-bg-primary uppercase tracking-[0.48px] cursor-pointer transition-colors duration-150 hover:bg-bg-primary hover:text-text-primary"
            >
              Back to Seed
            </button>
          ) : done ? (
            <div class="w-full border-2 border-blue p-1.5 transition-colors duration-150 has-[button:hover:not(:disabled)]:border-blue-hover">
              <button
                type="button"
                onClick={() => navigate("/create/done")}
                class="w-full bg-blue flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-pointer transition-colors duration-150 hover:bg-primary-600"
              >
                Continue
              </button>
            </div>
          ) : (
            <div class="w-full border-2 border-blue p-1.5 opacity-20">
              <button
                type="button"
                disabled
                class="w-full bg-blue flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-not-allowed"
              >
                Please be patient
              </button>
            </div>
          )}
        </div>
      </CardShell>
    </div>
  );
}
