import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTelegramLoaderForTests, type TelegramWebApp } from "@/lib/telegram/miniapp";
import { useTerminal } from "@/store/terminal";
import { TelegramMiniApp } from "./TelegramMiniApp";

function fakeWebApp() {
  let handler: (() => void) | null = null;
  const tg = {
    initData: "query_id=x&auth_date=1&hash=abc",
    version: "8.0",
    platform: "android",
    isVersionAtLeast: () => true,
    ready: vi.fn(),
    expand: vi.fn(),
    setHeaderColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    BackButton: {
      isVisible: false as boolean,
      show: vi.fn(() => {
        tg.BackButton.isVisible = true;
      }),
      hide: vi.fn(() => {
        tg.BackButton.isVisible = false;
      }),
      onClick: vi.fn((cb: () => void) => {
        handler = cb;
      }),
      offClick: vi.fn((cb: () => void) => {
        if (handler === cb) handler = null;
      }),
    },
  } satisfies TelegramWebApp;
  return { tg, click: () => handler?.() };
}

beforeEach(() => {
  useTerminal.setState({ tab: "tick" });
});

afterEach(() => {
  delete window.Telegram;
  __resetTelegramLoaderForTests();
});

describe("TelegramMiniApp", () => {
  it("does nothing outside Telegram", async () => {
    render(
      <MemoryRouter>
        <TelegramMiniApp />
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(window.Telegram).toBeUndefined();
    expect(document.head.querySelector("script")).toBeNull();
  });

  it("inits the WebApp and drives BackButton from desk history", async () => {
    const { tg, click } = fakeWebApp();
    window.Telegram = { WebApp: tg };
    render(
      <MemoryRouter>
        <TelegramMiniApp />
      </MemoryRouter>,
    );
    await waitFor(() => expect(tg.ready).toHaveBeenCalled());
    expect(tg.expand).toHaveBeenCalled();
    expect(tg.setHeaderColor).toHaveBeenCalledWith("#08090c");
    await waitFor(() => expect(tg.BackButton.hide).toHaveBeenCalled());
    expect(tg.BackButton.isVisible).toBe(false);

    act(() => useTerminal.getState().setTab("bot"));
    act(() => useTerminal.getState().setTab("wallet"));
    expect(tg.BackButton.isVisible).toBe(true);

    act(() => click());
    expect(useTerminal.getState().tab).toBe("bot");
    expect(tg.BackButton.isVisible).toBe(true);

    act(() => click());
    expect(useTerminal.getState().tab).toBe("tick");
    expect(tg.BackButton.isVisible).toBe(false);

    // A normal switch after going back is recorded again.
    act(() => useTerminal.getState().setTab("quotes"));
    expect(tg.BackButton.isVisible).toBe(true);
    act(() => click());
    expect(useTerminal.getState().tab).toBe("tick");
  });

  it("shows BackButton on sub-routes", async () => {
    const { tg } = fakeWebApp();
    window.Telegram = { WebApp: tg };
    render(
      <MemoryRouter initialEntries={["/npub1example"]}>
        <TelegramMiniApp />
      </MemoryRouter>,
    );
    await waitFor(() => expect(tg.BackButton.isVisible).toBe(true));
  });
});
