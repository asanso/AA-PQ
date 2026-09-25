/* ═══════════════════════════════════════════════════════════════════
   useTheme — reactive accessor for the stone/slate theme
   ───────────────────────────────────────────────────────────────────
   Thin wrapper over src/ui/theme.js so components read/switch the
   active theme through the same hook style as useMode / useNetwork.

     const t = useTheme();
     t.value          → "stone" | "slate"
     t.isSlate        → boolean
     t.set("slate")   → Promise (persists)
     t.toggle()       → Promise (flip + persist)
     t.themes         → ["stone", "slate"]
   ═══════════════════════════════════════════════════════════════════ */

import { theme, setTheme, toggleTheme, THEMES } from "@/ui/theme.js";

export function useTheme() {
  return {
    get value() {
      return theme.value;
    },
    get isSlate() {
      return theme.value === "slate";
    },
    get isStone() {
      return theme.value === "stone";
    },
    themes: THEMES,
    set: setTheme,
    toggle: toggleTheme,
  };
}
