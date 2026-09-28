

import { useState, useEffect } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useExecutionPhase } from "@/ui/hooks/useExecutionPhase.js";
import { EXECUTION_LABELS as PHASE_LABELS } from "@/ui/utils/execution-status.js";
import { useApproval, useNetwork, useBalance } from "@/ui/hooks";
import { vaultManager } from "@/vault/VaultManager.js";
import {
  smartAddr,
  isDetachedApproval,
  approvalMode,
  approvalData,
  page,
} from "@/ui/store.js";
import { decodeTx, formatArgValue } from "@/ui/utils/decode-tx.js";
import { publicClient } from "@/blockchain/client.js";
import { estimateUserOpCost } from "@/blockchain/gas-estimate.js";

import { TokenIcon } from "./dashboard/TokenIcon.jsx";
import { dappIconUrl } from "@/ui/utils/asset-icon.js";
import { CornerTopLeft, CornerBottomRight } from "../onboarding/OnboardingCorners.jsx";

const DONE_DWELL_MS = 2000;



/** "0x" / falsy → "0", else hex wei → "x.yyyyyy" with 6 decimals. */
function formatValue(hexValue) {
  if (!hexValue || hexValue === "0x" || hexValue === "0x0") return "0.00";
  try {
    const wei = BigInt(hexValue);
    const whole = wei / 10n ** 18n;
    const frac = wei % 10n ** 18n;
    const fracStr = frac.toString().padStart(18, "0").slice(0, 6);
    return `${whole}.${fracStr}`;
  } catch {
    return "?";
  }
}

