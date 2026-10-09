import { manualSendCount } from "@/transactions/manual-send-queue.js";
import { busy } from "@/ui/store.js";
import { signedActivity } from "@/transactions/transaction-activity.js";
/* ═══════════════════════════════════════════════════════════════════
   Dashboard — main popup screen
   ───────────────────────────────────────────────────────────────────
   Orchestrates the popup UI. Send is now a dedicated /send route,
   so this file just navigates to it instead of showing the form
   inline.

   The Balance/Assets tabs and the Send/Receive footer are rendered by
   the unified <BalanceCard> (Figma 37:16968), so they live in one place
   only. The active-tab state still lives here in useState and is handed
   to the card via tab / onTab; everything else reads from signals.
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import {
  activeTab,
  chainId as chainIdSignal,
  accounts as accountsSignal,
  currentIndex,
  tree,
} from "@/ui/store.js";
import { storageGet } from "@/utils/storage.js";
import { vaultManager } from "@/vault/VaultManager.js";

import { getNetwork, getActiveNetwork, isSphincsChain } from "@/config/networks.js";

import { DashboardHeader } from "./dashboard/DashboardHeader.jsx";
import { AddressBar } from "./dashboard/AddressBar.jsx";
import { BalanceCard } from "./dashboard/BalanceCard.jsx";
import { ExpandablePanel } from "./dashboard/ExpandablePanel.jsx";
import { RecentActivitiesPanel } from "./dashboard/RecentActivitiesPanel.jsx";

import { CornerTopLeft, CornerBottomRight } from "../onboarding/OnboardingCorners.jsx";

function TransactionsIcon() {
  return (
   <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
<path d="M12.5654 6.39844H11.438C11.3349 6.39844 11.2505 6.48282 11.2505 6.58594V13.0383C11.2505 13.0992 11.2786 13.1555 11.3279 13.1906L15.2021 16.0195C15.2865 16.0805 15.4036 16.0641 15.4646 15.9797L16.1349 15.0656C16.1982 14.9789 16.1794 14.8617 16.0951 14.8031L12.7529 12.3867V6.58594C12.7529 6.48282 12.6685 6.39844 12.5654 6.39844ZM17.7169 8.16094L21.3919 9.0586C21.5091 9.08672 21.624 8.99766 21.624 8.87813L21.6427 5.09297C21.6427 4.93594 21.4622 4.84688 21.3404 4.94532L17.6466 7.83047C17.6187 7.85207 17.5974 7.8811 17.5853 7.91424C17.5731 7.94738 17.5706 7.98327 17.5779 8.0178C17.5853 8.05232 17.6022 8.08407 17.6268 8.10939C17.6514 8.13471 17.6826 8.15258 17.7169 8.16094ZM21.6474 15.218L20.3185 14.7609C20.2722 14.7451 20.2214 14.7479 20.1772 14.769C20.133 14.79 20.0987 14.8275 20.0818 14.8734C20.0372 14.993 19.9904 15.1102 19.9411 15.2273C19.524 16.2141 18.9263 17.1023 18.1622 17.8641C17.4067 18.622 16.5112 19.2261 15.5255 19.643C14.5044 20.0747 13.4068 20.2963 12.2982 20.2945C11.1779 20.2945 10.0927 20.0766 9.07083 19.643C8.08514 19.2261 7.18969 18.622 6.43411 17.8641C5.6724 17.1023 5.07474 16.2141 4.65521 15.2273C4.22587 14.2057 4.00591 13.1082 4.00833 12C4.00833 10.8797 4.2263 9.79219 4.6599 8.77032C5.07708 7.7836 5.67474 6.89532 6.4388 6.1336C7.19438 5.37567 8.08983 4.77154 9.07552 4.35469C10.0927 3.9211 11.1802 3.70313 12.3005 3.70313C13.4208 3.70313 14.506 3.9211 15.5279 4.35469C16.5136 4.77154 17.409 5.37567 18.1646 6.1336C18.4036 6.375 18.6286 6.62578 18.8349 6.89063L20.2365 5.79375C18.3919 3.43594 15.5208 1.91953 12.2958 1.92188C6.68021 1.92422 2.17083 6.48516 2.22708 12.1031C2.28333 17.6227 6.77161 22.0781 12.3005 22.0781C16.6482 22.0781 20.3513 19.3219 21.7622 15.4617C21.7974 15.3633 21.7458 15.2531 21.6474 15.218Z" fill="#6E88EC"/>
</svg>
  );
}






/* Overlay shown when the active account is imported (bought from
   someone else) but bound to a DIFFERENT chain than the one currently
   active. The SA was created under the giver's CREATE2 salt only on
   `importedChainId` — on any other chain that same address doesn't
   exist or has a different owner. The user must switch back to the
   bound chain (or pick a different account) before doing anything. */


