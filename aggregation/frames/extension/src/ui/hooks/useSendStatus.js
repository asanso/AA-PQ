import { computed } from '@preact/signals';
import { logs, busy } from '@/ui/store.js';
import { deriveSendPhase } from '@/ui/utils/execution-status.js';

const phase = computed(() => deriveSendPhase(logs.value, busy.value));

export function useSendStatus() {
  return {
    get phase() { return phase.value; },
    get active() { return busy.value; },
  };
}
