import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  initTelegramWebApp,
  loadTelegramWebApp,
  supportsBackButton,
  TabBackStack,
  type TelegramWebApp,
} from "@/lib/telegram/miniapp";
import { useTerminal, type TabId } from "@/store/terminal";

/**
 * Telegram Mini App glue. Renders nothing and does nothing unless the page
 * runs inside Telegram (non-empty `Telegram.WebApp.initData`).
 *
 * initData is NOT verified and must never be used for auth or anything
 * security-relevant; see src/lib/telegram/miniapp.ts.
 *
 * Must be mounted inside <BrowserRouter>.
 */
export function TelegramMiniApp() {
  const [tg, setTg] = useState<TelegramWebApp | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadTelegramWebApp().then((webApp) => {
      if (cancelled || !webApp) return;
      initTelegramWebApp(webApp);
      setTg(webApp);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!tg || !supportsBackButton(tg)) return null;
  return <TelegramBackButton tg={tg} />;
}

function TelegramBackButton({ tg }: { tg: TelegramWebApp }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const stackRef = useRef(new TabBackStack<TabId>());
  const poppingRef = useRef(false);
  const [depth, setDepth] = useState(0);

  // Record desk switches so Back returns to the previous desk.
  useEffect(() => {
    const stack = stackRef.current;
    const unsubscribe = useTerminal.subscribe((state, prev) => {
      if (state.tab === prev.tab) return;
      if (poppingRef.current) {
        poppingRef.current = false;
      } else {
        stack.push(prev.tab);
      }
      setDepth(stack.size);
    });
    return () => {
      unsubscribe();
      tg.BackButton.hide();
    };
  }, [tg]);

  const onRoot = pathname === "/";
  const canGoBack = !onRoot || depth > 0;

  useEffect(() => {
    if (canGoBack) tg.BackButton.show();
    else tg.BackButton.hide();
  }, [tg, canGoBack]);

  useEffect(() => {
    const handler = () => {
      if (!onRoot) {
        // Sub-route (e.g. a NIP-19 page): go back in router history, or to
        // the terminal if this route was the entry point.
        const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
        if (idx > 0) navigate(-1);
        else navigate("/", { replace: true });
        return;
      }
      const prevTab = stackRef.current.pop();
      setDepth(stackRef.current.size);
      if (prevTab === undefined || prevTab === useTerminal.getState().tab) return;
      poppingRef.current = true;
      useTerminal.getState().setTab(prevTab);
    };
    tg.BackButton.onClick(handler);
    return () => tg.BackButton.offClick(handler);
  }, [tg, onRoot, navigate]);

  return null;
}

export default TelegramMiniApp;
