/* ═══════════════════════════════════════════════════════════════════
   onboarding/App.jsx — route shell for the setup flow
   ───────────────────────────────────────────────────────────────────
   Routes:
     /                    → Welcome
     /create/password     → CreatePassword
     /create/seed         → ShowSeed (vault created + SA precomputed here)
     /create/done         → FinalStep (also used by import flow)
     /import/seed         → ImportSeed
     /import/password     → ImportPassword
     /import/scanning     → ImportScanning

   The state shared across steps lives in useOnboardingFlow() so users
   can navigate back and forth without losing context. Sensitive data
   (password, phrase) is zeroed when FinalStep fires.
   ═══════════════════════════════════════════════════════════════════ */

import { Route, Switch, Router } from "wouter-preact";
import { useEffect, useState, useCallback } from "preact/hooks";

import { Welcome } from "@/ui/components/onboarding/Welcome.jsx";
import { CreatePassword } from "@/ui/components/onboarding/CreatePassword.jsx";
import { ShowSeed } from "@/ui/components/onboarding/ShowSeed.jsx";
import { FinalStep } from "@/ui/components/onboarding/FinalStep.jsx";
import { ImportSeed } from "@/ui/components/onboarding/ImportSeed.jsx";
import { ImportPassword } from "@/ui/components/onboarding/ImportPassword.jsx";
import { ImportScanning } from "@/ui/components/onboarding/ImportScanning.jsx";
import { OnboardingBack } from "@/ui/components/onboarding/OnboardingBack.jsx";

/* Inline hash-location hook; same implementation as popup/App.jsx. */
function useHashLocation() {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [loc, setLoc] = useState(read());

  useEffect(() => {
    const h = () => setLoc(read());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  const navigate = useCallback((to) => {
    window.location.hash = to.startsWith("/") ? to : "/" + to;
  }, []);

  return [loc, navigate];
}

export function App() {
  return (
   <div class="relative overflow-hidden flex flex-col h-screen justify-center items-center bg-bg-primary">
     {/* Pattern grid layer (Figma node 154:2409) */}
     <img
       src="/background_grid.png"
       alt=""
       className="pointer-events-none select-none fixed inset-0 z-0 w-full h-full object-cover opacity-60"
     />
     {/* Blue radial glow at top-center, 17% opacity (Figma node 154:2560) */}
     <div
       className="pointer-events-none fixed inset-0 z-0 opacity-[0.17]"
       style={{
         background: 'radial-gradient(108% 56% at 50% 0%, var(--color-blue) 0%, color-mix(in srgb, var(--color-blue) 50%, transparent) 50%, transparent 100%)'
       }}
     />

     {/* Sizing wrapper (NOT clipped) so the back arrow can sit in the
         margin to the right of the bordered card. */}
     <div class="relative z-10 w-full max-w-[460px] h-full max-h-[700px] font-['Poppins',sans-serif]">
        {/* Shared back arrow, top-right OUTSIDE the card (Figma 536:2182). */}
        <OnboardingBack />

        <div class="overflow-hidden flex flex-col border-2 border-stone-100 justify-center w-full h-full p-6">
          <div className="w-full h-full min-w-0">
            <Router hook={useHashLocation} >
              <Switch>

                  <Route path="/" component={Welcome} />
                  <Route path="/create/password" component={CreatePassword} />
                  <Route path="/create/seed" component={ShowSeed} />
                  <Route path="/create/done" component={FinalStep} />
                  <Route path="/import/seed" component={ImportSeed} />
                  <Route path="/import/password" component={ImportPassword} />
                  <Route path="/import/scanning" component={ImportScanning} />
                  <Route>
                    <div class="p-10 text-center text-text-secondary">
                      Unknown route
                    </div>
                  </Route>

              </Switch>
            </Router>
          </div>
        </div>
     </div>
   </div>
  );
}
