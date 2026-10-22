import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

/** Async chunks that must not ride the initial modulepreload graph. */
const DEFERRED_CHUNK = /wharfkit|use-bot-loop|use-portfolio-loop|use-wallet-sync|import-key|NIP19|NostrShell|nostrify|nostr-tools|recharts|lightweight-charts|CandleChart|DepthChart|bot-desk|ai-desk|portfolio-desk/i;

// https://vitejs.dev/config/
export default defineConfig(() => ({
  base: process.env.VITE_BASE || "/",
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router-dom",
      "@tanstack/react-query",
      "zustand",
      "@wharfkit/session",
      "@wharfkit/web-renderer",
      "@wharfkit/wallet-plugin-anchor",
      "@wharfkit/wallet-plugin-cloudwallet",
      "lightweight-charts",
      "recharts",
    ],
  },
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
    target: "es2022",
    minify: "oxc" as const,
    // Gzip of a multi-MB output is often slower than the bundle step itself.
    reportCompressedSize: false,
    modulePreload: {
      polyfill: false,
      resolveDependencies(_filename: string, deps: string[]) {
        return deps.filter((dep) => !DEFERRED_CHUNK.test(dep));
      },
    },
    rollupOptions: {
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
          // Wharfkit / Antelope session stack.
          if (
            /node_modules\/(@wharfkit|@greymass)\//.test(id)
          ) {
            return "vendor-wharfkit";
          }
          // Crypto primitives used by the wallet/key code (initial graph),
          // kept apart so they don't drag the Nostr chunk in with them.
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
