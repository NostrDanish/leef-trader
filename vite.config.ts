import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const DOM_TEST_GLOBS = [
  'src/**/*.test.tsx',
  'src/components/**/*.test.ts',
  'src/hooks/**/*.test.ts',
  'src/store/**/*.test.ts',
  'src/test/**/*.test.ts',
  'src/lib/telegram/**/*.test.ts',
];

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
    setupFiles: './src/test/setup.ts',
    // jsdom costs ~0.5s of setup per file, which dominated the suite when every
    // pure-logic test paid it. Only UI/browser-facing code gets a DOM.
    projects: [
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: [...DOM_TEST_GLOBS],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: [...DOM_TEST_GLOBS],
        },
      },
    ],
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