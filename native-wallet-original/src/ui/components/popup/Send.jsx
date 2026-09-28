

import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useExecutionPhase } from "@/ui/hooks/useExecutionPhase.js";
import { EXECUTION_LABELS as PHASE_LABELS } from "@/ui/utils/execution-status.js";
import {
  useSendTransaction,
  useBalance,
  useNetwork,
  useSendStatus,
  useTokens,
} from "@/ui/hooks";

import { publicClient } from "@/blockchain/client.js";
import { estimateUserOpCost, fetchFeeTiers } from "@/blockchain/gas-estimate.js";
import { resolveSendFees } from "@/blockchain/fee-preferences.js";
import { NetworkFeeButton, NetworkFeePage } from "./NetworkFeePicker.jsx";

import { checksumValidAddress } from "@/utils/address.js";
import { smartAddr, signingMethod } from "@/ui/store.js";
import { vaultManager } from "@/vault/VaultManager.js";
import { getActiveNetwork, isSphincsChain } from "@/config/networks.js";
import { encodeErc20Transfer, parseTokenAmount } from "@/blockchain/erc20.js";
import { parseEther, formatEther } from "viem";
import { TokenIcon } from "./dashboard/TokenIcon.jsx";
import { nativeIconUrl, tokenIconUrl } from "@/ui/utils/asset-icon.js";
import { SubPageShell } from "./dashboard/SubPageShell.jsx";



