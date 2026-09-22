import Lean
import GameServer.RpcHandlers
import GameServer.SaveData
import GameServer.Tactic.LetIntros
import GameServer.Helpers.DeclSig

namespace GameServer

open Lean Meta Elab Command


-- TODO: use HashSet for allowed tactics?
/--
Find all tactics in syntax object that are forbidden according to a
set `allowed` of allowed tactics.

L8: returns `true` iff a forbidden *tactic* was reported as an error (difficulty 2), so that
`Runner` can skip elaborating the proof. Forbidden theorems/definitions are reported exactly as
before but never set it. Every node is still visited, so all messages are still produced.
-/
partial def findForbiddenTactics (levelInfo : LevelInfo)
    (levelId : LevelId) (inventory : List String) (difficulty : Nat) (stx : Syntax) : CommandElabM Bool := do
  -- `levelInfo` is loaded ONCE by the caller (`Runner`): this function runs once per syntax node and
  -- `loadLevelData` (JSON read+parse) costs ~46 ms per call under wasm64, i.e. 46 ms × nodes per keystroke.
  -- Parse the syntax object and look for tactics and declarations.
  match stx with
  | .missing => return false
  | .node _info _kind args =>
    -- Go inside a node.
    let mut forbidden := false
    for arg in args do
      if ← findForbiddenTactics levelInfo levelId inventory difficulty arg then
        forbidden := true
    return forbidden
  | .atom _ val =>
    -- Atoms might be tactic names or other keywords.
    -- Note: We whitelisted known keywords because we cannot
    -- distinguish keywords from tactic names.
    let allowed := GameServer.ALLOWED_KEYWORDS
    -- Ignore syntax elements that do not start with a letter or are listed above.
    if 0 < val.length ∧ val.toList[0]!.isAlpha ∧ not (allowed.contains val) then
      match levelInfo.tactics.find? (·.name.toString == val) with
      | none =>
        -- Tactic will never be introduced in the game.
        match inventory.find? (· == val) with
        | some _ =>
          -- Tactic is in the inventory, allow it.
          -- Note: This case shouldn't be possible...
          return false
        | none =>
          -- Tactic is not in the inventory.
          addMessageByDifficulty s!"The tactic '{val}' is not available in this game!"
      | some tac =>
        -- Tactic is introduced at some point in the game.
        if tac.disabled then
          -- Tactic is disabled in this level.
          addMessageByDifficulty s!"The tactic '{val}' is disabled in this level!"
        else if tac.locked then
          match inventory.find? (· == val) with
          | none =>
            -- Tactic is marked as locked and not in the inventory.
            addMessageByDifficulty s!"You have not unlocked the tactic '{val}' yet!"
          | some _ =>
            -- Tactic is in the inventory, allow it.
            return false
        else
          return false
    else
      return false
  | .ident _ _rawVal val _preresolved =>
    -- Try to resolve the name
    let ns ←
      try resolveGlobalConst (mkIdent val)
      -- Catch "unknown constant" error
      catch | _ => pure []
    for n in ns do
      let some (.thmInfo ..) := (← getEnv).find? n
        -- Not a theorem, no checks needed.
        | return false
      if some n = levelInfo.statementName then
        -- Forbid the theorem we are proving currently
        logErrorAt stx m!"Structural recursion: you can't use '{n}' to proof itself!"
      let theoremsAndDefs := levelInfo.lemmas ++ levelInfo.definitions
      match theoremsAndDefs.find? (·.name == n) with
      | none =>
        -- Theorem will never be introduced in this game
        discard <| addMessageByDifficulty s!"The theorem/definition '{n}' is not available in this game!"
      | some thm =>
        -- Theorem is introduced at some point in the game.
        if thm.disabled then
          -- Theorem is disabled in this level.
          discard <| addMessageByDifficulty s!"The theorem/definition '{n}' is disabled in this level!"
        else if thm.locked then
          match inventory.find? (· == n.toString) with
          | none =>
            -- Theorem is still locked.
            discard <| addMessageByDifficulty s!"You have not unlocked the theorem/definition '{n}' yet!"
          | some _ =>
            -- Theorem is in the inventory, allow it.
            pure ()
    -- L8: forbidden theorems/definitions never stop the elaboration (only tactics do).
    return false

where addMessageByDifficulty (s : MessageData) : CommandElabM Bool := do
  -- Send nothing/warnings/errors depending on difficulty.
  if difficulty > 0 then
    logAt stx s (if difficulty > 1 then .error else .warning)
  -- L8: `true` iff the message was an error (difficulty 2).
  return difficulty > 1

/-- L8: the top-level tactics of a `tacticSeq` in order (the even-indexed children of its
`sepByIndent` node, for both `tacticSeq1Indented` and `tacticSeqBracketed`), or `none` if the
syntax has an unexpected shape. -/
def topLevelTactics? (seq : Syntax) : Option (Array Syntax) := do
  guard (seq.isOfKind ``Lean.Parser.Tactic.tacticSeq)
  let inner := seq[0]
  let sep ←
    if inner.isOfKind ``Lean.Parser.Tactic.tacticSeq1Indented then some inner[0]
    else if inner.isOfKind ``Lean.Parser.Tactic.tacticSeqBracketed then some inner[1]
    else none
  return sep.getArgs.zipIdx.filterMap fun (t, i) => if i % 2 == 0 then some t else none

