import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ScrollToTop } from "./components/ScrollToTop";

import Index from "./pages/Index";
import NotFound from "./pages/NotFound";

// NIP-19 pages pull in the whole Nostr stack (nostr-tools, @nostrify,
// relay pool). Both are lazy so the terminal route never downloads them.
const NostrShell = lazy(() => import("./components/NostrShell"));
const NIP19Page = lazy(() =>
  import("./pages/NIP19Page").then((m) => ({ default: m.NIP19Page })),
);

export function AppRouter() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Index />} />
        {/* NIP-19 route for npub1, note1, naddr1, nevent1, nprofile1 */}
        <Route
          path="/:nip19"
          element={
            <Suspense fallback={null}>
              <NostrShell>
                <NIP19Page />
              </NostrShell>
            </Suspense>
          }
        />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
export default AppRouter;
