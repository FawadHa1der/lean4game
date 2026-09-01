import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      // The cypress proxy strips COOP/COEP, so pages are never
      // crossOriginIsolated under test. The wasm64 Lean worker needs shared
      // Memory64; this flag grants SharedArrayBuffer without isolation.
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.family === 'chromium') {
          launchOptions.args.push('--enable-features=SharedArrayBuffer')
        }
        return launchOptions
      })
    },
    baseUrl: 'http://localhost:3000'
  },
});
