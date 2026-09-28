import { expect, test } from "bun:test";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";
import { parse } from "luaparse";

// actions.lua dispatches the unit/city/player requests and the decision families; options.lua owns
// discovery (civ.options/civ.probe); state.lua owns turnState (the engine flags the end-turn path is
// decided from). They are loaded in the same order as src/bridge.ts loads them into the game's
// InGame context, which resolves cross-module helpers at call time.
const paths = ["test/lua/shim.lua", "test/lua/fixture.lua", "lua/common.lua", "lua/state.lua", "lua/actions.lua", "lua/options.lua", "lua/diplomacy.lua", "lua/decisions.lua"];
const sources = await Promise.all(paths.map(path => Bun.file(path).text()));

// The fixture models Lua-visible objects only; it cannot simulate native access violations.
function scenario(code: string): void {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    for (const source of [...sources, `AstraCiv.session = 'test'; STUB_INSTALL('default'); AstraCiv.begin(); ${code}`]) {
      if (lauxlib.luaL_dostring(state, to_luastring(source)) !== lua.LUA_OK) {
        throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
      }
    }
  } finally {
    lua.lua_close(state);
  }
}

test("the action dispatcher remains valid Civ Lua 5.1", () => {
  expect(parse(sources[4]!, { luaVersion: "5.1" }).type).toBe("Chunk");
});

test("end turn is resubmittable exactly while the engine reports no outstanding submission", () => {
  scenario(`
    local A = AstraCiv
    local function endTurns() local n = 0
      for _, entry in ipairs(STUB_TRACE()) do if entry.call == 'UI.RequestAction' then n = n + 1 end end
      return n
    end
    local first = A.action({type='end_turn'})
    assert(first.accepted and first.status == 'submitted' and first.completed == false)
    assert(STUB_SUBMITTED == true, 'The engine flag must follow the request')
    -- The engine cleared its own flag again (an interruption such as pending popups or a blocking
    -- notification held the transition): the same turn may be submitted again.
    STUB_SUBMITTED = false
    local second = A.action({type='end_turn'})
    assert(second.accepted and second.status == 'submitted', 'A cleared engine flag was overridden by a stale local latch')
    -- While the engine still reports a submission outstanding, nothing is resubmitted.
    local third = A.action({type='end_turn'})
    assert(not third.accepted and third.status == 'processing_or_already_submitted')
    assert(third.turnState.submitted == true)
    assert(endTurns() == 2, 'An already-submitted turn sent a second ACTION_ENDTURN')
  `);
});

test("an active blocker is reported with its identity and never ends the turn", () => {
  scenario(`
    local A = AstraCiv
    STUB_FIRST_BLOCKER = EndTurnBlockingTypes.ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN}
    local blocked = A.action({type='end_turn'})
    assert(not blocked.accepted and blocked.status == 'blocked')
    -- CanEndTurn stays true with a blocker present; the bridge still does not end the turn, because
    -- the native end-turn button activates the blocker instead (ActionPanel.DoEndTurn).
    assert(blocked.turnState.canEndTurn == true)
    assert(blocked.blockers[1].type == 'ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN')
    assert(blocked.blockers[1].needs == 'influenceToken')
    -- The blocker record above is the whole answer: no prose restating that a blocker blocks.
    assert(blocked.note == nil, 'a refusal states itself through status and blockers, not a sentence')
    for _, entry in ipairs(STUB_TRACE()) do
      assert(entry.call ~= 'UI.RequestAction', 'A blocked turn end requested ACTION_ENDTURN')
    end
    assert(STUB_SUBMITTED == false)
  `);
});

test("the phase gate is family-specific: congress submits while its own segment disables ordinary commands", () => {
  scenario(`
    local A, stage = AstraCiv, 1
    GameCapabilities = {HasCapability=function() return true end}
    DB = {MakeHash=function(name) return name == 'TURNSEG_WORLDCONGRESS_1' and 1 or 2 end}
    Game.GetCurrentTurnSegment = function() return stage end
    Game.GetWorldCongress = function() return {GetProposals=function() return {Proposals={}} end} end
    PlayerOperations.WORLD_CONGRESS_SUBMIT_TURN = 9002
    -- TURNSEG_WORLDCONGRESS_1/2 set AllowStrategicCommands=false and AllowTacticalCommands=false.
    STUB_ALLOW_STRATEGIC, STUB_ALLOW_TACTICAL = false, false
    assert(A.decisionReady('congress') == true and A.decisionReady('pantheon') == false)
    -- An ordinary unit request keeps its refusal and reaches nothing.
    local ok, err = pcall(A.action, {type='move', unitId='test:unit:0:7', x=1, y=1})
    assert(not ok and err:find('ASTRA_REFUSED', 1, true), tostring(err))
    assert(err:find('disallows local commands', 1, true), tostring(err))
    assert(#STUB_TRACE() == 0, 'A refused ordinary action reached the engine')
    -- The congress ballot submit is the request this segment exists for.
    local submitted = A.action({type='congress', operation='submit'})
    assert(submitted.accepted and submitted.status == 'submitted' and submitted.type == 'congress')
    assert(STUB_REQUEST_INDEX == 1)
    local traced = 0
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UI.RequestPlayerOperation' then
        traced = traced + 1
        assert(entry.data.operation == PlayerOperations.WORLD_CONGRESS_SUBMIT_TURN, 'Wrong congress request')
      end
    end
    assert(traced == 1)
    -- Submit is the full native Accept: the segment request plus the turn-ending ACTION_ENDTURN
    -- (decisions.lua), which is why the batch rule treats congress submit as turn-ending.
    local endTurns = 0
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UI.RequestAction' then
        endTurns = endTurns + 1
        assert(entry.data.action == ActionTypes.ACTION_ENDTURN, 'Wrong action after the ballot')
      end
    end
    assert(endTurns == 1 and STUB_SUBMITTED == true)
    assert(A.decisionEndsTurn({type='congress', operation='submit'}) == true)
    local batchOk, batchErr = pcall(A.action, {actions={{type='congress', operation='submit'}, {type='government', item='GOVERNMENT_CHIEFDOM'}}})
    assert(not batchOk and batchErr:find('turn%-ending', 1), tostring(batchErr))
    -- Outside a congress segment the ordinary gate applies again.
    stage = 0
    STUB_ALLOW_STRATEGIC, STUB_ALLOW_TACTICAL = true, true
    assert(A.decisionReady('pantheon') == true)
    STUB_ALLOW_STRATEGIC, STUB_ALLOW_TACTICAL = false, false
    assert(A.decisionReady('congress') == false)
  `);
});

