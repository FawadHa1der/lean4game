import * as React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '../css/landing_page.css'
import bgImage from '../assets/bg.jpg'
import { Markdown } from './markdown';
import { ImpressumButton, LanguageButton, LanguageDropdown, MenuButton, PreferencesButton, PrivacyButton } from './app_bar';
import ReactCountryFlag from 'react-country-flag';
import lean4gameConfig from '../config.json'
import i18next from 'i18next';
import { popupAtom, PopupType } from '../store/popup-atoms';
import { useAtom } from 'jotai';
import { GithubIcon } from './navigation/github_icon';
import { navOpenAtom } from '../store/navigation-atoms';
import { gameIdAtom } from '../store/location-atoms';
import { gameInfoAtomFamily } from '../store/query-atoms';
import { preferencesAtom } from '../store/preferences-atoms';
import { completedLevelCountsAtom } from '../store/progress-atoms';
import { gameTilesAtom } from '../store/tiles-atoms';
import { fallbackSnapshotName, gameIdOf, tileSnapshotStates, type ApiGame, type TileSnapshotState } from '../wasm/games-api';
import { prepareGame, prepareStatusesAtom, removeRawSnapshot, storageSummary } from '../wasm/game-cache';
import { boundEnvironmentAtom } from '../wasm/game-boot';
import { bootStatusAtom } from '../store/boot-atoms';

/** The snapshot a tile's game boots (the catalog's name; the boot's fallback
 * for a row that predates the field). */
const tileSnapshotName = (row: ApiGame): string => row.snapshot || fallbackSnapshotName(gameIdOf(row))

/** Enter / Space on a click-handled element that is not a native button:
 * dispatch its click (React's onClick and the bubbling stay the same). */
const activateOnKey = (ev: React.KeyboardEvent<HTMLElement>) => {
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click() }
}

