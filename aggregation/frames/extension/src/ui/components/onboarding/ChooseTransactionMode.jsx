import { useLocation } from 'wouter-preact';
import { useOnboardingFlow } from '@/ui/hooks/useOnboardingFlow.js';
import { vaultManager } from '@/vault/VaultManager.js';
import { OnboardingHeader } from './OnboardingHeader.jsx';
import { CornerTopLeft, CornerBottomRight } from './OnboardingCorners.jsx';
import aggregation from '@/aggregated-frame/deployment.json';

const options = [
  { id: 'frame', title: 'Aggregated frames', description: 'SPHINCS-G with a block proof.' },
  { id: 'aa', title: 'ERC-4337', description: 'Send UserOperations via bundler.' },
];

export function ChooseTransactionMode() {
  const [, navigate] = useLocation();
  const flow = useOnboardingFlow();

  function select(mode) {
    if (flow.transactionMode !== mode) {
      // A changed setup choice must not reuse an account computed for the other factory.
      vaultManager.lock();
      flow.phrase = '';
      flow.smartAddress = '';
      flow.transactionMode = mode;
    }
  }

  return (
    <div class="h-full w-full flex flex-col gap-3 font-['Poppins',sans-serif]">
      <div class="flex flex-col gap-2.5 w-full">
        <div class="flex justify-between font-semibold text-[13px] uppercase text-text-muted tracking-[0.52px]">
          <p>Transaction mode</p><p>Step 1 of {flow.branch === 'import' ? 5 : 4}</p>
        </div>
        <div class="h-[2px] w-full bg-blue" />
      </div>
      <div class="relative flex-1 bg-text-primary flex flex-col min-h-0">
        <CornerTopLeft />
        <div class="flex-1 flex flex-col justify-center px-5 py-2 gap-2">
          <OnboardingHeader title="Transaction Mode" subtitle="SPHINCS-G in both modes."
            icon={<img src="/nicetry_logo_outline.svg" alt="" class="size-16 rounded-full shrink-0" />} />
          <fieldset class="flex flex-col gap-3 border-0 p-0 m-0">
            <legend class="sr-only">Transaction mode</legend>
            {options.map(option => (
              <label key={option.id} class="flex items-start gap-3 border-2 px-3 py-2 cursor-pointer transition-colors border-bg-primary/20 hover:border-blue has-[:checked]:border-blue has-[:checked]:bg-blue/10">
                <input type="radio" name="transaction-mode" value={option.id}
                  checked={flow.transactionMode === option.id} onChange={() => select(option.id)}
                  class="mt-1 shrink-0 accent-blue" />
                <span class="flex flex-col gap-1">
                  <span class="font-bold text-[16px] text-bg-primary">{option.title}</span>
                  <span class="text-[12px] leading-relaxed text-text-dim">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p class="text-[12px] leading-relaxed text-text-dim">
            {aggregation.active
              ? 'Each mode has its own account. Restore with the original mode.'
              : 'Aggregation preview. Native setup is unavailable until chain activation.'}
          </p>
        </div>
        <div class="shrink-0 px-5 pb-3 pt-2">
          <div class="w-full border-2 border-blue p-1.5 has-[:disabled]:opacity-40">
            <button type="button" disabled={!flow.transactionMode || (flow.transactionMode === 'frame' && !aggregation.active)}
              onClick={() => navigate(flow.branch === 'import' ? '/import/seed' : '/create/password')}
              class="w-full bg-blue py-3 px-8 text-text-primary font-bold text-[16px] uppercase tracking-[0.48px] hover:bg-primary-600 disabled:cursor-not-allowed">
              Continue
            </button>
          </div>
        </div>
        <CornerBottomRight />
      </div>
    </div>
  );
}
