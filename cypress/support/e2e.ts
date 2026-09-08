// ***********************************************************
// This example support/e2e.ts is processed and
// loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************

// Import commands.js using ES2015 syntax:
import './commands'

// Alternatively you can use CommonJS syntax:
// require('./commands')
// The production build registers a service worker; between specs, drop it
// and its caches so a spec never runs against the previous build's shell.
before(() => {
  cy.window().then(async (w) => {
    try {
      for (const r of await w.navigator.serviceWorker.getRegistrations()) await r.unregister()
      for (const k of await w.caches.keys()) await w.caches.delete(k)
    } catch { /* not supported in this browser */ }
  })
})
