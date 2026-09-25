/* ═══════════════════════════════════════════════════════════════════
   CreatePassword — mockup step 1/4
   ───────────────────────────────────────────────────────────────────
   The user picks a password. We DON'T create the vault here — that
   happens on ShowSeed mount, because createNewVault generates the
   mnemonic and we want to show it right after.

   Validation matches the legacy behavior:
     - Min 6 chars
     - Confirm must match
     - Terms checkbox must be ticked (new requirement from mockup)

   Password is stashed in useOnboardingFlow() for the next step.
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

export function CreatePassword() {
  const [, navigate] = useLocation();
  const flow = useOnboardingFlow();

  const [pw, setPw] = useState(flow.password); // pre-fill if user went back
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState("");
  const [showMismatch, setShowMismatch] = useState(false);

  // Debounced live mismatch check: only flag once the user has paused typing,
  // so the warning doesn't flicker on every keystroke while they're still going.
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
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (!strength.ok) {
      setError("Password is too weak — mix letters, numbers and symbols");
      return;
    }
    if (pw !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (!terms) {
      setError("You must agree to the Terms of Use");
      return;
    }

    flow.password = pw;
    navigate("/create/seed");
  }

  const totalSteps = 3;
  const currentStep = 1;

  const isValid = strength.ok && pw === confirm && terms;

  return (
    <form
      onSubmit={submit}
      class="w-full h-full flex flex-col gap-6"
    >
      {/* Topbar: label + step counter + progress bars */}
      <div class="w-full flex flex-col gap-2.5 overflow-hidden">
        <div class="w-full flex items-start justify-between font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-muted uppercase tracking-[0.52px] whitespace-nowrap">
          <p>Set Password</p>
          <p>Step {currentStep} of {totalSteps}</p>
        </div>
        <div class="w-full flex gap-4">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              class={
                "flex-1 h-2 rounded-full " +
                (i < currentStep ? "bg-blue" : "bg-text-primary")
              }
            />
          ))}
        </div>
      </div>

      {/* Vanity wrapper with blue corner triangles (Figma 154:2578 / 154:2629) */}
      <div class="flex-1 bg-text-primary flex flex-col w-full min-h-0 overflow-hidden">
        <CornerTopLeft />
        <div class="flex-1 w-full flex flex-col items-center justify-between px-10 py-5 min-h-0">

        {/* Header: logo + title + subtitle (shared OnboardingHeader) */}
        <OnboardingHeader
          title="Set Password"
          subtitle="Secure your wallet with a strong password on this device"
        />

        {/* Inputs */}
        <div class="flex-1 w-full flex flex-col items-center justify-center gap-5">
          <div class="w-full flex flex-col items-start gap-1.5">
            {/* Strength label slot is always rendered (invisible when
                empty) so the row's height doesn't change on first
                keystroke — no layout shift, just a colour fade-in. */}
            <label class="w-full flex items-center justify-between font-['Poppins'] text-[13px] leading-[1.2] text-text-dim">
              <span>Password</span>
              <span
                class={
                  "font-semibold uppercase tracking-[0.4px] text-[10px] " +
                  (pw ? "" : "invisible")
                }
                style={{ color: strength.color }}
                aria-hidden={!pw}
              >
                {pw ? strength.label : "—"}
              </span>
            </label>
            <div class="w-full bg-bg-primary/5 border border-bg-primary/10 backdrop-blur-[16px] flex items-center justify-between px-4 py-3 transition-colors duration-150 focus-within:border-blue">
              <input
                type={showPw ? "text" : "password"}
                value={pw}
                onInput={(e) => { setPw(e.currentTarget.value); setError(""); }}
                placeholder="Enter password"
                class="flex-1 min-w-0 bg-transparent outline-none border-none font-['Poppins'] text-[16px] leading-[1.6] text-bg-primary placeholder:text-text-muted"
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
            {/* Strength meter is always rendered: empty segments use a
                neutral grey and only their colour transitions as the
                user types. Removing the opacity flip eliminates the
                "switch" effect on the first keystroke. */}
            <div class="w-full flex gap-1" aria-hidden={!pw}>
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  class="flex-1 h-1 rounded-full transition-colors duration-150"
                  style={{
                    backgroundColor:
                      pw && i <= strength.score
                        ? strength.color
                        : "color-mix(in srgb, var(--color-bg-primary) 10%, transparent)",
                  }}
                />
              ))}
            </div>
            <p class="w-full font-['Poppins'] text-[10px] leading-[1.3] text-text-muted">
              Min {MIN_PASSWORD_LENGTH} chars · letters + numbers + symbols
            </p>
          </div>

          <div class="w-full flex flex-col items-start gap-2">
            <label class="w-full font-['Poppins'] text-[13px] leading-[1.2] text-text-dim">
              Confirm Password
            </label>
            <div class="w-full bg-bg-primary/5 border border-bg-primary/10 backdrop-blur-[16px] flex items-center justify-between px-4 py-3 transition-colors duration-150 focus-within:border-blue">
              <input
                type={showConfirm ? "text" : "password"}
                value={confirm}
                onInput={(e) => { setConfirm(e.currentTarget.value); setError(""); }}
                placeholder="Confirm Password"
                class="flex-1 min-w-0 bg-transparent outline-none border-none font-['Poppins'] text-[16px] leading-[1.6] text-bg-primary placeholder:text-text-muted"
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
            {/* Slot is always rendered to reserve vertical space — toggling
                only `invisible` keeps the layout stable when the warning
                appears/disappears. */}
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
            <div class="w-full text-red text-sm text-center">{error}</div>
          )}
        </div>

        {/* Footer: terms + main button */}
        <div class="w-full flex flex-col items-center justify-end gap-5">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => { setTerms(e.currentTarget.checked); setError(""); }}
              class="size-5 m-0 appearance-none bg-bg-primary/5 border border-black/10 rounded-[4px] checked:bg-blue checked:border-blue cursor-pointer relative checked:after:content-['✓'] checked:after:text-white checked:after:text-[14px] checked:after:absolute checked:after:inset-0 checked:after:flex checked:after:items-center checked:after:justify-center checked:after:leading-none"
            />
            <span class="font-['Poppins'] text-[13px] leading-[1.2] text-text-dim">
              I agree to the{" "}
              <span class="font-['Poppins'] font-bold underline text-text-dim">
                Terms of Use
              </span>
            </span>
          </label>

          <div class="w-full border-2 border-blue p-1.5 transition-colors duration-150 has-[button:hover:not(:disabled)]:border-blue-hover has-[:disabled]:opacity-50">
            <button
              type="submit"
              disabled={!isValid}
              class="w-full bg-blue flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-pointer transition-colors duration-150 hover:bg-primary-600 disabled:hover:bg-blue disabled:cursor-not-allowed"
            >
              Create New Wallet
            </button>
          </div>
        </div>
        </div>
        <CornerBottomRight />
      </div>

    </form>
  );
}
