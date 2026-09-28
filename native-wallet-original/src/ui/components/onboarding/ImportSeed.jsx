/* ═══════════════════════════════════════════════════════════════════
   ImportSeed — import flow step 1/4 (Figma 536:2173 "Recovery Seed Phrase")
   ───────────────────────────────────────────────────────────────────
   Twelve numbered word fields (3×4 grid) instead of one textarea.
     - Each field is a numbered cell (1.…12.) with its own input.
     - Pasting a full phrase into ANY field (or typing a word + space)
       spreads the words across the following fields automatically and
       advances focus — paste your whole 12-word phrase into field 1.
     - Words are trimmed + lower-cased on submit; BIP-39 checksum is
       verified later (HdKeyring derives the root in restoreVault).

   On continue → stash phrase in flow, go to /import/password.

   UI matches the onboarding design system: CardShell, OnboardingHeader
   (circular logo + title + subtitle), blue corner triangles, the bordered
   CONTINUE button. Cells use themeable tokens (bg-bg-primary/5, blue focus).
   ═══════════════════════════════════════════════════════════════════ */

import { useState, useRef } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { Mnemonic } from "ethers/wallet";
import { LangEn } from "ethers/wordlists";
import { useOnboardingFlow } from "@/ui/hooks/useOnboardingFlow.js";
import { OnboardingHeader } from "./OnboardingHeader.jsx";
import { CornerTopLeft, CornerBottomRight } from "./OnboardingCorners.jsx";

const STEP = 1;
const TOTAL_STEPS = 4;
const WORD_COUNT = 12;

/* BIP-39 English wordlist singleton — getWordIndex(word) is -1 when the
   word isn't a valid recovery word. */
const WORDLIST = LangEn.wordlist();

/* Alert-triangle glyph for the invalid-phrase state (Figma 274:4138). */
function WarningIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
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

      {/* Vanity wrapper with blue corner triangles */}
      <div class="flex-1 bg-text-primary flex flex-col w-full min-h-0 overflow-hidden">
        <CornerTopLeft />
        <div class="flex-1 w-full flex flex-col items-center justify-between px-10 py-5 min-h-0 gap-5 overflow-y-auto">
          {children}
        </div>
        <CornerBottomRight />
      </div>
    </div>
  );
}

