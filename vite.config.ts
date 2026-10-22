import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig(() => ({
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
    modulePreload: {
      resolveDependencies(_filename, deps) {
        // The Wharfkit session chunk is a dynamic import (~570 KB). Do not
        // preload it. `session-state` is the tiny handle the shell needs
        // immediately — that one stays.
        return deps.filter(
          (dep) => !/\/session-(?!state-)[^/]+\.js$/.test(dep),
        );
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
          // @noble/@scure are shared by the signer and the Nostr shell.
          // One chunk so neither graph duplicates them. Do not manually
          // chunk @wharfkit, nostr, or recharts: that pulled shared helpers
          // (tslib, bn.js, the react CJS wrapper) into the chunk and made
          // the entry import the whole thing.
          if (/node_modules\/(@noble|@scure)\//.test(id)) {
            return "vendor-crypto";
          }
        },
      },
    },
  },
}));