function Tile({tileWithName, snapshot, done, opfs, onCacheChanged}: {tileWithName: ApiGame, snapshot?: TileSnapshotState, done?: number, opfs: boolean | null, onCacheChanged: () => void}) {
  const { t, i18n } = useTranslation()
  const [, navigateToGame] = useAtom(gameIdAtom)
  const [preferences] = useAtom(preferencesAtom)
  // "Prepare offline" / "Remove download": the environment cache without a
  // boot (game-cache.ts). The prepare runs in a worker of this document —
  // navigating within the app keeps it, a reload cancels it (said on the
  // tile; a game switch waits for it before its reload) — and its status is
  // a page-level atom the boot reads too.
  const [prepares] = useAtom(prepareStatusesAtom)
  const [boundEnv] = useAtom(boundEnvironmentAtom)
  const snapshotName = tileSnapshotName(tileWithName)
  const prep = prepares[snapshotName]
  // The region is in OPFS from 'warming' on (the runtime warm-up still runs):
  // the availability row and the meter re-probe then, and once more at 'done'.
  React.useEffect(() => { if (prep?.phase === 'warming' || prep?.phase === 'done') onCacheChanged() }, [prep?.phase])
  const entry = snapshot?.entry
  const mb = (n: number) => Math.round(n / 1048576)
  // The game loaded in this tab: its session's own prefetch worker owns the
  // region file (a Prepare would find it busy and fail), and removing its
  // region would make the next crash-reboot download it again mid-play —
  // neither action is offered while it is bound.
  const inUse = boundEnv?.snapshot === snapshotName
  // Progress in the units the availability row promised (the transfer size:
  // gzip on the wire); the prefetch worker reports inflated offsets, which
  // are scaled here (the bar itself keeps the raw value/max).
  const transfer = entry ? (entry.transfer ?? entry.bytes) : 0
  const scaled = (bytes: number, total: number) => total > 0 ? Math.min(transfer, Math.round((bytes / total) * transfer)) : 0
  // Keyboard focus across the cell's button swaps: Prepare unmounts on
  // click (progress replaces it) and Remove is replaced by a fresh Prepare
  // node, so the browser dropped focus to <body>. A keyboard activation
  // (click detail 0) marks the cell; after each state change the focus is
  // put back on the cell's button, or on the cell itself while it has none.
  const cellRef = React.useRef<HTMLTableCellElement>(null)
  const keepFocus = React.useRef(false)
  const prepare = (ev: React.MouseEvent) => {
    ev.stopPropagation()
    keepFocus.current = ev.detail === 0
    if (entry) void prepareGame(entry, { sessionBound: boundEnv !== null })
  }
  const remove = async (ev: React.MouseEvent) => {
    ev.stopPropagation()
    keepFocus.current = ev.detail === 0
    if (entry) { await removeRawSnapshot(entry); onCacheChanged() }
  }
  React.useEffect(() => {
    const cell = cellRef.current
    if (!keepFocus.current || !cell) return
    const active = document.activeElement
    if (active !== document.body && active !== null && !cell.contains(active)) { keepFocus.current = false; return }
    const target = cell.querySelector<HTMLElement>('button') ?? cell
    if (active !== target) target.focus({ preventScroll: true })
  }, [prep?.phase, prep?.result, snapshot?.state, inUse])
  let cacheActions: React.ReactNode = null
  if (entry && (prep?.phase === 'running' || prep?.phase === 'warming')) {
    const progressText = prep.phase === 'warming'
      ? t("Caching the checker", { defaultValue: "Environment downloaded — caching the checker so this game plays offline…" })
      : t("Preparing… {{done}} / {{total}} MB", { done: mb(scaled(prep.bytes, prep.total)), total: mb(transfer) })
    cacheActions = <>
      <progress aria-label={progressText} value={prep.bytes} max={prep.total} />
      <div>{progressText}</div>
      <div className="note">
        {t("Prepare note", { defaultValue: "Keeps downloading while you browse this site; reloading the page cancels it." })}
        {prep.memoryNote ? ` ${t("Prepare memory note", { defaultValue: "Preparing a game while another one is loaded needs extra memory on this device." })}` : ''}
      </div>
    </>
  } else if (entry && inUse) {
    cacheActions = <div className="note">{t("In use by this tab", { defaultValue: "Loaded in this tab — its download is managed by the game." })}</div>
  } else if (opfs === false) {
    cacheActions = null // no offline storage: the page-level note says so once
  } else if (entry && snapshot?.state === 'download') {
    // The worker's exit status in the user's words; a Retry only where one
    // can succeed (a bare error, or a file another tab held).
    const failure = prep?.phase !== 'failed' ? null
      : prep.result === 'busy' ? t("Prepare busy", { defaultValue: "Already being downloaded — by the game loaded in this tab or by another tab." })
      : prep.result === 'unavailable' ? t("Offline storage unavailable", { defaultValue: "This browser mode cannot keep games offline; each visit downloads the game again." })
      : t("Preparation failed: {{error}}", { error: prep.error ?? prep.result })
    const retryable = prep?.phase === 'failed' && prep.result !== 'unavailable'
    cacheActions = <>
      {failure && <div className="note failed">{failure}</div>}
      {(prep?.phase !== 'failed' || retryable) && <button onClick={prepare}>{retryable ? t("Retry") : t("Prepare offline")}</button>}
    </>
  } else if (entry && snapshot?.state === 'ready') {
    cacheActions = <button onClick={remove}>{t("Remove download")}</button>
  }

  const gameTile = tileWithName.tile
  const gameId = gameIdOf(tileWithName)
  // The tile's truth before the click (served index + this shell's runtime
  // + OPFS): cached and playable offline, a download of N MB, or not
  // published for this build — the last cannot boot, so it does not navigate.
  // Unknown (not resolved yet, or the index/manifest unreadable) shows no
  // row and navigates: the boot's own pairing check reports the reason.
  const unavailable = snapshot?.state === 'unavailable'
  const availability = snapshot === undefined ? null
    : snapshot.state === 'ready' ? t("Ready — plays offline")
    : snapshot.state === 'download' ? t("Download ≈{{mb}} MB", { mb: snapshot.transferMB })
    : t("Not available on this build")

  // The tile is the game's link: in the tab order, named by its title,
  // opened by Enter / Space as well as by click (the Prepare / Remove
  // buttons inside it keep their own keys — stopPropagation on their
  // clicks; the key handler only acts on the tile itself).
  const titleId = `game-title-${gameId.replace(/[^A-Za-z0-9_-]/g, '-')}`
  const open = () => { if (!unavailable) navigateToGame(gameId) }
  return <div className={"game" + (unavailable ? " unavailable" : "")} onClick={open}
      role="link" tabIndex={unavailable ? -1 : 0} aria-disabled={unavailable || undefined} aria-labelledby={titleId}
      onKeyDown={(ev) => { if (ev.target !== ev.currentTarget) return; if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open() } }}>
      <div className="wrapper">
        <div className="title" id={titleId}>{t(gameTile.title, {ns: gameId})}</div>
        <div className="short-description">{t(gameTile.short, { ns: gameId })}
        </div>
        { gameTile.image ? <img className="image" src={`/data/${gameId}/${gameTile.image}`} alt="" /> : <div className="image"/> }
        <div className="long description"><Markdown>{t(gameTile.long, { ns: gameId })}</Markdown></div>
      </div>
      <table className="info">
        <tbody>
        <tr>
          <td title="consider playing these games first.">{t("Prerequisites")}</td>
          <td><Markdown>{gameTile.prerequisites.map((p) => t(p, { ns: gameId })).filter((p) => !/^\[Game\]/.test(p)).join(', ')}</Markdown></td>
        </tr>
        <tr>
          <td>{t("Worlds")}</td>
          <td>{gameTile.worlds}</td>
        </tr>
        <tr>
          <td>{t("Levels")}</td>
          <td>{gameTile.levels}</td>
        </tr>
        <tr className="languages">
          <td>{t("Language")}</td>

          <td>
            {gameTile.languages.map((lang) => {
              let langOpt = lean4gameConfig.languages.find((e) => e.iso == lang)
              if (preferences.useFlags && langOpt?.flag) {
                return <ReactCountryFlag key={`flag-${lang}`} title={langOpt.name} countryCode={langOpt.flag} className="emojiFlag"/>
              } else {
                return <span title={langOpt?.name}>{lang}</span>
              }
            })}
          </td>
        </tr>
        {availability !== null &&
        <tr className="availability">
          <td>{t("Environment")}</td>
          <td>{availability}</td>
        </tr>}
        {cacheActions !== null &&
        <tr className="cache-actions">
          {/* polite live region: the Prepare button unmounts on click, so the
              running / ready / failed text is what a screen reader hears */}
          <td colSpan={2} aria-live="polite" tabIndex={-1} ref={cellRef}
              onBlur={(ev) => { if (ev.relatedTarget && !ev.currentTarget.contains(ev.relatedTarget as Node)) keepFocus.current = false }}>{cacheActions}</td>
        </tr>}
        {done !== undefined &&
        <tr className="progress">
          <td>{t("Progress")}</td>
          <td>{t("{{done}} of {{total}} levels done", { done, total: gameTile.levels })}</td>
        </tr>}
        </tbody>
      </table>
  </div>
}


