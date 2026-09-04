// Node loader hook for running the .ts unit tests in this folder directly:
//   node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-translation.test.ts
// Node strips types natively but resolves ESM specifiers literally, while the
// sources use bundler-style extensionless relative imports (the tsconfig has
// no allowImportingTsExtensions). Retry a failed relative lookup with `.ts`.
import { registerHooks } from "node:module";
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
});
