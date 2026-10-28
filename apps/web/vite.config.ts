/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Content-Security-Policy for the built app (spec §12). The same policy belongs in the web server's header (see
 * README.md); the meta tag keeps it in force on mirrors and IPFS gateways that send no header. `frame-ancestors`
 * only works as a header.
 *
 * - No inline scripts or styles anywhere (React sets styles through the CSSOM, which CSP allows).
 * - 'wasm-unsafe-eval' lets libsodium (staging encryption in the contributor and moderator areas) compile its
 *   WebAssembly; it does not allow eval() of JavaScript.
 * - connect-src: relays, gateways, chain RPCs and the API are chosen at run time from signed lists, so any https/wss
 *   origin is allowed; every byte fetched is verified by hash. The `localnet` build mode also allows loopback http/ws
 *   for the local development network.
 */
export function csp(mode: string): string {
  const loopback =
    mode === "localnet" || mode === "development"
      ? " http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*"
      : "";
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self' https: wss:${loopback}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

function cspMeta(mode: string): Plugin {
  return {
    name: "azaad-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp(mode)}" />`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), cspMeta(mode)],
  resolve: {
    alias: [
      { find: /^@core\/(.*)$/, replacement: fileURLToPath(new URL("../../packages/core/dist/$1", import.meta.url)) },
      // The nostr-tools index bundles every NIP; core only needs nip19 from it.
      { find: /^nostr-tools$/, replacement: fileURLToPath(new URL("./src/lib/nostr-tools-index.ts", import.meta.url)) },
    ],
    // One copy of the noble libraries for core, schema and nostr-tools.
    dedupe: ["@noble/curves", "@noble/hashes"],
  },
  build: {
    target: "es2022",
    // Fonts and icons stay as files: CSP font-src/img-src don't allow data: URIs.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  worker: { format: "es" },
  preview: { host: "127.0.0.1" },
  server: { host: "127.0.0.1" },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 20_000,
  },
}));