/* Full-surface overlay shown when the active account has been transferred
   on the active chain. The user has zero signing power here — every
   action would either fail (pre-flight 2/2 against on-chain owner) or
   send funds to the new owner. We block the whole dashboard and offer
   the two recoverable paths: switch chain (account may still be ours
   elsewhere) or switch account. */


export function Dashboard() {
  const [, navigate] = useLocation();
  // One-shot read of the activeTab signal: when ImportToken sets it to
  // "assets" before navigating here, we mount on the Assets tab. We
  // immediately reset it so subsequent dashboard visits default to
  // balance.
  const [tab, setTab] = useState(() => {
    if (activeTab.value === "assets") {
      activeTab.value = "balance";
      return "assets";
    }
    return "balance";
  });
  /* Detect "active account is dead on this chain". Two distinct kinds
     of dead: transferred here (giver lost signing power) and imported
     but bound to a different chain (SA doesn't live here). Each gets
     its own overlay because the user actions differ slightly. */
  const activeAccountMeta = (accountsSignal.value || []).find((a) => a.isActive);
  const activeChainLower = String(chainIdSignal.value || "").toLowerCase();
  const isActiveTransferredHere = !!(
    activeAccountMeta?.transferred && activeAccountMeta.transferred[activeChainLower]
  );
  const isActiveImportedOnWrongChain = !!(
    activeAccountMeta?.imported &&
    activeAccountMeta?.importedChainId &&
    activeAccountMeta.importedChainId !== activeChainLower
  );




  return (
    <div class="relative bg-bg-primary flex flex-col items-stretch w-full min-h-screen text-text-primary">
      {/* Top-left blue corner triangle (Figma 169:2598) */}
      <CornerTopLeft />

      <DashboardHeader
        onOpenSettings={() => navigate("/settings")}
        onOpenAccounts={() => navigate("/accounts")}
        onOpenNetwork={() => navigate("/network")}
      />

      {/* Address + unified balance/assets card (Figma 37:16968). The
          card owns the Balance/Assets tabs and the Send/Receive footer,
          so there is no separate tab bar or action row here — that
          removes the duplicate Send/Receive row. */}
      <div class="w-full px-4 pt-4 pb-4 flex flex-col gap-4">
        <AddressBar />

        <BalanceCard
          tab={tab}
          onTab={setTab}
          onSend={() => navigate("/send")}
          onReceive={() => navigate("/receive")}
        />
      </div>

      {/* Common dropdowns — visible regardless of the active tab.
          Inset from the popup edges (Figma 181:4322: the sections sit
          inside a 16px gutter instead of running full-bleed). */}
      <div class="w-full px-4">
        <div class="h-px w-full bg-white/10" />

        <ExpandablePanel icon={<TransactionsIcon />} label="Transactions" defaultOpen={!!signedActivity.value}>
          <RecentActivitiesPanel />
        </ExpandablePanel>



        <div class="h-px w-full bg-white/10" />
      </div>

      {/* Spacer pushes the bottom corner to the very bottom of the popup */}
      <div class="flex-1 min-h-0" />
      {/* Bottom-right blue corner triangle (Figma 169:2598 mirrored) */}
      <CornerBottomRight />

      {/* Network / Account / Settings / Receive are now full routes
          (/network, /accounts, /settings, /receive) reached via the
          header + balance-card callbacks above — no in-dashboard
          overlay any more.

          Transferred-on-this-chain guard. Full-surface block shown when
          the active account has been handed over on the active chain;
          its CTAs route to the account / network pages. */}


      {/* Imported-on-wrong-chain guard. Mutually exclusive with the
          transferred overlay (an account can't be both imported here
          AND transferred on another chain at the same moment). */}
      {!isActiveTransferredHere && isActiveImportedOnWrongChain && (
        <ImportedWrongChainOverlay
          active={activeAccountMeta}
          currentChainHex={activeChainLower}
          onSwitchAccount={() => navigate("/accounts")}
          onSwitchNetwork={() => navigate("/network")}
        />
      )}
    </div>
  );
}