/** Truncate address-shaped string to 0x123456...abcdef. */
function shortenAddr(a) {
  if (!a || typeof a !== "string" || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}...${a.slice(-6)}`;
}

/** Truncate long decimal/hex strings to 6+6 chars with middle ellipsis. */
function shortenLong(s) {
  if (!s) return "—";
  const str = String(s);
  if (str.length <= 14) return str;
  return `${str.slice(0, 6)}...${str.slice(-6)}`;
}

/** Strip protocol from origin so "https://example.com" → "example.com". */
function originHost(origin) {
  if (!origin) return "Unknown dApp";
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Display value for a single decoded arg, with sensible truncation. */
function formatParam(arg) {
  if (!arg) return "—";
  const raw = formatArgValue(arg);
  if (typeof arg.type === "string" && arg.type.startsWith("address")) {
    return shortenAddr(raw);
  }
  return shortenLong(raw);
}

/* ── Icons ─────────────────────────────────────────────────────── */

function ChartIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="14 7 21 7 21 14" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/* ── Reusable shell with the popup's vanity-cut card ───────────── */

function Shell({ title, subtitle, children, footer, hideHeader, noScroll }) {
  // Connect screen passes noScroll=true so the body never produces a
  // scrollbar in the fixed-height popup. In sidebar mode (no height
  // cap) it doesn't matter — content just sits naturally.
  const bodyOverflow = noScroll ? "overflow-hidden" : "overflow-y-auto";

  return (
    <div class="flex flex-col items-stretch min-h-screen w-full">
      <div class="relative bg-bg-primary flex flex-col items-stretch flex-1 min-h-0 overflow-hidden text-text-primary">
        {/* Top-left blue corner triangle (Figma 169:2598) */}
        <CornerTopLeft />

        <div class={`flex-1 flex flex-col items-stretch gap-5 px-5 py-5 min-h-0 ${bodyOverflow}`}>
          {/* Default header — hidden for hero-style screens (Connect) */}
          {!hideHeader && (
            <div class="w-full flex items-center justify-between gap-3">
              <div class="flex flex-1 min-w-0 gap-3.5 items-center">
                <div class="bg-blue/20 flex items-center justify-center p-2 rounded-[10px] shrink-0">
                  <ChartIcon />
                </div>
                <div class="flex flex-col gap-1 min-w-0">
                  <p class="font-['Poppins'] font-medium text-[20px] leading-[1.2] text-text-primary uppercase whitespace-nowrap">
                    {title}
                  </p>
                  {subtitle && (
                    <p class="font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.52px] whitespace-nowrap truncate">
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>
              <div class="size-10 shrink-0" />
            </div>
          )}

          {children}

          <div class="flex-1 w-full flex flex-col items-stretch justify-end gap-3">
            {footer}
          </div>
        </div>
        <div class="h-px w-full bg-white/10" />

        {/* Bottom-right blue corner triangle (Figma 169:2598 mirrored) */}
        <CornerBottomRight />
      </div>
    </div>
  );
}

function Row({ label, children, indent }) {
  return (
    <div class={"w-full flex items-center justify-between " + (indent ? "pl-2" : "")}>
      <p class="font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
        {label}
      </p>
      <div class="font-['Poppins'] font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
        {children}
      </div>
    </div>
  );
}

function Card({ children }) {
  return (
    <div class="w-full border border-white/20 p-4 flex flex-col gap-3">
      {children}
    </div>
  );
}

/* ── eth_sendTransaction body (figma 169:3148) ─────────────────── */

function TransactionBody({ tx, origin, networkName, isTestnet }) {
  const [decoded, setDecoded] = useState(null);
  const [decoding, setDecoding] = useState(false);
  const [nonce, setNonce] = useState(null);

  const hasData = tx.data && tx.data !== "0x";
  const ethValue = formatValue(tx.value);

  /* Decode calldata once per tx. */
  useEffect(() => {
    if (!hasData) {
      setDecoded(null);
      return;
    }
    setDecoding(true);
    decodeTx(tx.data)
      .then((r) => setDecoded(r))
      .finally(() => setDecoding(false));
  }, [tx.data]);

  /* Fetch on-chain nonce for the smart account. */
  useEffect(() => {
    let cancelled = false;
    setNonce(null);
    (async () => {
      try {
        const addr = smartAddr.value;
        if (!addr) {
          if (!cancelled) setNonce("—");
          return;
        }
        const n = await publicClient.getTransactionCount({address:addr,blockTag:'pending'});
        if (!cancelled) setNonce(n.toString());
      } catch {
        if (!cancelled) setNonce("—");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      {/* Network / Request from / Interacting with / Nonce */}
      <Card>
        <Row label="Network">
          <span class="flex items-center gap-1">
            <span class="bg-black rounded-full size-3 inline-block" />
            <span>{networkName}{isTestnet ? " network" : ""}</span>
          </span>
        </Row>
        <Row label="Request from">{originHost(origin)}</Row>
        <Row label="Interacting with">{shortenAddr(tx.to)}</Row>
        <Row label="Nonce">{nonce === null ? "…" : nonce}</Row>
      </Card>

      {/* Data — only if calldata present */}
      {hasData && (
        <Card>
          <div class="w-full flex items-center justify-between">
            <p class="font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
              Data
            </p>
            <CopyIcon />
          </div>
          <Row label="Function" indent>
            {decoded?.name
              ? decoded.name
              : decoding
                ? "Decoding…"
                : (decoded?.selector || tx.data.slice(0, 10))}
          </Row>
          {decoded?.args?.map((arg, i) => (
            <Row key={i} label={`Param #${i + 1}`} indent>
              {formatParam(arg)}
            </Row>
          ))}
        </Card>
      )}

      {/* Amount */}
      <Card>
        <div class="w-full flex items-center justify-between">
          <p class="font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]">
            Amount
          </p>
          <p class="flex items-center gap-0.5 text-[13px] leading-[1.2] text-blue-hover whitespace-nowrap">
            <span class="font-['Poppins'] font-bold">{ethValue}</span>
            <span class="font-['Poppins'] font-medium">ETH</span>
          </p>
        </div>
      </Card>
    </>
  );
}

/* ── eth_requestAccounts body (figma 169:2901) ─────────────────── */

