# Vendored Telegram Mini Apps SDK

`telegram-web-app.js` is a **byte-for-byte copy** of Telegram's official Mini Apps SDK.
It is vendored (instead of loaded from `https://telegram.org`) so the CSP can keep
`script-src 'self'` and no third-party origin can change the code we run.

| | |
|---|---|
| Source | https://telegram.org/js/telegram-web-app.js |
| Fetched | 2026-10-02 |
| Upstream `Last-Modified` | Tue, 14 Jul 2026 09:31:36 GMT |
| Upstream `ETag` | `"6a5601f8-1c71e"` |
| Size | 116510 bytes |
| SHA-256 | `3549138a7934039fe7dfd1291a4ee739bd2b705a614308053a8b08a87d85c451` |

Telegram does not version the URL; the SDK negotiates the Bot API / WebApp
version at runtime (`Telegram.WebApp.version`, `isVersionAtLeast()`).

It is **not** part of the normal bundle. `src/lib/telegram/miniapp.ts` imports it
with `?url` (emitted as a content-hashed file under `/assets/`) and only injects
the `<script>` when the page was launched by Telegram. Regular browser visitors
never download or run it.

## Verify / update

```sh
curl -sSfL https://telegram.org/js/telegram-web-app.js | sha256sum
sha256sum src/vendor/telegram/telegram-web-app.js
```

To update: replace the file with the new upstream copy unmodified, then update the
table above. Review the diff; this script runs on our origin inside Telegram.
