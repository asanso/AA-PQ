

import { busy, recipient, amount, selectedToken, chainId, smartAddr } from "@/ui/store.js";
import { getActiveNetwork, isSphincsChain } from "@/config/networks.js";
import { vaultManager } from "@/vault/VaultManager.js";
import { parseEther } from "viem";





import { runQueuedSend, manualSendCount, assertSendContext } from '@/transactions/manual-send-queue.js';

export function useSendTransaction() {
  return {

    get busy() { return busy.value; },
    get willQueue() { return manualSendCount.value > 0; },


    get recipient()  { return recipient.value; },
    set recipient(v) { recipient.value = v; },
    get amount()     { return amount.value; },
    set amount(v)    { amount.value = v; },

    get selectedToken()  { return selectedToken.value; },
    set selectedToken(v) { selectedToken.value = v; },


    async run(override) {
      if (!isSphincsChain(getActiveNetwork())) {
        throw new Error("This build supports only SPHINCS-G sends on Daisugi.");
      }
      if (override?.recipient !== undefined) recipient.value = override.recipient;
      if (override?.amount !== undefined)    amount.value = String(override.amount);
      const request = Object.freeze({
        recipient: recipient.value, amount: String(amount.value),
        reviewed: override?.reviewed,
        selectedToken: selectedToken.value ? Object.freeze({ ...selectedToken.value }) : null,
        accountIndex: vaultManager.getActiveAccountIndex(), chainId: chainId.value, smartAddr: smartAddr.value,
      });
      return runQueuedSend(request, dispatchSend);
    },
  };
}

async function dispatchSend(request,options) {
  assertSendContext(request);
  const {sendViaSphincs}=await import('@/transactions/sphincs-send.js');
  return sendViaSphincs({request,...options,assertContext:()=>assertSendContext(request)});
}