test("a stale entity id is refused instead of being remapped to whatever FindID returns", () => {
  scenario(`
    local A = AstraCiv
    local realCollection = Players[0]:GetUnits()
    local realUnit = realCollection:FindID(7)
    assert(realUnit ~= nil and realUnit:GetID() == 7)
    -- The observed engine state: a stale id resolves to a live unit whose current id differs
    -- (low bits matched, generation did not). Acting on it would hit the wrong unit.
    Players[0].GetUnits = function() return { FindID = function() return realUnit end } end
    local ok, err = pcall(A.action, {type='move', unitId='test:unit:0:65543', x=2, y=1})
    assert(not ok and err:find('ASTRA_REFUSED', 1, true), tostring(err))
    assert(err:find('does not resolve', 1, true), tostring(err))
    assert(#STUB_TRACE() == 0, 'A stale identity reached the engine')
    -- The same lookup with the current id is a normal, legal request against that exact unit.
    local submitted = A.action({type='move', unitId='test:unit:0:7', x=2, y=1})
    assert(submitted.accepted and submitted.status == 'submitted')
    assert(submitted.observed.engineId == 7 and submitted.observed.own == true)
    -- The read path refuses it too, and says so instead of attaching data to the wrong unit.
    local entity, reason = A.resolveEntity('unit', 0, 65543)
    assert(entity == nil and reason:find('never remapped', 1, true), tostring(reason))
    Players[0].GetUnits = function() return realCollection end
    assert(A.resolveEntity('unit', 0, 7) == realUnit)
  `);
});

test("an unknown outcome stops batch admission, and a turn-ending action must be last", () => {
  scenario(`
    local A = AstraCiv
    -- decisions.lua reports an unobservable acknowledgement as a returned status='unknown'.
    A.decisionActionTypes = {fixture_unknown = {operations=A.array{'go'}}}
    A.decisionReady = function() return true end
    A.decisionAction = function() return {accepted=false, completed=false, status='unknown', reasons=A.array()} end
    local batch = A.action({actions={{type='fixture_unknown'}, {type='research', item='TECH_POTTERY'}}, stopOnError=false})
    assert(batch.results[1].status == 'unknown', tostring(batch.results[1].status))
    assert(batch.results[2].status == 'not_attempted', 'A returned unknown outcome admitted a later action')
    assert(batch.stoppedAt == 1 and batch.submitted == 0)
    for _, entry in ipairs(STUB_TRACE()) do
      assert(entry.call ~= 'UI.RequestPlayerOperation', 'A request was sent after an unknown outcome')
    end
    -- A known refusal is different: with stopOnError=false the batch continues.
    TRACE = {}
    A.decisionAction = function() return {accepted=false, completed=false, status='illegal', reasons=A.array()} end
    local continued = A.action({actions={{type='fixture_unknown'}, {type='government', item='GOVERNMENT_CHIEFDOM'}}, stopOnError=false})
    assert(continued.results[1].status == 'illegal' and continued.results[2].status == 'submitted', tostring(continued.results[2].status))
    assert(continued.submitted == 1)
    -- A turn-ending decision (decisions.lua: congress submit sends ACTION_ENDTURN itself) keeps the
    -- same last-in-batch rule as end_turn, through the call-time predicate decisions owns.
    A.decisionActionTypes = {fixture_ends = {operations=A.array{'submit'}}}
    A.decisionEndsTurn = function(action) return action.type == 'fixture_ends' end
    A.decisionAction = function() return {accepted=true, completed=false, status='submitted', reasons=A.array()} end
    local badOk, badErr = pcall(A.action, {actions={{type='fixture_ends'}, {type='government', item='GOVERNMENT_CHIEFDOM'}}})
    assert(not badOk and badErr:find('turn%-ending', 1), tostring(badErr))
    local good = A.action({actions={{type='government', item='GOVERNMENT_CHIEFDOM'}, {type='fixture_ends'}}, stopOnError=false})
    assert(good.results[1].status == 'submitted' and good.results[2].status == 'submitted', tostring(good.results[2].status))
  `);
});