export function ImportSeed() {
  const [, navigate] = useLocation();
  const flow = useOnboardingFlow();

  const init = (flow.phrase || "").trim().split(/\s+/).filter(Boolean);
  const [words, setWords] = useState(() =>
    Array.from({ length: WORD_COUNT }, (_, i) => init[i] || "")
  );
  const [error, setError] = useState("");
  // When the entered phrase is invalid we swap the grid for a full error
  // view (Figma 274:4108): { title, body, focus } — focus is the 0-based
  // index of the first bad field so "Return to Seed" lands the cursor there.
  const [seedError, setSeedError] = useState(null);
  const inputs = useRef([]);

  /* A single keystroke updates one field; whitespace (paste of a full
     phrase, or typing a word + space) spreads tokens across the following
     fields and advances focus. */
  function handleInput(i, raw) {
    setError("");
    const toks = raw.split(/\s+/);
    if (toks.length <= 1) {
      setWords((prev) => {
        const n = [...prev];
        n[i] = raw;
        return n;
      });
      return;
    }
    setWords((prev) => {
      const n = [...prev];
      let j = i;
      for (const t of toks) {
        if (j > WORD_COUNT - 1) break;
        if (t) n[j++] = t.toLowerCase();
      }
      const focusIdx = Math.min(j, WORD_COUNT - 1);
      queueMicrotask(() => inputs.current[focusIdx]?.focus());
      return n;
    });
  }

  function onKeyDown(i, e) {
    // Backspace on an empty field hops to the previous one.
    if (e.key === "Backspace" && !words[i] && i > 0) {
      e.preventDefault();
      inputs.current[i - 1]?.focus();
    }
  }

  const isValid = words.every((w) => w.trim().length > 0);

  function submit(e) {
    e?.preventDefault?.();
    const filled = words.map((w) => w.trim().toLowerCase());
    if (filled.some((w) => !w)) {
      setError(`Enter all ${WORD_COUNT} words`);
      return;
    }

    // Validate each word against the BIP-39 wordlist. `bad` holds the
    // EXACT word numbers (1-based) of every word that isn't recognised —
    // these are the human positions shown to the user, not array indices.
    const bad = [];
    filled.forEach((w, i) => {
      if (WORDLIST.getWordIndex(w) === -1) bad.push(i + 1);
    });

    if (bad.length > 0) {
      const single = bad.length === 1;
      setSeedError({
        title: single
          ? `Something wrong at index ${bad[0]}`
          : `Something wrong at index ${bad.join(", ")}`,
        body: single
          ? `Word #${bad[0]} isn't a valid recovery word. Check its spelling against your backup, then return to the seed to correct it.`
          : `Words #${bad.join(", ")} aren't valid recovery words. Check their spelling against your backup, then return to the seed to correct them.`,
        focus: bad[0] - 1,
      });
      return;
    }

    // All words are valid on their own — confirm they form a valid phrase
    // (BIP-39 length + checksum).
    const phrase = filled.join(" ");
    if (!Mnemonic.isValidMnemonic(phrase)) {
      setSeedError({
        title: "Invalid recovery phrase",
        body: "Every word is valid, but together they don't form a valid recovery phrase. Double-check the words and their order, then return to the seed.",
        focus: 0,
      });
      return;
    }

    flow.phrase = phrase;
    navigate("/import/password");
  }

  /* Leave the error view back to the input grid, focusing the first bad
     field. Entered words are preserved (state isn't unmounted). */
  function returnToSeed() {
    const idx = seedError?.focus ?? 0;
    setSeedError(null);
    setError("");
    queueMicrotask(() => inputs.current[idx]?.focus());
  }

  /* Invalid-phrase view (Figma 274:4108): header + red alert carrying the
     exact wrong word number(s), then Return to Seed / Cancel. */
  if (seedError) {
    return (
      <div class="w-full h-full flex flex-col">
        <CardShell>
          <div class="w-full flex flex-col items-center gap-2.5">
            <OnboardingHeader
              title="Recovery Seed Phrase"
              subtitle="Enter your 12-word seed phrase to restore your wallet"
            />

            <div class="w-full flex gap-3 items-start bg-red/10 border border-red rounded-[8px] p-[13px] text-red">
              <span class="shrink-0 mt-0.5">
                <WarningIcon />
              </span>
              <div class="flex-1 min-w-0 flex flex-col gap-1">
                <p class="font-['Inter'] font-bold text-[13px] leading-[1.6]">
                  {seedError.title}
                </p>
                <p class="font-['Inter'] text-[13px] leading-[1.6]">
                  {seedError.body}
                </p>
              </div>
            </div>
          </div>

          <div class="w-full flex flex-col items-center gap-3">
            <div class="w-full border-2 border-blue p-1.5 transition-colors duration-150 has-[button:hover]:border-blue-hover">
              <button
                type="button"
                onClick={returnToSeed}
                class="w-full bg-blue flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-pointer transition-colors duration-150 hover:bg-primary-600"
              >
                Return to Seed
              </button>
            </div>
            <button
              type="button"
              onClick={() => navigate("/")}
              class="w-full bg-transparent border-2 border-bg-primary flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-bg-primary uppercase tracking-[0.48px] cursor-pointer transition-colors duration-150 hover:bg-bg-primary hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </CardShell>
      </div>
    );
  }

  return (
    <form onSubmit={submit} class="w-full h-full flex flex-col">
      <CardShell>
        <OnboardingHeader
          title="Recovery Seed Phrase"
          subtitle="Enter your 12-word seed phrase to restore your wallet"
        />

        {/* 12 numbered word fields (3×4). */}
        <div class="w-full flex flex-col gap-3">
          <div class="w-full grid grid-cols-3 gap-3">
            {words.map((w, i) => (
              <label
                key={i}
                class="relative flex flex-col items-center justify-center min-w-0 overflow-hidden bg-bg-primary/5 border border-bg-primary/15 rounded-[4px] px-4 py-3 transition-colors duration-150 focus-within:border-blue"
              >
                {/* Index sits in the top-left corner (Figma 536:2135). */}
                <span class="absolute left-0 top-0 px-1.5 py-1 font-['Inter'] font-medium text-[11px] leading-[1.2] text-bg-primary/70 select-none pointer-events-none">
                  {i + 1}.
                </span>
                <input
                  ref={(el) => (inputs.current[i] = el)}
                  value={w}
                  onInput={(e) => handleInput(i, e.currentTarget.value)}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellcheck={false}
                  aria-label={`Word ${i + 1}`}
                  class="w-full min-w-0 bg-transparent outline-none border-none text-center font-['Inter'] text-[13px] leading-[1.2] text-bg-primary placeholder:text-text-muted"
                  autoFocus={i === 0}
                />
              </label>
            ))}
          </div>
          <p
            class={
              "w-full font-['Poppins'] text-[13px] leading-[1.2] text-red " +
              (error ? "" : "invisible")
            }
            aria-hidden={!error}
          >
            {error || "placeholder"}
          </p>
        </div>

        {/* Footer — Continue. "Back" lives outside the card (OnboardingBack). */}
        <div class="w-full flex flex-col items-center gap-3">
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
