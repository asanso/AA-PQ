import { useLocation } from "wouter-preact";
import { signedActivity } from "@/transactions/transaction-activity.js";
import { formatSigningMs } from "@/ui/utils/transaction-activity.js";
import { useEffect, useState } from 'preact/hooks';
import { useSendStatus } from '@/ui/hooks/useSendStatus.js';
import { useExecutionPhase } from '@/ui/hooks/useExecutionPhase.js';
import { EXECUTION_LABELS } from '@/ui/utils/execution-status.js';

const DONE_DWELL_MS = 2000;

export function ExecutingOverlay() {
  const status = useSendStatus();
  const [, navigate] = useLocation();
  const notice = signedActivity.value;
  const [dismissed, setDismissed] = useState(null);
  useEffect(() => {
    if (!notice?.activityId) return;
    const timer = setTimeout(() => {
      setDismissed(notice.activityId);
      navigate('/dashboard');
    }, 450);
    return () => clearTimeout(timer);
  }, [notice?.activityId]);
  const [visible, setVisible] = useState(false);
  const phase = useExecutionPhase(status.phase);

  // Keep the real terminal result visible briefly. Ending busy never
  // manufactures success: only a DONE event produces the Done label.
  useEffect(() => {
    if (status.active) {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(false), DONE_DWELL_MS);
    return () => clearTimeout(timer);
  }, [status.active]);

  if (notice?.activityId && dismissed === notice.activityId) return null;
  if (!status.active && !visible && !notice) return null;
  const isError = !notice && phase === 'error';
  const spinning = !notice && !['done', 'error', 'signed'].includes(phase);
  return (
    <div class="fixed inset-0 z-40 bg-bg-primary flex flex-col items-center justify-center gap-6 px-4 text-text-primary">
      <div class="size-16 rounded-full bg-primary-50 p-1.5 flex items-center justify-center">
        <img src="/nicetry_logo_outline.svg" alt=""
          class={'size-[52px] ' + (spinning ? 'animate-spin' : '')}
          style={{ animationDuration: '1.6s' }} />
      </div>
      <p role="status" aria-live="polite" class={'type-label-special whitespace-pre-line text-center ' + (isError ? 'text-red' : 'text-blue-hover')}>
        {notice ? 'Signature complete' : EXECUTION_LABELS[phase] || EXECUTION_LABELS.connecting}
      </p>
      {notice && formatSigningMs(notice.signingMs) && (
        <p class="type-mono-code-sm text-text-secondary">Signed in {formatSigningMs(notice.signingMs)}</p>
      )}
    </div>
  );
}
