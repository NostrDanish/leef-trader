/**
 * Telegram Mini App integration (presentation only).
 *
 * SECURITY: `Telegram.WebApp.initData` / `initDataUnsafe` come from the URL
 * fragment and can be forged by anyone who opens the page. They are NOT
 * validated here (that needs the bot token and a server-side HMAC check).
 * Never use them for auth, identity, account linking, permissions, limits or
 * anything else security-relevant. The only thing they do here is answer
 * "are we inside Telegram?" so the UI can call ready()/expand(), set colours
 * and drive the native BackButton. A forged value only changes cosmetics.
 *
 * Outside Telegram nothing happens: the SDK is not even downloaded.
 */
// Vendored, unmodified copy of https://telegram.org/js/telegram-web-app.js.
// Source, fetch date and SHA-256 are in src/vendor/telegram/README.md.
// `?url` makes Vite emit it as a hashed same-origin asset (script-src 'self'),
// so it never enters the main bundle.
import telegramSdkUrl from "@/vendor/telegram/telegram-web-app.js?url";

/** Dark theme background (matches index.html `theme-color` / `--bg`). */
export const TELEGRAM_THEME_COLOR = "#08090c";

/** Subset of `Telegram.WebApp` that this app uses. */
export interface TelegramBackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

export interface TelegramWebApp {
  /** Raw, UNVERIFIED launch data. Do not trust; see file header. */
  initData: string;
  version: string;
  platform: string;
  isVersionAtLeast(version: string): boolean;
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  BackButton: TelegramBackButton;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
    TelegramWebviewProxy?: unknown;
  }
}

/**
 * The WebApp object, but only when actually running inside Telegram
 * (`initData` non-empty). Returns null in a normal browser even if the SDK
 * happens to be present.
 */
export function getTelegramWebApp(win: Window = window): TelegramWebApp | null {
  const tg = win.Telegram?.WebApp;
  if (!tg || typeof tg.initData !== "string" || tg.initData.length === 0) {
    return null;
  }
  return tg;
}

/**
 * Cheap pre-check (before the SDK is loaded) for "was this page opened by a
 * Telegram client?". Telegram passes launch params in the URL fragment
 * (`#tgWebAppData=...&tgWebAppVersion=...`); after an in-app reload the SDK
 * keeps them in sessionStorage; native clients also inject
 * `TelegramWebviewProxy`. A false positive only costs one same-origin script
 * download: the real gate is still `getTelegramWebApp()`.
 */
export function isLikelyTelegramLaunch(win: Window = window): boolean {
  try {
    const hash = win.location.hash;
    if (hash.includes("tgWebAppData=") || hash.includes("tgWebAppVersion=")) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    const stored = win.sessionStorage.getItem("__telegram__initParams");
    if (stored && stored.includes("tgWebAppData")) return true;
  } catch {
    // sessionStorage can throw (privacy mode, sandboxed frames)
  }
  return typeof win.TelegramWebviewProxy !== "undefined";
}

let sdkPromise: Promise<TelegramWebApp | null> | null = null;

/**
 * Loads the vendored SDK once, only when `isLikelyTelegramLaunch()`.
 * Resolves to the WebApp when inside Telegram, otherwise null. Never rejects.
 */
export function loadTelegramWebApp(win: Window = window): Promise<TelegramWebApp | null> {
  const existing = getTelegramWebApp(win);
  if (existing) return Promise.resolve(existing);
  if (!isLikelyTelegramLaunch(win)) return Promise.resolve(null);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve) => {
    const doc = win.document;
    const script = doc.createElement("script");
    script.src = telegramSdkUrl;
    script.async = true;
    script.onload = () => resolve(getTelegramWebApp(win));
    script.onerror = () => resolve(null);
    doc.head.appendChild(script);
  });
  return sdkPromise;
}

/** Test hook: forget the cached loader promise. */
export function __resetTelegramLoaderForTests(): void {
  sdkPromise = null;
}

/**
 * One-time cosmetic setup. Each call is guarded by the client's WebApp
 * version so old clients don't log "not supported" warnings.
 */
export function initTelegramWebApp(tg: TelegramWebApp): void {
  tg.ready();
  tg.expand();
  if (tg.isVersionAtLeast("6.1")) {
    tg.setHeaderColor(TELEGRAM_THEME_COLOR);
    tg.setBackgroundColor(TELEGRAM_THEME_COLOR);
  }
}

/** BackButton is Bot API 6.1+. */
export function supportsBackButton(tg: TelegramWebApp): boolean {
  return tg.isVersionAtLeast("6.1");
}

/**
 * In-memory history of terminal tabs (the terminal switches desks via
 * zustand state, not URLs). Bounded so a long session can't grow it forever.
 */
export class TabBackStack<T> {
  private items: T[] = [];
  constructor(private readonly limit = 50) {}

  push(item: T): void {
    if (this.items[this.items.length - 1] === item) return;
    this.items.push(item);
    if (this.items.length > this.limit) this.items.shift();
  }

  pop(): T | undefined {
    return this.items.pop();
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}
