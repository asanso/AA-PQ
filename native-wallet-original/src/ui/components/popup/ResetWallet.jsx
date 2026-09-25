/* ═══════════════════════════════════════════════════════════════════
   ResetWallet — "Forgot password?" recovery screen (MetaMask-style)
   ───────────────────────────────────────────────────────────────────
   Reached from the Unlock screen when the user can't remember their
   password. The vault is encrypted with that password and cannot be
   decrypted without it, so the only ways forward are:

     1. Recover with seed phrase — re-derive the SAME wallet from the
        12/24-word mnemonic and set a NEW password. Because every
        account/SA address is deterministic from the seed, this
        reproduces the wallet exactly (same addresses, same on-chain
        funds). vault.restore() overwrites the old encrypted blob.

     2. Erase & start over — permanently delete the local vault and open
        onboarding to create a brand-new wallet. Irreversible: without
        the seed phrase the old funds are unrecoverable, so we gate it
        behind an explicit acknowledgement.

   Three internal views ("choose" | "recover" | "erase") keep this to a
   single route/file. Styling mirrors Unlock (dark surface + corners).
   ═══════════════════════════════════════════════════════════════════ */

import { useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useVault } from "@/ui/hooks";
import { vaultManager } from "@/vault/VaultManager.js";
import { storeSessionKey, clearSessionKey } from "@/popup/session.js";
import { evaluatePassword, MIN_PASSWORD_LENGTH } from "@/utils/password-strength.js";
import { page } from "@/ui/store.js";
import { CornerTopLeft, CornerBottomRight } from "../onboarding/OnboardingCorners.jsx";

function wordCountOf(phrase) {
  return (phrase || "").trim().split(/\s+/).filter(Boolean).length;
}

/* Module-level so its identity is stable across renders — a nested
   component would remount on every keystroke and drop input focus. */
function Shell({ children }) {
  return (
    <div class="relative bg-bg-primary flex flex-col items-stretch w-full min-h-screen text-text-primary">
      <CornerTopLeft />
      <div class="w-full flex flex-col gap-5 px-5 pt-8 pb-5">{children}</div>
      <div class="flex-1 min-h-0" />
      <CornerBottomRight />
    </div>
  );
}