function shortenAddr(a) {
  if (!a || typeof a !== "string" || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}...${a.slice(-6)}`;
}

const DONE_DWELL_MS = 2000;

/** Truncate a long decimal string in the "1000…0000" middle-ellipsis
    form used by the figma DATA card. Keeps first 6 + last 6 chars. */
function shortenLong(s) {
  if (!s || s.length <= 14) return s || "—";
  return `${s.slice(0, 6)}...${s.slice(-6)}`;
}

function SendIcon() {
  return (
 <svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 15 15" fill="none">
  <path d="M4.375 4.375H10.625V10.625" stroke="#3F56E3" stroke-width="1.5625" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M4.375 10.625L10.625 4.375" stroke="#3F56E3" stroke-width="1.5625" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
  );
}

/* 32px circular Dicebear "thumbs" avatar seeded by an address. Same
   visual used in DashboardHeader for the smart account, reused here
   in the recap From/To rows so each side of the transfer gets its
   own deterministic thumb instead of a flat blue circle. */
function AddrThumb({ addr }) {
  const seed = addr || "nicetry";
  const url = `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed)}`;
  return (
    <div class="rounded-full overflow-hidden shrink-0 size-8 flex items-center justify-center">
      <img src={url} alt="" class="block w-full h-full" referrerPolicy="no-referrer" />
    </div>
  );
}

export function Send() {
  const [, navigate] = useLocation();
  const send = useSendTransaction();
  const bal = useBalance();
  const net = useNetwork();
  const status = useSendStatus();
  const tokensApi = useTokens();

  const [error, setError] = useState("");
  const [step, setStep] = useState("asset");
  const [nonce, setNonce] = useState(null);
  /* Gas pre-flight result — null while checking, then the object from
     estimateUserOpCost. The Confirm button is gated on .sufficient. */
  const [gasCheck, setGasCheck] = useState(null);
  const [gasChecking, setGasChecking] = useState(false);
  /* Network-fee picker page (Figma 181:6494). While open we render it
     INSTEAD of the Send shell — Send stays mounted so step/gasCheck
     survive the round-trip. */
  const [feeOpen, setFeeOpen] = useState(false);
  /* `submitted` gates the "executing/done" UI to this lifecycle. The
     global useSendStatus phase reads from logs which still contain
     DONE/error from previous sends — without this flag, opening Send
     after a successful tx would immediately show "✓ Done" and auto-
     navigate back to the dashboard, blocking new sends. */
  const [submitted, setSubmitted] = useState(false);
  const submitting = useRef(false);
  const willQueue = send.willQueue;

  const [sendOutcome, setSendOutcome] = useState(null);
  const realPhase = !submitted ? 'idle'
    : sendOutcome === 'error' ? 'error'
    : sendOutcome === 'success' ? 'done'
    : status.active ? status.phase : 'connecting';
  const heldPhase = useExecutionPhase(realPhase);

  const selectedToken = send.selectedToken; // null = native
  const networkSymbol = net.network.value?.symbol || "ETH";
  const networkName = net.network.value?.name || "Ethereum";
  const fromAddr = smartAddr.value;


  const needsEnroll = false;

  /* Fixed SPHINCS-G signing policy. Its fees are
     hardcoded over-provisioned (submitSphincsUserOp), so the network-fee
     picker doesn't apply — the recap shows a fixed estimate instead. */
  const sphincsSend =
    signingMethod.value === "sphincs" && isSphincsChain(getActiveNetwork());

  /* When sending an ERC-20: symbol + balance come from the token, not
     from the network's native asset. */
  const symbol = selectedToken ? selectedToken.symbol : networkSymbol;
  const tokenBalances = tokensApi.balances.value;
  const available = selectedToken
    ? (tokenBalances[selectedToken.address.toLowerCase()] ?? "0.000000")
    : bal.sa.value;

  /* ── Reset send-state when this component unmounts ─────────────
     recipient + amount are global signals, so without an explicit
     reset they survive navigation and reappear pre-filled the next
     time the user enters /send — which feels like the wallet is
     "remembering" a prior destination. Clear them along with the
     selected token so every visit to /send starts blank. */
  useEffect(() => {
    return () => {
      send.selectedToken = null;
      send.recipient = "";
      send.amount = "";
    };
  }, []);

  // Navigate only after this submission actually succeeded.
  useEffect(() => {
    if (!submitted || sendOutcome !== 'success') return;
    bal.refresh().catch(() => {});
    tokensApi.refresh().catch(() => {});
    const timer = setTimeout(() => navigate('/dashboard'), DONE_DWELL_MS);
    return () => clearTimeout(timer);
  }, [submitted, sendOutcome]);

  /* ── Refresh balances when entering the asset picker ─────────── */
  useEffect(() => {
    if (step !== "asset") return;
    bal.refresh().catch(() => {});
    tokensApi.refresh().catch(() => {});
  }, [step]);

  /* ── Fetch nonce on-chain when entering recap ────────────────── */
  useEffect(() => {
    if (step !== "recap") return;
    let cancelled = false;
    setNonce(null);
    (async () => {
      try {
        if (!fromAddr) {
          if (!cancelled) setNonce("—");
          return;
        }
        const n = await publicClient.getTransactionCount({address:fromAddr,blockTag:'pending'});
        if (!cancelled) setNonce(n.toString());
      } catch {
        if (!cancelled) setNonce("—");
      }
    })();
    return () => { cancelled = true; };
  }, [step, fromAddr, willQueue]);

  /* ── Pre-flight gas check when entering recap ─────────────────────
     Without paymaster the SA pays its own gas. Block the Confirm
     button if the SA balance can't cover gas + value being transferred.
     Native sends count `parseEther(amount)` toward the cost; ERC-20
     sends only need to cover gas. */
  useEffect(() => {
    if (step !== "recap") return;
    let cancelled = false;
    setGasCheck(null);
    setGasChecking(true);
    (async () => {
      try {
        if (!fromAddr) {
          if (!cancelled) setGasChecking(false);
          return;
        }
        let valueWei = 0n;
        if (!selectedToken) {
          try {
            valueWei = parseEther(String(send.amount || "0"));
          } catch {
            valueWei = 0n;
          }
        }
        const res = await estimateUserOpCost({
          smartAddress: fromAddr,
          to: selectedToken?.address || send.recipient,
          data: selectedToken ? encodeErc20Transfer(send.recipient,parseTokenAmount(send.amount,selectedToken.decimals)) : '0x',
          valueWei,

          sphincs: needsEnroll || sphincsSend,
        });
        if (!cancelled) setGasCheck(res);
      } catch (error) {
        if (!cancelled) setError('Could not estimate the transaction: ' + error.message);
        // Estimator failed end-to-end (no RPC, no fallback). Leave the
        // check null so the UI shows "checking…" indefinitely rather
        // than silently allowing a confirm we couldn't validate.
      } finally {
        if (!cancelled) setGasChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [step, fromAddr, send.amount, selectedToken, needsEnroll, sphincsSend, willQueue]);


  useEffect(() => {
    if (step !== "recap" || !gasCheck || submitted) return;
    if (needsEnroll || sphincsSend) return;
    const id = setInterval(async () => {
      const fresh = await fetchFeeTiers();
      if (fresh) setGasCheck((prev) => (prev ? { ...prev, tiers: fresh } : prev));
    }, 5000);
    return () => clearInterval(id);
  }, [step, !gasCheck, submitted, needsEnroll, sphincsSend]);

  /* Format + EIP-55 checksum: a mixed-case address must checksum-validate
     so a single mistyped hex char can't send funds to the wrong (and
     irrecoverable) address. See src/utils/address.js. */
  function validAddress(a) {
    return checksumValidAddress(a);
  }

  /* Asset picker is now a SELECT step (the Cancel / Confirm footer
     advances), so picking only sets the asset — Confirm calls
     setStep("form"). Native = selectedToken null. */
  function pickNative() {
    send.selectedToken = null;
  }

  function pickToken(t) {
    send.selectedToken = {
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
    };
  }

  function goToRecap(e) {
    e?.preventDefault?.();
    if (!validAddress(send.recipient)) {
      setError("Invalid address or bad checksum — double-check it");
      return;
    }
    if (!send.amount || parseFloat(send.amount) < 0) {
      setError("Enter a valid amount");
      return;
    }
    setError("");
    setStep("recap");
  }

  async function submit(e) {
    e?.preventDefault?.();
    if (submitting.current) return;
    submitting.current = true;
    setError("");
    setSendOutcome(null);
    setSubmitted(true);
    try {
      const result = await send.run({reviewed:gasCheck?.reviewed});
      if (result?.queued) { navigate("/dashboard"); return; }
      setSendOutcome("success");
    } catch (err) {
      setError(err?.message || "Transaction failed");
      setSendOutcome("error");
    } finally { submitting.current = false; }
  }

  function setMax() {
    send.amount = available;
  }

  function back() {
    if (submitted && !sendOutcome) return;
    if (step === "recap") {
      setStep("form");
      return;
    }
    if (step === "form") {
      setStep("asset");
      send.selectedToken = null;
      setError("");
      return;
    }
    navigate("/dashboard");
  }

  // Honor the global phase only after a fresh submit in this lifecycle.
  // Keep the overlay visible on terminal states ("done" / "error") so the
  // user sees the result (✓ Done or "Error — tap to retry") instead of
  // silently bouncing back to recap when the rotation fails fast.
  const showExecuting = submitted;

  /* ── Effective fee for the CURRENT tier choice ────────────────────
     gasCheck's own gasCost/sufficient are computed at the fast tier;
     the user can pick Low/Market/Custom from the recap, so cost and
     prefund sufficiency are re-derived here from totalGas × chosen
     maxFee. Reading the sendFeeChoice signal (inside resolveSendFees)
     makes this re-render on every picker change. */
  const effFees =
    gasCheck?.tiers && gasCheck?.totalGas != null
      ? resolveSendFees(gasCheck.tiers)
      : null;
  const effGasCostWei = gasCheck
    ? effFees
      ? gasCheck.totalGas * effFees.maxFeePerGas
      : gasCheck.gasCostWei
    : 0n;
  const effTotalCostWei = gasCheck
    ? effGasCostWei + (gasCheck.valueWei || 0n)
    : 0n;

  const effSufficient = gasCheck
    ? effFees
      ? gasCheck.balanceWei >= effTotalCostWei
      : gasCheck.sufficient
    : false;
  const effDeficitWei = gasCheck && !effSufficient
    ? effFees
      ? effTotalCostWei - gasCheck.balanceWei
      : gasCheck.deficitWei
    : 0n;

  // Insufficient balance: amount typed > available. Both are strings;
  // parseFloat returns NaN for empty / "—" balances and the comparison
  // short-circuits to false in that case (don't block when unknown).
  const amountNum = parseFloat(send.amount);
  const availableNum = parseFloat(available);
  const insufficient =
    Number.isFinite(amountNum) &&
    Number.isFinite(availableNum) &&
    amountNum > availableNum;

  const subtitle =
    step === "asset"
      ? "Select an asset"
      : step === "recap"
        ? selectedToken
          ? "Confirm token transfer"
          : "Confirm transaction"
        : "Transfer to another address";

  // Pre-compute raw uint256 amount string for the DATA / PARAM #2
  // line in the token recap. Wrapped in try since the user might
  // type bad input — we just show "—" in that case.
  let rawAmountStr = "—";
  if (selectedToken && step === "recap") {
    try {
      rawAmountStr = parseTokenAmount(send.amount || "0", selectedToken.decimals).toString();
    } catch {
      rawAmountStr = "—";
    }
  }

  /* Cancel / Confirm footer buttons (Figma 37:33283 / 37:33289) — both
     in Barlow (type-label-button). Cancel = bordered ghost, Confirm =
     filled Primary/600. */
  const cancelBtnClass =
    "flex-1 min-w-0 h-10 rounded-[8px] border border-border-light bg-transparent flex items-center justify-center type-label-button text-primary-50 cursor-pointer transition-colors duration-150 hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed";
  const confirmBtnClass =
    "flex-1 min-w-0 h-10 rounded-[8px] bg-primary-600 border-none flex items-center justify-center type-label-button text-primary-50 cursor-pointer transition-colors duration-150 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed";

  /* Pinned footer (Figma 37:33282). Form/recap show Cancel + Confirm;
     while executing it shows the live status pill instead. The asset
     picker has no footer. */
  const footer = showExecuting ? (
    /* On-chain confirm (Figma 37:35527) — single full-width status
       button. The live logo + phase label sit centered in the body. */
    <div class="w-full flex flex-col gap-3">
      <div class="w-full h-10 rounded-[8px] bg-primary-600 flex items-center justify-center type-label-button text-primary-50 opacity-60">
        {heldPhase === "done" ? (
          "✓ Done"
        ) : heldPhase === "error" ? (
          "Error — tap to retry"
        ) : (
          <span class="inline-flex items-baseline">
            <span>Executing</span>
            <span class="nt-dot nt-dot-1">.</span>
            <span class="nt-dot nt-dot-2">.</span>
            <span class="nt-dot nt-dot-3">.</span>
          </span>
        )}
      </div>

      {heldPhase === "error" && (
        <button
          type="button"
          onClick={() => navigate("/dashboard")}
          class="w-full h-10 rounded-[8px] bg-transparent border border-border-light flex items-center justify-center cursor-pointer type-label-button text-text-dim"
        >
          Back to dashboard
        </button>
      )}
    </div>
  ) : step === "form" ? (
    <div class="w-full flex gap-4 items-center">
      <button type="button" onClick={back} class={cancelBtnClass}>
        Cancel
      </button>
      <button type="button" onClick={goToRecap} disabled={insufficient} class={confirmBtnClass}>
        Confirm
      </button>
    </div>
  ) : step === "recap" ? (
    <div class="w-full flex flex-col gap-3">
      {willQueue && <p class="type-body-sm text-text-dim">
        This send will be queued until the previous transaction is confirmed.
        Keep this wallet window open. Balances are checked again before sending.
      </p>}
      {/* Gas pre-flight failure — the fee itself lives in the recap
          body's Network-fee row (Figma 181:6467). */}
      {!gasChecking && gasCheck && !effSufficient && (
        <div class="w-full bg-red/10 border border-red/40 p-3 flex flex-col gap-1">
          <p class="font-display font-bold text-[13px] leading-[1.4] text-red uppercase tracking-[0.44px]">
            Insufficient {networkSymbol} for gas
          </p>
          <p class="font-body text-[13px] leading-[1.6] text-text-primary break-words">
            The smart account needs about{" "}
            <b>{Number(formatEther(effGasCostWei)).toFixed(6)} {networkSymbol}</b>
            {gasCheck.valueWei > 0n
              ? ` plus ${Number(send.amount || 0).toFixed(6)} ${networkSymbol} being sent`
              : ""}
            , but only has{" "}
            <b>{Number(gasCheck.balanceEth).toFixed(6)} {networkSymbol}</b>.
            Fund it with{" "}
            <b>~{Number(formatEther(effDeficitWei)).toFixed(6)} {networkSymbol}</b> more
            and try again.
          </p>
        </div>
      )}
      <div class="w-full flex gap-4 items-center">
        <button type="button" onClick={back} class={cancelBtnClass}>
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitted || gasChecking || !gasCheck || !effSufficient}
          class={confirmBtnClass}
        >
          {willQueue ? "Queue send" : "Confirm"}
        </button>
      </div>
    </div>
  ) : step === "asset" ? (
    <div class="w-full flex gap-4 items-center">
      <button type="button" onClick={() => navigate("/dashboard")} class={cancelBtnClass}>
        Cancel
      </button>
      <button type="button" onClick={() => setStep("form")} class={confirmBtnClass}>
        Confirm
      </button>
    </div>
  ) : null;

  /* Fee-picker page replaces the whole Send shell while open (all
     hooks above have already run, so Send's state machine keeps
     ticking underneath). Only reachable from the recap with live
     tier quotes — NetworkFeeButton doesn't open it otherwise. */
  if (feeOpen && step === "recap" && !showExecuting && gasCheck?.tiers) {
    return (
      <NetworkFeePage
        gasCheck={gasCheck}
        symbol={networkSymbol}
        onClose={() => setFeeOpen(false)}
      />
    );
  }

  return (
    <SubPageShell
      icon={<SendIcon />}
      title="Send"
      subtitle={subtitle}
      onBack={back}
      backDisabled={submitted && !sendOutcome}
      footer={footer}
    >
      {showExecuting ? (
        /* On-chain confirm — centered live status (Figma 37:35499).
           Logic untouched: driven by the real transaction phase. */
        <div class="w-full flex-1 flex flex-col items-center justify-center gap-6 px-4 py-4">
          <div class="size-16 rounded-full bg-primary-50 p-1.5 flex items-center justify-center">
            <img
              src="/nicetry_logo_outline.svg"
              alt=""
              class={
                "size-[52px] " +
                (["done", "error", "signed"].includes(heldPhase) ? "" : "animate-spin")
              }
              style={{ animationDuration: "1.6s" }}
            />
          </div>
          <p
            class={
              "type-label-special whitespace-pre-line text-center " +
              (heldPhase === "error" ? "text-red" : "text-blue-hover")
            }
          >
            {heldPhase === "error"
              ? "Transaction failed"
              : PHASE_LABELS[heldPhase] || PHASE_LABELS.signing}
          </p>
          {heldPhase === "error" && error && <p class="type-body-sm text-red text-center">{error}</p>}
        </div>
      ) : (
        <div class="w-full flex flex-col px-4 py-4 flex-1">
          {/* ── Step 1: asset picker ─────────────────────────────── */}
          {step === "asset" && !showExecuting && (
            <div class="w-full flex flex-col gap-3">
              {/* Native asset — selected when no token is chosen */}
              <button
                type="button"
                onClick={pickNative}
                class={
                  "w-full border-l-2 flex items-center justify-between pl-5 pr-3 py-3 cursor-pointer text-left transition-colors duration-150 " +
                  (!selectedToken
                    ? "bg-blue/20 border-blue"
                    : "bg-bg-card border-transparent hover:bg-bg-hover")
                }
              >
                <div class="flex gap-3 items-center min-w-0">
                  <TokenIcon src={nativeIconUrl(net.chainId)} seed={`native-${net.chainId}`} size={40} />
                  <div class="flex flex-col min-w-0 gap-0.5">
                    <p class="type-label-button text-text-primary truncate">
                      {networkName}
                    </p>
                    <p class="type-label-button-sm text-text-dim truncate">
                      {networkSymbol}
                    </p>
                  </div>
                </div>
                <p class="type-label-button text-text-primary whitespace-nowrap">
                  {bal.sa.value} {networkSymbol}
                </p>
              </button>

              {/* Imported ERC-20 tokens */}
              {tokensApi.list.value.map((t) => {
                const tokBal = tokenBalances[t.address.toLowerCase()] ?? "—";
                const isSel =
                  selectedToken?.address?.toLowerCase() === t.address.toLowerCase();
                return (
                  <button
                    key={t.address}
                    type="button"
                    onClick={() => pickToken(t)}
                    class={
                      "w-full border-l-2 flex items-center justify-between pl-5 pr-3 py-3 cursor-pointer text-left transition-colors duration-150 " +
                      (isSel
                        ? "bg-blue/20 border-blue"
                        : "bg-bg-card border-transparent hover:bg-bg-hover")
                    }
                  >
                    <div class="flex gap-3 items-center min-w-0">
                      <TokenIcon src={tokenIconUrl(net.chainId, t.address)} seed={t.address} size={40} />
                      <div class="flex flex-col min-w-0 gap-0.5">
                        <p class="type-label-button text-text-primary truncate">
                          {t.name || t.symbol}
                        </p>
                        <p class="type-label-button-sm text-text-dim truncate">
                          {t.symbol}
                        </p>
                      </div>
                    </div>
                    <p class="type-label-button text-text-primary whitespace-nowrap">
                      {tokBal} {t.symbol}
                    </p>
                  </button>
                );
              })}
            </div>
          )}

          {/* ── Step 2: amount + recipient form (Figma 37:33204) ─── */}
          {step === "form" && (
            <div class="w-full flex flex-col gap-6 border border-border-light p-4">
              {/* Amount */}
              <div class="w-full flex flex-col gap-2 items-start">
                {/* Label row: blue tick + caption + MAX link */}
                <div class="w-full flex items-center gap-1.5 px-1">
                  <span class="w-[3px] h-3 bg-primary-600 shrink-0" />
                  <span class="flex-1 min-w-0 type-label-special text-text-dim truncate">
                    Insert amount ({symbol})
                  </span>
                  <button
                    type="button"
                    onClick={setMax}
                    disabled={submitted}
                    class="shrink-0 type-label-button-sm text-blue-hover underline bg-transparent border-none cursor-pointer p-0 disabled:opacity-50"
                  >
                    Max
                  </button>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={send.amount}
                  onInput={(e) => {
                    /* Allow only digits and a single decimal point.
                       Force the DOM value too: when the sanitized result
                       equals the current state, the signal doesn't change
                       and Preact wouldn't re-render, leaving the rejected
                       char visible. */
                    const v = e.currentTarget.value
                      .replace(/[^0-9.]/g, "")
                      .replace(/(\..*)\./g, "$1");
                    e.currentTarget.value = v;
                    send.amount = v;
                    setError("");
                  }}
                  placeholder="Ex. 0.0425"
                  disabled={submitted}
                  class="w-full h-10 bg-bg-input border border-border-light outline-none px-3 type-mono-address text-text-primary placeholder:text-text-primary/25 transition-colors duration-150 focus:border-blue disabled:opacity-50"
                />
                {/* Available balance */}
                <div class="w-full flex items-center justify-between type-body-sm text-text-dim">
                  <span>Available:</span>
                  <span class="flex items-center gap-0.5">
                    <span class="font-mono">{available}</span>
                    <span>{symbol}</span>
                  </span>
                </div>
              </div>

              {/* To (recipient) */}
              <div class="w-full flex flex-col gap-2 items-start">
                <div class="w-full flex items-center gap-1.5 px-1">
                  <span class="w-[3px] h-3 bg-primary-600 shrink-0" />
                  <span class="flex-1 min-w-0 type-label-special text-text-dim truncate">
                    Send to [insert address]
                  </span>
                </div>
                <input
                  type="text"
                  value={send.recipient}
                  onInput={(e) => { send.recipient = e.currentTarget.value; setError(""); }}
                  placeholder="Ex. 0x71C7…976F"
                  disabled={submitted}
                  spellcheck={false}
                  autoComplete="off"
                  class="w-full h-10 bg-bg-input border border-border-light outline-none px-3 type-mono-address text-text-primary placeholder:text-text-primary/25 transition-colors duration-150 focus:border-blue disabled:opacity-50"
                />
              </div>

              {insufficient && !submitted && (
                <p class="w-full type-body-md text-red text-center">
                  Insufficient balance
                </p>
              )}

              {error && !insufficient && !submitted && (
                <p class="w-full type-body-md text-red text-center">
                  {error}
                </p>
              )}
            </div>
          )}

          {/* ── Step 3: recap ────────────────────────────────────── */}
          {step === "recap" && (
            <div class="w-full flex flex-col gap-5 flex-1">
              {/* AMOUNT */}
              <div class="w-full border border-white/20 p-4 flex items-center justify-between">
                <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                  Amount
                </p>
                <p class="flex items-center gap-0.5 text-[13px] leading-[1.2] text-blue-hover whitespace-nowrap">
                  <span class="font-mono font-bold">{send.amount || "0.00"}</span>
                  <span class="font-mono font-medium">{symbol}</span>
                </p>
              </div>

              {/* FROM / TO */}
              <div class="w-full border border-white/20 p-4 flex flex-col gap-3">
                <div class="w-full flex gap-3 items-center">
                  <div class="flex-1 min-w-0 flex flex-col gap-1">
                    <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                      From
                    </p>
                    <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                      {shortenAddr(fromAddr)}
                    </p>
                  </div>
                  <AddrThumb addr={fromAddr} />
                </div>
                <div class="h-px w-full bg-white/10" />
                <div class="w-full flex gap-3 items-center">
                  <div class="flex-1 min-w-0 flex flex-col gap-1">
                    <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                      To
                    </p>
                    <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                      {shortenAddr(send.recipient)}
                    </p>
                  </div>
                  <AddrThumb addr={send.recipient} />
                </div>
              </div>

              {/* NETWORK (+ INTERACTING WITH for token sends) + NONCE */}
              <div class="w-full border border-white/20 p-4 flex flex-col gap-3">
                <div class="w-full flex items-center justify-between">
                  <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                    Network
                  </p>
                  <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                    {networkName}{net.network.value?.testnet ? " network" : ""}
                  </p>
                </div>
                {selectedToken && (
                  <div class="w-full flex items-center justify-between">
                    <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                      Interacting with
                    </p>
                    <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                      {shortenAddr(selectedToken.address)}
                    </p>
                  </div>
                )}
                <div class="w-full flex items-center justify-between">
                  <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                    Nonce
                  </p>
                  <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                    {willQueue ? "Assigned when sent" : nonce === null ? "…" : nonce}
                  </p>
                </div>
              </div>

              {/* DATA (only for ERC-20 transfers) */}
              {selectedToken && (
                <div class="w-full border border-white/20 p-4 flex flex-col gap-3">
                  <div class="w-full flex items-center justify-between">
                    <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                      Data
                    </p>
                    <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                      -
                    </p>
                  </div>
                  <div class="w-full pl-2 flex items-center justify-between">
                    <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                      Function
                    </p>
                    <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                      transfer
                    </p>
                  </div>
                  <div class="w-full pl-2 flex items-center justify-between">
                    <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                      Param #1
                    </p>
                    <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                      {shortenAddr(send.recipient)}
                    </p>
                  </div>
                  <div class="w-full pl-2 flex items-center justify-between">
                    <p class="font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
                      Param #2
                    </p>
                    <p class="font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
                      {shortenLong(rawAmountStr)}
                    </p>
                  </div>
                </div>
              )}

              {}
              {(gasChecking || gasCheck) && (
                <NetworkFeeButton
                  gasCheck={gasCheck}
                  symbol={networkSymbol}
                  costEth={formatEther(effGasCostWei)}
                  locked={needsEnroll || sphincsSend}
                  checking={gasChecking}
                  onOpen={() => setFeeOpen(true)}
                />
              )}

              {/* First-transaction-on-a-new-device heads-up (Figma 162:3745):
                  this send is SPHINCS⁺-signed to activate the re-imported
                  device. Pinned (mt-auto) to the foot of the recap, just
                  above the footer's Cancel/Confirm bar. */}

            </div>
          )}

        </div>
      )}
    </SubPageShell>
  );
}
