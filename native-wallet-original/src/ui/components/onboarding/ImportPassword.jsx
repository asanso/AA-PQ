/* ═══════════════════════════════════════════════════════════════════
   ImportPassword — import flow step 2/4
   ───────────────────────────────────────────────────────────────────
   Set a password for the imported vault. Same validation as the
   create-flow CreatePassword:
     - Min 6 chars
     - Confirm must match

   On continue → stash password in flow, go to /import/scanning where
   the actual restoreVault + on-chain detection runs.

   UI matches the create-flow design system (CardShell, OnboardingHeader,
   EyeIcon password toggle, blue corner triangles).
   ═══════════════════════════════════════════════════════════════════ */

import { useState, useEffect } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useOnboardingFlow } from "@/ui/hooks/useOnboardingFlow.js";
import { OnboardingHeader } from "./OnboardingHeader.jsx";
import { CornerTopLeft, CornerBottomRight } from "./OnboardingCorners.jsx";
import {
  evaluatePassword,
  MIN_PASSWORD_LENGTH,
} from "@/utils/password-strength.js";

const STEP = 2;
const TOTAL_STEPS = 4;

function EyeIcon({ open }) {
  return open ? (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.86 19.86 0 0 1-3.17 4.19M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function CardShell({ children }) {
  return (
    <div class="w-full h-full flex flex-col gap-6">
      <div class="w-full flex flex-col gap-2.5 overflow-hidden">
        <div class="w-full flex items-start justify-between font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-muted uppercase tracking-[0.52px] whitespace-nowrap">
          <p>Set Password</p>
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

export function ImportPassword() {
  const [, navigate] = useLocation();
  const flow = useOnboardingFlow();

  const [pw, setPw] = useState(flow.password);
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState("");
  const [showMismatch, setShowMismatch] = useState(false);
  const [agreed, setAgreed] = useState(false);

  // Debounced live mismatch check (matches CreatePassword pattern).
  useEffect(() => {
    setShowMismatch(false);
    if (!confirm) return;
    const t = setTimeout(() => {
      if (pw !== confirm) setShowMismatch(true);
    }, 400);
    return () => clearTimeout(t);
  }, [pw, confirm]);

  const strength = evaluatePassword(pw);

  function submit(e) {
    e?.preventDefault?.();
    if (pw.length < MIN_PASSWORD_LENGTH) {
      return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (!strength.ok) {
      return setError("Password is too weak — mix letters, numbers and symbols");
    }
    if (pw !== confirm) return setError("Passwords do not match");
    if (!agreed) return setError("Please accept the Terms of Use to continue");

    flow.password = pw;
    navigate("/import/scanning");
  }

  // Button enables on length + match + terms; strength is enforced on submit
  // with an explanatory error (the design has no inline strength meter).
  const isValid =
    pw.length >= MIN_PASSWORD_LENGTH && pw === confirm && agreed;

  return (
    <form onSubmit={submit} class="w-full h-full flex flex-col">
      <CardShell>
        <OnboardingHeader
          title="Set Password"
          subtitle="Secure your wallet with a strong password on this device"
        />

        {/* Inputs */}
        <div class="flex-1 w-full flex flex-col items-center justify-center gap-5">
          <div class="w-full flex flex-col items-start gap-2">
            <label class="w-full font-['Inter'] text-[13px] leading-[1.2] text-text-dim">
              Password
            </label>
            <div class="w-full bg-bg-primary/5 border border-bg-primary/10 backdrop-blur-[16px] flex items-center justify-between px-4 py-3 transition-colors duration-150 focus-within:border-blue">
              <input
                type={showPw ? "text" : "password"}
                value={pw}
                onInput={(e) => { setPw(e.currentTarget.value); setError(""); }}
                placeholder="Enter password"
                class="flex-1 min-w-0 bg-transparent outline-none border-none font-['Inter'] text-[16px] leading-[1.6] text-bg-primary placeholder:text-text-muted"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPw(!showPw)}
                class="size-[18px] flex items-center justify-center text-bg-primary shrink-0 ml-2 bg-transparent border-none cursor-pointer p-0"
                aria-label={showPw ? "Hide password" : "Show password"}
              >
                <EyeIcon open={showPw} />
              </button>
            </div>
          </div>

          <div class="w-full flex flex-col items-start gap-2">
            <label class="w-full font-['Inter'] text-[13px] leading-[1.2] text-text-dim">
              Confirm Password
            </label>
            <div class="w-full bg-bg-primary/5 border border-bg-primary/10 backdrop-blur-[16px] flex items-center justify-between px-4 py-3 transition-colors duration-150 focus-within:border-blue">
              <input
                type={showConfirm ? "text" : "password"}
                value={confirm}
                onInput={(e) => { setConfirm(e.currentTarget.value); setError(""); }}
                placeholder="Confirm Password"
                class="flex-1 min-w-0 bg-transparent outline-none border-none font-['Inter'] text-[16px] leading-[1.6] text-bg-primary placeholder:text-text-muted"
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                class="size-[18px] flex items-center justify-center text-bg-primary shrink-0 ml-2 bg-transparent border-none cursor-pointer p-0"
                aria-label={showConfirm ? "Hide password" : "Show password"}
              >
                <EyeIcon open={showConfirm} />
              </button>
            </div>
            {/* Reserved-space mismatch slot, mirrors CreatePassword. */}
            <p
              class={
                "w-full font-['Poppins'] text-[13px] leading-[1.2] text-red " +
                (showMismatch ? "" : "invisible")
              }
              aria-hidden={!showMismatch}
            >
              Passwords do not match
            </p>
          </div>

          {error && (
            <div class="w-full font-['Poppins'] text-[13px] text-red text-center">
              {error}
            </div>
          )}
        </div>

        {/* Footer — Terms checkbox + Continue. "Back" lives outside the card. */}
        <div class="w-full flex flex-col items-center gap-4">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => { setAgreed(e.currentTarget.checked); setError(""); }}
              class="peer sr-only"
            />
            <span class="size-5 shrink-0 rounded-[3px] border border-bg-primary/30 bg-bg-primary/5 flex items-center justify-center transition-colors duration-150 peer-checked:bg-blue peer-checked:border-blue peer-focus-visible:ring-2 peer-focus-visible:ring-blue/40">
              {agreed && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="text-text-primary">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
            <span class="font-['Inter'] text-[13px] leading-[1.2] text-bg-primary">
              I agree to the <span class="font-semibold underline">Terms of Use</span>
            </span>
          </label>

          <div class="w-full border-2 border-blue p-1.5 transition-colors duration-150 has-[button:hover:not(:disabled)]:border-blue-hover has-[:disabled]:opacity-50">
            <button
              type="submit"
              disabled={!isValid}
              class="w-full bg-blue flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-pointer transition-colors duration-150 hover:bg-primary-600 disabled:hover:bg-blue disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </div>
        </div>
      </CardShell>
    </form>
  );
}
