/* ═══════════════════════════════════════════════════════════════════
   useApproval — dApp-request approval flow
   ───────────────────────────────────────────────────────────────────
   When a dApp calls eth_requestAccounts / eth_sendTransaction,
   the background service worker
   parks the request in `pendingRequests` and opens the popup at
   `popup.html#approve/<id>`. The popup reads the pending request
   details and shows an approval screen.

   This hook exposes that flow as a reactive, imperative API so the
   Approval component can focus on UX.

     const approval = useApproval();
     if (!approval.request) return null;
     if (approval.request.method === "eth_requestAccounts") { … }
     await approval.approve({ accounts: [addr] });  // connect
      await approval.approve();                      // tx: uses dapp-handler
     await approval.reject();
   ═══════════════════════════════════════════════════════════════════ */

import { signal } from "@preact/signals";
import { approvalData, approvalMode } from "@/ui/store.js";
import { handleDappTransaction } from "@/transactions/dapp-handler.js";

const submitting = signal(false);
const statusMsg = signal("");
const errorMsg = signal(null);
const transactionPhase = signal("idle");

/** Ask the background for the pending request parked under this id. */
function fetchPending(pendingId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_PENDING", pendingId }, (res) => {
      resolve(res || null);
    });
  });
}

/** Send the decision back to the background and close the popup. */
function reply(pendingId, payload) {
  chrome.runtime.sendMessage({
    type: "APPROVAL_RESULT",
    pendingId,
    ...payload,
  });
}

function normalizeAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr)
    ? addr.toLowerCase()
    : null;
}

function assertRequestAccount(req, address) {
  const expected = normalizeAddress(req?.account);
  const actual = normalizeAddress(address);
  if (expected && actual && expected !== actual) {
    throw new Error("Requested account is not connected to this site");
  }
  return actual || expected;
}

export function useApproval() {
  return {
    /** Reactive current request: { method, params, origin, pendingId } | null. */
    get request() { return approvalData.value; },
    /** Reactive: true when the popup was opened specifically for an approval. */
    get isApprovalPopup() { return approvalMode.value; },
    /** Reactive: true while approve() is running (signing in flight). */
    get submitting() { return submitting.value; },
    /** Short human-readable progress message, updated during approve(). */
    get status() { return statusMsg.value; },
    get phase() { return transactionPhase.value; },
    /** Last error thrown during approve(), if any. */
    get error() { return errorMsg.value; },

    /**
     * Load a pending request by id into the store. Called by the popup
     * entry point when the URL hash is #approve/<id>.
     *
     * Returns the request object or null if it has expired / unknown.
     */
    async load(pendingId) {
      const pending = await fetchPending(pendingId);
      if (!pending) return null;
      approvalData.value = { ...pending, pendingId };
      approvalMode.value = true;
      return approvalData.value;
    },

    /**
     * Manually set approval data — used when the background pushes a
     * fresh request into an already-open popup via runtime.onMessage
     * (APPROVE_REQUEST).
     */
    setRequest(data) {
      approvalData.value = data;
      approvalMode.value = true;
    },

    /**
     * Approve the currently-loaded request.
     *
     * For eth_requestAccounts: pass `{ accounts: [address] }` — the
     * array that will be shared with the dApp.
     *
     * For signing/sending methods: no args needed. The hook reads
     * params from the stored request and dispatches to the appropriate
     * vaultManager / dapp-handler function.
     *
     * On success, sends APPROVAL_RESULT to background and updates the
     * status signal to "✓ Success". The hook DOES NOT close the window
     * or navigate — that decision belongs to the Approval component,
     * which knows whether it's running inside a detached popup (close)
     * or a sidepanel/inline popup (stay and navigate to /dashboard).
     */
    async approve({ accounts, reviewed } = {}) {
      const req = approvalData.value;
      if (!req) throw new Error("No pending request to approve");

      submitting.value = true;
      errorMsg.value = null;
      transactionPhase.value = "connecting";

      try {
        const { method, pendingId } = req;
        const params = req.params || [];

        if (method === "eth_requestAccounts") {
          statusMsg.value = "Connecting…";
          reply(pendingId, { approved: true, accounts: accounts || [] });
        } else if (method === "eth_sendTransaction") {
          statusMsg.value = "Preparing frame transaction…";
          const tx = params[0] || {};
          assertRequestAccount(req, tx.from);
          const result = await handleDappTransaction(tx, null, {
            reviewed,
            onPhase: phase => { transactionPhase.value = phase; },
          });
          transactionPhase.value = "done";
          reply(pendingId, { approved: true, result: result.txHash });
        } else {
          throw new Error(`Unsupported method: ${method}`);
        }

        statusMsg.value = "";
      } catch (e) {
        transactionPhase.value = "error";
        errorMsg.value = e;
        statusMsg.value = "";
        throw e;
      } finally {
        submitting.value = false;
      }
    },

    /**
     * Reject the currently-loaded request. Sends APPROVAL_RESULT with
     * approved:false to the background.
     *
     * Like approve(), this does NOT close the window or navigate —
     * the caller decides.
     */
    reject() {
      const req = approvalData.value;
      if (!req) return;
      reply(req.pendingId, { approved: false });
    },

    /** Clear local approval state. Used in tests / after reject. */
    clear() {
      approvalData.value = null;
      approvalMode.value = false;
      submitting.value = false;
      statusMsg.value = "";
      errorMsg.value = null;
      transactionPhase.value = "idle";
    },
  };
}
