import { signal } from '@preact/signals';

// The wallet's only transaction mode: native frame transactions whose account verifies a leanSPHINCS signature.
// The vault still records the mode, so a vault set up for a mode this build no longer has is refused, not reused.
export const TRANSACTION_MODES = Object.freeze({
  native: 'Native frames',
});
export const DEFAULT_TRANSACTION_MODE = 'native';

// This signal is a UI mirror. Signing reads the authenticated vault instead.
export const transactionMode = signal(null);

export function requireTransactionMode(mode) {
  if (!Object.hasOwn(TRANSACTION_MODES, mode)) {
    throw new Error(mode
      ? 'This wallet was set up for a transaction mode this build no longer supports. Reset it and restore it from its recovery phrase.'
      : 'Choose a transaction mode during wallet setup.');
  }
  return mode;
}