function LandingPage() {
  const [, setPopup] = useAtom(popupAtom)
  const [navOpen] = useAtom(navOpenAtom)
  const [tiles] = useAtom(gameTilesAtom)
  // "n of N levels done" per game from the local-storage progress the games
  // write (a read-only view; a game with no record shows no row).
  const [completedCounts] = useAtom(completedLevelCountsAtom)
  // Per-tile truth (ready / download size / not available) from the served
  // snapshot index, this shell's runtime build and OPFS, fetched once the
  // tile list is known. A plain effect: the query atoms only fetch while
  // mounted, and games-api memoises the requests it shares with the boot.
  const [snapshotStates, setSnapshotStates] = React.useState<Map<string, TileSnapshotState>>(new Map())
  const snapshotNames = tiles.map(tileSnapshotName).join(' ')
  // Bumped by a tile when it changed the cache (a prepare finished, a
  // download was removed): the tile states and the storage meter re-probe.
  const [cacheGeneration, setCacheGeneration] = React.useState(0)
  const onCacheChanged = React.useCallback(() => setCacheGeneration((n) => n + 1), [])
  // The game loaded in this tab caches its region through its own boot (no
  // prepare status flips for it): re-probe the tiles once that boot is ready.
  const [bootStatus] = useAtom(bootStatusAtom)
  const [boundEnv] = useAtom(boundEnvironmentAtom)
  React.useEffect(() => { if (boundEnv && bootStatus.state === 'ready') onCacheChanged() }, [boundEnv?.snapshot, bootStatus.state])
  // Offline storage at all? Firefox private mode throws on getDirectory (the
  // tiles would offer a Prepare that can only fail): probed once per page;
  // false hides Prepare / Remove and the meter and says so once.
  const [opfs, setOpfs] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    let cancelled = false
    Promise.resolve().then(() => navigator.storage.getDirectory()).then(() => true, () => false).then((ok) => { if (!cancelled) setOpfs(ok) })
    return () => { cancelled = true }
  }, [])
  React.useEffect(() => {
    if (!snapshotNames) return
    let cancelled = false
    tileSnapshotStates(snapshotNames.split(' ')).then(
      (states) => { if (!cancelled) setSnapshotStates(states) },
      (e) => console.warn('[landing] snapshot states unavailable:', e))
    return () => { cancelled = true }
  }, [snapshotNames, cacheGeneration])
  // The storage meter: navigator.storage.estimate() (hidden where it is
  // unavailable — Firefox private mode) and the count of tiles whose
  // region is in OPFS.
  const [storage, setStorage] = React.useState<{ usage: number; quota: number } | null>(null)
  React.useEffect(() => {
    let cancelled = false
    storageSummary().then((s) => { if (!cancelled) setStorage(s) })
    return () => { cancelled = true }
  }, [cacheGeneration])
  const cachedGames = [...snapshotStates.values()].filter((s) => s.state === 'ready').length
  const gb = (n: number) => (n / 1e9).toFixed(1)
  // Chrome reports navigator.deviceMemory in {0.25 … 8}: below 8 the device
  // really is small; 8 means "8 or more". Said here, before the first click,
  // and again in the level pane (deep links never see this page).
  const deviceGb = (navigator as { deviceMemory?: number }).deviceMemory
  const smallDevice = typeof deviceGb === 'number' && deviceGb < 8


  const { t, i18n } = useTranslation()

  // Load the namespaces of all games
  i18n.loadNamespaces(tiles.map(tileWithName => `g/${tileWithName.owner}/${tileWithName.game}`))
  // Offline landing: those namespace fetches happen before the service
  // worker controls a first-visit page (index.tsx registers it on 'load'),
  // so the worker never stored them, and an offline landing then retried
  // each one six times (console errors; the Robo tile showed raw keys).
  // Once the worker is in control, fetch them again through it — its
  // network-first path keeps them in the runtime cache; the HTTP cache
  // answers the second fetch. i18next holds them in memory already, so this
  // is invisible to the page.
  React.useEffect(() => {
    if (!snapshotNames || !('serviceWorker' in navigator)) return
    let cancelled = false
    const langs = [...new Set([i18n.language, 'en'])]
    const urls = tiles.flatMap((row) => langs.map((lng) => `/i18n/g/${row.owner}/${row.game}/${lng}`))
    const warm = () => {
      if (cancelled || !navigator.serviceWorker.controller) return
      for (const u of urls) fetch(u).catch(() => {})
    }
    navigator.serviceWorker.ready.then(warm, () => {})
    navigator.serviceWorker.addEventListener('controllerchange', warm)
    return () => { cancelled = true; navigator.serviceWorker.removeEventListener('controllerchange', warm) }
  }, [snapshotNames, i18n.language])

  return <div className="landing-page">
    <header style={{backgroundImage: `url(${bgImage})`}}>
      <nav className="landing-page-nav">
        <LanguageButton />
        <GithubIcon url="https://github.com/leanprover-community/lean4game"/>
        <MenuButton />
        <LanguageDropdown />
        <div className={'menu dropdown' + (navOpen ? '' : ' hidden')}>
            <ImpressumButton isDropdown={true} />
            <PrivacyButton isDropdown={true} />
            <PreferencesButton />
        </div>
      </nav>
      <div id="main-title">
        <h1>{t("Caption.translation", { defaultValue: "Lean Game Server"})}</h1>
        <p>
          <Trans
            i18nKey="Subcaption.description"
            defaults="A repository of learning games for the proof assistant <1>Lean</1> <i>(Lean 4)</i> and its mathematical library <2>mathlib</2>"
            components={
              {1: <a target="_blank" href="https://leanprover-community.github.io/"/>,
               2: <a target="_blank" href="https://github.com/leanprover-community/mathlib4"/>
            }}
          />
        </p>
        <p className="wasm-notice">
          <Trans
            i18nKey="Wasm notice.description"
            defaults="Games run <strong>fully in your browser</strong> — no server. Each game's environment is downloaded on first play and cached by your browser (the tiles below say how much); later visits start in seconds. The first game also downloads the checker once (about 150 MB)."
          />
        </p>
        {smallDevice &&
          <p className="wasm-notice small-device">
            {t("Small device notice", { defaultValue: "This device reports about {{gb}} GB of memory; the checker needs roughly 8 GB free while it starts and may not start here.", gb: deviceGb })}
          </p>
        }
      </div>
    </header>
    <div className="game-list">
      {opfs === false &&
        <p className="storage-meter">
          {t("Offline storage unavailable", { defaultValue: "This browser mode cannot keep games offline; each visit downloads the game again." })}
        </p>}
      {opfs !== false && storage !== null && snapshotStates.size > 0 &&
        <p className="storage-meter">
          {t("Storage meter", { defaultValue: "Games cached in this browser: {{n}} ({{used}} GB of the {{quota}} GB this site may use)", n: cachedGames, used: gb(storage.usage), quota: gb(storage.quota) })}
        </p>}
      {
      tiles.map((tileWithName, i) => {
          return <Tile
            key={tileWithName.owner + tileWithName.game}
            tileWithName={tileWithName}
            snapshot={snapshotStates.get(tileSnapshotName(tileWithName))}
            done={completedCounts.get(gameIdOf(tileWithName))}
            opfs={opfs}
            onCacheChanged={onCacheChanged}
          />
        })
      }
      {/* {allTiles.filter(x => x != null).length == 0 ?
        <p>
          <Trans
            i18nKey="No Games.description"
            default="No Games loaded. Use <1>http://localhost:3000/#/g/local/FOLDER</1> to open a game directly from a local folder."
            components={{1: <a />}}
          />
        </p>
        : lean4gameConfig.allGames.map((id, i) => (
          <Tile
            key={id}
            gameId={`g/${id}`}
          />
        ))
      } */}
    </div>
    <section>
      <div className="wrapper">
        <h2>{t("In your browser.translation", { defaultValue: "Runs entirely in your browser" })}</h2>
        <Trans
          i18nKey="In your browser.description"
          defaults="<p>There is no game server: the Lean proof checker itself runs inside this tab as WebAssembly. Nothing you type leaves your computer, and there is no capacity limit — as many people can play at once as want to.</p><p>The first visit downloads the checker and the game's mathematical environment (each tile above says how much) and keeps it in your browser's storage, so later visits start in seconds. You need a recent desktop browser (Chrome, Edge or Firefox) and a few GB of free memory; on other browsers the game may not start yet. Your progress is saved in this browser.</p>"
        />
      </div>
    </section>
    <section>
      <div className="wrapper">
        <h2>{t("Development notes.translation", { defaultValue: "Development notes" })}</h2>
        <Trans
          i18nKey="Development notes.description"
          defaults="<p>Most aspects of the games and the infrastructure are still in development. Feel free to file a <1>GitHub Issue</1> about any problems you experience!</p>"
          components={{1: <a target="_blank" href="https://github.com/leanprover-community/lean4game/issues"/>}}
        />
      </div>
    </section>
    <section>
      <div className="wrapper">
        <h2>{t("Adding new games.translation", { defaultValue: "Adding new games" })}</h2>
        <Trans
          i18nKey="Adding new games.description"
          defaults="If you are considering writing your own game, you should use the <1>GameSkeleton Github Repo</1> as a template and read <2>How to Create a Game</2>.<p>You can directly load your games into the server and play it using the correct URL. The <3>instructions above</3> also explain the details for how to load your game to the server. We'd like to encourage you to contact us if you have any questions.</p><p>Featured games on this page are added manually. Please get in contact and we'll happily add yours.</p>"
          components={
            {
             1: <a target="_blank" href="https://github.com/hhu-adam/GameSkeleton"/>,
             2: <a target="_blank" href="https://github.com/leanprover-community/lean4game/"/>,
             3: <a target="_blank" href="https://github.com/leanprover-community/lean4game/"/>,
            }
          }
        />
      </div>
    </section>
    <section>
      <div className="wrapper">
        {/* "Funding.translation" is a key corresponding to a .json entry in a translation.json file. */}
        <h2>{t("Funding.translation", { defaultValue: "Funding" })}</h2>
        <p>
          <Trans
            i18nKey="Funding.description"
            defaults="This server is hosted at Heinrich Heine University Düsseldorf. The lean4game software was developed as part of the project <1>ADAM: Anticipating the Digital Age of Mathematics</1>, funded by the programme <i>Freiraum 2022</i> of the <i>Stiftung Innovation in der Hochschullehre</i>. Ongoing maintenance and development are generously supported by <i>Renaissance Philanthropy</i> through the <i>AI for Math Fund</i>."
            components={{1: <a target="_blank" href="https://hhu-adam.github.io"/>}}
          />
        </p>
      </div>
    </section>
    <footer>
      {/* Do not translate "Impressum", it's needed for German GDPR */}
      <a className="link" role="button" tabIndex={0} onKeyDown={activateOnKey} onClick={() => {setPopup(PopupType.impressum)}}>Impressum</a>
      <a className="link" role="button" tabIndex={0} onKeyDown={activateOnKey} onClick={() => {setPopup(PopupType.privacy)}}>{t("Privacy Policy")}</a>
    </footer>
  </div>
}

export default LandingPage