test("a request refused before submission is reported as refusal, not as an unknown outcome", () => {
  scenario(`
    local A = AstraCiv
    local ok, err = pcall(A.action, {type='move'})
    assert(not ok and err:find('ASTRA_REFUSED', 1, true), tostring(err))
    local batch = A.action({actions={{type='move'}, {type='end_turn'}}, stopOnError=true})
    assert(batch.results[1].status == 'refused' and batch.results[2].status == 'not_attempted')
    assert(batch.results[1].reason:find('unitId', 1, true), batch.results[1].reason)
    assert(STUB_SUBMITTED == false)
    -- Raising after a native request really is an unknown outcome and must stay one.
    local afterOk, after = pcall(A.entry, function()
      A.mutate(function() return true end)
      error('engine threw after the request')
    end)
    assert(not afterOk and after:find('ASTRA_UNKNOWN', 1, true), tostring(after))
    local beforeOk, before = pcall(A.entry, function() error('refused before any request') end)
    assert(not beforeOk and before:find('ASTRA_REFUSED', 1, true), tostring(before))
  `);
});

test("PROMOTE submits the promotion row Index, and an unavailable technology is refused instead of crashing", () => {
  scenario(`
    local A = AstraCiv
    -- UnitPromotionPopup.lua compares the engine's promotion list against row.Index and submits that
    -- value as PARAM_PROMOTION_TYPE, so the request must not carry the row Hash.
    local promoted = A.action({type='unit_command', unitId='test:unit:0:7', command='PROMOTE', promotion='PROMOTION_DRILL_1'})
    assert(promoted.accepted and promoted.status == 'submitted')
    local request = nil
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UnitManager.RequestCommand' then request = entry.data end
    end
    assert(request ~= nil and request.command == 2100)
    assert(request.parameters[UnitCommandTypes.PARAM_PROMOTION_TYPE] == 0,
      'The promotion Hash was sent where the native UI sends the row Index')
    -- CanResearch is not consulted any more (the native tree queues through the path), so a failing
    -- CanResearch cannot turn into a Lua error or a veto. An empty native path is a verdict, not a crash.
    TRACE = {}
    local techs = Players[0]:GetTechs()
    techs.CanResearch = function() error('CanResearch must not be consulted for a queue request') end
    techs.GetResearchPath = function() return {} end
    local refused = A.action({type='research', item='TECH_POTTERY'})
    assert(refused.accepted == false and refused.status == 'illegal', tostring(refused.status))
    assert(refused.reason:find('no native research path', 1, true), refused.reason)
    assert(refused.reasons ~= nil and refused.note:find('GetResearchPath', 1, true), tostring(refused.note))
    assert(#STUB_TRACE() == 0, 'A request without a native path still reached the engine')
    -- A civic path read that is unavailable refuses the same way, not with a crash.
    local okCivic, errCivic = pcall(A.action, {type='civic', item='CIVIC_CODE_OF_LAWS'})
    assert(not okCivic and errCivic:find('ASTRA_REFUSED', 1, true), tostring(errCivic))
    assert(errCivic:find('GetCivicPath', 1, true), tostring(errCivic))
  `);
});

