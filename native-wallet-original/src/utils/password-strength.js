/* ═══════════════════════════════════════════════════════════════════
   password-strength — lightweight password strength estimator
   ───────────────────────────────────────────────────────────────────
   No dictionary lookup, no external deps (zxcvbn weighs ~700KB and
   is overkill for an in-extension tier indicator). Tiering is based
   on length + variety of character classes, with a hard floor on
   length below which the password is rejected.

   Output: { tier, label, color, score, ok }
     - tier  : 0=too-short, 1=weak, 2=fair, 3=good, 4=strong
     - score : 0..4 for progress-bar segments
     - ok    : boolean — false for tier 0/1, used to gate submit

   Rationale for the thresholds:
     - 10 chars is the practical floor for AES-GCM(PBKDF2-600k) to
       stay infeasible against consumer GPU brute-force.
     - 14 chars with ≥3 classes = "Strong" because that's where a
       random-ish password crosses ~80 bits of effective entropy.
     - We don't claim to estimate true entropy — just to nudge the
       user toward something the vault crypto can actually defend.
   ═══════════════════════════════════════════════════════════════════ */

export const MIN_PASSWORD_LENGTH = 10;

export const TIERS = {
  TOO_SHORT: 0,
  WEAK:      1,
  FAIR:      2,
  GOOD:      3,
  STRONG:    4,
};

const TIER_META = {
  0: { label: "Too short",  color: "var(--color-red)" },
  1: { label: "Weak",       color: "var(--color-red)" },
  2: { label: "Fair",       color: "var(--color-amber)" },
  3: { label: "Good",       color: "var(--color-green)" },
  4: { label: "Strong",     color: "var(--color-green)" },
};

export function evaluatePassword(pw) {
  if (!pw) {
    return { tier: 0, score: 0, ok: false, label: "Too short", color: "var(--color-text-muted)" };
  }

  const len = pw.length;
  if (len < MIN_PASSWORD_LENGTH) {
    return { tier: 0, score: 0, ok: false, ...TIER_META[0] };
  }

  // Count character classes present.
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^a-zA-Z0-9]/.test(pw)) classes++;

  let tier;
  if (len < 12 || classes < 2) {
    tier = TIERS.WEAK;
  } else if (len < 14 || classes < 3) {
    tier = TIERS.FAIR;
  } else if (len < 16) {
    tier = TIERS.GOOD;
  } else {
    tier = TIERS.STRONG;
  }

  return { tier, score: tier, ok: tier >= TIERS.FAIR, ...TIER_META[tier] };
}
