import { atomWithQuery } from 'jotai-tanstack-query'
import { gameIdAtom, levelIdAtom, worldIdAtom } from './location-atoms'
import { Doc, GameInfo, InventoryOverview, LevelInfo } from './api'
import { atomFamily } from 'jotai/utils'
import { atom } from 'jotai'
import { InventoryTab } from './inventory-atoms'
import { fetchGamedataJson } from '../wasm/gamedata-cache'

/** The info about all games */
export const gameInfoAtomFamily = atomFamily((gameId: string) => atomWithQuery<GameInfo>(() => {
  return {
    queryKey: ['gameInfo', gameId],
    queryFn: async () => {
      return fetchGamedataJson<GameInfo>(`${window.location.origin}/data/${gameId}/game.json`)
    },
    enabled: gameId.length > 0,
  }
}))

/** The info about the current game */
export const gameInfoAtom = atom((get) => {
  const gameId = get(gameIdAtom)
  return get(gameInfoAtomFamily(gameId ?? ""))
})

/** Info about the current level */
export const levelInfoAtom = atomWithQuery<LevelInfo>((get) => {
  const gameId = get(gameIdAtom)
  const worldId = get(worldIdAtom)
  const levelId = get(levelIdAtom)
  // L6: the same guard as Level() (level.tsx). On an in-app navigation from a
  // mounted level to a bad one the still-mounted subscribers re-key this query
  // before React swaps in the not-found page — one level__<W>__<n>.json 404
  // per such navigation on the deployed site. Level 0 (the world intro) has
  // no level file either. Until game.json is known nothing can be ruled out.
  const worldSize = get(gameInfoAtom).data?.worldSize
  const size = worldId ? worldSize?.[worldId] : undefined
  const exists = !worldSize || (size !== undefined && Number.isInteger(levelId) && levelId! >= 1 && levelId! <= size)
  return {
    queryKey: ['levelInfo', gameId, worldId, levelId],
    queryFn: async () => {
      return fetchGamedataJson<LevelInfo>(`${window.location.origin}/data/${gameId}/level__${worldId}__${levelId}.json`)
    },
    // Leaving a level re-reads these options with the ids already gone while
    // the level's subscribers are still mounted; without the guard the query
    // fetched /data/undefined/level__undefined__undefined.json on every exit
    // (a console error offline). Same guard as gameInfoAtomFamily.
    enabled: !!gameId && !!worldId && levelId != null && exists,
  }
})