test("research replace and append both queue the native prerequisite path, and the native queue is read, never invented", () => {
  scenario(`
    local A = AstraCiv
    -- PlayerOperations.VALUE_APPEND comes from the shared fixture (real enum: TechTree.lua:241,
    -- CivicsTree.lua:241); the two insert modes must stay distinct.
    assert(PlayerOperations.VALUE_APPEND ~= nil and PlayerOperations.VALUE_APPEND ~= PlayerOperations.VALUE_EXCLUSIVE)
    local techs = Players[0]:GetTechs()
    -- A distant goal: the engine says it is not researchable yet, but the native tree still queues its
    -- prerequisite path, and so does this bridge (there is no fake selectability veto).
    techs.CanResearch = function() return false end
    techs.GetResearchPath = function(self, hash)
      assert(hash == 2700, 'GetResearchPath takes the technology row Hash')
      return {0, 4}
    end
    STUB_RESEARCH_QUEUE = {[1] = 0, [3] = 4}
    STUB_RESEARCHING_TECH = 0
    -- The shared fixture records scalar parameters only, and the native path is a table, so this
    -- scenario wraps the native entry point to observe the real argument table as it is passed.
    local realRequest = UI.RequestPlayerOperation
    local sent = {}
    UI.RequestPlayerOperation = function(owner, operation, parameters)
      sent[#sent + 1] = {owner = owner, operation = operation, parameters = parameters}
      return realRequest(owner, operation, parameters)
    end
    local replace = A.action({type='research', item='TECH_POTTERY'})
    assert(replace.accepted and replace.mode == 'replace', tostring(replace.reason))
    local append = A.action({type='research', item='TECH_POTTERY', mode='append'})
    assert(append.accepted and append.mode == 'append')
    assert(#sent == 2, 'Expected one request per research action')
    for index, call in ipairs(sent) do
      assert(call.operation == PlayerOperations.RESEARCH, 'Wrong player operation')
      local path = call.parameters[PlayerOperations.PARAM_TECH_TYPE]
      assert(type(path) == 'table' and path[1] == 0 and path[2] == 4, 'Request '..index..' did not carry the native path')
    end
    assert(sent[1].parameters[PlayerOperations.PARAM_INSERT_MODE] == PlayerOperations.VALUE_EXCLUSIVE)
    assert(sent[2].parameters[PlayerOperations.PARAM_INSERT_MODE] == PlayerOperations.VALUE_APPEND)
    -- The queue observation is the engine's own list, keyed by queue position.
    local queue = A.researchQueue(Players[0], 'research')
    assert(queue.known == true and queue.current == 'TECH_POTTERY')
    assert(#queue.items == 2 and queue.items[1].index == 1 and queue.items[2].index == 3)
    assert(queue.items[1].type == 'TECH_POTTERY' and queue.items[1].name == 'LOC_POTTERY')
    -- An entry the ruleset cannot name keeps its position; it is not silently dropped.
    assert(queue.items[2].type == A.null)
    -- No native path: nothing is submitted, and the engine's own reads explain why.
    sent = {}
    techs.GetResearchPath = function() return {} end
    local empty = A.action({type='research', item='TECH_POTTERY'})
    assert(empty.accepted == false and empty.status == 'illegal', tostring(empty.status))
    assert(empty.reason:find('no native research path', 1, true), empty.reason)
    assert(empty.completed == false and empty.alreadyResearched == A.null)
    assert(#sent == 0, 'An empty native path still reached the engine')
    -- The same case for an already-completed technology says so.
    techs.HasTech = function() return true end
    local completed = A.action({type='research', item='TECH_POTTERY'})
    assert(completed.status == 'illegal' and completed.completed == false and completed.alreadyResearched == true)
    assert(completed.reason:find('already completed', 1, true), completed.reason)
    assert(#sent == 0)
    -- An unavailable path read is a refusal (nothing reached the engine), not a guessed request.
    techs.GetResearchPath = nil
    local ok, err = pcall(A.action, {type='research', item='TECH_POTTERY'})
    assert(not ok and err:find('ASTRA_REFUSED', 1, true), tostring(err))
    assert(#sent == 0)
    -- Without a working queue read the queue is unknown, not empty (A.call maps a throw to A.null,
    -- which is a table: the explicit comparison is what keeps this honest).
    techs.GetResearchQueue = function() error('native queue read unavailable') end
    local unknown = A.researchQueue(Players[0], 'research')
    assert(unknown.known == false and #unknown.items == 0 and unknown.current == A.null)
    assert(type(unknown.reason) == 'string' and #unknown.reason > 0, tostring(unknown.reason))
    -- An empty queue is a real answer: the engine says nothing is queued.
    techs.GetResearchQueue = function() return {} end
    local none = A.researchQueue(Players[0], 'research')
    assert(none.known == true and #none.items == 0 and none.reason == nil)
  `);
});

test("production keeps the native display filter but reports current availability, reasons and exact prices", () => {
  scenario(`
    local A = AstraCiv
    local city = Players[0]:GetCities():FindID(3)
    local queue = city:GetBuildQueue()
    -- The two native answers differ, exactly as they can in the engine: the item is displayable but
    -- not currently producible, with the engine's own failure reason.
    queue.CanProduce = function(self, hash, displayOnly, returnResults)
      if returnResults then return false, {[CityCommandResults.FAILURE_REASONS] = {'LOC_TEST_NO_PREREQ'}} end
      return true
    end
    queue.GetUnitResourceCost = function(self, index, formation) return 20 end
    city.GetGold = function() return {
      GetPurchaseCost = function(self, yield, hash, formation) return yield == 1 and 250 or 120 end,
      IsUnitFaithPurchaseEnabled = function(self, hash) return true end,
      IsBuildingFaithPurchaseEnabled = function(self, hash) return false end,
    } end
    local options = A.options({cityId='test:city:0:3'})
    local warrior = nil
    for _, item in ipairs(options.production) do if item.item == 'UNIT_WARRIOR' then warrior = item end end
    assert(warrior ~= nil, 'A displayable item disappeared from the list')
    assert(warrior.available == false, 'Current legality was reported as available')
    assert(warrior.reasons[1] == 'LOC_TEST_NO_PREREQ', tostring(warrior.reasons[1]))
    assert(warrior.cost == 40 and warrior.resource ~= nil and warrior.resource.amount == 20)
    local priced = A.options({cityId='test:city:0:3', operation='purchase'})
    local pricedWarrior = nil
    for _, item in ipairs(priced.production) do if item.item == 'UNIT_WARRIOR' then pricedWarrior = item end end
    assert(pricedWarrior ~= nil and pricedWarrior.purchase ~= nil)
    assert(pricedWarrior.purchase.gold.cost == 250 and pricedWarrior.purchase.gold.balance == 100)
    assert(pricedWarrior.purchase.gold.legal == true and pricedWarrior.purchase.gold.covers == false)
    assert(pricedWarrior.purchase.faith.cost == 120 and pricedWarrior.purchase.faith.enabled == true)
    -- The same numbers are reported when the engine refuses the purchase itself.
    STUB_CITY_COMMAND_LEGAL = false
    STUB_CITY_COMMAND_RESULTS = {[CityCommandResults.FAILURE_REASONS] = {'LOC_TEST_CANT_AFFORD'}}
    local refused = A.action({type='purchase', cityId='test:city:0:3', kind='unit', item='UNIT_WARRIOR', currency='gold'})
    assert(refused.accepted == false and refused.status == 'illegal')
    assert(refused.reasons[1] == 'LOC_TEST_CANT_AFFORD', tostring(refused.reasons[1]))
    assert(refused.price.cost == 250 and refused.price.balance == 100 and refused.price.covers == false)
  `);
});

