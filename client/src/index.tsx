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

// Offline reloads: the service worker precaches the app shell and caches the
// runtime chunks and artifact manifests on first use (client/src/sw/
// sw.template.js, generated into dist/sw.js by scripts/build-sw.mjs). The
// snapshots and library pack already live in OPFS. Production only: the dev
// server serves no sw.js, and a stale worker would mask live edits.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[sw] registration failed:', e))
  })
}

function Router() {
  const [gameId] = useAtom(gameIdAtom)
  const [worldId] = useAtom(worldIdAtom)
  const [levelId] = useAtom(levelIdAtom)
  const [hashSegments] = useAtom(hashSegmentsAtom)
  const [segments] = useAtom(pathSegmentsAtom)
  const [, redirect] = useAtom(redirectAtom)

  // If `VITE_LEAN4GAME_SINGLE` is set to true, then `/` should be redirected to
  // `/g/local/game` or customized VITE_LEAN4GAME_SINGLE_NAME. This is used for the devcontainer setup
  let single_game = (import.meta.env.VITE_LEAN4GAME_SINGLE === "true")
  let single_game_name = (import.meta.env.VITE_LEAN4GAME_SINGLE_NAME === undefined) ? "game" : import.meta.env.VITE_LEAN4GAME_SINGLE_NAME
  if (single_game && hashSegments.length == 0 && segments.length == 0) {
    redirect(`#/g/local/${single_game_name}`)
    return <div/>
  }

  let child: React.ReactNode
  if (gameId && worldId && levelId != null) {
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