function ConnectBody({ origin }) {
  const bal = useBalance();
  const networkSymbol = useNetwork().network.value?.symbol || "ETH";

  useEffect(() => {
    bal.refresh().catch(() => {});
  }, []);

  const addr =
    smartAddr.value ||
    vaultManager.smartAccountAddress ||
    vaultManager.getAllAccounts()[0] ||
    "";

  return (
    <>
      {/* Hero: big avatar + dApp host + "Connect this website with NiceTry" */}
      <div class="w-full flex flex-col gap-5 items-center">
        <TokenIcon
          src={dappIconUrl(origin)}
          seed={origin}
          size={72}
          bgClass="bg-blue/40"
        />
        <div class="w-full flex flex-col gap-2.5 items-center">
          <p class="font-['Poppins'] font-bold text-[25px] leading-[1.2] text-text-primary text-center break-all">
            {originHost(origin)}
          </p>
          <p class="w-full font-['Poppins'] font-normal text-[16px] leading-[1.6] text-text-dim text-center">
            Connect this website with NiceTry
          </p>
        </div>
      </div>

      {/* Account card */}
      <div class="w-full bg-black/30 border border-black/50 rounded-[10px] flex gap-4 items-center p-[13px]">
        <div class="flex flex-1 min-w-0 gap-3 items-center">
          <div class="bg-primary-50 rounded-full overflow-hidden shrink-0 size-10 flex items-center justify-center">
            <img
              src={`https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(addr || "nicetry")}`}
              alt=""
              class="block w-full h-full"
              referrerPolicy="no-referrer"
            />
          </div>
          <div class="flex-1 min-w-0 flex flex-col justify-between py-0.5 gap-1">
            <p class="font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px] whitespace-nowrap">
              Account 1
            </p>
            <p class="font-['Poppins'] font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap">
              {shortenAddr(addr)}
            </p>
          </div>
        </div>
        <div class="shrink-0 flex items-end">
          <p class="font-['Poppins'] font-medium text-[13px] leading-[1.2] text-text-primary text-right whitespace-nowrap">
            {bal.sa.value} {networkSymbol}
          </p>
        </div>
      </div>
    </>
  );
}

/* ── Main component ────────────────────────────────────────────── */