test("Great Person activation and order cancel dispatch as parameterless native commands with the engine's plots", () => {
  scenario(`
    local A = AstraCiv
    local unit = Players[0]:GetUnits():FindID(7)
    unit.GetGreatPerson = function() return {
      IsGreatPerson = function() return true end,
      GetClass = function() return 0 end,
      GetIndividual = function() return 0 end,
      GetActionCharges = function() return 2 end,
      -- Plot indices, as SelectedUnit.lua iterates them.
      GetActivationHighlightPlots = function() return {4} end,
    } end
    -- The shared fixture has no Great Person command row, so this test installs the two rows the
    -- engine ships (UnitCommands.xml: UNITCOMMAND_ACTIVATE_GREAT_PERSON, UNITCOMMAND_CANCEL) by
    -- wrapping the fixture's own iterator instead of editing it.
    local baseIterator = GameInfo.UnitCommands()
    local injected = {
      { Index = 6, Hash = 2106, CommandType = 'UNITCOMMAND_ACTIVATE_GREAT_PERSON', Description = 'LOC_ACTIVATE_GP', VisibleInUI = true, CategoryInUI = 'SPECIFIC' },
      { Index = 7, Hash = 2107, CommandType = 'UNITCOMMAND_CANCEL', Description = 'LOC_CANCEL', VisibleInUI = true, CategoryInUI = 'INPLACE' },
    }
    for _, row in ipairs(injected) do GameInfo.UnitCommands[row.Index] = row end
    setmetatable(GameInfo.UnitCommands, { __call = function()
      local index = 0
      local delegated = false
      return function()
        if not delegated then
          index = index + 1
          if injected[index] ~= nil then return injected[index] end
          delegated = true
        end
        return baseIterator()
      end
    end })
    UnitManager.GetQueuedDestination = function() return 4 end
    -- Record the native argument shape: four-argument CanStartCommand with false for no parameters,
    -- and two-argument RequestCommand (UnitPanel.lua:471,2493-2531).
    local realCommand, realCheck = UnitManager.RequestCommand, UnitManager.CanStartCommand
    local requestArgs, checkArgs = nil, nil
    UnitManager.RequestCommand = function(...)
      requestArgs = { n = select('#', ...), args = { ... } }
      return realCommand(...)
    end
    UnitManager.CanStartCommand = function(...)
      checkArgs = { n = select('#', ...), args = { ... } }
      return realCheck(...)
    end
    local options = A.options({unitId='test:unit:0:7'})
    local activate, cancel = nil, nil
    for _, entry in ipairs(options.commands) do
      if entry.cmd == 'ACTIVATE_GREAT_PERSON' then activate = entry end
      if entry.cmd == 'CANCEL' then cancel = entry end
    end
    -- Appearing in the default list is the claim that the bridge can submit it; supported=true on
    -- every listed row said the same thing a second time and is now only in detail='full'.
    assert(activate ~= nil and activate.available == true and activate.supported == nil)
    assert(#activate.needs == 0, 'Activation must not require a field')
    assert(activate.greatPerson.charges == 2 and activate.greatPerson.activationPlots[1][1] == 1)
    assert(activate.greatPerson.activationPlots[1][2] == 1)
    assert(cancel ~= nil)
    local full = A.options({unitId='test:unit:0:7', detail='full'})
    local fullActivate
    for _, entry in ipairs(full.commands) do
      if entry.cmd == 'ACTIVATE_GREAT_PERSON' then fullActivate = entry end
    end
    assert(fullActivate ~= nil and fullActivate.supported == true,
      'detail=full still carries the ruleset/supported provenance')
    -- A queued multi-turn move is native state, reported instead of guessed.
    assert(options.movement.queuedDestination[1] == 1 and options.movement.queuedDestination[2] == 1)
    local submitted = A.action({type='unit_command', unitId='test:unit:0:7', command='ACTIVATE_GREAT_PERSON'})
    assert(submitted.accepted and submitted.status == 'submitted')
    assert(requestArgs ~= nil and requestArgs.n == 2, 'A parameterless command was sent with a parameter argument')
    assert(requestArgs.args[2] == 2106, 'Wrong command identity')
    assert(checkArgs ~= nil and checkArgs.n == 4 and checkArgs.args[3] == false,
      'A parameterless command must be checked with false as its parameter argument, as the native panel does')
    local cleared = A.action({type='unit_command', unitId='test:unit:0:7', command='CANCEL'})
    assert(cleared.accepted and cleared.status == 'submitted')
    assert(requestArgs.args[2] == 2107)
    -- While the game core is busy the path is deferred, not queried (the native movement UI guards
    -- its path helpers the same way, WorldInput.lua:818,884,1163).
    UI.IsGameCoreBusy = function() return true end
    local queries = 0
    for _, entry in ipairs(STUB_TRACE()) do if entry.call == 'UnitManager.GetMoveToPathEx' then queries = queries + 1 end end
    local deferred = A.path({unitId='test:unit:0:7', x=2, y=0})
    assert(deferred.deferred == true and deferred.blocked == A.null)
    assert(deferred.reason:find('busy', 1, true), tostring(deferred.reason))
    local after = 0
    for _, entry in ipairs(STUB_TRACE()) do if entry.call == 'UnitManager.GetMoveToPathEx' then after = after + 1 end end
    assert(after == queries, 'A busy game core still queried the native path')
    UI.IsGameCoreBusy = function() return false end
    local live = A.path({unitId='test:unit:0:7', x=2, y=0})
    assert(live.deferred == false and #live.plots > 0)
  `);
});

