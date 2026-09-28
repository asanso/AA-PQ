// Only an explicit completed signature permits the UI to leave signing.
export const EXECUTION_LABELS = {
  idle: 'Preparing transaction…',
  connecting: 'Preparing transaction…',
  signing: 'Signing transaction…',
  signed: 'Signature complete',
  creating: 'Signature complete\nSubmitting transaction…',
  verifying: 'Signature complete\nSubmitting transaction…',
  destroying: 'Confirming transaction…',
  done: 'Done',
  error: 'Transaction failed',
};

export function deriveSendPhase(entries, active) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const { msg = '', type } = entries[i] || {};
    if (type === 'err') return 'error';
    if (msg === 'Transaction started' || /^═+ (?:SEND|FIRST SEND)/.test(msg)) {
      return active ? 'connecting' : 'idle';
    }
    if (/^═+ DONE ═+$/.test(msg)) return 'done';
    if (/^Tx:/.test(msg)) return 'destroying';
    if (msg === 'Signature complete') return 'signed';
    if (/^Signing with /.test(msg)) return 'signing';
  }
  return active ? 'connecting' : 'idle';
}
