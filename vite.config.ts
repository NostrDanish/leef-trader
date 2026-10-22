import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// GitHub Pages sets VITE_BASE to /<repo>/. Every other host stays at /.
const base = process.env.VITE_BASE || "/";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  base,
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/{vite,eslint}.config.*',
      '.agents/**',
    ],
    onConsoleLog(log) {
      return !log.includes("React Router Future Flag Warning");
    },
    env: {
      DEBUG_PRINT_LIMIT: '0', // Suppress DOM output that exceeds AI context windows
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    // Baseline browsers already understand this syntax; skip downlevel work.
    target: "es2022",
    // modulepreload is supported by the same baseline. The polyfill is an
    // inline script on every HTML response and does nothing there.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          // Core framework — needed for first paint, cached across deploys.
          if (
            /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run)\//.test(
              id,
            )
          ) {
            return "vendor-react";
          }
          // Wharfkit is a dynamic import (wallet login only). Do NOT manual
          // chunk it: grouping it pulled shared helpers into that chunk and
          // modulepreload put the whole 580 KB stack on first paint.
          // Crypto primitives. Loaded with the engine chunk and the key
          // importer, not with the shell. Kept apart so a shared helper
          // cannot drag the Nostr chunk into this one.
          if (/node_modules\/(@noble|@scure)\//.test(id)) {
            return "vendor-crypto";
          }
          // NOTE: nostr and recharts are intentionally NOT manually chunked.
          // They are only reachable through lazy boundaries (NostrShell,
          // lazy desks), so rolldown auto-splits them into async chunks.
          // Forcing them into manual chunks dragged shared CJS interop
          // helpers (react wrapper) into that chunk and pulled it back
          // into the initial modulepreload graph.
        },
      },
    },
  },
}));