test("trade-route discovery uses native legality and path, and never looks up fogged foreign cities", () => {
  scenario(`
    local A = AstraCiv
    local query = {unitId='test:unit:0:7'}
    local quiet = A.options(query)
    local trade
    for _, op in ipairs(quiet.operations) do if op.op == 'MAKE_TRADE_ROUTE' then trade = op end end
    assert(trade and trade.targets == nil and trade.available == A.null)
    for _, call in ipairs(STUB_TRACE()) do
      assert(call.call ~= 'TradeManager.GetTradeRoutePath', 'default options unexpectedly scanned routes')
      assert(not call.call:find('TradeManager.Calculate', 1, true), 'default options unexpectedly computed yields')
      assert(call.call ~= 'UnitManager.GetOperationTargets' or call.data.operation ~= 2013,
        'trade routes must not use generic plot target discovery')
    end

    -- The foreign city is present in the native player's city collection, but its identity
    -- getters fail under fog. Revealed does not imply currently visible.
    STUB_VISIBLE['2,0'] = true
    local ownAndMinor = A.options({unitId=query.unitId, operation='MAKE_TRADE_ROUTE'})
    trade = ownAndMinor.operations[1]
    assert(trade.available == true and trade.targetsTotal == 2 and trade.targetsMore == false)
    assert(trade.targets[1].cityId == 'test:city:0:3' and trade.targets[2].cityId == 'test:city:2:11')
    assert(trade.targets[2].x == 2 and trade.targets[2].y == 0)
    assert(trade.targets[1].name == 'LOC_TEST_CITY' and trade.targets[1].originYields[1].value == 5)
    for _, call in ipairs(STUB_TRACE()) do
      if call.call == 'UnitManager.CanStartOperation' and call.data.operation == 2013 then
        assert(call.data.parameters[UnitOperationTypes.PARAM_X0] ~= 2
          or call.data.parameters[UnitOperationTypes.PARAM_Y0] ~= 2,
          'fogged foreign city was checked for route legality')
      end
    end

    STUB_VISIBLE['2,2'] = true
    STUB_TRADE_LEGAL['2,0'] = false
    local legal = A.options({unitId=query.unitId, operation='MAKE_TRADE_ROUTE', targetLimit=1, limit=1})
    trade = legal.operations[1]
    assert(legal.offset == 0 and legal.more == false, 'target paging must not page operation entries')
    assert(trade.targetsTotal == 2 and #trade.targets == 1 and trade.targetsMore == true)
    assert(trade.targets[1].cityId == 'test:city:0:3' and trade.targetOffset == 0)
    local second = A.options({unitId=query.unitId, operation='MAKE_TRADE_ROUTE', targetOffset=1, targetLimit=1})
    trade = second.operations[1]
    assert(trade.targetsTotal == 2 and trade.targetOffset == 1 and trade.targetsMore == false)
    assert(#trade.targets == 1 and trade.targets[1].cityId == 'test:city:1:12')
    local beyond = A.options({unitId=query.unitId, operation='MAKE_TRADE_ROUTE', targetOffset=3, targetLimit=1})
    assert(#beyond.operations[1].targets == 0 and beyond.operations[1].targetsMore == false)
    -- A legal operation with no route path is NOT a destination the chooser would show.
    STUB_TRADE_PATHS['1:12'] = nil
    local pathless = A.options({unitId=query.unitId, operation='MAKE_TRADE_ROUTE'})
    assert(pathless.operations[1].targetsTotal == 1)
    STUB_TRADE_LEGAL['1,1'] = false
    local empty = A.options({unitId=query.unitId, operation='MAKE_TRADE_ROUTE'})
    assert(empty.operations[1].available == A.null and empty.operations[1].targetsTotal == 0,
      'No visible destination is not proof that a fogged city cannot receive a route')
    assert(#empty.operations[1].targets == 0 and empty.operations[1].targetsMore == false)
  `);
});

