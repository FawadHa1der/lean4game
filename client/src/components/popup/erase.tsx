/**
 * @fileOverview
*/
import * as React from 'react'
import { downloadFile } from '../world_tree'
import { Button } from '../button'
import { Trans, useTranslation } from 'react-i18next'
import { useAtom } from 'jotai'
import { popupAtom } from '../../store/popup-atoms'
import { gameIdAtom, levelIdAtom, worldIdAtom } from '../../store/location-atoms'
import { levelProgressAtom, progressAtom, worldProgressAtom } from '../../store/progress-atoms'
import { GameProgress } from '../../store/progress-types'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { levelUri } from '../../wasm/level-uri'
import { crashedAtom, proofAtom } from '../../store/editor-atoms'
import { proofLevel } from '../infoview/goals'

/** download the current progress (i.e. what's saved in the browser store) */
export function downloadProgress(gameId: string, gameProgress: GameProgress) {
  downloadFile({
    data: JSON.stringify(gameProgress, null, 2),
    fileName: `lean4game-${gameId}-${new Date().toLocaleDateString()}.json`,
    fileType: 'text/json',
  })
}

// /** Pop-up to delete game progress.
//  *
//  * `handleClose` is the function to close it again because it's open/closed state is
//  * controlled by the containing element.
//  */
// export function ErasePopup ({handleClose}) {
//   let { t } = useTranslation()
//   const gameId = React.useContext(GameIdContext)
//   const gameProgress = useSelector(selectProgress(gameId))
//   const dispatch = useAppDispatch()

//   const eraseProgress = () => {
//     dispatch(deleteProgress({game: gameId}))
//     handleClose()
//   }

//   const downloadAndErase = (ev) => {
//     downloadProgress(gameId, gameProgress, ev)
//     eraseProgress()
//   }

//   return <div className="modal-wrapper">
//   <div className="modal-backdrop" onClick={handleClose} />
//   <div className="modal">
//     <div className="codicon codicon-close modal-close" onClick={handleClose}></div>
//     <h2>{t("Delete Progress?")}</h2>
//     <Trans>
//       <p>Do you want to delete your saved progress irreversibly?</p>
//       <p>
//         (This deletes your proofs and your collected inventory.
//         Saves from other games are not deleted.)
//       </p>
//     </Trans>
//     <Button onClick={eraseProgress} >{t("Delete")}</Button>
//     <Button onClick={downloadAndErase} >{t("Download & Delete")}</Button>
//     <Button onClick={handleClose} >{t("Cancel")}</Button>
//   </div>
// </div>
// }

export function ErasePopup () {
  let { t } = useTranslation()
  const [gameId, navigateToGame] = useAtom(gameIdAtom)
  const [worldId] = useAtom(worldIdAtom)
  const [levelId] = useAtom(levelIdAtom)
  const [gameProgress, setGameProgress] = useAtom(progressAtom)
  const [worldProgress, setWorldProgress] = useAtom(worldProgressAtom)
  const [levelProgress, setLevelProgress] = useAtom(levelProgressAtom)

  // const { setPage } = useContext(PageContext)
  const [, setPopup] = useAtom(popupAtom)

  const eraseProgress = () => {
    resetMountedLevel() // L1 (the caller then navigates to the map)
    setGameProgress(null)
    setPopup(null)
    // setPage(0) // TODO: fix me
    // ev.preventDefault() // TODO: this is a hack to prevent the buttons below from opening a link
  }

  const [, setProof] = useAtom(proofAtom)
  const [, setCrashed] = useAtom(crashedAtom)

  /** L1: the level under the popup is MOUNTED — its editor still holds the
   * proof, the pane still shows it as completed, and the editor's persist
   * effect would write the text straight back. Empty the live model first
   * (its didChange re-elaborates the empty proof), drop the in-memory proof
   * state (and its level stamp, so nothing re-saves completed:true), then
   * erase. "Delete Everything" leaves the level (the map), where the model
   * is disposed with it (level.tsx cleanup). */
  function resetMountedLevel () {
    if (!worldId || !levelId) return
    try {
      monaco.editor.getModel(monaco.Uri.parse(levelUri(worldId, levelId)))?.setValue('')
    } catch (e) { console.warn('[erase] could not reset the open editor:', e) }
    proofLevel.key = ''
    setProof(undefined)
    setCrashed(false)
  }

  function eraseLevel () {
    resetMountedLevel()
    setLevelProgress(null)
    setPopup(null)
  }

  function eraseWorld () {
    resetMountedLevel()
    setWorldProgress(null)
    setPopup(null)
  }

  const downloadAndErase = () => {
    if (!gameId) return
    if (gameProgress) {
      downloadProgress(gameId, gameProgress)
    }
    eraseProgress()
  }

  return <>
    <h2>{t("Delete Progress?")}</h2>
    <Trans>
      <p>Do you want to delete your saved progress irreversibly?</p>
    </Trans>
    <div className='settings-buttons'>
      <Button onClick={(ev) => {ev.preventDefault(); eraseLevel()}}  disabled={!levelId} >{t("Delete this Level")}</Button>
      <Button onClick={(ev) => {ev.preventDefault(); eraseWorld()}}  disabled={!worldId} >{t("Delete this World")}</Button>
      <Button onClick={(ev) => {ev.preventDefault(); eraseProgress(); if(gameId) {navigateToGame(gameId)}}} >{t("Delete Everything")}</Button>
    </div>
    <Trans>
      <p>
        Deleting everything will delete all your proofs and your collected inventory! It's recommended
        to download your progress first.
      </p>
      <p>
        (Saves from other games are not deleted.)
      </p>
    </Trans>
    <div className='settings-buttons'>
      <Button onClick={(ev) => {ev.preventDefault(); downloadAndErase(); if(gameId) {navigateToGame(gameId)}}} >{t("Download & Delete everything")}</Button>
      <Button onClick={(ev) => {setPopup(null); ev.preventDefault()}} >{t("Cancel")}</Button>
    </div>
  </>
}
