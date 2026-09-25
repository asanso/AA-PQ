/* ═══════════════════════════════════════════════════════════════════
   session.js — chrome.storage.session derived-key helpers
   ───────────────────────────────────────────────────────────────────
   The session secret survives popup close but is cleared when the
   browser exits or when the vault locks. Storing it in
   `chrome.storage.session` keeps it out of disk and out of extension
   storage that would persist across browser restarts.

   What is stored is NOT the vault password but the PBKDF2-derived
   AES key bytes (see encryption.js "Session-key model"). The derived
   key can open this vault, but cannot reveal the password itself —
   which users often reuse elsewhere — and is useless against a vault
   re-encrypted with a different password.

   Extracted from the legacy src/popup/main.js so both the new
   main.jsx entry point and the legacy pages (Unlock, Dashboard) can
   import from a neutral location. The legacy re-exports in main.js
   forward here so existing imports keep working.
   ═══════════════════════════════════════════════════════════════════ */

const SESSION_KEY_KEY = "nt_session_key";
const SESSION_EXPIRY_KEY = "nt_session_expires_at";
/* Pre-derived-key versions stored the raw password under this key.
   Always include it in removals so an upgraded install never keeps a
   stale plaintext password around. */
const LEGACY_PASSWORD_KEY = "nt_session_pw";
/* Default lock window written alongside the key in case the SW
   hasn't processed SESSION_START yet by the time the popup opens.
   Matches DEFAULT_AUTOLOCK_MIN in background/index.js — when the SW
   eventually runs startSession() it overwrites this with the
   user-configured nt_autolock_min value. Without this client-side
   write, getSessionKey() right after onboarding can see the key
   without an expiry, treat the session as expired, and wipe both
   keys — sending the user back to the unlock screen on the very
   first wallet open. */
const DEFAULT_SESSION_MS = 10 * 60 * 1000;

function hardenSessionAccess() {
  try {
    chrome.storage.session?.setAccessLevel?.({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch {}
}

/** Resolves to the derived vault-key bytes (number[]) or null. */
export function getSessionKey() {
  return new Promise((resolve) => {
    hardenSessionAccess();
    if (chrome.storage.session) {
      chrome.storage.session.get([SESSION_KEY_KEY, SESSION_EXPIRY_KEY], (r) => {
        const keyBytes = r?.[SESSION_KEY_KEY] || null;
        const expiresAt = Number(r?.[SESSION_EXPIRY_KEY] || 0);
        if (!Array.isArray(keyBytes) || !keyBytes.length || !expiresAt || expiresAt <= Date.now()) {
          chrome.storage.session.remove([
            SESSION_KEY_KEY,
            SESSION_EXPIRY_KEY,
            LEGACY_PASSWORD_KEY,
          ]);
          resolve(null);
          return;
        }
        chrome.runtime?.sendMessage?.({ type: "SESSION_ACTIVITY" }).catch?.(() => {});
        resolve(keyBytes);
      });
    } else {
      resolve(null);
    }
  });
}

/** Stores the derived vault-key bytes (number[] from
    vaultManager.getSessionKeyBytes()). */
export function storeSessionKey(keyBytes) {
  hardenSessionAccess();
  if (chrome.storage.session && Array.isArray(keyBytes) && keyBytes.length) {
    const expiresAt = Date.now() + DEFAULT_SESSION_MS;
    chrome.storage.session.set(
      { [SESSION_KEY_KEY]: keyBytes, [SESSION_EXPIRY_KEY]: expiresAt },
      () => {
        chrome.storage.session.remove([LEGACY_PASSWORD_KEY]);
        chrome.runtime?.sendMessage?.({ type: "SESSION_START" }).catch?.(() => {});
      },
    );
  }
}

export function clearSessionKey() {
  if (chrome.storage.session) {
    chrome.storage.session.remove([
      SESSION_KEY_KEY,
      SESSION_EXPIRY_KEY,
      LEGACY_PASSWORD_KEY,
    ]);
  }
}
