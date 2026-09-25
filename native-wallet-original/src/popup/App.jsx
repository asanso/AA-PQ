/* ═══════════════════════════════════════════════════════════════════
   popup/App.jsx — route shell
   ───────────────────────────────────────────────────────────────────
   Hash-based routes:
     /landing          → Landing (no vault)
     /unlock           → Unlock (vault exists, locked)
     /reset            → ResetWallet (forgot password: recover or erase)
     /dashboard        → Dashboard (main screen)
     /network          → NetworkSwitcher (pick the active chain)
     /network-edit/:id → EditNetwork (per-chain custom RPC + rename)
     /accounts         → AccountSwitcher (pick / create / manage accounts)
     /settings         → SettingsMenu (wallet settings)
     /receive          → ReceiveModal (address + QR for incoming funds)
     /send             → Send (full-screen transfer + rotate flow)
     /import-token     → ImportToken (add ERC-20 to wallet)
     /approve          → (approval component — stub until you build it)
     /setup-incomplete → SetupNotComplete
   ═══════════════════════════════════════════════════════════════════ */

import { Route, Switch, Router, useLocation } from "wouter-preact";
import { useEffect, useState, useCallback } from "preact/hooks";
import { effect } from "@preact/signals";

import { page } from "@/ui/store.js";
import { Landing } from "@/ui/components/popup/Landing.jsx";
import { Loading } from "@/ui/components/popup/Loading.jsx";
import { Unlock } from "@/ui/components/popup/Unlock.jsx";
import { ResetWallet } from "@/ui/components/popup/ResetWallet.jsx";
import { Dashboard } from "@/ui/components/popup/Dashboard.jsx";
import { Send } from "@/ui/components/popup/Send.jsx";
import { ImportToken } from "@/ui/components/popup/ImportToken.jsx";
import { Approval } from "@/ui/components/popup/Approval.jsx";
import { SetupNotComplete } from "@/ui/components/popup/SetupNotComplete.jsx";



import { NetworkSwitcher } from "@/ui/components/popup/dashboard/NetworkSwitcher.jsx";
import { EditNetwork } from "@/ui/components/popup/dashboard/EditNetwork.jsx";
import { AccountSwitcher } from "@/ui/components/popup/dashboard/AccountSwitcher.jsx";
import { SettingsMenu } from "@/ui/components/popup/dashboard/SettingsMenu.jsx";
import { ReceiveModal } from "@/ui/components/popup/dashboard/ReceiveModal.jsx";
import { ExecutingOverlay } from "@/ui/components/common/ExecutingOverlay.jsx";

const readHash = () => {
  const h = window.location.hash.replace(/^#/, "");
  if (!h) return "/";
  if (h.startsWith("approve/")) return "/approve";
  return "/" + h;
};

function useHashLocation() {
  const [loc, setLoc] = useState(readHash());

  useEffect(() => {
    const handler = () => setLoc(readHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = useCallback((to) => {
    const next = to.startsWith("/") ? to.slice(1) : to;
    window.location.hash = next;
  }, []);

  return [loc, navigate];
}

function PageToRoute() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    return effect(() => {
      const target = "/" + page.value;
      if (readHash() !== target) setLocation(target);
    });
  }, [setLocation]);

  return null;
}

export function App() {
  return (
    <Router hook={useHashLocation}>
      <PageToRoute />
      {/* Global on-chain executing block — spinning logo + phase label.
          Shows for ANY flow that runs the rotation (send / contract
          interaction / transfer-ownership / …) via the global `busy`
          signal, on top of whatever route is active. */}
      <ExecutingOverlay />
      <Switch>
        <Route path="/loading" component={Loading} />
        <Route path="/landing" component={Landing} />
        <Route path="/unlock" component={Unlock} />
        <Route path="/reset" component={ResetWallet} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/network" component={NetworkSwitcher} />
        <Route path="/network-edit/:chainId" component={EditNetwork} />
        <Route path="/accounts" component={AccountSwitcher} />
        <Route path="/settings" component={SettingsMenu} />
        <Route path="/receive" component={ReceiveModal} />
        <Route path="/send" component={Send} />
        <Route path="/import-token" component={ImportToken} />
        <Route path="/approve" component={Approval} />
        <Route path="/setup-incomplete" component={SetupNotComplete} />



        {/* /claim kept as a backward-compat alias for the older
            verify-and-import flow; new flows route to /buy. */}

        <Route>
          {/* Fallback while the URL is still "/" before PageToRoute
              syncs to the page signal. Shows the skeleton, never the
              Landing CTA — Landing only renders for confirmed
              empty-vault state. */}
          <Loading />
        </Route>
      </Switch>
    </Router>
  );
}
