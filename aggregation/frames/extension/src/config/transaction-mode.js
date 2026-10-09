import { signal } from '@preact/signals';

export const TRANSACTION_MODES = Object.freeze({
  frame: 'Aggregated frames',
  aa: 'ERC-4337',
});

// This signal is a UI mirror. Signing reads the authenticated vault instead.
export const transactionMode = signal(null);

export function requireTransactionMode(mode) {
  if (!Object.hasOwn(TRANSACTION_MODES, mode)) {
    throw new Error('Choose Aggregated frames or ERC-4337 during wallet setup.');
  }
  return mode;
}
