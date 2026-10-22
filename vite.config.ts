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
    target: "es2022",
    // Gzip accounting walks every asset. With the font and chunk count here
    // it dominates an otherwise short rolldown build.
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      experimental: {
        // Skip unused re-exports in side-effect-free barrels (lucide).
        lazyBarrel: true,
      },
      output: {
        // Avoid TDZ checks on bundled top-level bindings.
        topLevelVar: true,
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/,
              priority: 20,
            },
            {
              // Dynamic import from session.ts. Do not pull shared helpers
              // into this chunk — that reattached it to the entry graph.
              name: "vendor-wharfkit",
              test: /node_modules[\\/](@wharfkit|@greymass)[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
            {
              name: "vendor-crypto",
              test: /node_modules[\\/](@noble|@scure)[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
            // nostr and recharts are intentionally NOT grouped. They are only
            // reachable through lazy boundaries (NostrShell, lazy desks).
            // Forcing them into a vendor chunk dragged shared CJS interop
            // helpers along and pulled that chunk back into the initial
            // modulepreload graph.
          ],
        },
      },
    },
  },
}));