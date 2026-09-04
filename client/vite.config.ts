import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react-swc'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { normalizePath } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import svgr from "vite-plugin-svgr"
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import importMetaUrlPlugin from '@codingame/esbuild-import-meta-url-plugin'


const backendPort = process.env.PORT || 8080;
const clientPort = process.env.CLIENT_PORT || 3000;
// wasm64 build: no relay/backend — the Lean server runs in-tab. Static
// gamedata is served from public/, and the dev server must send COOP/COEP
// so SharedArrayBuffer + Memory64 are available to the worker.
const wasmMode = process.env.QED64_WASM !== "0"; // default ON in this fork

const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      next();
    });
  },
};

// https://vitejs.dev/config/
function runtimeBuildId(): string {
  try {
    const m = JSON.parse(readFileSync(new URL("./public/runtime/runtime-manifest.json", import.meta.url), "utf8"))
    return typeof m.buildId === "string" && m.buildId ? m.buildId : "dev"
  } catch {
    return "dev"
  }
}

export default defineConfig({
  build: {
    // Relative to the root
    // Note: This has to match the path in `relay/index.mjs`
    outDir: 'dist',
  },
  plugins: [
    ...(wasmMode ? [crossOriginIsolation] : []),
    react(),
    svgr({
      svgrOptions: {
        // svgr options
      },
    }),
    viteStaticCopy({
      targets: [
        {
          src: [
            normalizePath(path.resolve(__dirname, '../node_modules/lean4monaco/node_modules/@leanprover/infoview/dist/*')),
            normalizePath(path.resolve(__dirname, '../node_modules/lean4monaco/dist/webview/webview.js')),
          ],
          dest: 'infoview'
        },
        {
          src: [
            normalizePath(path.resolve(__dirname, '../node_modules/lean4monaco/node_modules/@leanprover/infoview/dist/codicon.ttf'))
          ],
          dest: 'assets'
        }
      ]
    }),
    nodePolyfills({
      overrides: {
        fs: 'memfs',
      },
    }),
  ],
  define: {
    // qed64-boot asks first for the runtime manifest pinned to the build id of
    // the manifest we ship (public/runtime/runtime-manifest.json) — the
    // atomic-promote scheme of QED64's docs/DEPLOY.md: a shell deploy never
    // races the mutable manifest in R2. Falls back to "dev" (404s the pinned
    // name, then reads the mutable manifest) when no manifest is staged.
    __QED64_BUILD_ID__: JSON.stringify(runtimeBuildId()),
  },
  publicDir: "public",
  base: "/", // setting this to `/leangame/` means the server is now accessible at `localhost:3000/leangame`
  optimizeDeps: {
    exclude: ['games', 'qed64'],
    esbuildOptions: {
      plugins: [importMetaUrlPlugin]
    }
  },
  server: {
    port: Number(clientPort),
    fs: {
      allow: ['..'],
    },
    proxy: wasmMode ? {} : {
      '/websocket': {
        target: `ws://localhost:${backendPort}`,
        ws: true
      },
      '/import': {
        target: `http://localhost:${backendPort}`,
      },
      '/data': {
        target: `http://localhost:${backendPort}`,
      },
      '/api': {
        target: `http://localhost:${backendPort}`,
      },
      '/i18n': {
        target: `http://localhost:${backendPort}`,
      },
    }
  },
  resolve: {
    alias: {
      path: "path-browserify",
      // The wasm substrate (boot, watchdog shim, runtime client, snapshot
      // loader) is a vendored, commit-pinned copy of the qed64 closure —
      // see client/src/wasm/vendor/QED64-PIN and scripts/sync-qed64.sh. It
      // used to be a live `file:` link into the qed64 checkout, which made
      // every build depend on that checkout's uncommitted state.
      qed64: fileURLToPath(new URL('./src/wasm/vendor/qed64', import.meta.url)),
    },
  },
})
