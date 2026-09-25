import { useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useOnboardingFlow } from "@/ui/hooks/useOnboardingFlow.js";
import { vaultManager } from "@/vault/VaultManager.js";

import { deploySmartAccount } from "@/blockchain/helpers.js";


import { storageSet } from "@/utils/storage.js";

import { tree, smartAddr, chainId as chainSignal, currentIndex } from "@/ui/store.js";
import {
  NETWORKS,
  DEFAULT_CHAIN_ID,
  isFactoryDeployed,
  listVisibleNetworks,
} from "@/config/networks.js";
import { OnboardingHeader } from "./OnboardingHeader.jsx";
import { CornerTopLeft, CornerBottomRight } from "./OnboardingCorners.jsx";
import { TokenIcon } from "@/ui/components/popup/dashboard/TokenIcon.jsx";
import { chainLogoUrl } from "@/ui/utils/asset-icon.js";

const STEP = 3;
const TOTAL_STEPS = 4;

function InfoIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 16.5C13.1421 16.5 16.5 13.1421 16.5 9C16.5 4.85786 13.1421 1.5 9 1.5C4.85786 1.5 1.5 4.85786 1.5 9C1.5 13.1421 4.85786 16.5 9 16.5Z" stroke="#3F56E3" stroke-width="1.875" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9 6V9" stroke="#3F56E3" stroke-width="1.875" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9 12H9.0075" stroke="#3F56E3" stroke-width="1.875" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  );
}

function CardShell({ children }) {
  return (
    <div class="w-full h-full flex flex-col gap-6">
      <div class="w-full flex flex-col gap-2.5 overflow-hidden">
        <div class="w-full flex items-start justify-between font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-[#a5a5a5] uppercase tracking-[0.52px] whitespace-nowrap">
          <p>Network</p>
          <p>Step {STEP} of {TOTAL_STEPS}</p>
        </div>
        <div class="w-full flex gap-4">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              class={
                "flex-1 h-2 rounded-full " +
                (i < STEP ? "bg-[#3f56e3]" : "bg-[#fafafa]")
              }
            />
          ))}
        </div>
      </div>

      <div class="flex-1 bg-[#f8f6f4] flex flex-col w-full min-h-0 overflow-hidden">
        <CornerTopLeft />
        <div class="flex-1 w-full flex flex-col items-center justify-between px-10 py-5 min-h-0 gap-5">
          {children}
        </div>
        <CornerBottomRight />
      </div>
    </div>
  );
}