export function ResetWallet() {
  const [, navigate] = useLocation();
  const vault = useVault();

  const [view, setView] = useState("choose"); // choose | recover | erase

  /* ── Recover-with-seed state ─────────────────────────────────────── */
  const [phrase, setPhrase] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const words = wordCountOf(phrase);
  const seedValid = words === 12 || words === 24;
  const strength = evaluatePassword(pw);
  const recoverValid =
    seedValid && strength.ok && pw.length >= MIN_PASSWORD_LENGTH && pw === confirm;

  async function doRecover(e) {
    e?.preventDefault?.();
    if (busy) return;
    if (!seedValid) { setError("Enter exactly 12 or 24 words"); return; }
    if (pw.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`); return;
    }
    if (!strength.ok) {
      setError("Password is too weak — mix letters, numbers and symbols"); return;
    }
    if (pw !== confirm) { setError("Passwords do not match"); return; }

    setBusy(true);
    setError("");
    try {
      /* restore re-derives the wallet from the seed and persists a fresh
         vault encrypted with the new password (BIP-39 checksum is
         verified here — a bad phrase throws). */
      await vault.restore(pw, phrase.trim().toLowerCase());
      /* Session = derived vault key, never the raw password. */
      storeSessionKey(vaultManager.getSessionKeyBytes());
      chrome.runtime.sendMessage({ type: "SESSION_START" }).catch?.(() => {});
      page.value = "dashboard";
      navigate("/dashboard");
    } catch {
      setError("Invalid seed phrase. Check the words and try again.");
      setBusy(false);
    }
  }

  /* ── Erase-and-start-over state ──────────────────────────────────── */
  const [ack, setAck] = useState(false);

  async function doErase() {
    if (busy || !ack) return;
    setBusy(true);
    try {
      await vault.destroy();      // wipes vault + clears tree/smartAddr signals
      clearSessionKey();
      chrome.runtime.sendMessage({ type: "SESSION_LOCK" }).catch?.(() => {});
      // Open the full onboarding flow (create new wallet) in a tab.
      chrome.runtime.sendMessage({ type: "OPEN_ONBOARDING" }).catch(() => {
        chrome.tabs?.create?.({ url: chrome.runtime.getURL("onboarding.html") });
      });
      window.close();
    } catch (e) {
      setError(e?.message || "Could not erase the wallet.");
      setBusy(false);
    }
  }

  /* ── View: choose ────────────────────────────────────────────────── */
  if (view === "choose") {
    return (
      <Shell>
        <div class="w-full flex flex-col items-center gap-3">
          <img src="/nicetry_logo_outline.svg" alt="" class="size-16 rounded-full bg-primary-50 p-1" />
          <p class="type-display-title text-text-primary text-center">Reset access</p>
          <p class="type-body-md text-text-muted text-center">
            Your password can't be recovered. Choose how to regain access.
          </p>
        </div>

        <button
          type="button"
          onClick={() => { setError(""); setView("recover"); }}
          class="w-full bg-blue flex flex-col items-start gap-1 px-5 py-4 cursor-pointer border-none text-left transition-colors duration-150 hover:bg-primary-600"
        >
          <span class="type-label-button text-text-primary">Recover with seed phrase</span>
          <span class="type-body-sm text-text-primary/80">
            Restore this wallet and set a new password.
          </span>
        </button>

        <button
          type="button"
          onClick={() => { setError(""); setAck(false); setView("erase"); }}
          class="w-full bg-bg-card border border-red/50 flex flex-col items-start gap-1 px-5 py-4 cursor-pointer text-left transition-colors duration-150 hover:border-red"
        >
          <span class="type-label-button text-red">Erase &amp; create new wallet</span>
          <span class="type-body-sm text-text-muted">
            Permanently delete this wallet from this device.
          </span>
        </button>

        <button
          type="button"
          onClick={() => navigate("/unlock")}
          class="w-full bg-transparent border-none cursor-pointer type-body-md text-text-muted hover:text-text-primary py-2"
        >
          Back to unlock
        </button>
      </Shell>
    );
  }

  /* ── View: recover ───────────────────────────────────────────────── */
  if (view === "recover") {
    return (
      <Shell>
        <form onSubmit={doRecover} class="w-full flex flex-col gap-5">
          <div class="w-full flex flex-col items-center gap-2">
            <p class="type-display-title text-text-primary text-center">Recover wallet</p>
            <p class="type-body-md text-text-muted text-center">
              Enter your seed phrase and choose a new password.
            </p>
          </div>

          <div class="w-full flex flex-col gap-2">
            <label class="type-label-sm text-text-dim flex items-center justify-between">
              <span>Seed phrase</span>
              <span class={"font-semibold " + (seedValid ? "text-blue" : "text-text-muted")}>
                {words} {words === 1 ? "word" : "words"}
              </span>
            </label>
            <textarea
              value={phrase}
              onInput={(e) => { setPhrase(e.currentTarget.value); setError(""); }}
              placeholder="word1  word2  word3  …  word12"
              rows={3}
              spellcheck={false}
              autoFocus
              class="w-full backdrop-blur-[16px] bg-bg-card border border-white/20 outline-none px-4 py-3 font-body text-[14px] leading-[1.6] text-text-primary placeholder:text-border-light resize-none transition-colors duration-150 focus:border-blue"
            />
          </div>

          <div class="w-full flex flex-col gap-2">
            <label class="type-label-sm text-text-dim">New password</label>
            <input
              type="password"
              value={pw}
              onInput={(e) => { setPw(e.currentTarget.value); setError(""); }}
              placeholder="Enter a new password"
              class="w-full backdrop-blur-[16px] bg-bg-card border border-white/20 outline-none px-4 py-3 font-body text-[16px] leading-[1.6] text-text-primary placeholder:text-border-light transition-colors duration-150 focus:border-blue"
            />
            <p class="type-body-sm text-text-muted">
              Min {MIN_PASSWORD_LENGTH} chars · letters + numbers + symbols
            </p>
          </div>

          <div class="w-full flex flex-col gap-2">
            <label class="type-label-sm text-text-dim">Confirm new password</label>
            <input
              type="password"
              value={confirm}
              onInput={(e) => { setConfirm(e.currentTarget.value); setError(""); }}
              placeholder="Confirm new password"
              class="w-full backdrop-blur-[16px] bg-bg-card border border-white/20 outline-none px-4 py-3 font-body text-[16px] leading-[1.6] text-text-primary placeholder:text-border-light transition-colors duration-150 focus:border-blue"
            />
          </div>

          {error && <p class="type-body-md text-red text-center">{error}</p>}

          <button
            type="submit"
            disabled={busy || !recoverValid}
            class="w-full bg-blue flex items-center justify-center px-6 py-4 cursor-pointer border-none type-label-button text-text-primary transition-colors duration-150 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Recovering…" : "Recover wallet"}
          </button>
          <button
            type="button"
            onClick={() => { setError(""); setView("choose"); }}
            class="w-full bg-transparent border-none cursor-pointer type-body-md text-text-muted hover:text-text-primary py-1"
          >
            Back
          </button>
        </form>
      </Shell>
    );
  }

  /* ── View: erase ─────────────────────────────────────────────────── */
  return (
    <Shell>
      <div class="w-full flex flex-col items-center gap-2">
        <p class="type-display-title text-red text-center">Erase wallet</p>
        <p class="type-body-md text-text-muted text-center">
          This permanently deletes the wallet from this device.
        </p>
      </div>

      <div class="w-full bg-red/10 border border-red/40 p-4">
        <p class="type-body-md text-text-primary">
          Make sure you have your seed phrase saved. Without it, the funds
          in this wallet are lost forever — there is no other way back.
        </p>
      </div>

      <label class="w-full flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.currentTarget.checked)}
          class="mt-[2px] size-4 shrink-0 accent-red cursor-pointer"
        />
        <span class="type-body-sm text-text-muted">
          I understand this wallet will be permanently deleted and cannot be
          recovered without the seed phrase.
        </span>
      </label>

      {error && <p class="type-body-md text-red text-center">{error}</p>}

      <button
        type="button"
        onClick={doErase}
        disabled={busy || !ack}
        class="w-full bg-red flex items-center justify-center px-6 py-4 cursor-pointer border-none type-label-button text-text-primary transition-colors duration-150 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? "Erasing…" : "Erase wallet"}
      </button>
      <button
        type="button"
        onClick={() => { setError(""); setView("choose"); }}
        class="w-full bg-transparent border-none cursor-pointer type-body-md text-text-muted hover:text-text-primary py-1"
      >
        Back
      </button>
    </Shell>
  );
}
