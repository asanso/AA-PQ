/* ═══════════════════════════════════════════════════════════════════
   render.js — migration stub
   ───────────────────────────────────────────────────────────────────
   In the legacy vanilla-JS build, render() wiped #app and reconstructed
   the full DOM on every state mutation. The whole codebase is peppered
   with `state.foo = x; render();` pairs.

   In the new Preact + signals world, assigning to a signal (which is
   what `state.foo = x` now does, via the state.js Proxy) automatically
   triggers re-renders of any component that read it. The render() call
   is therefore redundant.

   Rather than hunt down every call site, we keep this module as a
   no-op. The ~200 render() calls scattered through the legacy modules
   become harmless. Delete this file once every caller has been
   migrated to a Preact component.
   ═══════════════════════════════════════════════════════════════════ */

export function render() {
  // Signals handle reactivity. This stub exists for migration only.
}
