// Node loader hook for running the .ts unit tests in this folder directly:
//   node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-translation.test.ts
// Node strips types natively but resolves ESM specifiers literally, while the
// sources use bundler-style extensionless relative imports (the tsconfig has
// no allowImportingTsExtensions). Retry a failed relative lookup with `.ts`.
//
// The qed64 dependency ships its library entry (`qed64/embed`) as TypeScript
// source, and Node refuses to strip types under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — the closure also uses
// parameter properties, which stripping alone cannot run. So a module of that
// package is transpiled with the TypeScript the client already depends on,
// as Vite's esbuild does for the build (the package's docs/EMBEDDING.md §6:
// "A Node test runner needs a transpile hook"). Only that package: everything
// else keeps Node's own handling.
import { createRequire, registerHooks } from "node:module";

const QED64_TS = /\/node_modules\/qed64\/.*\.ts$/;
let ts = null; // loaded on first use: a test that never reaches qed64 pays nothing
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (e) {
      if (e?.code === "ERR_MODULE_NOT_FOUND" && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return next(specifier + ".ts", context);
      }
      throw e;
    }
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !QED64_TS.test(new URL(url).pathname)) return next(url, context);
    ts ??= createRequire(import.meta.url)("typescript");
    const { source } = next(url, context);
    const { outputText } = ts.transpileModule(String(source), {
      fileName: new URL(url).pathname,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
