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

/** The snapshot a tile's game boots (the catalog's name; the boot's fallback
 * for a row that predates the field). */
const tileSnapshotName = (row: ApiGame): string => row.snapshot || fallbackSnapshotName(gameIdOf(row))

function Tile({tileWithName, snapshot, done}: {tileWithName: ApiGame, snapshot?: TileSnapshotState, done?: number}) {
  const { t, i18n } = useTranslation()
  const [, navigateToGame] = useAtom(gameIdAtom)
  const [preferences] = useAtom(preferencesAtom)

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

  return <div className={"game" + (unavailable ? " unavailable" : "")} onClick={() => { if (!unavailable) navigateToGame(gameId) }}>
      <div className="wrapper">
        <div className="title">{t(gameTile.title, {ns: gameId})}</div>
        <div className="short-description">{t(gameTile.short, { ns: gameId })}
        </div>
        { gameTile.image ? <img className="image" src={`/data/${gameId}/${gameTile.image}`} alt="" /> : <div className="image"/> }
        <div className="long description"><Markdown>{t(gameTile.long, { ns: gameId })}</Markdown></div>
      </div>
      <table className="info">
        <tbody>
        <tr>
          <td title="consider playing these games first.">{t("Prerequisites")}</td>
          <td><Markdown>{t(gameTile.prerequisites.join(', '), { ns: gameId })}</Markdown></td>
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
  React.useEffect(() => {
    if (!snapshotNames) return
    let cancelled = false
    tileSnapshotStates(snapshotNames.split(' ')).then(
      (states) => { if (!cancelled) setSnapshotStates(states) },
      (e) => console.warn('[landing] snapshot states unavailable:', e))
    return () => { cancelled = true }
  }, [snapshotNames])
  // Chrome reports navigator.deviceMemory in {0.25 … 8}: below 8 the device
  // really is small; 8 means "8 or more". Said here, before the first click,
  // and again in the level pane (deep links never see this page).
  const deviceGb = (navigator as { deviceMemory?: number }).deviceMemory
  const smallDevice = typeof deviceGb === 'number' && deviceGb < 8


  const { t, i18n } = useTranslation()

  // Load the namespaces of all games
  i18n.loadNamespaces(tiles.map(tileWithName => `g/${tileWithName.owner}/${tileWithName.game}`))

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
            defaults="Games run <strong>fully in your browser</strong> — no server. Each game's environment is downloaded on first play and cached by your browser (the tiles below say how much); later visits start in seconds. The first game also downloads the checker once (about 260 MB)."
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
      {
      tiles.map((tileWithName, i) => {
          return <Tile
            key={tileWithName.owner + tileWithName.game}
            tileWithName={tileWithName}
            snapshot={snapshotStates.get(tileSnapshotName(tileWithName))}
            done={completedCounts.get(gameIdOf(tileWithName))}
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
      <a className="link" onClick={() => {setPopup(PopupType.impressum)}}>Impressum</a>
      <a className="link" onClick={() => {setPopup(PopupType.privacy)}}>{t("Privacy Policy")}</a>
    </footer>
  </div>
}

export default LandingPage
