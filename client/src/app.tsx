import * as React from 'react';
import { useEffect, useRef } from 'react';
import { useAtom } from 'jotai';

import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';

import './css/reset.css';
import './css/app.css';
import i18n from './i18n';
import { Popup } from './components/popup/popup';
import { leanMonacoAtom, leanMonacoOptionsAtom } from './store/editor-atoms';
import { LeanMonaco } from 'lean4monaco';
import { preferencesAtom } from './store/preferences-atoms';
import { bootGameRuntime } from './wasm/game-boot';
import { BootBanner } from './components/boot_banner';

// Start the in-tab Lean runtime immediately: the multi-hundred-MB artifact
// download and snapshot load overlap the user reading the world map. The
// editor's LSP port buffers until this resolves.
void bootGameRuntime().catch((e) => console.error('[wasm] Lean runtime boot failed:', e));
// A landing-page load defers game binding; re-trigger when a game route is
// entered (bootGameRuntime is idempotent once bound).
window.addEventListener('hashchange', () => {
  void bootGameRuntime().catch((e) => console.error('[wasm] Lean runtime boot failed:', e));
});

function App({ children }: { children?: React.ReactNode }) {

  const infoviewRef = useRef<HTMLDivElement>(null)
  const [leanMonaco, setLeanMonaco] = useAtom(leanMonacoAtom)
  const [leanMonacoOptions] = useAtom(leanMonacoOptionsAtom)
  const [preferences] = useAtom(preferencesAtom)

  useEffect(() => {
    i18n.changeLanguage(preferences.language)
  }, [preferences.language])

  // You need to start one `LeanMonaco` instance once in your application using a `useEffect`
  useEffect(() => {
    const _leanMonaco = new LeanMonaco()
    setLeanMonaco(_leanMonaco)
    // infoviewRef's div is never rendered (lean4game replaces the iframe
    // infoview with its own EditorConnection), so the ref is always null and
    // lean4monaco's infoview auto-open crashes appending into it. Hand it a
    // real detached element instead - rendered nowhere, harmless everywhere.
    _leanMonaco.setInfoviewElement(infoviewRef.current ?? document.createElement("div"))

    ;(async () => {
      await _leanMonaco.start(leanMonacoOptions)
      console.debug('[lean4game]: leanMonaco started')
    })()

    return () => {
      if (leanMonaco && typeof leanMonaco?.dispose === "function") {
        leanMonaco?.dispose?.()
      }
    }
  }, [leanMonacoOptions, setLeanMonaco])

  return (
    <div className="app">
      <React.Suspense>
        {children}
      </React.Suspense>
      <Popup />
      <BootBanner />
    </div>
  )
}

export default App