export function ChooseChain() {
  const [, navigate] = useLocation();
  const flow = useOnboardingFlow();

  /* Driven entirely by NETWORKS so adding a chain in src/config/networks.js
     auto-populates this picker. `hidden: true` on a record drops it. */
  const visibleNetworks = listVisibleNetworks();

  /* No default selection — the user must actively click a row before
     "Deploy" enables, so nobody deploys on the wrong chain by accident.
     The choice is NOT permanent: the live chain can be switched later
     from the dashboard (useNetwork.switchChain). This screen just picks
     the chain the first smart account is deployed on. */
  const [selected, setSelected] = useState(flow.chainId || null);
  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const selectedNet = selected ? NETWORKS[selected] : null;
  const factoryReady = !!selectedNet && isFactoryDeployed(selectedNet);

  async function confirm() {
    if (!selectedNet || deploying) return;

    setDeploying(true);
    setError("");

    try {
    globalThis.__NT_CHAIN_ID=selected;chainSignal.value=selected;await storageSet('nt_chainId',selected);
    setProgress('Deriving your SPHINCS-G account…');
    const address=await deploySmartAccount();smartAddr.value=address;flow.smartAddress=address;
    await vaultManager.persist();navigate('/create/done');
  } catch (e) {
      globalThis.__NT_OWNER_OVERRIDE = null;
      setError(e.message || String(e));
      setDeploying(false);
      setProgress("");
    }
  }

  return (
    <CardShell>
      <div class="w-full flex flex-col items-center gap-2.5">
        <OnboardingHeader
          title="Choose Network"
          subtitle="Pick your starting network — you can switch anytime later"
        />
        <div class="w-full flex gap-2 items-center justify-center backdrop-blur-[16px]">
          <div class="size-[18px] shrink-0">
            <InfoIcon />
          </div>
          <p class="font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-[#3f56e3] uppercase tracking-[0.52px] whitespace-nowrap">
            Switchable Anytime
          </p>
        </div>
      </div>

      <div class="w-full flex-1 min-h-0 overflow-y-auto flex flex-col gap-3">
        {visibleNetworks.map((net) => {
          const isSelected = selected === net.chainId;
          const rowAccent = "#3f56e3";
          const rowAccent20 = "rgba(63,86,227,0.2)";
          const rowOnAccent = "#f0f3fe";
          /* Mainnet/production rows are not selectable in this build —
             real-funds deployment is gated. We keep the row visible
             (so users know the chain is on the roadmap) but render
             everything in greyscale so it's visually obvious it's
             inert: greyed name, grey badge, no hover, no click. */
          const isMainnetLike = !net.testnet;
          const isDisabled = isMainnetLike;
          const badgeBg = isDisabled
            ? "#a5a5a5"
            : isSelected ? rowAccent : "#a5a5a5";
          const badgeColor = isDisabled
            ? "#767676"
            : isSelected ? rowOnAccent : "#fafafa";
          const labelColor = isDisabled
            ? "#9a9a9a"
            : isSelected ? rowAccent : "#a5a5a5";
          const radioBorderColor = isDisabled ? "#9a9a9a" : "#767676";

          return (
            <div
              key={net.chainId}
              onClick={() => {
                if (deploying || isDisabled) return;
                setSelected(net.chainId);
              }}
              class={
                "w-full bg-[#d6d6d6] flex items-center " +
                (isSelected ? "border-l-2 " : "") +
                (isDisabled
                  ? "cursor-not-allowed "
                  : deploying
                    ? "cursor-wait "
                    : "cursor-pointer ")
              }
              style={isSelected ? { borderLeftColor: rowAccent } : undefined}
            >
              <div
                class="flex-1 min-w-0 flex items-center p-[18px]"
                style={isSelected ? { backgroundColor: rowAccent20 } : undefined}
              >
                <div class="flex-1 min-w-0 flex items-center justify-between gap-3">
                  <div class="flex gap-2 items-center min-w-0">
                    {isSelected ? (
                      <div
                        class="size-5 shrink-0 rounded-full border-2 flex items-center justify-center"
                        style={{ backgroundColor: rowAccent, borderColor: rowAccent }}
                      >
                        <div class="size-2 rounded-full bg-white" />
                      </div>
                    ) : (
                      <div
                        class="size-5 shrink-0 rounded-full border-2"
                        style={{ borderColor: radioBorderColor }}
                      />
                    )}
                    <TokenIcon
                      src={chainLogoUrl(net.chainId)}
                      seed={`chain-${net.chainId}`}
                      size={24}
                      bgClass="bg-white"
                    />
                    <p
                      class="font-['Inter'] font-bold text-[13px] leading-[1.4] whitespace-nowrap"
                      style={{ color: labelColor }}
                    >
                      {net.name}
                    </p>
                  </div>
                  <div
                    class="rounded-full px-2.5 py-1.5 shrink-0"
                    style={{ backgroundColor: badgeBg }}
                  >
                    <p
                      class="font-['Poppins'] font-semibold text-[10px] leading-[1.2] uppercase tracking-[0.4px] whitespace-nowrap"
                      style={{ color: badgeColor }}
                    >
                      {net.badge}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div class="w-full flex flex-col items-center gap-2">
        {progress && (
          <p class="w-full font-['Poppins'] text-[13px] leading-[1.6] text-[#767676] text-center">
            {progress}
          </p>
        )}
        {error && (
          <p class="w-full font-['Poppins'] text-[13px] leading-[1.6] text-[#e33f3f] text-center break-all">
            {error}
          </p>
        )}
        <div class="w-full border-2 border-[#3f56e3] p-1.5 transition-colors duration-150 has-[button:hover:not(:disabled)]:border-[#6e88ec] has-[:disabled]:opacity-50">
          <button
            type="button"
            disabled={deploying || !selected || !factoryReady}
            onClick={confirm}
            class={
              "w-full bg-[#3f56e3] flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-[#f8f6f4] uppercase tracking-[0.48px] border-none transition-colors duration-150 hover:bg-[#3743d9] disabled:hover:bg-[#3f56e3] disabled:cursor-not-allowed " +
              (deploying ? "cursor-wait" : "cursor-pointer")
            }
          >
            {deploying ? "Deploying…" : "Deploy"}
          </button>
        </div>
      </div>
    </CardShell>
  );
}
