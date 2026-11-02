import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { normalizePath } from 'vite'
import path from 'node:path'
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
  // No __QED64_BUILD_ID__ define: it would make qed64's boot ask for a pinned
  // runtime manifest and per-build index copies, which this site no longer has
  // or needs (wasm/DEPLOY.md, "Deploy, in order").
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
      // No qed64 alias: the wasm substrate is the `qed64` package (a git
      // dependency pinned by SHA in package.json), and `qed64/embed` resolves
      // through the package's own exports map — an alias here would capture it.
    },
  },
})
