/* ═══════════════════════════════════════════════════════════════════
   address.js — EVM address validation helpers
   ───────────────────────────────────────────────────────────────────
   Shared by every flow that takes a user-pasted recipient (Send,
   TransferOwnership). A bare format check (0x + 40 hex) can't catch a
   typo; EIP-55 mixed-case addresses carry a checksum that does.
   ═══════════════════════════════════════════════════════════════════ */

import { getAddress } from "viem";

/** True for a syntactically well-formed 0x-prefixed 20-byte address. */
export function isAddressFormat(raw) {
  return /^0x[0-9a-fA-F]{40}$/.test((raw || "").trim());
}

/* EIP-55 checksum gate. A typo in a hex address is otherwise undetectable
   and a transfer is irreversible. If the user pasted a mixed-case
   (checksummed) address, the case MUST validate — viem's getAddress
   throws on a bad checksum. An all-lower / all-upper address carries no
   checksum information, so it can't be rejected on that basis. */
export function checksumValidAddress(raw) {
  const a = (raw || "").trim();
  if (!isAddressFormat(a)) return false;
  const hex = a.slice(2);
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (!mixed) return true; // no checksum to verify
  try {
    getAddress(a);
    return true;
  } catch {
    return false;
  }
}
