import { atomWithQuery } from "jotai-tanstack-query"
import { atom } from "jotai"
import { fetchGamesCatalog, type ApiGame } from "../wasm/games-api"


const gameTilesQueryAtom = atomWithQuery<ApiGame[]>(() => {
  return {
    queryKey: ['gameTiles'],
    // One /api/games request, shared with the boot's snapshot binding.
    queryFn: fetchGamesCatalog,
  }
})

/** Tiles of the games the landing page advertises. `listed: false` rows
 * (TestGame, for cypress) stay reachable by URL only. */
export const gameTilesAtom = atom(get => (get(gameTilesQueryAtom).data ?? []).filter((g) => g.listed !== false))
