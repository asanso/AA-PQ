/* ═══════════════════════════════════════════════════════════════════
   ActionRow — two-button row under the balance (Send / Receive)
   ───────────────────────────────────────────────────────────────────
   Pure UI — the parent (Dashboard) decides what happens:
     onSend:    scrolls to / opens the send form
     onReceive: opens the receive modal with the address + QR

   Visual spec: Figma 154:342
     - Wrapper: gap-[20px], pt-[20px]
     - Send (primary):    bg #3f56e3,  px-[24px] py-[16px], gap-[8px]
     - Receive (outline): border-2 #fafafa, same padding/gap
     - Label: Poppins Bold 14 / tracking 0.42 / uppercase / #fafafa
     - Icons: 20×20, stroke #fafafa, paper-plane (send) and ↙ arrow (receive)
   ═══════════════════════════════════════════════════════════════════ */

function SendIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-text-primary)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function ReceiveIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-text-primary)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Down-left incoming arrow per Figma 154:347 */}
      <line x1="17" y1="7" x2="7" y2="17" />
      <polyline points="7 11 7 17 13 17" />
    </svg>
  );
}

export function ActionRow({ onSend, onReceive }) {
  return (
    <div class="relative w-full flex items-center justify-center gap-5 px-5 pt-5 pb-5">
      {/* Background fill behind the buttons: dashboard bg color (#292929)
          with a vertical opacity gradient — 60% at the top, 100% at the
          bottom — so the decorative chart fades out beneath the row. */}
      <div
        class="absolute inset-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(to bottom, color-mix(in srgb, var(--color-bg-primary) 60%, transparent) 0%, var(--color-bg-primary) 100%)",
        }}
      />
      <button
        type="button"
        onClick={onSend}
        class="relative z-10 flex-1 min-w-0 bg-blue border-2 border-blue flex items-center justify-center gap-2 px-6 py-4 cursor-pointer rounded-[8px]"
      >
        <SendIcon />
        <span class="font-['Poppins'] font-bold text-[14px] leading-[1.2] text-text-primary uppercase tracking-[0.42px]">
          Send
        </span>
      </button>
      <button
        type="button"
        onClick={onReceive}
        class="relative z-10 flex-1 min-w-0 bg-transparent border-2 border-text-primary flex items-center justify-center gap-2 px-6 py-4 cursor-pointer rounded-[8px]"
      >
        <ReceiveIcon />
        <span class="font-['Poppins'] font-bold text-[14px] leading-[1.2] text-text-primary uppercase tracking-[0.42px]">
          Receive
        </span>
      </button>
    </div>
  );
}
