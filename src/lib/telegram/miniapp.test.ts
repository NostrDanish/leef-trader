import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetTelegramLoaderForTests,
  getTelegramWebApp,
  initTelegramWebApp,
  isLikelyTelegramLaunch,
  loadTelegramWebApp,
  TabBackStack,
  TELEGRAM_THEME_COLOR,
  type TelegramWebApp,
} from "./miniapp";

const root = path.resolve(import.meta.dirname, "../../..");

function fakeWebApp(over: Partial<TelegramWebApp> = {}): TelegramWebApp {
  return {
    initData: "query_id=x&user=%7B%7D&auth_date=1&hash=abc",
    version: "8.0",
    platform: "ios",
    isVersionAtLeast: (v: string) => parseFloat("8.0") >= parseFloat(v),
    ready: vi.fn(),
    expand: vi.fn(),
    setHeaderColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    BackButton: {
      isVisible: false,
      show: vi.fn(),
      hide: vi.fn(),
      onClick: vi.fn(),
      offClick: vi.fn(),
    },
    ...over,
  };
}

afterEach(() => {
  delete window.Telegram;
  delete window.TelegramWebviewProxy;
  window.location.hash = "";
  sessionStorage.clear();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
  __resetTelegramLoaderForTests();
});

describe("getTelegramWebApp", () => {
  it("is null without the SDK", () => {
    expect(getTelegramWebApp()).toBeNull();
  });

  it("is null when the SDK is loaded in a normal browser (empty initData)", () => {
    window.Telegram = { WebApp: fakeWebApp({ initData: "" }) };
    expect(getTelegramWebApp()).toBeNull();
  });

  it("returns the WebApp inside Telegram", () => {
    const tg = fakeWebApp();
    window.Telegram = { WebApp: tg };
    expect(getTelegramWebApp()).toBe(tg);
  });
});

describe("isLikelyTelegramLaunch", () => {
  it("is false for a plain visit", () => {
    expect(isLikelyTelegramLaunch()).toBe(false);
  });

  it("detects Telegram launch params in the fragment", () => {
    window.location.hash = "#tgWebAppData=abc&tgWebAppVersion=8.0";
    expect(isLikelyTelegramLaunch()).toBe(true);
  });

  it("detects params kept by the SDK across an in-app reload", () => {
    sessionStorage.setItem("__telegram__initParams", JSON.stringify({ tgWebAppData: "abc" }));
    expect(isLikelyTelegramLaunch()).toBe(true);
  });

  it("detects the native webview proxy", () => {
    window.TelegramWebviewProxy = {};
    expect(isLikelyTelegramLaunch()).toBe(true);
  });
});

describe("loadTelegramWebApp", () => {
  it("does not inject the SDK outside Telegram", async () => {
    await expect(loadTelegramWebApp()).resolves.toBeNull();
    expect(document.head.querySelector("script")).toBeNull();
  });

  it("injects one same-origin script inside Telegram and resolves the WebApp", async () => {
    window.location.hash = "#tgWebAppData=abc";
    const p = loadTelegramWebApp();
    const again = loadTelegramWebApp();
    const scripts = document.head.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    const src = scripts[0].getAttribute("src") ?? "";
    expect(src).not.toMatch(/^https?:\/\//);
    expect(src).toContain("telegram-web-app");

    const tg = fakeWebApp();
    window.Telegram = { WebApp: tg };
    scripts[0].dispatchEvent(new Event("load"));
    await expect(p).resolves.toBe(tg);
    await expect(again).resolves.toBe(tg);
  });

  it("resolves null if the script fails to load", async () => {
    window.location.hash = "#tgWebAppData=abc";
    const p = loadTelegramWebApp();
    document.head.querySelector("script")!.dispatchEvent(new Event("error"));
    await expect(p).resolves.toBeNull();
  });
});

describe("initTelegramWebApp", () => {
  it("calls ready/expand and sets the dark theme colours", () => {
    const tg = fakeWebApp();
    initTelegramWebApp(tg);
    expect(tg.ready).toHaveBeenCalledOnce();
    expect(tg.expand).toHaveBeenCalledOnce();
    expect(tg.setHeaderColor).toHaveBeenCalledWith(TELEGRAM_THEME_COLOR);
    expect(tg.setBackgroundColor).toHaveBeenCalledWith(TELEGRAM_THEME_COLOR);
    expect(TELEGRAM_THEME_COLOR).toBe("#08090c");
  });

  it("skips colour calls on clients older than 6.1", () => {
    const tg = fakeWebApp({ version: "6.0", isVersionAtLeast: () => false });
    initTelegramWebApp(tg);
    expect(tg.ready).toHaveBeenCalledOnce();
    expect(tg.setHeaderColor).not.toHaveBeenCalled();
  });
});

describe("TabBackStack", () => {
  it("is LIFO, skips consecutive duplicates and is bounded", () => {
    const s = new TabBackStack<string>(3);
    s.push("a");
    s.push("a");
    s.push("b");
    expect(s.size).toBe(2);
    s.push("c");
    s.push("d");
    expect(s.size).toBe(3);
    expect(s.pop()).toBe("d");
    expect(s.pop()).toBe("c");
    expect(s.pop()).toBe("b");
    expect(s.pop()).toBeUndefined();
  });
});

describe("deployment guards", () => {
  it("vercel.json only lets Telegram (and self) frame the app", () => {
    const vercel = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const all = vercel.headers.flatMap((h) => h.headers);
    expect(all.find((h) => h.key.toLowerCase() === "x-frame-options")).toBeUndefined();
    const csp = all.find((h) => h.key === "Content-Security-Policy");
    expect(csp?.value).toBe(
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
    );
  });

  it("index.html keeps script-src 'self' only (SDK is vendored)", () => {
    const html = readFileSync(path.join(root, "index.html"), "utf8");
    expect(html).toContain("script-src 'self';");
    expect(html).not.toContain("telegram.org");
  });

  it("vendored SDK matches the hash recorded in its README", () => {
    const dir = path.join(root, "src/vendor/telegram");
    const sha = createHash("sha256")
      .update(readFileSync(path.join(dir, "telegram-web-app.js")))
      .digest("hex");
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toContain(sha);
  });
});
