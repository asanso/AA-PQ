import { useEffect, useState } from 'preact/hooks';

// A short visual dwell makes a completed signature visible even when the
// bundler accepts immediately. It never delays signing or submission.
export function useExecutionPhase(phase) {
  const signed = ['signed', 'creating', 'verifying'].includes(phase);
  const [showBundler, setShowBundler] = useState(false);
  useEffect(() => {
    setShowBundler(false);
    if (!signed) return;
    const timer = setTimeout(() => setShowBundler(true), 900);
    return () => clearTimeout(timer);
  }, [signed]);
  if (!signed) return phase;
  return showBundler ? 'creating' : 'signed';
}
