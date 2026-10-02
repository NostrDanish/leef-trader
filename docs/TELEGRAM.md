# Telegram Mini App

The site can be opened as a Telegram Mini App (e.g. from the bot's menu button).
Everything here is **presentation only** and is inert in a normal browser.

## How it works

- `src/lib/telegram/miniapp.ts` checks whether the page was launched by Telegram
  (`#tgWebAppData=` launch params, the SDK's sessionStorage copy after a reload, or
  the native `TelegramWebviewProxy`). Only then it injects the **vendored** SDK
  (`src/vendor/telegram/telegram-web-app.js`, emitted as a hashed `/assets/` file).
  Normal visitors never download it.
- `src/components/TelegramMiniApp.tsx` (mounted in `AppRouter`) runs only when
  `Telegram.WebApp.initData` is non-empty:
  - `ready()`, `expand()`;
  - `setHeaderColor` / `setBackgroundColor` to `#08090c` (Bot API 6.1+);
  - native **BackButton**: shown on non-root routes or after switching desks;
    tapping it returns to the previous desk (in-memory history) or router back.

## Security

- `initData` is **not verified** and is never sent anywhere or used for auth,
  identity, permissions or limits. Using it for anything like that requires a
  server-side HMAC check with the bot token (not part of this app).
- CSP keeps `script-src 'self'` (the SDK is vendored, not loaded from telegram.org).
- `vercel.json` sends `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org`
  so Telegram Web (which embeds Mini Apps in an iframe) can frame the app; every
  other origin is still blocked (clickjacking protection). `X-Frame-Options` was
  dropped because it has no allow-list form; all modern browsers honour
  `frame-ancestors`.
  The separate `Content-Security-Policy-Report-Only` allowlist policy is unaffected
  by this change and still ships intact. Note: a `<meta>` CSP cannot carry
  `frame-ancestors`, so on hosts that ignore
  `vercel.json` (static mirrors, `.nsite`) framing is not restricted by headers.

## Known limits

- Wallet popups / deep links (Anchor, WAX Cloud Wallet) may be blocked or open
  outside Telegram's in-app browser. Test them manually. Session-key import in
  the tab is unaffected.
- Not done (yet): `themeParams` mapping, `disableVerticalSwipes()`,
  `openLink()` for external links, haptics.
