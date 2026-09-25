/* ═══════════════════════════════════════════════════════════════════
   encryption.js — AES-GCM 256 vault encryption with PBKDF2-SHA256
   ───────────────────────────────────────────────────────────────────
   Security note:
   Vault format v2 uses 600 000 PBKDF2 iterations (OWASP 2023+ guidance
   for SHA-256). Legacy vaults created with v1 (100 000 iterations) are
   still readable — VaultManager will re-encrypt them on next unlock.

   Ciphertext envelope:
     { v: 2, salt: [...], iv: [...], ct: [...], iter: 600000 }
   Legacy envelope (v1, no `v` field, no `iter`):
     { salt: [...], iv: [...], ct: [...] }          // treated as 100k

   Session-key model:
   The popup session must survive popup close without keeping the raw
   password anywhere. Instead of the password, callers can hold the
   DERIVED 256-bit AES key (deriveBits output) plus the envelope's
   salt/iter, and use encryptVaultWithKey / decryptVaultWithKey. The
   derived key can decrypt this vault but cannot reveal the password
   itself (which users often reuse elsewhere). Re-encrypting with the
   session key reuses the envelope's salt — PBKDF2 salts are per-secret,
   not per-encryption, so a stable per-vault salt is sound; the GCM IV
   is always freshly random.
   ═══════════════════════════════════════════════════════════════════ */

export const VAULT_VERSION = 2;
export const PBKDF2_ITERATIONS = 600_000;
const LEGACY_ITERATIONS = 100_000;

async function deriveKeyBytes(password, salt, iterations) {
  const raw = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    raw,
    256
  );
  return new Uint8Array(bits);
}

function importAesKey(keyBytes) {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptWithKeyBytes(keyBytes, saltArr, iterations, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyBytes);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(data))
  );
  return JSON.stringify({
    v: VAULT_VERSION,
    iter: iterations,
    salt: [...saltArr],
    iv: [...iv],
    ct: [...new Uint8Array(ct)],
  });
}

/* Encrypt with a fresh salt derived from the password. Returns the
   derived key material too so the caller can keep a session key without
   paying a second PBKDF2 run. */
export async function encryptVaultDetailed(password, data) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyBytes = await deriveKeyBytes(password, salt, PBKDF2_ITERATIONS);
  const encrypted = await encryptWithKeyBytes(keyBytes, salt, PBKDF2_ITERATIONS, data);
  return {
    encrypted,
    keyBytes: [...keyBytes],
    salt: [...salt],
    iter: PBKDF2_ITERATIONS,
  };
}

export async function encryptVault(password, data) {
  const { encrypted } = await encryptVaultDetailed(password, data);
  return encrypted;
}

/* Re-encrypt with an existing session key. `sessionKey` is the object
   returned alongside unlockVaultDetailed / encryptVaultDetailed:
   { keyBytes, salt, iter }. The salt/iter MUST be the ones the key was
   derived with, or the next password unlock would derive a mismatched
   key and fail GCM authentication. */
export function encryptVaultWithKey(sessionKey, data) {
  const { keyBytes, salt, iter } = sessionKey;
  return encryptWithKeyBytes(keyBytes, salt, iter || PBKDF2_ITERATIONS, data);
}

/* Decrypt with the password and return the derived key material along
   with the data, so the caller can establish a password-free session. */
export async function unlockVaultDetailed(password, encrypted) {
  const parsed = JSON.parse(encrypted);
  const { salt, iv, ct } = parsed;
  // Legacy vaults (v1) have no `v`/`iter` fields → assume 100k iterations.
  const iterations = parsed.iter || LEGACY_ITERATIONS;

  const keyBytes = await deriveKeyBytes(password, new Uint8Array(salt), iterations);
  const key = await importAesKey(keyBytes);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(ct)
  );
  return {
    data: JSON.parse(new TextDecoder().decode(decrypted)),
    keyBytes: [...keyBytes],
    salt: [...salt],
    iter: iterations,
  };
}

export async function decryptVault(password, encrypted) {
  const { data } = await unlockVaultDetailed(password, encrypted);
  return data;
}

/* Decrypt with a previously derived session key (no password, no
   PBKDF2 run). GCM authentication fails if the key doesn't match the
   envelope — e.g. the vault was re-encrypted with a new password. */
export async function decryptVaultWithKey(keyBytes, encrypted) {
  const parsed = JSON.parse(encrypted);
  const { salt, iv, ct } = parsed;
  const iterations = parsed.iter || LEGACY_ITERATIONS;
  const key = await importAesKey(keyBytes);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(ct)
  );
  return {
    data: JSON.parse(new TextDecoder().decode(decrypted)),
    salt: [...salt],
    iter: iterations,
  };
}

/**
 * Returns true if the ciphertext was encrypted with an older format
 * (pre-v2, pre-600k PBKDF2). VaultManager uses this to auto-upgrade
 * on the next unlock.
 */
export function isLegacyVault(encrypted) {
  try {
    const parsed = JSON.parse(encrypted);
    return !parsed.v || parsed.v < VAULT_VERSION ||
           (parsed.iter || LEGACY_ITERATIONS) < PBKDF2_ITERATIONS;
  } catch {
    return false;
  }
}
