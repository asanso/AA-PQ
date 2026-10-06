/* ═══════════════════════════════════════════════════════════════════
   Unlock — popup screen when the vault exists but is locked
   ───────────────────────────────────────────────────────────────────
   Shown when:
     - Popup opens fresh (browser just started, no session key)
     - User manually locked from the settings menu
     - Auto-lock timer expired in the background

   On successful unlock:
     1. Stash the derived vault key in chrome.storage.session so next
        popup open skips this screen (raw password is never stored)
     2. Hydrate tree / currentIndex / smartAddr / mode from the vault
     3. If a pending dApp approval is queued, route to /approve;
        otherwise route to /dashboard
     4. Notify background SESSION_START so the lock timer restarts

   Visual style is aligned with the rest of the popup — dark surface,
   corner triangles, the Figma type system (Barlow display title + Inter
   body/labels via .type-* classes), brand-blue input focus.
   The "Delete wallet" affordance lives in SettingsMenu now.
   ═══════════════════════════════════════════════════════════════════ */

import { useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useVault } from "@/ui/hooks";
import { vaultManager } from "@/vault/VaultManager.js";
import { storeSessionKey } from "@/popup/session.js";
import {
  approvalMode,
  approvalData,
  pendingApprovalId,
  page,
} from "@/ui/store.js";
import { CornerTopLeft, CornerBottomRight } from "../onboarding/OnboardingCorners.jsx";

function fetchPending(id) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_PENDING", pendingId: id }, (res) =>
      resolve(res || null)
    );
  });
}

export function Unlock() {
  const [, navigate] = useLocation();
  const vault = useVault();

  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function doUnlock(e) {
    e?.preventDefault?.();
    if (submitting) return;
    if (!pw) return;

    setSubmitting(true);
    setError("");

    try {
      await vault.unlock(pw);
      /* Session = derived vault key, never the raw password. */
      storeSessionKey(vaultManager.getSessionKeyBytes());

      // If a dApp approval is pending, route there instead of dashboard.
      let nextRoute = "/dashboard";
      if (approvalMode.value && approvalData.value) {
        nextRoute = "/approve";
      } else if (pendingApprovalId.value) {
        const pending = await fetchPending(pendingApprovalId.value);
        if (pending) {
          approvalMode.value = true;
          approvalData.value = { ...pending, pendingId: pendingApprovalId.value };
          nextRoute = "/approve";
        }
        pendingApprovalId.value = null;
      }

      chrome.runtime.sendMessage({ type: "SESSION_START" }).catch?.(() => {});
      page.value = nextRoute.slice(1); // Keep legacy signal in sync
      navigate(nextRoute);
    } catch {
      setError("Wrong password");
      setSubmitting(false);
    }
  }

  return (
    <div class="relative bg-bg-primary flex flex-col items-stretch w-full min-h-screen text-text-primary">
      <CornerTopLeft />

      {/* Top-aligned content (per user request: input at the top, not
          vertically centered like the previous version). */}
      <form onSubmit={doUnlock} class="w-full flex flex-col gap-5 px-5 pt-8 pb-5">
        <div class="w-full flex flex-col items-center gap-3">
          <img
            src="/nicetry_logo_outline.svg"
            alt=""
            class="size-16 rounded-full bg-primary-50 p-1"
          />
          <p class="type-display-title text-text-primary text-center">
            Welcome back
          </p>
          <p class="type-body-md text-text-muted text-center">
            Unlock your wallet to continue.
          </p>
        </div>

        <div class="w-full flex flex-col gap-2">
          <label class="type-label-sm text-text-dim">
            Password
          </label>
          <input
            type="password"
            value={pw}
            onInput={(e) => { setPw(e.currentTarget.value); setError(""); }}
            placeholder="Enter your password"
            autoFocus
            class="w-full backdrop-blur-[16px] bg-bg-card border border-white/20 outline-none px-4 py-3 font-body text-[16px] leading-[1.6] text-text-primary placeholder:text-border-light transition-colors duration-150 focus:border-blue"
          />
        </div>

        {error && (
          <p class="type-body-md text-red text-center">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !pw}
          class="w-full bg-blue flex items-center justify-center px-6 py-4 cursor-pointer border-none type-label-button text-text-primary transition-colors duration-150 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Unlocking…" : "Unlock"}
        </button>

        <button
          type="button"
          onClick={() => navigate("/reset")}
          class="w-full bg-transparent border-none cursor-pointer type-body-md text-text-muted text-center hover:text-text-primary py-1"
        >
          Forgot password?
        </button>
      </form>

      <div class="flex-1 min-h-0" />
      <CornerBottomRight />
    </div>
  );
}