-- TODO(Alex): Use config parser?
-- TODO(Alex): Ensure Runner is the last command in the file
/-- Run a game level -/
elab "Runner" gameId:str worldId:str levelId:num
 "(" &"difficulty" ":=" difficulty:num ")"
 "(" &"inventory" ":=" "[" inventory:str,* "]" ")" ":=" byStx:&"by"
 tacticStx:tacticSeq ? : command => do

  let levelId := {game := gameId.getString, world := worldId.getString, level := levelId.getNat}
  let difficulty := difficulty.getNat
  let inventory := inventory.getElems.map (·.getString) |>.toList

  let some level ← getLevel? levelId
    | logError m!"Level not found: {levelId}"

  -- use open namespaces and options as in the level file
  let scope := { level.scope with
    varDecls := level.scope.varDecls.map (⟨·.raw.rewriteBottomUp fun stx => stx.setInfo .none⟩)
    attrs :=  level.scope.attrs.map (⟨·.raw.rewriteBottomUp fun stx => stx.setInfo .none⟩)
  }
  Elab.Command.withScope (fun _ => scope) do
    for od in scope.openDecls do
      let .simple ns _ := od
        | pure ()
      activateScoped ns
    activateScoped scope.currNamespace

    -- Position before first tactic and any prepended whitespace
    let startPos := byStx.getTailInfo.getRange?.getD (Lean.Syntax.Range.mk 0 0) |>.stop

    -- Position behind the last tactic
    let endPos := (tacticStx.map TSyntax.raw).getD byStx
      |>.getTailInfo |>.getRangeWithTrailing? |>.getD (Lean.Syntax.Range.mk 0 0) |>.stop
    -- Adjust endPos to be one character earlier (probably the end of file character?)
    let endPos := ⟨endPos.byteIdx-1⟩

    -- L8: check for forbidden tactics BEFORE elaborating the proof. At difficulty 2 they are errors
    -- and the level fails whatever the proof does, so the proof is elaborated TRUNCATED before the
    -- first top-level tactic that contains a forbidden tactic (a nested one counts as its enclosing
    -- top-level tactic): the tactics before it keep their goals in the info tree, it and everything
    -- after it are dropped, and the final `done` moves to its position so that `goalsAt?` at the
    -- start of its line still finds the goals after the last kept tactic. If the first tactic is
    -- forbidden, the empty-proof placeholder `skip` is elaborated instead (the initial goal shows).
    -- Under wasm64 a forbidden `exact?` otherwise runs its library search for 13–46 s before the
    -- error reaches the client. The messages (wording, positions), difficulty 0/1, forbidden
    -- theorems and accepted proofs are unchanged; every forbidden tactic is still reported.
    -- Invisible `skip` command to make sure we always display the initial goal
    let skip : TSyntax `tactic := ⟨Syntax.node (.original default startPos default endPos)
      ``Lean.Parser.Tactic.skip #[]⟩
    let mut tactics : Array (TSyntax `tactic) := #[skip] -- empty tactic sequence
    let mut donePos := endPos
    let mut truncated := false
    if let some seq := tacticStx then
      let levelInfo ← loadLevelData "." levelId.world levelId.level
      match topLevelTactics? seq.raw with
      | some tops =>
        let mut cut? : Option Nat := none
        for t in tops, i in [0:tops.size] do
          if ← findForbiddenTactics levelInfo levelId inventory difficulty t then
            if cut?.isNone then
              cut? := some i
        match cut? with
        | none => tactics := seq.raw.getArgs.map (⟨.⟩) -- nothing forbidden: elaborate as before
        | some k =>
          truncated := true
          donePos := tops[k]!.getPos?.getD endPos
          if k > 0 then
            tactics := (tops.extract 0 k).map (⟨.⟩)
      | none =>
        -- unexpected `tacticSeq` shape: treat the whole sequence as one tactic
        if !(← findForbiddenTactics levelInfo levelId inventory difficulty seq.raw) then
          tactics := seq.raw.getArgs.map (⟨.⟩)

    -- Insert final `done` command to display unsolved goal error in the end
    -- L8: when the proof was cut, `done` sits at the first forbidden tactic and is *canonical*, because
    -- `goalsAt?` ignores non-canonical positions and nothing else covers the start of that line: its
    -- (recorded even though it fails) goals-before are the goals after the last kept tactic.
    let done := Syntax.node (.synthetic donePos donePos (canonical := truncated)) ``Lean.Parser.Tactic.done #[]
    let tacticStx := tactics ++ #[⟨done⟩]

    let tacticStx := ← `(Lean.Parser.Tactic.tacticSeq| $[$(tacticStx)]*)

    let goal := ⟨level.goal.raw.rewriteBottomUp fun stx => stx.setInfo .none⟩

    let isProp := level.isProp
    let optDeclSig := declSig.toOptDeclSig goal


    -- Run the proof
    let thmStatement ← match isProp with
    | true => `(command| theorem the_theorem $(goal) := by {let_intros; $(⟨level.preamble⟩); $(⟨tacticStx⟩)} )
    | false => `(command| def the_theorem $(optDeclSig) := by {let_intros; $(⟨level.preamble⟩); $(⟨tacticStx⟩)} )

    elabCommand thmStatement