test("trade-route page reports the chooser's native yield totals and only public destination facts", () => {
  scenario(`
    local A = AstraCiv
    STUB_VISIBLE['2,0'] = true
    STUB_VISIBLE['2,2'] = true
    local page = A.options({unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE'}).operations[1]
    assert(page.available == true and page.targetsTotal == 3)
    local byOwner = {}
    for _, target in ipairs(page.targets) do byOwner[target.owner] = target end
    local own, minor, foreign = byOwner[0], byOwner[2], byOwner[1]
    assert(own.owner == 0 and own.name == 'LOC_TEST_CITY' and own.distance == 0)
    assert(own.tradingPost == false and own.tradeRouteQuest == false)
    assert(own.originYields[1].yield == 'YIELD_FOOD' and own.originYields[1].value == 5)
    assert(own.originYields[2].yield == 'YIELD_GOLD' and own.originYields[2].value == 8)
    assert(#own.originYields == 2 and own.destinationYields[1].yield == 'YIELD_GOLD'
      and own.destinationYields[1].value == 4 and own.destinationYields[2].yield == 'YIELD_FAITH'
      and own.destinationYields[2].value == 3,
      'a complete sparse array omits genuine zeroes without international multipliers')
    assert(minor.owner == 2 and minor.name == 'LOC_TEST_CITY_STATE')
    assert(minor.tradeRouteQuest == true and minor.tradingPost == false)
    assert(minor.originYields[1].value == 7.5 and minor.originYields[2].value == 16)
    assert(minor.destinationYields[1].value == 5 and minor.destinationYields[2].value == 3,
      'city-state destination must use its own receiving-player multiplier')
    assert(foreign.owner == 1 and foreign.name == 'LOC_FOREIGN_CITY' and foreign.distance == 1)
    assert(foreign.tradingPost == true and foreign.tradeRouteQuest == false)
    assert(foreign.originYields[2].value == 16 and foreign.destinationYields[1].value == 12)
    assert(foreign.destinationYields[2].value == 6)
    assert(foreign.pathLength == 2 and foreign.pathPlots == nil and foreign.pathMore == nil)

    local calls = 0
    for _, call in ipairs(STUB_TRACE()) do
      if call.call == 'TradeManager.CalculateOriginYieldsFromPotentialRoute' then
        calls = calls + 1
        assert(call.data.originOwner == 0 and call.data.originId == 3)
      end
    end
    assert(calls == 3, 'yield calculation must occur on returned targets, not hidden cities')
    STUB_TRADE_YIELDS.Origin.YieldsFromModifiers[3] = -2
    local negative = A.options({unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE', targetLimit=1})
      .operations[1].targets[1].originYields
    assert(#negative == 3 and negative[3].yield == 'YIELD_FAITH' and negative[3].value == -2,
      'negative yields remain observable and unmultiplied')
    STUB_TRADE_YIELDS.Origin.YieldsFromPotentialRoute = {0, 0, 0}
    STUB_TRADE_YIELDS.Origin.YieldsFromPath = {0, 0, 0}
    STUB_TRADE_YIELDS.Origin.YieldsFromModifiers = {0, 0, 0}
    local zero = A.options({unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE', targetLimit=1})
      .operations[1].targets[1]
    assert(zero.originYields ~= A.null and #zero.originYields == 0 and zero.originYieldsReason == nil,
      'a complete zero-yield answer differs from an unavailable yield API')
  `);
});

test("missing native trade facts remain unknown without removing legal destinations", () => {
  scenario(`
    local A = AstraCiv
    STUB_VISIBLE['2,2'] = true
    local manager = Game.GetTradeManager()
    local oldPathYields = manager.CalculateOriginYieldsFromPath
    manager.CalculateOriginYieldsFromPath = nil
    local oldTrade = Players[1].GetTrade
    Players[1].GetTrade = nil
    local oldQuests = Game.GetQuestsManager
    Game.GetQuestsManager = nil
    local target = A.options({
      unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE', targetOffset=1, targetLimit=1,
    }).operations[1]
    assert(target.available == true and target.targetsTotal == 2 and #target.targets == 1)
    local foreign = target.targets[1]
    assert(foreign.cityId == 'test:city:1:12' and foreign.name == 'LOC_FOREIGN_CITY')
    assert(foreign.originYields == A.null and foreign.originYieldsReason:find('CalculateOriginYieldsFromPath', 1, true))
    assert(foreign.destinationYields == A.null and foreign.destinationYieldsReason:find('modifier', 1, true))
    assert(foreign.tradeRouteQuest == A.null and foreign.tradeRouteQuestReason)
    assert(foreign.tradingPost == true and foreign.distance == 1)
    manager.CalculateOriginYieldsFromPath = oldPathYields
    Players[1].GetTrade = oldTrade
    Game.GetQuestsManager = oldQuests
    STUB_TRADE_YIELDS.Origin.YieldsFromPath = {1}
    local partial = A.options({unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE'}).operations[1].targets[1]
    assert(partial.originYields == A.null and partial.originYieldsReason:find('components', 1, true),
      'a missing yield position cannot silently become zero')
  `);
});

