import * as React from 'react'
import { createRoot } from 'react-dom/client'
import App from './app'
import { Provider } from 'react-redux'
import Welcome from './components/welcome'
import LandingPage from './components/landing_page'
import Level from './components/level'
import './i18n';
import { useAtom } from 'jotai'
import { gameIdAtom, hashSegmentsAtom, levelIdAtom, pathSegmentsAtom, redirectAtom, worldIdAtom } from './store/location-atoms'
import { ErrorBoundary } from './error/ErrorBoundary'
import { NotFound } from './error/NotFound'
import { gameKnown, gameKnownCheck } from './wasm/games-api'
import { CircularProgress } from '@mui/material'
import { scheduleServiceWorkerRegistration } from './wasm/sw-client'
import { leanDownloadInFlight } from './wasm/game-boot'

/** L11: `undefined` while the check runs, then whether the routed game id is
 * one this site serves (see gameKnown — unknown only on positive evidence). */
function useGameKnown(gameId: string | null | undefined): boolean | undefined {
  const [known, setKnown] = React.useState<{ id: string; known: boolean } | null>(null)
  React.useEffect(() => {
    if (!gameId) return
    let live = true
    // The real check decides (D4: the placeholder stays up until it answers
    // — on a slow link the catalog took longer than the old 4 s bound, the
    // level mounted and the boot banner showed for an unknown game); the
    // bounded gameKnown (20 s) is the stalled-link escape hatch only, and a
    // late negative from the real check still lands here.
    void gameKnownCheck(gameId).then((k) => { if (live) setKnown({ id: gameId, known: k }) })
    void gameKnown(gameId).then((k) => { if (live) setKnown((cur) => cur?.id === gameId ? cur : { id: gameId, known: k }) })
    return () => { live = false }
  }, [gameId])
  if (!gameId) return true
  return known?.id === gameId ? known.known : undefined
}

// Offline reloads: the service worker precaches the app shell and caches the
// runtime chunks and artifact manifests on first use (client/src/sw/
// sw.template.js, generated into dist/sw.js by scripts/build-sw.mjs). The
// snapshots and library pack already live in OPFS. Production only: the dev
// server serves no sw.js, and a stale worker would mask live edits.
// N2: a page that boots a game (a game route) registers once the game is
// served or, after 60 s, once no Lean download runs (at most 30 min) — the
// install must never compete with the runtime/snapshot download; the landing page registers on
// load and fills the rest of the shell while no Prepare downloads
// (wasm/sw-client.ts).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // The same two route shapes game-boot's currentGameId reads.
    const gameRoute = /#\/g\/[^/]+\/[^/]+/.test(window.location.hash) || window.location.pathname.split('/').filter(Boolean).length >= 2
    scheduleServiceWorkerRegistration({ deferForBoot: gameRoute, busy: leanDownloadInFlight })
  })
}

function Router() {
  const [gameId] = useAtom(gameIdAtom)
  const [worldId] = useAtom(worldIdAtom)
  const [levelId] = useAtom(levelIdAtom)
  const [hashSegments] = useAtom(hashSegmentsAtom)
  const [segments] = useAtom(pathSegmentsAtom)
  const [, redirect] = useAtom(redirectAtom)
  // L11: an unknown game id rendered the full game chrome around nothing and
  // a burst of 404s; nothing of the game mounts until the id is confirmed.
  const known = useGameKnown(gameId)

  // If `VITE_LEAN4GAME_SINGLE` is set to true, then `/` should be redirected to
  // `/g/local/game` or customized VITE_LEAN4GAME_SINGLE_NAME. This is used for the devcontainer setup
  let single_game = (import.meta.env.VITE_LEAN4GAME_SINGLE === "true")
  let single_game_name = (import.meta.env.VITE_LEAN4GAME_SINGLE_NAME === undefined) ? "game" : import.meta.env.VITE_LEAN4GAME_SINGLE_NAME
  if (single_game && hashSegments.length == 0 && segments.length == 0) {
    redirect(`#/g/local/${single_game_name}`)
    return <div/>
  }

  let child: React.ReactNode
  if (gameId && known === undefined) {
    // Not an empty page: the catalog answer can take seconds on a slow link
    // (the wait itself is bounded in gameKnown).
    child = <div className="app-content loading"><CircularProgress /></div>
  } else if (gameId && known === false) {
    child = <NotFound />
  } else if (gameId && worldId && levelId != null) {
    child = <Level />
  } else if (gameId) {
    child = <Welcome />
  } else if (hashSegments.length == 0) {
    child = <LandingPage />
  }
  else {
    child = <NotFound />
  }

  return (
    <ErrorBoundary>
      <App>{child}</App>
    </ErrorBoundary>
  )
}




const container = document.getElementById('root');
const root = createRoot(container!);
root.render(
  <React.StrictMode>
    <Router />
  </React.StrictMode>
);