export function Approval() {
  const approval = useApproval();
  const net = useNetwork();
  const [, navigate] = useLocation();
  const req = approval.request;

  const networkName = net.network.value?.name || "Sepolia";
  const isTestnet = !!net.network.value?.testnet;

  if (!req) {
    return (
      <Shell title="No request" subtitle="Nothing to approve">
        <p class="font-['Poppins'] text-[13px] leading-[1.6] text-text-dim text-center">
          No pending request.
        </p>
        <div class="flex-1" />
        <button
          type="button"
          onClick={() => {
            if (isDetachedApproval.value) window.close();
            else navigate("/dashboard");
          }}
          class="w-full bg-transparent border-2 border-text-dim flex items-center justify-center px-6 py-4 cursor-pointer font-display font-bold text-[14px] leading-[1.2] text-text-dim uppercase tracking-[0.42px]"
        >
          {isDetachedApproval.value ? "Close" : "Back to dashboard"}
        </button>
      </Shell>
    );
  }

  const { method, params, origin } = req;

  /* Title / subtitle per method, matching the figma copy where given. */
  const TITLE = {
    eth_sendTransaction:  { title: "Transaction Request", subtitle: "Review contract call" },
    eth_requestAccounts:  { title: "Connect", subtitle: "Allow this dApp to read your address" },
  };
  const { title, subtitle } = TITLE[method] || {
    title: "Approve Request",
    subtitle: method,
  };

  function finish() {
    if (isDetachedApproval.value) {
      window.close();
      return;
    }
    approvalMode.value = false;
    approvalData.value = null;
    page.value = "dashboard";
    navigate("/dashboard");
  }

  const isTxFlow = method === 'eth_sendTransaction';
  const [phaseRunning, setPhaseRunning] = useState(false);
  const [approveOutcome, setApproveOutcome] = useState(null);
  const heldPhase = useExecutionPhase(phaseRunning ? approval.phase : 'idle');

  /* ── Pre-flight gas check (TX flow only) ─────────────────────────
     Without paymaster the SA must cover gas + tx.value out of its own
     ETH balance. Block Confirm if the balance is insufficient. */
  const [gasCheck, setGasCheck] = useState(null);
  const [gasChecking, setGasChecking] = useState(false);
  const [gasError,setGasError]=useState('');
  useEffect(() => {
    if (!isTxFlow) {
      setGasCheck(null);
      return;
    }
    let cancelled = false;
    setGasCheck(null);
    setGasChecking(true);setGasError('');
    (async () => {
      try {
        const tx = params?.[0] || {};
        const addr = smartAddr.value;
        if (!addr) {
          if (!cancelled) setGasChecking(false);
          return;
        }
        let valueWei = 0n;
        try {
          if (tx.value) valueWei = BigInt(tx.value);
        } catch {
          valueWei = 0n;
        }
        const res = await estimateUserOpCost({
          smartAddress: addr,
          to:tx.to, data:tx.data || tx.input || '0x',
          valueWei,
        });
        if (!cancelled) setGasCheck(res);
      } catch(error) {
        if(!cancelled)setGasError('Could not estimate the transaction: '+error.message);
        // Estimator gave up; leave gasCheck null so the button stays
        // disabled rather than silently approving without verification.
      } finally {
        if (!cancelled) setGasChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isTxFlow, params]);

  useEffect(() => {
    if (!phaseRunning || approveOutcome !== 'success') return;
    const timer = setTimeout(finish, DONE_DWELL_MS);
    return () => clearTimeout(timer);
  }, [phaseRunning, approveOutcome]);

  async function onApprove() {
    // Connect / sign flows: silent. No phases, no "Done" screen — the
    // disabled Confirm button already indicates work in flight. As soon
    // as approve() resolves we finish().
    if (!isTxFlow) {
      try {
        if (method === "eth_requestAccounts") {
          const addr =
            req.account ||
            smartAddr.value ||
            vaultManager.smartAccountAddress;
          if (!addr) throw new Error("No account available to share");
          await approval.approve({ accounts: [addr] });
        } else {
          await approval.approve({reviewed:gasCheck?.reviewed});
        }
        finish();
      } catch {
        // Error surfaces via approval.error.
      }
      return;
    }

    // TX flow: display progress from the real approval.
    setApproveOutcome(null);
    setPhaseRunning(true);
    try {
      await approval.approve({reviewed:gasCheck?.reviewed});
      setApproveOutcome("success");
    } catch {
      // Tear down the executing block so the idle Cancel/Confirm pair
      // returns and the user can retry. Error is rendered above.
      setApproveOutcome("error");
      setPhaseRunning(false);
    }
  }

  function onReject() {
    approval.reject();
    finish();
  }

  const showExecuting = phaseRunning && !approval.error;

  /* TX-flow gating: while the gas check is in flight or has failed
     "sufficient", the Confirm button is disabled. Connect / sign flows
     are unaffected — they don't move funds. */
  const networkSymbol = net.network.value?.symbol || "ETH";
  const txConfirmBlocked =
    isTxFlow && (gasChecking || !gasCheck || !gasCheck.sufficient);

  const footer = (
    <>
      {gasError && <p class="text-red text-sm break-words">{gasError}</p>}
      {/* Pre-flight network-fee surface for the tx flow only. */}
      {isTxFlow && !showExecuting && gasChecking && (
        <p class="w-full font-['Poppins'] text-[13px] leading-[1.6] text-text-dim text-center">
          Estimating network fee…
        </p>
      )}
      {isTxFlow && !showExecuting && !gasChecking && gasCheck?.sufficient && (
        <p class="w-full font-['Poppins'] text-[13px] leading-[1.6] text-text-dim text-center">
          Maximum network fee:&nbsp;
          <span class="text-text-primary">
            {Number(gasCheck.gasCostEth).toFixed(6)} {networkSymbol}
          </span>
        </p>
      )}
      {isTxFlow && !showExecuting && !gasChecking && gasCheck && !gasCheck.sufficient && (
        <div class="w-full bg-red/10 border border-red/40 p-3 flex flex-col gap-1">
          <p class="font-['Poppins'] font-bold text-[13px] leading-[1.4] text-red uppercase tracking-[0.44px]">
            Insufficient {networkSymbol} for gas
          </p>
          <p class="font-['Poppins'] text-[13px] leading-[1.6] text-text-primary break-words">
            {}
            Your smart account needs about{" "}
            <b>{Number(gasCheck.prefundEth ?? gasCheck.gasCostEth).toFixed(6)} {networkSymbol}</b>
            {gasCheck.valueWei > 0n
              ? ` plus the value being sent`
              : ""}
            , but only has{" "}
            <b>{Number(gasCheck.balanceEth).toFixed(6)} {networkSymbol}</b>.
            Fund it with{" "}
            <b>~{Number(gasCheck.deficitEth).toFixed(6)} {networkSymbol}</b> more
            and try again.
          </p>
        </div>
      )}

      {/* Error stays as a plain red line — it's not part of the
          executing choreography. The raw approval.status text is
          intentionally hidden during the flow; the spinning-logo row
          below replaces it with the friendlier scripted labels. */}
      {approval.error && (
        <div class="w-full font-['Poppins'] text-[13px] leading-[1.6] text-center break-words text-red">
          Error: {approval.error.message || String(approval.error)}
        </div>
      )}

      {/* Executing block — same visual as Send: spinning NiceTry logo +
          phase label, then a primary button with animated "Executing..."
          dots (or "✓ Done" when finished). */}
      {showExecuting && !approval.error && (
        <>
          <div class="w-full flex items-center gap-3">
            <div class="bg-primary-50 rounded-full p-[3px] shrink-0 size-8 flex items-center justify-center">
              <img
                src="/nicetry_logo_outline.svg"
                alt=""
                class={"size-[26px] " + (["done", "error", "signed"].includes(heldPhase) ? "" : "animate-spin")}
                style={{ animationDuration: "1.6s" }}
              />
            </div>
            <p class="font-['Poppins'] font-medium text-[13px] leading-[1.2] text-blue-hover whitespace-pre-line">
              {PHASE_LABELS[heldPhase] || PHASE_LABELS.signing}
            </p>
          </div>
          <div class="w-full bg-blue flex items-center justify-center px-6 py-4 font-display font-bold text-[14px] leading-[1.2] text-text-primary uppercase tracking-[0.42px] opacity-60">
            {heldPhase === "done" ? (
              "✓ Done"
            ) : (
              <span class="inline-flex items-baseline">
                <span>Executing</span>
                <span class="nt-dot nt-dot-1">.</span>
                <span class="nt-dot nt-dot-2">.</span>
                <span class="nt-dot nt-dot-3">.</span>
              </span>
            )}
          </div>
        </>
      )}

      {/* Idle state — the regular Cancel / Confirm pair. Hidden once
          the user fires onApprove (showExecuting takes over). */}
      {!showExecuting && (
        <div class="w-full flex gap-5 items-center">
          <button
            type="button"
            onClick={onReject}
            disabled={approval.submitting}
            class="flex-1 min-w-0 bg-transparent border-2 border-[white] rounded-[8px] flex items-center justify-center gap-2 px-6 py-4 cursor-pointer font-display font-bold text-[14px] leading-[1.2] text-[white] uppercase tracking-[0.42px] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={approval.submitting || txConfirmBlocked}
            class="flex-1 min-w-0 bg-blue rounded-[8px] flex items-center justify-center gap-2 px-6 py-4 cursor-pointer border-none font-display font-bold text-[14px] leading-[1.2] text-text-primary uppercase tracking-[0.42px] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {method === "eth_requestAccounts"
              ? "Connect"
              : "Confirm"}
          </button>
        </div>
      )}
    </>
  );

  return (
    <Shell
      title={title}
      subtitle={subtitle}
      footer={footer}
      hideHeader={method === "eth_requestAccounts"}
      noScroll={method === "eth_requestAccounts"}
    >
      {method === "eth_sendTransaction" && (
        <TransactionBody
          tx={params?.[0] || {}}
          origin={origin}
          networkName={networkName}
          isTestnet={isTestnet}
        />
      )}
      {method === "eth_requestAccounts" && <ConnectBody origin={origin} />}
      {![
        "eth_sendTransaction",
        "eth_requestAccounts",
      ].includes(method) && (
        <Card>
          <Row label="Method">{method}</Row>
          <pre class="font-['Poppins'] text-[13px] leading-[1.4] text-text-primary whitespace-pre-wrap break-all max-h-48 overflow-y-auto m-0">
            {JSON.stringify(params, null, 2)}
          </pre>
        </Card>
      )}

    </Shell>
  );
}