test("detailed trade paths are bounded to one destination and omit fogged coordinates", () => {
  scenario(`
    local A = AstraCiv
    STUB_VISIBLE['2,2'] = true
    STUB_TRADE_PATHS['1:12'] = {4, 6, 8} -- 6 is revealed but currently fogged.
    local many = A.options({unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE', detail='full'})
    assert(many.operations[1].targets[2].pathLength == 3 and many.operations[1].targets[2].pathPlots == nil)
    local one = A.options({
      unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE', detail='full', targetOffset=1, targetLimit=1,
    }).operations[1].targets[1]
    assert(one.pathLength == 3 and one.pathMore == false and #one.pathPlots == 2)
    assert(one.pathPlots[1].position == 1 and one.pathPlots[1].x == 1)
    assert(one.pathPlots[2].position == 3 and one.pathPlots[2].x == 2)
    local long = {}
    for i = 1, 70 do long[i] = i % 2 == 0 and 6 or 4 end
    STUB_TRADE_PATHS['1:12'] = long
    local capped = A.options({
      unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE', detail='full', targetOffset=1, targetLimit=1,
    }).operations[1].targets[1]
    assert(capped.pathLength == 70 and capped.pathMore == true and #capped.pathPlots == 32)
    assert(capped.pathPlots[#capped.pathPlots].position == 63)
    STUB_TRADE_PATHS['1:12'] = {4, 999, 8}
    local unreadable = A.options({
      unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE', detail='full', targetOffset=1, targetLimit=1,
    }).operations[1].targets[1]
    assert(unreadable.cityId == 'test:city:1:12' and unreadable.pathLength == 3)
    assert(unreadable.pathPlots == A.null and unreadable.pathPlotsReason)
  `);
});

test("trade-route query failures are unavailable rather than an empty legal destination list", () => {
  scenario(`
    local A = AstraCiv
    local query = {unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE'}
    local nativeManager = Game.GetTradeManager
    Game.GetTradeManager = nil
    local missing = A.options(query).operations[1]
    assert(missing.available == A.null and missing.targets == A.null)
    assert(missing.targetsTotal == A.null and missing.targetsMore == A.null and missing.targetOffset == 0)
    assert(missing.reason:find('unavailable', 1, true))
    Game.GetTradeManager = function() return {
      GetTradeRoutePath = function() error('native route query failed') end,
    } end
    local failed = A.options(query).operations[1]
    assert(failed.available == A.null and failed.targets == A.null and failed.targetsTotal == A.null)
    Game.GetTradeManager = nativeManager
    PlayersVisibility[0].IsVisible = function() return nil end
    local unknownVisibility = A.options(query).operations[1]
    assert(unknownVisibility.available == A.null and unknownVisibility.targetsTotal == A.null)
    local invalidOffset = pcall(A.options, {unitId=query.unitId, targetOffset=-1})
    local invalidLimit = pcall(A.options, {unitId=query.unitId, targetLimit=51})
    assert(not invalidOffset and not invalidLimit)
  `);
});

test("trade-route submission sends the same origin and destination parameters as the native chooser", () => {
  scenario(`
    STUB_VISIBLE['2,2'] = true
    local result = AstraCiv.action({
      type='unit_operation', unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE',
      destinationX=2, destinationY=2,
    })
    assert(result.accepted == true and result.status == 'submitted')
    local check, request
    for _, call in ipairs(STUB_TRACE()) do
      if call.call == 'UnitManager.CanStartOperation' and call.data.operation == 2013 then check = call.data.parameters end
      if call.call == 'UnitManager.RequestOperation' and call.data.operation == 2013 then request = call.data.parameters end
    end
    assert(check and request)
    for _, params in ipairs({check, request}) do
      assert(params[UnitOperationTypes.PARAM_X0] == 2 and params[UnitOperationTypes.PARAM_Y0] == 2)
      assert(params[UnitOperationTypes.PARAM_X1] == 1 and params[UnitOperationTypes.PARAM_Y1] == 1)
    end
  `);
});

test("trade-route target pagination defaults to twenty and caps the requested page at fifty", () => {
  scenario(`
    -- The fixture's small map cannot contain 55 real cities. Supply distinct own-city identities
    -- at a known own plot to exercise only the result bound, not Civ map generation rules.
    local player = Players[0]
    local originalCities = player.GetCities
    player.GetCities = function(self)
      local original = originalCities(self)
      local cities = {original:FindID(3)}
      for id = 100, 153 do
        cities[#cities + 1] = {
          GetOwner = function() return 0 end,
          GetID = function() return id end,
          GetX = function() return 1 end,
          GetY = function() return 1 end,
        }
      end
      return {Members = function() return ipairs(cities) end}
    end
    Game.GetTradeManager = function() return {GetTradeRoutePath = function() return {4} end} end
    local args = {unitId='test:unit:0:7', operation='MAKE_TRADE_ROUTE'}
    local first = AstraCiv.options(args).operations[1]
    assert(first.targetsTotal == 55 and #first.targets == 20 and first.targetsMore == true)
    assert(first.targetOffset == 0 and first.targets[20].cityId == 'test:city:0:118')
    args.targetOffset, args.targetLimit = 20, 50
    local remaining = AstraCiv.options(args).operations[1]
    assert(remaining.targetsTotal == 55 and #remaining.targets == 35 and remaining.targetsMore == false)
    assert(remaining.targets[1].cityId == 'test:city:0:119')
  `);
});
