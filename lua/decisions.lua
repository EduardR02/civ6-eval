local A = AstraCiv
-- ---------------------------------------------------------------------------
-- Gameplay decisions: discovery (A.decisions), answering (A.decide), and the
-- decision-family action types A.action delegates here (A.decisionAction).
--
-- Three states are kept apart everywhere:
--   present   - the ruleset has this concept at all (Game.GetWorldCongress, GameInfo.Governors...)
--   supported - this bridge has a verified native request path for it
--   legal     - the engine says the player may do it right now
-- A missing bridge handler is never reported as a missing engine operation.
--
-- Popup closing is NOT this module's responsibility. src/bridge/popups.ts owns native
-- screen teardown through reviewed per-screen adapters; a generic UIManager:DequeuePopup
-- from here would skip temporary visibility, lens/cinematic reset, private-queue drain
-- and popup-handling unlock. Nothing in this file dismisses a screen.
-- ---------------------------------------------------------------------------

local KINDS = {'commemoration','pantheon','great_person','governor','religion','city_fate','congress','espionage','diplomacy','envoy','blocker'}
local KIND_SET = {}
for _, name in ipairs(KINDS) do KIND_SET[name] = true end
local KIND_HELP = table.concat(KINDS, ', ')
local function kindNames()
  local out = A.array()
  for _, name in ipairs(KINDS) do out[#out+1] = name end
  return out
end

-- ---------------------------------------------------------------------------
-- Ids and shared plumbing.
-- ---------------------------------------------------------------------------
--- Decision ids carry the loaded-game session plus the entity/era/session identity that
--- makes the choice meaningful, so a stale id from an earlier era or a finished congress
--- simply fails to resolve instead of answering the wrong question.
local function decisionId(kind, key) return A.session..':decision:'..kind..':'..key end
local function entityId(kind, owner, index) return A.session..':'..kind..':'..owner..':'..index end
local function parseCityId(value)
  assert(type(value) == 'string', 'Expected a game-qualified cityId from civ.decisions/civ.snapshot')
  local session, kind, owner, index = value:match('^([^:]+):([^:]+):(%d+):(%d+)$')
  assert(session == A.session and kind == 'city', 'City id is from another loaded game instance')
  return tonumber(owner), tonumber(index)
end
local function number(value) if type(value) == 'number' then return value end return nil end

--- Native FindID/CityManager.GetCity resolve an index or slot, and a stale index can hand back a
--- live object that is NOT the requested entity (the reviewed run produced seven actions on the
--- wrong entity this way). Owner and id are therefore compared before any field is read and before
--- any request is built for that object; a mismatch refuses, and never remaps onto the found entity.
local function exactIdentity(group, kind, owner, id, entity)
  if entity == nil or entity == A.null then return nil end
  local actualOwner = number(A.call(group, entity, 'GetOwner'))
  local actualId = number(A.call(group, entity, 'GetID'))
  if actualOwner ~= owner or actualId ~= id then
    local reason = 'The engine resolved '..kind..' '..tostring(id)..' to a different entity (owner '
      ..tostring(actualOwner)..', id '..tostring(actualId)..'); nothing was submitted for it'
    A.unavailable('identity', kind, reason)
    return nil, reason
  end
  return entity
end

--- Resolve a session:city:<owner>:<id> id to a live city: the own city collection for an own
--- destination, the global CityManager otherwise (a city-state destination is not owned by us),
--- then exact identity. Returns nil plus a reason when the lookup answered with another entity.
local function cityById(group, ctx, owner, cid)
  local city
  if owner == ctx.pid then city = A.call(group, ctx.player:GetCities(), 'FindID', cid)
  else city = A.static(group, CityManager, 'GetCity', owner, cid) end
  return exactIdentity(group, 'city', owner, cid, city)
end

--- One native request. Submission is never completion: UI.RequestPlayerOperation and the
--- managers return nothing observable, so an untorn call is 'submitted' with the
--- acknowledgement explicitly marked unobservable, a thrown call is 'unknown' and stops
--- everything after it, and an explicit false is a refusal.
--- A.mutate records that the request reached the engine, so an error raised later (for example by
--- a validation check on the next item of the same decision) is reported as an unknown outcome
--- instead of a clean refusal.
local function request(fn, ...)
  local count = select('#', ...)
  local args = {...}
  local ok, value = pcall(A.mutate, fn, unpack(args, 1, count))
  if not ok then return {status='unknown', error=tostring(value):match('^[^\r\n]*')} end
  if value == false then return {status='rejected'} end
  if value == nil then return {status='submitted', acknowledgement='not_observable'} end
  if value == true then return {status='submitted', acknowledgement='accepted'} end
  return {status='submitted', acknowledgement=tostring(value)}
end

local function playerOperation(pid, operationName, parameters)
  local operation = A.param(PlayerOperations, operationName)
  return request(UI.RequestPlayerOperation, pid, operation, parameters or {})
end

--- Run an ordered list of native requests. A decision that needs several requests
--- (religion beliefs, multi-commemoration, a congress ballot) reports each one and stops
--- at the first non-submitted result. Nothing is ever replayed, and the already-submitted
--- prefix is reported rather than hidden.
local function submit(items, note)
  assert(type(items) == 'table' and #items > 0, 'Nothing to submit; a decision with no native request is a bug, not an acceptance')
  local results, status, stoppedAt, submitted = A.array(), 'submitted', A.null, 0
  for index, item in ipairs(items) do
    local result = item.run()
    result.index, result.request = index, item.label
    results[#results+1] = result
    if result.status == 'submitted' then submitted = submitted + 1
    else status, stoppedAt = result.status, index; break end
  end
  local out = {
    accepted = status == 'submitted',
    completed = false,
    status = status,
    reasons = A.array(),
    requests = results,
    requestCount = #items,
    submittedCount = submitted,
    stoppedAt = stoppedAt,
    turnState = A.turnState(),
  }
  if status == 'unknown' then
    out.reasons[#out.reasons+1] = 'Native request '..tostring(stoppedAt)..' of '..#items..' threw or lost its acknowledgement. It was NOT replayed and no later request was sent. Re-observe before retrying.'
  elseif status == 'rejected' then
    out.reasons[#out.reasons+1] = 'Native request '..tostring(stoppedAt)..' of '..#items..' was refused by the engine. Earlier requests in this decision were already submitted.'
  end
  if note ~= nil then out.note = note end
  return out
end

local function refused(status, reason, extra)
  local out = extra or {}
  out.accepted, out.completed, out.status = false, false, status
  out.reasons = A.array{reason}
  out.turnState = A.turnState()
  return out
end

-- Shared runtime helpers. lua/diplomacy.lua resolves these at call time so every decision family
-- describes submitted/rejected/unknown identically and no copy of the mutation-safety rules can
-- drift away from this one place.
A.decisionRequest = request
A.decisionSubmit = submit
A.decisionRefused = refused

-- ---------------------------------------------------------------------------
-- Context: local player plus the currently active end-turn blockers, decoded by name.
-- state.lua's turnState carries the blocker list; this map is the decision module's own
-- view of which blockers a decision family answers, including the ones state.lua does not
-- yet name (commemoration, governor, congress, disloyal city).
-- ---------------------------------------------------------------------------
local function activeBlockers(turnState)
  local names = {}
  if turnState.blockers == A.null then return names, false end
  for _, blocker in ipairs(turnState.blockers) do
    if type(blocker.type) == 'string' then names[blocker.type] = true end
  end
  return names, true
end

local function context()
  local pid, player = A.localPlayer()
  local turnState = A.turnState()
  local blockers, blockersKnown = activeBlockers(turnState)
  return {pid=pid, player=player, blockers=blockers, blockersKnown=blockersKnown,
    turn=turnState.turn, turnState=turnState}
end

local function blocking(ctx, name) return ctx.blockers[name] == true end

-- ---------------------------------------------------------------------------
-- Commemoration / era dedication.
-- Native: DLC/Expansion2/UI/Additions/DedicationPopup.lua OnConfirm ->
--   PlayerOperations.COMMEMORATE with PARAM_COMMEMORATION_TYPE = the CommemorationTypes
--   row *Index* (OnCommemorationSelected is wired with commemorationInfo.Index), one
--   request per selected commemoration. Choices and the allowed count come from
--   Game.GetEras():GetPlayerCommemorateChoices / GetPlayerNumAllowedCommemorations.
-- CommemorationTypes has no Name column; CategoryDescription is the native label.
-- ---------------------------------------------------------------------------
local function dedicationReady(ctx, eras)
  -- DedicationPopup.OnShow excludes the initial era and configured start turn.
  local era = number(A.call('commemoration', eras, 'GetCurrentEra'))
  local start = number(A.static('commemoration', GameConfiguration, 'GetStartTurn'))
  if era == nil or start == nil or ctx.turn == nil then
    A.unavailable('commemoration', 'readiness', 'Current era or configured start turn unavailable')
    return false
  end
  return era > 0 and ctx.turn ~= start
end

local function commemorationDecisions(ctx, out)
  local eras = A.static('commemoration', Game, 'GetEras')
  -- A nil native return is normalized to A.null but does not itself record a diagnostic.
  if eras == A.null then return A.unavailable('commemoration', 'GetEras', 'Era manager unavailable') end
  if not dedicationReady(ctx, eras) then return end
  local allowed = number(A.call('commemoration', eras, 'GetPlayerNumAllowedCommemorations', ctx.pid))
  -- Do not query dedication choices until the engine says a dedication is due.
  if allowed == nil then return A.unavailable('commemoration', 'allowance', 'Dedication allowance unknown') end
  if allowed < 1 then return end
  local choices = A.call('commemoration', eras, 'GetPlayerCommemorateChoices', ctx.pid)
  if choices == A.null or type(choices) ~= 'table' then
    return A.unavailable('commemoration', 'choices', 'Dedication choices unavailable')
  end
  local options = A.array()
  for _, index in ipairs(choices) do
    local row = A.row('CommemorationTypes', index)
    if row ~= A.null then
      options[#options+1] = {
        choice = row.CommemorationType, engineIndex = index, available = true,
        label = A.loc(row.CategoryDescription),
        goldenAge = A.loc(row.GoldenAgeBonusDescription),
        normalAge = A.loc(row.NormalAgeBonusDescription),
        darkAge = A.loc(row.DarkAgeBonusDescription),
      }
    end
  end
  if #options == 0 then return end
  local era = number(A.call('commemoration', eras, 'GetCurrentEra'))
  local active = A.array()
  local chosen = A.call('commemoration', eras, 'GetPlayerActiveCommemorations', ctx.pid)
  if type(chosen) == 'table' then
    for _, index in ipairs(chosen) do
      local row = A.row('CommemorationTypes', index)
      if row ~= A.null then active[#active+1] = row.CommemorationType end
    end
  end
  out[#out+1] = {
    key = 'era'..tostring(era or 'unknown'),
    kind = 'commemoration', actionType = 'commemoration',
    operations = A.array{'choose'},
    label = 'Era dedication: choose '..allowed..' commemoration'..(allowed == 1 and '' or 's'),
    mandatory = true,
    blocks = blocking(ctx, 'ENDTURN_BLOCKING_COMMEMORATION_AVAILABLE'),
    selectCount = allowed,
    era = era or A.null,
    ageState = {
      golden = A.call('commemoration', eras, 'HasGoldenAge', ctx.pid),
      heroic = A.call('commemoration', eras, 'HasHeroicGoldenAge', ctx.pid),
      dark = A.call('commemoration', eras, 'HasDarkAge', ctx.pid),
    },
    activeCommemorations = active,
    options = options,
    choiceHelp = allowed == 1 and 'choice=<CommemorationType>' or ('choices=[<CommemorationType> x '..allowed..']'),
  }
end

local function commemorationSubmit(ctx, list)
  assert(type(list) == 'table' and #list > 0, 'commemoration needs commemoration=<CommemorationType> or commemorations=[...]')
  local eras = A.static('commemoration', Game, 'GetEras')
  assert(eras ~= A.null, 'Game.GetEras is unavailable in this ruleset; commemoration is a Rise & Fall / Gathering Storm concept')
  assert(dedicationReady(ctx, eras), 'Dedication is not ready in this era/turn')
  local allowed = number(A.call('commemoration', eras, 'GetPlayerNumAllowedCommemorations', ctx.pid))
  assert(allowed ~= nil and allowed >= 1, 'No commemoration may be chosen right now')
  assert(#list <= allowed, 'This era allows '..allowed..' commemoration(s); '..#list..' were supplied')
  local offered = {}
  local choices = A.call('commemoration', eras, 'GetPlayerCommemorateChoices', ctx.pid)
  assert(choices ~= A.null and type(choices) == 'table', 'Native commemoration choice list unavailable')
  for _, index in ipairs(choices) do
    local row = A.row('CommemorationTypes', index)
    if row ~= A.null then offered[row.CommemorationType] = index end
  end
  local items, seen = {}, {}
  for _, name in ipairs(list) do
    assert(type(name) == 'string', 'Each commemoration must be a CommemorationType string')
    local index = offered[name]
    assert(index ~= nil, 'Commemoration is not offered this era: '..name)
    assert(not seen[name], 'Duplicate commemoration: '..name)
    seen[name] = true
    items[#items+1] = {label = 'COMMEMORATE '..name, run = function()
      local parameters = {}
      parameters[A.param(PlayerOperations, 'PARAM_COMMEMORATION_TYPE')] = index
      return playerOperation(ctx.pid, 'COMMEMORATE', parameters)
    end}
  end
  return submit(items)
end

-- ---------------------------------------------------------------------------
-- Pantheon.
-- Native: Base/Assets/UI/Choosers/PantheonChooser.lua ConfirmPantheon ->
--   PlayerOperations.FOUND_PANTHEON with PARAM_BELIEF_TYPE = belief *Hash* and
--   PARAM_INSERT_MODE = VALUE_EXCLUSIVE. Availability is CanSelectBelief: class
--   BELIEF_CLASS_PANTHEON, not IsInSomePantheon, not IsInSomeReligion.
-- ---------------------------------------------------------------------------
local function knownBoolean(group, object, method, ...)
  local value = A.call(group, object, method, ...)
  if type(value) ~= 'boolean' then
    A.unavailable(group, method, 'Native legality/readiness is unknown')
    return nil
  end
  return value
end

local function pantheonBeliefs(gameReligion)
  local options = A.array()
  if GameInfo.Beliefs == nil then return options end
  for row in GameInfo.Beliefs() do
    if row.BeliefClassType == 'BELIEF_CLASS_PANTHEON' then
      if knownBoolean('pantheon', gameReligion, 'IsInSomePantheon', row.Index) == false
        and knownBoolean('pantheon', gameReligion, 'IsInSomeReligion', row.Index) == false then
        options[#options+1] = {choice = row.BeliefType, engineIndex = row.Index, available = true,
          label = A.loc(row.Name), description = A.loc(row.Description)}
      end
    end
  end
  return options
end

local function pantheonDecisions(ctx, out)
  local religion = A.call('pantheon', ctx.player, 'GetReligion')
  -- Guard: the player's Religion manager can be absent; a null result must not reach CanCreatePantheon.
  if religion == A.null then return A.unavailable('pantheon', 'GetReligion', 'Player religion manager unavailable') end
  if A.call('pantheon', religion, 'CanCreatePantheon') ~= true then return end
  local gameReligion = A.static('pantheon', Game, 'GetReligion')
  -- Guard: the game-level Religion manager can be absent; belief availability must not query a null object.
  if gameReligion == A.null then return A.unavailable('pantheon', 'Game.GetReligion', 'Game religion manager unavailable') end
  local options = pantheonBeliefs(gameReligion)
  if #options == 0 then return end
  out[#out+1] = {
    key = 'player'..ctx.pid,
    kind = 'pantheon', actionType = 'pantheon', operations = A.array{'found'},
    label = 'Found a pantheon: pick one pantheon belief',
    mandatory = true,
    blocks = blocking(ctx, 'ENDTURN_BLOCKING_PANTHEON'),
    faith = A.call('pantheon', religion, 'GetFaithBalance'),
    minimumFaithNextPantheon = A.call('pantheon', gameReligion, 'GetMinimumFaithNextPantheon'),
    options = options,
    choiceHelp = 'choice=<BeliefType>',
  }
end

local function pantheonSubmit(ctx, belief)
  assert(type(belief) == 'string', 'pantheon needs belief=<BeliefType>')
  local religion = A.call('pantheon', ctx.player, 'GetReligion')
  assert(religion ~= A.null and A.call('pantheon', religion, 'CanCreatePantheon') == true,
    'The engine says no pantheon may be founded right now')
  local row = GameInfo.Beliefs[belief]
  assert(row, 'Unknown BeliefType: '..belief)
  assert(row.BeliefClassType == 'BELIEF_CLASS_PANTHEON', belief..' is not a pantheon belief')
  local gameReligion = A.static('pantheon', Game, 'GetReligion')
  assert(gameReligion ~= A.null, 'Game.GetReligion is unavailable; belief availability cannot be revalidated')
  assert(A.call('pantheon', gameReligion, 'IsInSomePantheon', row.Index) ~= true
    and A.call('pantheon', gameReligion, 'IsInSomeReligion', row.Index) ~= true,
    'Belief has already been taken: '..belief)
  return submit({{label = 'FOUND_PANTHEON '..belief, run = function()
    local parameters = {}
    parameters[A.param(PlayerOperations, 'PARAM_BELIEF_TYPE')] = row.Hash
    parameters[A.param(PlayerOperations, 'PARAM_INSERT_MODE')] = A.param(PlayerOperations, 'VALUE_EXCLUSIVE')
    return playerOperation(ctx.pid, 'FOUND_PANTHEON', parameters)
  end}})
end

-- ---------------------------------------------------------------------------
-- Great people.
-- Native: Base/Assets/UI/Popups/GreatPeoplePopup.lua. The timeline read is GetTimeline()
--   (:702-704) and the popup passes the entry's own `Individual` value to every legality call and
--   to PARAM_GREAT_PERSON_INDIVIDUAL_TYPE (:726-745 discovery, :886-927 requests); it is never
--   re-derived from a row index. Legality and costs come from Game.GetGreatPeople():
--   CanRecruitPerson / CanRejectPerson+GetRejectCost / CanPatronizePerson+GetPatronizeCost(
--   player, individual, YieldTypes.GOLD|FAITH). Requests are RECRUIT_GREAT_PERSON /
--   REJECT_GREAT_PERSON / PATRONIZE_GREAT_PERSON with PARAM_YIELD_TYPE for patronage.
--   A patronage price of 1000000 is the engine's "not purchasable" sentinel (:241-258) and the
--   CAPABILITY_GREAT_PEOPLE_* capabilities gate the native buttons (:241-284); both are reported,
--   neither is silently folded into engine legality.
-- Recruiting is only an *opportunity* unless ENDTURN_BLOCKING_CLAIM_GREAT_PERSON is up.
-- ---------------------------------------------------------------------------
local PATRONIZE_UNAVAILABLE_COST = 1000000
local GREAT_PERSON_CAPABILITIES = {
  recruit = 'CAPABILITY_GREAT_PEOPLE_CAN_RECRUIT',
  reject = 'CAPABILITY_GREAT_PEOPLE_CAN_REJECT',
  gold = 'CAPABILITY_GREAT_PEOPLE_RECRUIT_WITH_GOLD',
  faith = 'CAPABILITY_GREAT_PEOPLE_RECRUIT_WITH_FAITH',
}

--- Capabilities are UI gates, not engine legality: they are reported as facts, and an unknown
--- capability stays A.null instead of being read as false in either direction.
local function greatPersonCapabilities()
  local out = {}
  for key, capability in pairs(GREAT_PERSON_CAPABILITIES) do
    local value = A.static('greatPeople', GameCapabilities, 'HasCapability', capability)
    -- `false` is a real answer ("this ruleset has no such button") and must not collapse into the
    -- unknown value the way `x and y or z` would.
    if type(value) == 'boolean' then out[key] = value else out[key] = A.null end
  end
  return out
end

--- One timeline entry, read the way the popup reads it: one legality call per possible action plus
--- the exact price each action reports. Prices are read even while an action is illegal, exactly
--- as the native screen does for a disabled button; nothing is paid or chosen here.
local function greatPersonEntryState(people, pid, entry)
  local individual = entry.Individual
  local goldYield = YieldTypes and YieldTypes.GOLD
  local faithYield = YieldTypes and YieldTypes.FAITH
  local state = {
    individual = individual,
    individualType = A.typeName('GreatPersonIndividuals', individual, 'GreatPersonIndividualType'),
    claimedBy = entry.Claimant or A.null,
    recruitCost = entry.Cost or A.null,
    canRecruit = A.call('greatPeople', people, 'CanRecruitPerson', pid, individual) == true,
    canReject = A.call('greatPeople', people, 'CanRejectPerson', pid, individual) == true,
  }
  if state.canReject then
    state.rejectCost = A.call('greatPeople', people, 'GetRejectCost', pid, individual)
  end
  if goldYield ~= nil then
    state.goldCost = A.call('greatPeople', people, 'GetPatronizeCost', pid, individual, goldYield)
    state.canPatronizeGold = A.call('greatPeople', people, 'CanPatronizePerson', pid, individual, goldYield) == true
    if type(state.goldCost) == 'number' and state.goldCost >= PATRONIZE_UNAVAILABLE_COST then
      -- The sentinel means "no purchasable price in this ruleset", so the native screen hides the
      -- button entirely; reporting 1000000 as a price would be a fabricated number.
      state.goldCost, state.canPatronizeGold = A.null, false
    end
  end
  if faithYield ~= nil then
    state.faithCost = A.call('greatPeople', people, 'GetPatronizeCost', pid, individual, faithYield)
    state.canPatronizeFaith = A.call('greatPeople', people, 'CanPatronizePerson', pid, individual, faithYield) == true
    if type(state.faithCost) == 'number' and state.faithCost >= PATRONIZE_UNAVAILABLE_COST then
      state.faithCost, state.canPatronizeFaith = A.null, false
    end
  end
  return state
end

--- Resolve a caller-supplied individual against a freshly read timeline. Accepts the timeline's
--- own `Individual` value or a GreatPersonIndividualType string, so an id-based decide survives a
--- round trip without the caller knowing which representation the engine handed out.
local function greatPersonEntry(people, individual)
  local timeline = A.call('greatPeople', people, 'GetTimeline')
  if timeline == A.null or type(timeline) ~= 'table' then
    return nil, 'Great-people timeline unavailable; call civ.decisions again'
  end
  for _, entry in ipairs(timeline) do
    if type(entry) == 'table' and entry.Individual ~= nil then
      if entry.Individual == individual then return entry end
      if type(individual) == 'string' then
        local row = A.row('GreatPersonIndividuals', entry.Individual)
        if row ~= A.null and row.GreatPersonIndividualType == individual then return entry end
      end
    end
  end
  return nil, 'That great person is not on the current timeline; call civ.decisions again'
end

local function greatPeopleDecisions(ctx, out)
  local people = A.static('greatPeople', Game, 'GetGreatPeople')
  -- Do not query a missing great-people manager.
  if people == A.null then return A.unavailable('greatPeople', 'GetGreatPeople', 'Great-people manager unavailable') end
  local timeline = A.call('greatPeople', people, 'GetTimeline')
  -- Guard: GetTimeline is only usable as a table; anything else means no data, not a crash.
  if timeline == A.null or type(timeline) ~= 'table' then return A.unavailable('greatPeople', 'GetTimeline', 'Great-people timeline unavailable') end
  local claimBlocks = blocking(ctx, 'ENDTURN_BLOCKING_CLAIM_GREAT_PERSON')
  local capabilities = greatPersonCapabilities()
  local scanned, emitted, ledger = 0, 0, A.array()
  for _, entry in ipairs(timeline) do
    local individual = type(entry) == 'table' and entry.Individual or nil
    -- Guard: entries without an Individual id (or already claimed) are skipped, not queried.
    if individual ~= nil then
      scanned = scanned + 1
      if entry.Claimant == nil then
        local state = greatPersonEntryState(people, ctx.pid, entry)
        local anyLegal = state.canRecruit or state.canReject
          or state.canPatronizeGold == true or state.canPatronizeFaith == true
        ledger[#ledger+1] = state
        if anyLegal then
          local row = A.row('GreatPersonIndividuals', individual)
          local options = A.array()
          -- `available` is the native button state: engine legality AND the ruleset capability AND
          -- a real price. The underlying facts stay visible in engineLegal/capability/cost, so a
          -- refusal is traceable instead of opaque.
          options[#options+1] = {choice='recruit', operation='recruit',
            available = state.canRecruit and type(state.recruitCost) == 'number' and capabilities.recruit ~= false,
            engineLegal = state.canRecruit, cost = state.recruitCost, capability = capabilities.recruit}
          if type(state.rejectCost) == 'number' then
            options[#options+1] = {choice='reject', operation='reject', currency='great_person_points',
              available = state.canReject and capabilities.reject ~= false,
              engineLegal = state.canReject, cost = state.rejectCost, capability = capabilities.reject}
          end
          if type(state.goldCost) == 'number' then
            options[#options+1] = {choice='patronize_gold', operation='patronize', currency='gold',
              available = state.canPatronizeGold == true and capabilities.gold ~= false,
              engineLegal = state.canPatronizeGold == true, cost = state.goldCost, capability = capabilities.gold}
          end
          if type(state.faithCost) == 'number' then
            options[#options+1] = {choice='patronize_faith', operation='patronize', currency='faith',
              available = state.canPatronizeFaith == true and capabilities.faith ~= false,
              engineLegal = state.canPatronizeFaith == true, cost = state.faithCost, capability = capabilities.faith}
          end
          emitted = emitted + 1
          out[#out+1] = {
            key = 'individual'..tostring(individual),
            kind = 'great_person', actionType = 'great_person',
            operations = A.array{'recruit','reject','patronize'},
            label = (row ~= A.null and A.loc(row.Name) or ('Great person '..tostring(individual))),
            mandatory = claimBlocks and state.canRecruit,
            blocks = claimBlocks and state.canRecruit,
            individual = individual,
            individualType = state.individualType,
            individualIndex = row ~= A.null and row.Index or A.null,
            class = A.typeName('GreatPersonClasses', entry.Class, 'GreatPersonClassType'),
            era = A.typeName('Eras', entry.Era, 'EraType'),
            turnGranted = entry.TurnGranted or A.null,
            actionCharges = row ~= A.null and row.ActionCharges or A.null,
            actionName = A.loc(entry.ActionNameText),
            actionUsage = A.loc(entry.ActionUsageText),
            actionEffect = A.loc(entry.ActionEffectText),
            passiveEffect = A.loc(entry.PassiveEffectText),
            earnConditions = A.loc(A.call('greatPeople', people, 'GetEarnConditionsText', ctx.pid, individual)),
            capabilities = capabilities,
            activation = 'civ.action(type="unit_command", unitId=<the claimed unit\'s unitId>, command="ACTIVATE_GREAT_PERSON"): activation happens in place on the map unit after the claim, and civ.options(unitId=...) lists the engine\'s activationPlots for it.',
            options = options,
            choiceHelp = 'choice=recruit|reject|patronize_gold|patronize_faith. Patronage and rejection spend real currency; nothing is paid implicitly. Claiming does not choose a tile or ability use: the spawned unit\'s activation is the separate ACTIVATE_GREAT_PERSON unit command named in the activation field.',
          }
        end
      else
        ledger[#ledger+1] = {individual = individual, claimedBy = entry.Claimant,
          individualType = A.typeName('GreatPersonIndividuals', individual, 'GreatPersonIndividualType')}
      end
    end
  end
  -- A pending claim that this bridge cannot explain must be visible, not an empty list: the
  -- blocker comes from the engine, and an empty answer used to look like "nothing to claim".
  if claimBlocks and emitted == 0 then
    local diagnostics = A.array()
    for index = 1, math.min(#ledger, 24) do diagnostics[#diagnostics+1] = ledger[index] end
    out[#out+1] = {
      key = 'unresolved:turn'..tostring(ctx.turn),
      kind = 'great_person', actionType = 'great_person',
      operations = A.array(),
      label = 'A Great Person claim is pending but the native timeline offers no legal claim',
      mandatory = true, blocks = true,
      timelineEntries = scanned,
      options = A.array(),
      timeline = diagnostics,
      timelineTruncated = #ledger > #diagnostics,
      capabilities = capabilities,
      choiceHelp = 'civ.decide cannot answer this record: it exists so an unresolved engine claim is observable. timeline[] is the raw per-entry state (claimedBy, canRecruit, canReject, goldCost, faithCost). Re-read civ.decisions; the native Great People screen remains available.',
    }
  end
end

local function greatPersonSubmit(ctx, operation, individual, currency)
  local people = A.static('greatPeople', Game, 'GetGreatPeople')
  assert(people ~= A.null, 'Game.GetGreatPeople is unavailable in this context')
  assert(individual ~= nil, 'great_person needs individual=<timeline individual or GreatPersonIndividualType from civ.decisions>')
  local entry, failure = greatPersonEntry(people, individual)
  assert(entry ~= nil, failure)
  assert(entry.Claimant == nil, 'That great person has already been claimed or passed; call civ.decisions again')
  local value = entry.Individual
  local label = A.typeName('GreatPersonIndividuals', value, 'GreatPersonIndividualType')
  local name = label ~= A.null and label or tostring(value)
  local parameters = {}
  parameters[A.param(PlayerOperations, 'PARAM_GREAT_PERSON_INDIVIDUAL_TYPE')] = value
  local nativeOperation
  if operation == 'recruit' then
    assert(A.call('greatPeople', people, 'CanRecruitPerson', ctx.pid, value) == true, 'Engine refuses recruitment of '..name)
    nativeOperation = 'RECRUIT_GREAT_PERSON'
  elseif operation == 'reject' then
    assert(A.call('greatPeople', people, 'CanRejectPerson', ctx.pid, value) == true, 'Engine refuses rejection of '..name)
    nativeOperation = 'REJECT_GREAT_PERSON'
  elseif operation == 'patronize' then
    assert(currency == 'gold' or currency == 'faith', 'patronize needs currency="gold" or "faith"; the cost is never chosen for you')
    local yield = YieldTypes and (currency == 'gold' and YieldTypes.GOLD or YieldTypes.FAITH)
    assert(yield ~= nil, 'YieldTypes is unavailable in this context')
    assert(A.call('greatPeople', people, 'CanPatronizePerson', ctx.pid, value, yield) == true,
      'Engine refuses '..currency..' patronage of '..name)
    local cost = A.call('greatPeople', people, 'GetPatronizeCost', ctx.pid, value, yield)
    assert(type(cost) ~= 'number' or cost < PATRONIZE_UNAVAILABLE_COST,
      'The engine reports no purchasable '..currency..' price for '..name)
    parameters[A.param(PlayerOperations, 'PARAM_YIELD_TYPE')] = yield
    nativeOperation = 'PATRONIZE_GREAT_PERSON'
  else
    error('great_person operation must be recruit, reject or patronize')
  end
  return submit({{label = nativeOperation..' '..name, run = function()
    return playerOperation(ctx.pid, nativeOperation, parameters)
  end}})
end

-- ---------------------------------------------------------------------------
-- Governors.
-- Native: DLC/Expansion2/UI/Additions/GovernorPanel.lua (appoint/promote) and
--   GovernorAssignmentChooser.lua (assign, the authority for assignment parameters).
--   PARAM_GOVERNOR_TYPE and PARAM_GOVERNOR_PROMOTION_TYPE are GameInfo row *Indexes*
--   (SetVoid1(governorDef.Index) / SetVoid2(kPromotion.Index)); the legality calls
--   CanPromoteGovernor / CanEarnPromotion / CanAssignGovernor take *Hashes*.
--   ASSIGN_GOVERNOR additionally passes PARAM_PLAYER_ONE = the selected city's OWNER,
--   which is not the local player when Amani is assigned to a city-state, plus
--   PARAM_CITY_DEST = the city id. Option choices therefore carry a full
--   session:city:<owner>:<id> id so the destination owner can never be lost.
-- ---------------------------------------------------------------------------
local function cannotAssign(governorRow)
  if GameInfo.GovernorsCannotAssign == nil then return false end
  local row = GameInfo.GovernorsCannotAssign[governorRow.GovernorType]
  return row ~= nil and row.CannotAssign == true
end

--- The only native promotion-to-governor relationship is GovernorPromotionSets: GovernorPromotions has
--- no GovernorType column at all (Expansion2_Schema.sql:372-379 defines GovernorPromotionType,
--- Name, Description, Level, Column, BaseAbility; :402-407 adds the set table), and both shipped
--- panels walk the set table before looking the promotion row up by its GovernorPromotion type
--- (GovernorPanel.lua:203-208, GovernorDetailsPanel.lua:159-166). Matching a GovernorType field on
--- the promotion row is what made every valid promotion look like it belonged to another governor.
local function governorPromotionRows(governorType)
  local out = A.array()
  if GameInfo.GovernorPromotionSets == nil or GameInfo.GovernorPromotions == nil then return out, false end
  local ok = pcall(function()
    for set in GameInfo.GovernorPromotionSets() do
      if type(set) == 'table' and set.GovernorType == governorType then
        local row = GameInfo.GovernorPromotions[set.GovernorPromotion]
        if row ~= nil then out[#out+1] = row
        else A.unavailable('governors', 'GovernorPromotions', 'Promotion set names an undefined promotion: '..tostring(set.GovernorPromotion)) end
      end
    end
  end)
  if not ok then A.unavailable('governors', 'GovernorPromotionSets', 'Promotion set walk failed; promotion discovery is incomplete') end
  table.sort(out, function(a, b) return (number(a.Index) or 0) < (number(b.Index) or 0) end)
  return out, true
end

--- Prerequisite promotions, read from GovernorPromotionPrereqs exactly as GovernorSupport does
--- (GovernorSupport.lua:167-182).
local function governorPromotionPrereqs(promotion)
  local out = A.array()
  if GameInfo.GovernorPromotionPrereqs == nil then return out end
  local ok = pcall(function()
    for row in GameInfo.GovernorPromotionPrereqs() do
      if type(row) == 'table' and row.GovernorPromotionType == promotion.GovernorPromotionType
        and row.PrereqGovernorPromotion ~= nil then
        out[#out+1] = row.PrereqGovernorPromotion
      end
    end
  end)
  if not ok then A.unavailable('governors', 'GovernorPromotionPrereqs', 'Promotion prerequisites unavailable') end
  return out
end

--- GovernorSupport.IsPromotionHidden masks a promotion until its prerequisites are earned
--- (GovernorSupport.lua:127-146: GovernorPromotionConditions.HiddenWithoutPrereqs plus a missing
--- GovernorPromotionPrereqs entry). Masking changes the label the native screen shows, never whether
--- the promotion can be submitted, so this is reported as information only.
local function governorPromotionHidden(promotion, governor)
  if GameInfo.GovernorPromotionConditions == nil then return A.null end
  local hidden, missingPrereq = false, false
  local ok = pcall(function()
    for condition in GameInfo.GovernorPromotionConditions() do
      if type(condition) == 'table' and condition.GovernorPromotionType == promotion.GovernorPromotionType then
        hidden = condition.HiddenWithoutPrereqs == true
      end
    end
    if hidden then
      for _, name in ipairs(governorPromotionPrereqs(promotion)) do
        local prereq = GameInfo.GovernorPromotions[name]
        if prereq ~= nil and A.call('governors', governor, 'HasPromotion', prereq.Hash) ~= true then
          missingPrereq = true
        end
      end
    end
  end)
  if not ok then return A.null end
  return hidden and missingPrereq
end

local function assignableCities(ctx, governors, governorRow, governor)
  local options, partial = A.array(), false
  local function consider(city)
    -- Never pass an absent city into native governor legality.
    if city == nil or city == A.null then partial = true; A.unavailable('governors', 'city', 'Assignment city unavailable'); return end
    local owner, cid = city:GetOwner(), city:GetID()
    local can, results = false, nil
    local ok, a, b = pcall(function() return governors:CanAssignGovernor(governorRow.Hash, city, true) end)
    if ok then can, results = a == true, b else partial = true end
    local decoded = A.results(PlayerOperationResults, results)
    options[#options+1] = {
      choice = entityId('city', owner, cid), available = can,
      label = A.loc(A.call('governors', city, 'GetName')), cityOwner = owner,
      reasons = decoded.reasons or A.null,
    }
  end
  local cities = A.call('governors', ctx.player, 'GetCities')
  -- Collection getters can return nil even when the player object exists.
  if cities == A.null then
    partial = true
    A.unavailable('governors', 'GetCities', 'Own city collection unavailable')
  else
    local ok = pcall(function() for _, city in cities:Members() do consider(city) end end)
    if not ok then partial = true; A.unavailable('governors', 'cities', 'Own city walk failed') end
  end
  -- Amani-style governors may be assigned into met city-states that can receive influence;
  -- GovernorAssignmentChooser walks PlayerManager.GetAliveMinors for exactly this case.
  if governor ~= nil and governor ~= A.null and A.call('governors', governor, 'IsGovernCityState') == true then
    local minors = A.static('governors', PlayerManager, 'GetAliveMinors')
    if type(minors) == 'table' then
      local diplomacy = A.call('governors', ctx.player, 'GetDiplomacy')
      if diplomacy == A.null then
        A.unavailable('governors', 'GetDiplomacy', 'Diplomacy manager unavailable for city-state assignments')
        return options, true
      end
      for _, minor in ipairs(minors) do
        local okMinor = pcall(function()
          if minor == nil or minor == A.null then partial = true; A.unavailable('governors', 'minor', 'City-state player unavailable'); return end
          local mid = minor:GetID()
          local influence = A.call('governors', minor, 'GetInfluence')
          if influence == A.null then
            partial = true
            A.unavailable('governors', 'GetInfluence', 'City-state influence manager unavailable')
            return
          end
          if A.call('governors', influence, 'CanReceiveInfluence') == true
            and A.call('governors', diplomacy, 'HasMet', mid) == true then
            local minorCities = A.call('governors', minor, 'GetCities')
            if minorCities == A.null then partial = true; A.unavailable('governors', 'minorCities', 'City-state city collection unavailable'); return end
            for _, city in minorCities:Members() do consider(city) end
          end
        end)
        if not okMinor then partial = true end
      end
    else
      partial = true
    end
  end
  return options, partial
end

local function governorDecisions(ctx, out)
  -- Guard: without the Governors ruleset table the whole family is absent; nothing to query.
  if GameInfo.Governors == nil then return end
  local governors = A.call('governors', ctx.player, 'GetGovernors')
  -- Guard: the player's Governors manager can be absent; null must not reach CanAppoint/GetGovernor.
  if governors == A.null then return A.unavailable('governors', 'GetGovernors', 'Governor manager unavailable') end
  local canAppoint = A.call('governors', governors, 'CanAppoint') == true
  local points = number(A.call('governors', governors, 'GetGovernorPoints'))
  local spent = number(A.call('governors', governors, 'GetGovernorPointsSpent'))
  if canAppoint then
    local options = A.array()
    for row in GameInfo.Governors() do
      if A.call('governors', governors, 'HasGovernor', row.Hash) == false
        and A.call('governors', governors, 'CanEverAppointGovernor', row.Hash) == true then
        options[#options+1] = {choice = row.GovernorType, available = true, label = A.loc(row.Name),
          title = A.loc(row.Title), secret = cannotAssign(row), description = A.loc(row.Description)}
      end
    end
    if #options > 0 then
      out[#out+1] = {
        key = 'appoint',
        kind = 'governor', actionType = 'governor', operation = 'appoint',
        operations = A.array{'appoint'},
        label = 'Appoint a governor ('..tostring(points and spent and (points - spent) or '?')..' titles available)',
        mandatory = false,
        blocks = blocking(ctx, 'ENDTURN_BLOCKING_GOVERNOR_APPOINTMENT'),
        titlesAvailable = (points ~= nil and spent ~= nil) and (points - spent) or A.null,
        options = options,
        choiceHelp = 'choice=<GovernorType>',
      }
    end
  end
  for row in GameInfo.Governors() do
    local governor = A.null
    -- GovernorSupport establishes appointment before retrieving a native governor.
    if A.call('governors', governors, 'HasGovernor', row.Hash) == true then
      governor = A.call('governors', governors, 'GetGovernor', row.Hash)
      if governor == A.null then A.unavailable('governors', 'GetGovernor', 'Appointed governor object unavailable') end
    end
    if governor ~= A.null then
      -- Promotion. Membership comes from the native GovernorPromotionSets relationship and
      -- eligibility from the engine; the full set is reported so a locked or hidden promotion is
      -- visible as a rule, not as a missing decision.
      if A.call('governors', governors, 'CanPromoteGovernor', row.Hash) == true then
        local promotions, setsKnown = governorPromotionRows(row.GovernorType)
        if not setsKnown then
          A.unavailable('governors', 'GovernorPromotionSets', 'GovernorPromotionSets/GovernorPromotions absent; promotion membership is unknown')
        else
          local options = A.array()
          for _, promotion in ipairs(promotions) do
            -- The base ability is granted with the appointment and is not earnable
            -- (GovernorDetailsPanel.lua:159-175 splits it out of the promotion tree).
            if promotion.BaseAbility ~= true then
              local owned = A.call('governors', governor, 'HasPromotion', promotion.Hash)
              local eligible = A.call('governors', governors, 'CanEarnPromotion', row.Hash, promotion.Hash)
              options[#options+1] = {
                choice = promotion.GovernorPromotionType,
                available = eligible == true and owned ~= true,
                owned = owned == true,
                eligible = type(eligible) == 'boolean' and eligible or A.null,
                level = promotion.Level or A.null,
                column = promotion.Column or A.null,
                hidden = governorPromotionHidden(promotion, governor),
                prereqs = governorPromotionPrereqs(promotion),
                label = A.loc(promotion.Name),
                description = A.loc(promotion.Description),
              }
            end
          end
          if #options > 0 then
            local anyLegal = false
            for _, option in ipairs(options) do if option.available then anyLegal = true; break end end
            out[#out+1] = {
              key = 'promote:'..row.GovernorType,
              kind = 'governor', actionType = 'governor', operation = 'promote',
              operations = A.array{'promote'},
              label = 'Promote '..tostring(A.loc(row.Name))..(anyLegal and '' or ' (no promotion is earnable right now)'),
              mandatory = false,
              blocks = blocking(ctx, 'ENDTURN_BLOCKING_GOVERNOR_PROMOTION'),
              governor = row.GovernorType,
              promotionSet = 'GovernorPromotionSets',
              options = options,
              choiceHelp = 'choice=<GovernorPromotionType>. Every promotion in this governor\'s native set is listed with its owned/eligible flags and prerequisite promotions; only available=true can be submitted now.',
            }
          end
        end
      end
      -- Assignment. A neutralized governor cannot be moved (GovernorPanel OnAssignButton).
      if not cannotAssign(row) then
        local neutralized = number(A.call('governors', governor, 'GetNeutralizedTurns'))
        if neutralized ~= nil and neutralized <= 0 then
          local options, partial = assignableCities(ctx, governors, row, governor)
          local anyLegal = false
          for _, option in ipairs(options) do if option.available then anyLegal = true; break end end
          if anyLegal then
            local assigned = A.call('governors', governor, 'GetAssignedCity')
            out[#out+1] = {
              key = 'assign:'..row.GovernorType,
              kind = 'governor', actionType = 'governor', operation = 'assign',
              operations = A.array{'assign'},
              label = 'Assign '..tostring(A.loc(row.Name))..' to a city',
              mandatory = false,
              blocks = blocking(ctx, 'ENDTURN_BLOCKING_GOVERNOR_IDLE') or blocking(ctx, 'ENDTURN_BLOCKING_GOVERNOR_OPPORTUNITY'),
              governor = row.GovernorType,
              currentCityId = (assigned ~= nil and assigned ~= A.null)
                and entityId('city', assigned:GetOwner(), assigned:GetID()) or A.null,
              established = A.call('governors', governor, 'IsEstablished'),
              candidatesPartial = partial,
              options = options,
              choiceHelp = 'choice=<cityId>. The id encodes the destination OWNER; a city-state target is not owned by you.',
            }
          end
        end
      end
    end
  end
end

local function governorSubmit(ctx, operation, governorType, promotionType, cityIdValue)
  assert(GameInfo.Governors ~= nil, 'Governors are not present in this ruleset')
  assert(type(governorType) == 'string', 'governor needs governor=<GovernorType>')
  local row = GameInfo.Governors[governorType]
  assert(row, 'Unknown GovernorType: '..governorType)
  local governors = A.call('governors', ctx.player, 'GetGovernors')
  assert(governors ~= A.null, 'Player governor API unavailable')
  if operation == 'assign' or operation == 'promote' then
    assert(A.call('governors', governors, 'HasGovernor', row.Hash) == true, 'Governor is not known to be appointed')
  end
  local parameters = {}
  parameters[A.param(PlayerOperations, 'PARAM_GOVERNOR_TYPE')] = row.Index
  if operation == 'appoint' then
    assert(A.call('governors', governors, 'CanAppoint') == true, 'No governor title is available')
    assert(A.call('governors', governors, 'HasGovernor', row.Hash) == false, governorType..' is already appointed or appointment state is unknown')
    assert(A.call('governors', governors, 'CanEverAppointGovernor', row.Hash) == true, governorType..' can never be appointed by this player')
    return submit({{label = 'APPOINT_GOVERNOR '..governorType, run = function()
      return playerOperation(ctx.pid, 'APPOINT_GOVERNOR', parameters)
    end}})
  elseif operation == 'promote' then
    assert(type(promotionType) == 'string', 'governor promote needs promotion=<GovernorPromotionType>')
    -- Membership comes from GovernorPromotionSets, the same relationship discovery uses; a
    -- GovernorType field on the promotion row does not exist in the installed ruleset.
    local promotions, setsKnown = governorPromotionRows(governorType)
    assert(setsKnown, 'GovernorPromotionSets/GovernorPromotions are absent from this ruleset; promotion membership is unknown')
    local promotion
    for _, candidate in ipairs(promotions) do
      if candidate.GovernorPromotionType == promotionType then promotion = candidate end
    end
    assert(promotion ~= nil, promotionType..' is not in '..governorType..'\'s native promotion set (GovernorPromotionSets)')
    assert(promotion.BaseAbility ~= true, promotionType..' is this governor\'s base ability, not an earnable promotion')
    assert(A.call('governors', governors, 'CanPromoteGovernor', row.Hash) == true, governorType..' cannot be promoted now')
    assert(A.call('governors', governors, 'CanEarnPromotion', row.Hash, promotion.Hash) == true,
      'Engine refuses promotion '..promotionType)
    assert(A.call('governors', governor, 'HasPromotion', promotion.Hash) ~= true, governorType..' already has '..promotionType)
    parameters[A.param(PlayerOperations, 'PARAM_GOVERNOR_PROMOTION_TYPE')] = promotion.Index
    return submit({{label = 'PROMOTE_GOVERNOR '..governorType..' '..promotionType, run = function()
      return playerOperation(ctx.pid, 'PROMOTE_GOVERNOR', parameters)
    end}})
  elseif operation == 'assign' then
    local owner, cid = parseCityId(cityIdValue)
    local city, mismatch = cityById('governors', ctx, owner, cid)
    if city == nil then
      return refused('stale', mismatch or ('Destination city '..tostring(cid)..' is no longer observable; nothing was submitted'),
        {governor = governorType, cityId = cityIdValue})
    end
    local can, results = false, nil
    local ok, a, b = pcall(function() return governors:CanAssignGovernor(row.Hash, city, true) end)
    if ok then can, results = a == true, b end
    if not can then
      local decoded = A.results(PlayerOperationResults, results)
      return refused('illegal', 'Engine CanAssignGovernor refused this destination',
        {details = decoded.reasons or A.null, governor = governorType, cityId = cityIdValue})
    end
    -- PARAM_PLAYER_ONE is the CITY OWNER, not the local player. Amani in a city-state
    -- assigns with the minor civ's id here; using the local player would be a real bug.
    parameters[A.param(PlayerOperations, 'PARAM_PLAYER_ONE')] = owner
    parameters[A.param(PlayerOperations, 'PARAM_CITY_DEST')] = cid
    return submit({{label = 'ASSIGN_GOVERNOR '..governorType..' -> '..cityIdValue, run = function()
      return playerOperation(ctx.pid, 'ASSIGN_GOVERNOR', parameters)
    end}})
  end
  error('governor operation must be appoint, assign or promote')
end

-- ---------------------------------------------------------------------------
-- Religion: founding and belief selection.
-- Native: Base/Assets/UI/ReligionScreen.lua confirmBeliefsButton ->
--   PlayerOperations.FOUND_RELIGION with PARAM_INSERT_MODE=VALUE_EXCLUSIVE,
--   PARAM_RELIGION_TYPE = religion *Hash*, and PARAM_RELIGION_CUSTOM_NAME only when the
--   row's RequiresCustomName is set; then one PlayerOperations.ADD_BELIEF request per
--   selected belief (PARAM_BELIEF_TYPE = belief Hash, PARAM_INSERT_MODE=VALUE_EXCLUSIVE).
--   Belief availability is PopulateAvailableBeliefs: not IsInSomePantheon, not
--   IsInSomeReligion, not IsTooManyForReligion(index, playerReligion), class not
--   BELIEF_CLASS_PANTHEON, and one belief per BeliefClassType per submission.
-- ---------------------------------------------------------------------------
local function religionBeliefOptions(gameReligion, playerReligionType)
  local options = A.array()
  if GameInfo.Beliefs == nil then return options end
  for row in GameInfo.Beliefs() do
    if row.BeliefClassType ~= 'BELIEF_CLASS_PANTHEON'
      and knownBoolean('religion', gameReligion, 'IsInSomePantheon', row.Index) == false
      and knownBoolean('religion', gameReligion, 'IsInSomeReligion', row.Index) == false
      and knownBoolean('religion', gameReligion, 'IsTooManyForReligion', row.Index, playerReligionType) == false then
      options[#options+1] = {choice = row.BeliefType, available = true, beliefClass = row.BeliefClassType,
        label = A.loc(row.Name), description = A.loc(row.Description)}
    end
  end
  return options
end

local function equippedBeliefCount(gameReligion, pid)
  local religions = A.call('religion', gameReligion, 'GetReligions')
  if religions == A.null or type(religions) ~= 'table' then
    A.unavailable('religion', 'GetReligions', 'Equipped beliefs unknown')
    return nil
  end
  for _, entry in ipairs(religions) do
    if type(entry) == 'table' and entry.Founder == pid then
      if entry.Beliefs == A.null or type(entry.Beliefs) ~= 'table' then
        A.unavailable('religion', 'Beliefs', 'Founder belief list unavailable')
        return nil
      end
      local count = 0
      for _ in pairs(entry.Beliefs) do count = count + 1 end
      return count
    end
  end
  return 0
end

local function religionDecisions(ctx, out)
  local religion = A.call('religion', ctx.player, 'GetReligion')
  local gameReligion = A.static('religion', Game, 'GetReligion')
  -- Guard: either Religion manager may be absent; null results must not reach the belief queries.
  if religion == A.null then return A.unavailable('religion', 'GetReligion', 'Player religion manager unavailable') end
  if gameReligion == A.null then return A.unavailable('religion', 'Game.GetReligion', 'Game religion manager unavailable') end
  local created = number(A.call('religion', religion, 'GetReligionTypeCreated'))
  local pantheon = number(A.call('religion', religion, 'GetPantheon'))
  local earned = number(A.call('religion', religion, 'GetNumBeliefsEarned'))
  if created == nil or pantheon == nil or earned == nil then
    return A.unavailable('religion', 'readiness', 'Religion, pantheon or earned belief state unknown')
  end
  -- ReligionScreen.ViewMyReligion enters founding after the prophet has earned beliefs,
  -- not merely because a founding unit exists (it may not have been activated).
  if pantheon < 0 or earned == 0 then return end
  if created < 0 and earned > 0 and GameInfo.Religions ~= nil then
    local options = A.array()
    for row in GameInfo.Religions() do
      if row.Pantheon == false and knownBoolean('religion', gameReligion, 'HasBeenFounded', row.Index) == false then
        options[#options+1] = {choice = row.ReligionType, available = true, label = A.loc(row.Name),
          requiresCustomName = row.RequiresCustomName == true}
      end
    end
    if #options > 0 then
      out[#out+1] = {
        key = 'found',
        kind = 'religion', actionType = 'religion', operation = 'found',
        operations = A.array{'found'},
        label = 'Found a religion',
        mandatory = true,
        blocks = blocking(ctx, 'ENDTURN_BLOCKING_RELIGION'),
        beliefsEarned = earned,
        beliefOptions = religionBeliefOptions(gameReligion, -1),
        options = options,
        choiceHelp = 'choice=<ReligionType>; pass name="..." when the option says requiresCustomName. Optionally pass beliefs=[<BeliefType>...] from beliefOptions to send the founding beliefs in the same native sequence the confirm button uses; otherwise answer the religion/belief decision afterwards.',
      }
    end
  end
  if created < 0 then return end
  local equipped = equippedBeliefCount(gameReligion, ctx.pid)
  local pending = (equipped ~= nil) and (earned - equipped) or nil
  if pending ~= nil and pending > 0 then
    local options = religionBeliefOptions(gameReligion, created)
    if #options > 0 then
      out[#out+1] = {
        key = 'belief:earned'..earned,
        kind = 'religion', actionType = 'religion', operation = 'belief',
        operations = A.array{'belief'},
        label = 'Choose '..pending..' religious belief'..(pending == 1 and '' or 's'),
        mandatory = true,
        blocks = blocking(ctx, 'ENDTURN_BLOCKING_BELIEF'),
        selectCount = pending,
        beliefsEarned = earned,
        beliefsEquipped = equipped,
        options = options,
        choiceHelp = 'choice=<BeliefType> or choices=[...]; at most one belief per beliefClass per submission. Each belief is a separate native ADD_BELIEF request and partial progress is reported.',
      }
    end
  end
end

--- Build one ADD_BELIEF request per belief with the same filters PopulateAvailableBeliefs
--- applies. `created` is the player's religion index, or -1 while founding (exactly what
--- the native screen passes to IsTooManyForReligion during the founding confirm).
local function beliefRequests(ctx, gameReligion, beliefs, created)
  local items, seenBelief, seenClass = {}, {}, {}
  for _, name in ipairs(beliefs) do
    assert(type(name) == 'string', 'Each belief must be a BeliefType string')
    local row = GameInfo.Beliefs and GameInfo.Beliefs[name]
    assert(row, 'Unknown BeliefType: '..tostring(name))
    assert(row.BeliefClassType ~= 'BELIEF_CLASS_PANTHEON', name..' is a pantheon belief; use the pantheon decision')
    assert(not seenBelief[name], 'Duplicate belief: '..name)
    assert(not seenClass[row.BeliefClassType], 'Two beliefs of class '..tostring(row.BeliefClassType)..'; the native chooser allows one per class per submission')
    assert(knownBoolean('religion', gameReligion, 'IsInSomePantheon', row.Index) == false
      and knownBoolean('religion', gameReligion, 'IsInSomeReligion', row.Index) == false
      and knownBoolean('religion', gameReligion, 'IsTooManyForReligion', row.Index, created) == false,
      'Belief is not available: '..name)
    seenBelief[name], seenClass[row.BeliefClassType] = true, true
    items[#items+1] = {label = 'ADD_BELIEF '..name, run = function()
      local parameters = {}
      parameters[A.param(PlayerOperations, 'PARAM_BELIEF_TYPE')] = row.Hash
      parameters[A.param(PlayerOperations, 'PARAM_INSERT_MODE')] = A.param(PlayerOperations, 'VALUE_EXCLUSIVE')
      return playerOperation(ctx.pid, 'ADD_BELIEF', parameters)
    end}
  end
  return items
end

local function religionSubmit(ctx, operation, religionType, customName, beliefs)
  local religion = A.call('religion', ctx.player, 'GetReligion')
  local gameReligion = A.static('religion', Game, 'GetReligion')
  assert(religion ~= A.null and gameReligion ~= A.null, 'Religion APIs unavailable in this context')
  if operation == 'found' then
    assert(type(religionType) == 'string', 'religion found needs religion=<ReligionType>')
    local row = GameInfo.Religions and GameInfo.Religions[religionType]
    assert(row, 'Unknown ReligionType: '..religionType)
    assert(row.Pantheon == false, religionType..' is the pantheon pseudo-religion, not a foundable religion')
    assert(knownBoolean('religion', gameReligion, 'HasBeenFounded', row.Index) == false, religionType..' is not known to be available')
    local created = number(A.call('religion', religion, 'GetReligionTypeCreated'))
    local pantheon = number(A.call('religion', religion, 'GetPantheon'))
    local earned = number(A.call('religion', religion, 'GetNumBeliefsEarned'))
    assert(created ~= nil and created < 0 and pantheon ~= nil and pantheon >= 0 and earned ~= nil and earned > 0,
      'Religion founding is not currently ready')
    local parameters = {}
    parameters[A.param(PlayerOperations, 'PARAM_INSERT_MODE')] = A.param(PlayerOperations, 'VALUE_EXCLUSIVE')
    parameters[A.param(PlayerOperations, 'PARAM_RELIGION_TYPE')] = row.Hash
    if row.RequiresCustomName == true then
      assert(type(customName) == 'string' and customName ~= '', religionType..' requires name="..."')
      parameters[A.param(PlayerOperations, 'PARAM_RELIGION_CUSTOM_NAME')] = customName
    end
    local items = {{label = 'FOUND_RELIGION '..religionType, run = function()
      return playerOperation(ctx.pid, 'FOUND_RELIGION', parameters)
    end}}
    -- The native confirm button sends FOUND_RELIGION and then one ADD_BELIEF per founding
    -- belief in the same sequence; beliefs are optional here and validated against -1
    -- exactly as the native screen does before the religion exists.
    if beliefs ~= nil then
      assert(type(beliefs) == 'table', 'religion found beliefs must be an array of BeliefType')
      assert(#beliefs <= earned, 'Only '..earned..' belief(s) have been earned; '..#beliefs..' were supplied')
      for _, item in ipairs(beliefRequests(ctx, gameReligion, beliefs, -1)) do items[#items+1] = item end
    end
    return submit(items, #items > 1
      and 'FOUND_RELIGION followed by one ADD_BELIEF per belief, in order. requests[] reports exactly which were submitted; an unknown acknowledgement stops the rest and is never replayed.'
      or nil)
  elseif operation == 'belief' then
    assert(type(beliefs) == 'table' and #beliefs > 0, 'religion belief needs belief=<BeliefType> or beliefs=[...]')
    local created = number(A.call('religion', religion, 'GetReligionTypeCreated'))
    local earned = number(A.call('religion', religion, 'GetNumBeliefsEarned'))
    assert(created ~= nil and created >= 0 and earned ~= nil, 'An existing religion and known earned beliefs are required')
    local equipped = equippedBeliefCount(gameReligion, ctx.pid)
    assert(equipped ~= nil, 'Equipped belief count is unknown')
    local pending = earned - equipped
    assert(pending > 0, 'No belief slot is currently earned and unfilled')
    assert(#beliefs <= pending, 'Only '..pending..' belief slot(s) are earned; '..#beliefs..' were supplied')
    return submit(beliefRequests(ctx, gameReligion, beliefs, created),
      'Each belief is a separate native ADD_BELIEF request. requests[] reports exactly which ones were submitted; an unknown acknowledgement stops the rest and is never replayed.')
  end
  error('religion operation must be found or belief')
end

-- ---------------------------------------------------------------------------
-- Captured / rebelled city fate.
-- Native: Base/Assets/UI/Popups/RazeCity.lua (GetNextCapturedCity; KEEP / RAZE /
--   LIBERATE_FOUNDER / LIBERATE_PREVIOUS_OWNER) and Expansion2 DisloyalCityChooser.lua
--   (GetNextRebelledCity; KEEP / REJECT). All four use
--   CityManager.RequestCommand(city, CityCommandTypes.DESTROY, {PARAM_FLAGS=<directive>})
--   gated by CityManager.CanStartCommand with the same parameters; PARAM_FLAGS is read
--   off UnitOperationTypes in the native source.
-- ---------------------------------------------------------------------------
local CITY_FATE = {
  keep = 'KEEP', raze = 'RAZE',
  liberate_founder = 'LIBERATE_FOUNDER', liberate_previous_owner = 'LIBERATE_PREVIOUS_OWNER',
  reject = 'REJECT',
}
local CITY_FATE_ORDER = {'keep','raze','liberate_founder','liberate_previous_owner','reject'}

local function cityFateParameters(directiveName)
  local directive = CityDestroyDirectives and CityDestroyDirectives[directiveName]
  if directive == nil then return nil end
  local flags = UnitOperationTypes and UnitOperationTypes.PARAM_FLAGS
  if flags == nil then return nil end
  local parameters = {}
  parameters[flags] = directive
  return parameters
end

local function cityFateRecord(ctx, city, source, out)
  local owner, cid = city:GetOwner(), city:GetID()
  local options = A.array()
  for _, name in ipairs(CITY_FATE_ORDER) do
    local parameters = cityFateParameters(CITY_FATE[name])
    if parameters ~= nil then
      local legal = false
      local ok, value = pcall(function() return CityManager.CanStartCommand(city, CityCommandTypes.DESTROY, parameters) end)
      if ok and type(value) == 'boolean' then legal = value
      else A.unavailable('cityFate', 'CanStartCommand', ok and 'City legality unknown' or value) end
      if legal then options[#options+1] = {choice = name, directive = CITY_FATE[name], available = true} end
    end
  end
  if #options == 0 then return end
  out[#out+1] = {
    key = tostring(owner)..':'..tostring(cid),
    kind = 'city_fate', actionType = 'city_fate',
    operations = A.array{'keep','raze','liberate_founder','liberate_previous_owner','reject'},
    label = (source == 'rebelled' and 'Disloyal city offer: ' or 'Captured city: ')..tostring(A.loc(A.call('cityFate', city, 'GetName'))),
    mandatory = true,
    blocks = source == 'rebelled' and blocking(ctx, 'ENDTURN_BLOCKING_CONSIDER_DISLOYAL_CITY')
      or blocking(ctx, 'ENDTURN_BLOCKING_CONSIDER_RAZE_CITY'),
    source = source,
    cityId = entityId('city', owner, cid),
    population = A.call('cityFate', city, 'GetPopulation'),
    canRaze = A.call('cityFate', city, 'CanRaze'),
    originalOwner = A.call('cityFate', city, 'GetOriginalOwner'),
    ownerBeforeOccupation = A.call('cityFate', city, 'GetOwnerBeforeOccupation'),
    justConqueredFrom = A.call('cityFate', city, 'GetJustConqueredFrom'),
    options = options,
    choiceHelp = 'choice=keep|raze|liberate_founder|liberate_previous_owner|reject (only the listed options are legal)',
  }
end

local function cityFateDecisions(ctx, out)
  local cities = A.call('cityFate', ctx.player, 'GetCities')
  -- Guard: the player's city list can be absent; null must not reach GetNextCaptured/RebelledCity.
  if cities == A.null then return A.unavailable('cityFate', 'GetCities', 'City collection unavailable') end
  local captured = A.call('cityFate', cities, 'GetNextCapturedCity')
  -- Guard: a null next-captured city means nothing to adjudicate; the record builder needs a live city.
  if captured ~= nil and captured ~= A.null then
    local ok, err = pcall(cityFateRecord, ctx, captured, 'captured', out)
    if not ok then A.unavailable('cityFate', 'captured', err) end
  end
  local rebelled = A.call('cityFate', cities, 'GetNextRebelledCity')
  if rebelled ~= nil and rebelled ~= A.null then
    local ok, err = pcall(cityFateRecord, ctx, rebelled, 'rebelled', out)
    if not ok then A.unavailable('cityFate', 'rebelled', err) end
  end
end

local function cityFateSubmit(ctx, operation, cityIdValue)
  local directiveName = CITY_FATE[operation]
  assert(directiveName ~= nil, 'city_fate operation must be keep, raze, liberate_founder, liberate_previous_owner or reject')
  local owner, cid = parseCityId(cityIdValue)
  local city, mismatch = cityById('cityFate', ctx, owner, cid)
  if city == nil then
    return refused('stale', mismatch or ('City '..tostring(cid)..' is no longer observable; nothing was submitted'),
      {operation = operation, cityId = cityIdValue})
  end
  local parameters = cityFateParameters(directiveName)
  assert(parameters ~= nil, 'CityDestroyDirectives.'..directiveName..' or UnitOperationTypes.PARAM_FLAGS is unavailable in this ruleset')
  local legal = false
  local ok, value = pcall(function() return CityManager.CanStartCommand(city, CityCommandTypes.DESTROY, parameters) end)
  if ok then legal = value == true end
  if not legal then
    return refused('illegal', 'Engine CanStartCommand refused CityCommandTypes.DESTROY with directive '..directiveName,
      {cityId = cityIdValue, operation = operation})
  end
  return submit({{label = 'CITY DESTROY '..directiveName..' '..cityIdValue, run = function()
    return request(CityManager.RequestCommand, city, CityCommandTypes.DESTROY, parameters)
  end}})
end

-- ---------------------------------------------------------------------------
-- World Congress.
-- Native: DLC/Expansion2/UI/Additions/WorldCongressPopup.lua.
--   Stage: Game.GetCurrentTurnSegment() against DB.MakeHash('TURNSEG_WORLDCONGRESS_1'|'_2'|
--   '_RESOLUTION') (:21-23,78-92). 1 is the regular session, 2 the special session and the
--   resolution segment is the stage-4 results screen; all three clear
--   AllowStrategicCommands/AllowTacticalCommands (DLC/Expansion2/Data/Expansion2_TurnPhases.xml
--   :12-14), which is why a congress request must not be judged by the ordinary command gate.
--   In session the popup reads resolutions from GetResolutions(pid), discussions from
--   GetProposals(pid).Proposals and prices from GetVotesandFavorCost(pid) (:574-575,1179-1186).
--   OnAccept (:2222-2315) sends, per resolution with votes, WORLD_CONGRESS_RESOLUTION_VOTE with
--   PARAM_RESOLUTION_TYPE = the Resolutions row Hash, PARAM_WORLD_CONGRESS_VOTES = the total
--   positive votes, PARAM_RESOLUTION_OPTION = 1|2 and PARAM_RESOLUTION_SELECTION = the 1-based
--   PossibleTargets index minus one; per discussion WORLD_CONGRESS_DISCUSSION_VOTE with
--   PARAM_PLAYER_ONE/TWO and a SIGNED vote count; then WORLD_CONGRESS_SUBMIT_TURN and
--   ActionTypes.ACTION_ENDTURN. This module mirrors that exactly: operation="submit" sends the
--   votes it is given (if any), then WORLD_CONGRESS_SUBMIT_TURN and ACTION_ENDTURN, and it is the
--   only turn-ending request any decision family issues. No ballot, vote or turn end is inferred
--   from anything else, and operation="vote" never releases the session.
--   The popup also keeps its screen until its own ClosePopup runs UIManager:DequeuePopup(ContextPtr)
--   + Input.PopContext(), and out of session that close sends WORLD_CONGRESS_LOOKED_AT_AVAILABLE
--   (:2394-2408). Screen teardown belongs to the popup module; the look acknowledgement is a
--   player operation and is exposed explicitly as operation="looked".
--   Out of session (including the results segment) the available-proposals tab sends
--   WORLD_CONGRESS_DISCUSSION_SELECTION with PARAM_OTHER_PLAYER and PARAM_DISCUSSION_TYPE for each
--   selected proposal, at most one per target player (:1452-1490,2270-2295), after an explicit
--   favor-cost confirmation.
-- ---------------------------------------------------------------------------
local CONGRESS_SEGMENTS = {
  {hash = 'TURNSEG_WORLDCONGRESS_1', stage = 1},
  {hash = 'TURNSEG_WORLDCONGRESS_2', stage = 2},
  {hash = 'TURNSEG_WORLDCONGRESS_RESOLUTION', stage = 4},
}
--- 1 regular session, 2 special session, 4 results/review segment, 0 no congress segment, nil
--- when the segment cannot be decoded. nil is honest ignorance: no congress decision is emitted
--- rather than guessing the wrong stage.
local function congressSegment()
  local segment = A.static('congress', Game, 'GetCurrentTurnSegment')
  if type(segment) ~= 'number' then return nil end
  for _, entry in ipairs(CONGRESS_SEGMENTS) do
    local hash = A.static('congress', DB, 'MakeHash', entry.hash)
    -- Without the hash names this stage cannot be identified; do not fall through to "no segment".
    if type(hash) ~= 'number' then return nil end
    if segment == hash then return entry.stage end
  end
  return 0
end

local function congressStageLabel(stage)
  if stage == 1 then return 'regular_session' end
  if stage == 2 then return 'special_session' end
  if stage == 4 then return 'results' end
  if stage == 0 then return 'none' end
  return A.null
end

--- Native congress collections are keyed maps with a non-numeric "Stage" key; sort by the numeric
--- key so repeated reads are byte-stable and the stage entries that carry no resolution are last.
local function sortedValues(map)
  local list = {}
  if type(map) ~= 'table' then return list end
  for key, value in pairs(map) do
    if type(value) == 'table' then list[#list+1] = {key = key, value = value} end
  end
  table.sort(list, function(a, b)
    local an, bn = tonumber(a.key), tonumber(b.key)
    if an ~= nil and bn ~= nil then return an < bn end
    if an ~= nil then return true end
    if bn ~= nil then return false end
    return tostring(a.key) < tostring(b.key)
  end)
  local out = {}
  for _, entry in ipairs(list) do out[#out+1] = entry.value end
  return out
end

local function proposalKey(proposal)
  return tostring(proposal.TypeName)..'_'..tostring(proposal.Target)..'_'..tostring(proposal.Sender)
end

--- The proposal map is keyed by the ProposalTypes row; the popup sorts categories by
--- ProposalTypes.Sort and lists each category's ProposalsOfType (:1498-1518). The category and its
--- per-category favor cost are attached so a caller can price a proposal selection instead of
--- guessing, and so a disabled category entry cannot be mistaken for a votable discussion.
local function proposalValues(result)
  local out = {}
  if result == A.null or type(result) ~= 'table' or type(result.Proposals) ~= 'table' then
    A.unavailable('congress', 'proposals', 'Native proposal categories unavailable')
    return out
  end
  for key, category in pairs(result.Proposals) do
    local definition = A.row('ProposalTypes', key)
    if type(category) == 'table' and type(category.ProposalsOfType) == 'table' then
      local sort = definition ~= A.null and number(definition.Sort) or nil
      for _, proposal in pairs(category.ProposalsOfType) do
        if type(proposal) == 'table' and proposal.Type ~= nil and proposal.Target ~= nil then
          proposal.category = key
          proposal.categoryName = definition ~= A.null and A.loc(definition.Name) or A.null
          proposal.categorySort = sort or A.null
          proposal.categoryCost = number(category.FavorCost)
          out[#out+1] = proposal
        else
          A.unavailable('congress', 'proposal', 'Native proposal identity unavailable')
        end
      end
    else
      A.unavailable('congress', 'proposals', 'Native ProposalsOfType unavailable')
    end
  end
  table.sort(out, function(a, b)
    local as, bs = tonumber(a.categorySort), tonumber(b.categorySort)
    if as ~= nil and bs ~= nil and as ~= bs then return as < bs end
    return proposalKey(a) < proposalKey(b)
  end)
  return out
end

--- GetVotesandFavorCost returns the table the voting widgets index as `kCostData[votes - 1]` and
--- cap with `kCostData.MaxVotes` (:983-1006,1443-1478): each numeric entry is the total favor that
--- many votes cost, so the marginal price of the nth vote is the difference to the previous entry.
--- Decoded here so a caller sees prices instead of a raw engine table. An entry the native shape
--- does not explain stays unknown; a missing price never becomes zero.
local function favorCosts(costs)
  local cumulative, perVote = A.array(), A.array()
  if type(costs) ~= 'table' then
    A.unavailable('congress', 'GetVotesandFavorCost', 'Native favor cost table unavailable')
    return cumulative, perVote, nil
  end
  local count = 0
  while type(costs[count]) == 'number' do count = count + 1 end
  for index = 0, count - 1 do
    cumulative[index + 1] = costs[index]
    perVote[index + 1] = index == 0 and costs[0] or (costs[index] - costs[index - 1])
  end
  if count == 0 then A.unavailable('congress', 'GetVotesandFavorCost', 'Native favor cost table carried no vote prices') end
  return cumulative, perVote, number(costs.MaxVotes)
end

--- The native popup labels targets with GetVisiblePlayerName, which reports an unmet player as
--- "unmet player" instead of leaking the name (PlayerSupport.lua:39-92). Only a positively met
--- player's civilization name is returned; an unknown HasMet stays unknown rather than revealing
--- a name the player has not earned.
local function congressPlayerLabel(ctx, pid)
  if type(pid) ~= 'number' then return A.null end
  local function nameOf(config)
    local name = A.call('congress', config, 'GetCivilizationShortDescription')
    if type(name) ~= 'string' then name = A.call('congress', config, 'GetCivilizationTypeName') end
    return type(name) == 'string' and A.loc(name) or A.null
  end
  if pid == ctx.pid then
    local own = PlayerConfigurations and PlayerConfigurations[pid]
    return own and nameOf(own) or A.null
  end
  local diplomacy = A.call('congress', ctx.player, 'GetDiplomacy')
  local met = A.call('congress', diplomacy, 'HasMet', pid)
  if met ~= true then
    return met == false and A.loc('LOC_DIPLOPANEL_UNMET_PLAYER') or A.null
  end
  local config = PlayerConfigurations and PlayerConfigurations[pid]
  if config == nil then return A.null end
  return nameOf(config)
end

local function congressReady(ctx, stage)
  local capability = A.static('congress', GameCapabilities, 'HasCapability', 'CAPABILITY_WORLD_CONGRESS')
  if capability ~= true then
    if capability ~= false then A.unavailable('congress', 'readiness', 'World Congress capability unknown') end
    return false
  end
  -- Voting and the results segment are independent of ordinary era access.
  if stage == 1 or stage == 2 or stage == 4 then return true end
  if blocking(ctx, 'ENDTURN_BLOCKING_WORLD_CONGRESS_LOOK')
    or blocking(ctx, 'ENDTURN_BLOCKING_EMERGENCY_NEEDS_ATTENTION')
    or A.hasCongressNotification(ctx.pid) then return true end
  local era = number(A.call('congress', A.static('congress', Game, 'GetEras'), 'GetCurrentEra'))
  local initial = GlobalParameters and number(GlobalParameters.WORLD_CONGRESS_INITIAL_ERA)
  if era == nil or initial == nil then
    A.unavailable('congress', 'readiness', 'World Congress era readiness unknown')
    return false
  end
  return era >= initial
end

--- Fresh native facts about the presented congress screen, read after a submission. The screen
--- itself stays up until the popup module runs the native close; this only reports state.
local function congressObservation(ctx, congress)
  return A.section('observed', function()
    local stage = congressSegment()
    return {
      stage = stage or A.null,
      stageName = congressStageLabel(stage),
      inSession = A.call('congress', congress, 'IsInSession'),
      blockersKnown = ctx.blockersKnown,
      turnState = A.turnState(),
    }
  end)
end

--- A resolution option the native widget can actually vote: the row, both A/B effects, the 1-based
--- engine target list with the exact PARAM_RESOLUTION_SELECTION value for each entry, and whether
--- the engine reported any target at all (a resolution without targets cannot be voted).
local function resolutionOption(ctx, data)
  local row = A.row('Resolutions', data.Type)
  local targets = A.array()
  if type(data.PossibleTargets) == 'table' then
    for index, value in ipairs(data.PossibleTargets) do
      local playerId = data.TargetType == 'PlayerType' and tonumber(value) or nil
      targets[#targets+1] = {
        selection = index - 1,
        targetIndex = index,
        value = value,
        playerId = playerId or A.null,
        label = playerId ~= nil and congressPlayerLabel(ctx, playerId) or A.loc(value),
      }
    end
  end
  local favored, disfavored = A.array(), A.array()
  for _, pid in ipairs(type(data.FavoredPlayerIDs) == 'table' and data.FavoredPlayerIDs or {}) do
    favored[#favored+1] = congressPlayerLabel(ctx, tonumber(pid))
  end
  for _, pid in ipairs(type(data.DisfavoredPlayerIDs) == 'table' and data.DisfavoredPlayerIDs or {}) do
    disfavored[#disfavored+1] = congressPlayerLabel(ctx, tonumber(pid))
  end
  if data.TargetType == nil then
    A.unavailable('congress', 'resolutions', 'Resolution '..tostring(data.Type)..' reported no TargetType')
  end
  if row == A.null then
    A.unavailable('congress', 'resolutions', 'Resolution row unavailable for '..tostring(data.Type))
  end
  return {
    subject = 'resolution',
    resolution = row ~= A.null and row.ResolutionType or A.null,
    available = row ~= A.null and #targets > 0,
    label = row ~= A.null and A.loc(row.Name) or A.null,
    effect1 = row ~= A.null and A.loc(row.Effect1Description) or A.null,
    effect2 = row ~= A.null and A.loc(row.Effect2Description) or A.null,
    targetType = data.TargetType or A.null,
    targets = targets,
    favoredPlayers = favored,
    disfavoredPlayers = disfavored,
    reasons = #targets == 0
      and A.array{'The engine reported no possible targets for this resolution; the native resolution widget cannot be voted without one'}
      or A.null,
    choice = {subject='resolution', resolution = row ~= A.null and row.ResolutionType or A.null,
      option = 1, selection = 0, votes = 1},
  }
end

--- A discussion option. `votes` in the choice template is signed: positive supports the proposal,
--- negative opposes it, which is exactly what PARAM_WORLD_CONGRESS_VOTES carries (:2222-2262).
local function discussionOption(ctx, proposal)
  local blocker = proposal.VotingRestriction ~= nil and A.row('VotingBlockers', proposal.VotingRestriction) or A.null
  local noUpvote = blocker ~= A.null and blocker.NoUpvote == true
  local noDownvote = blocker ~= A.null and blocker.NoDownvote == true
  return {
    subject = 'discussion',
    available = proposal.Disabled ~= true and not (noUpvote and noDownvote),
    disabled = proposal.Disabled == true,
    label = A.loc(proposal.Name),
    description = A.loc(proposal.Description),
    category = proposal.categoryName or A.null,
    discussionType = proposal.TypeName,
    discussionTypeId = proposal.Type,
    sender = proposal.Sender,
    target = proposal.Target,
    senderName = congressPlayerLabel(ctx, proposal.Sender),
    targetName = congressPlayerLabel(ctx, proposal.Target),
    votingRestriction = proposal.VotingRestriction or A.null,
    noUpvote = noUpvote,
    noDownvote = noDownvote,
    restrictionNote = blocker ~= A.null and A.loc(blocker.Description) or A.null,
    proposalBlocker = proposal.ProposalBlockerType or A.null,
    choice = {subject='discussion', sender=proposal.Sender, target=proposal.Target, votes=1},
  }
end

--- In session: the votable ballot. Both stages vote discussions; only stage 1 has resolutions
--- (SetPhase only populates resolutions for stage 1, :248-276).
local function congressSession(ctx, out, congress, stage)
  local options = A.array()
  if stage == 1 then
    for _, data in ipairs(sortedValues(A.call('congress', congress, 'GetResolutions', ctx.pid))) do
      if data.Type ~= nil then options[#options+1] = resolutionOption(ctx, data) end
    end
  end
  for _, proposal in ipairs(proposalValues(A.call('congress', congress, 'GetProposals', ctx.pid))) do
    options[#options+1] = discussionOption(ctx, proposal)
  end
  local anyLegal = false
  for _, option in ipairs(options) do if option.available then anyLegal = true; break end end
  if not anyLegal then return end
  -- Guard: only touch GetVotesandFavorCost/GetFavor once a votable ballot exists.
  local cumulative, perVote, maxVotes = favorCosts(A.call('congress', congress, 'GetVotesandFavorCost', ctx.pid))
  local favor = number(A.call('congress', ctx.player, 'GetFavor'))
  out[#out+1] = {
    key = 'session:stage'..stage..':turn'..ctx.turn,
    kind = 'congress', actionType = 'congress', operation = 'vote',
    operations = A.array{'vote','submit'},
    label = 'World Congress '..(stage == 1 and 'regular session' or 'special session')..': cast votes',
    mandatory = true,
    blocks = blocking(ctx, 'ENDTURN_BLOCKING_WORLD_CONGRESS_SESSION'),
    stage = stage,
    stageName = congressStageLabel(stage),
    inSession = A.call('congress', congress, 'IsInSession'),
    favor = favor or A.null,
    maxVotes = maxVotes or A.null,
    favorCostByVotes = cumulative,
    favorCostPerVote = perVote,
    options = options,
    choiceHelp = 'choices=[{subject="resolution",resolution=<ResolutionType>,option=1|2,selection=<targets[].selection>,votes=<n>}, {subject="discussion",sender=<playerId>,target=<playerId>,votes=<signed n>}]. '
      ..'votes costs favor: favorCostByVotes[n] is the total price of n votes and favorCostPerVote[n] the price of the nth vote. '
      ..'Submit with civ.action(type="congress",operation="submit") - it sends the votes you pass, then WORLD_CONGRESS_SUBMIT_TURN and ACTION_ENDTURN exactly like the native Accept button; operation="vote" alone defers that release.',
  }
end

--- The native results/current-effects tabs: GetReview(pid) carries the last session's outcomes
--- (WorldCongressPopup.PopulateReview:1822-1900), each with the chosen option, the chosen target and
--- every player's votes. Read whenever the between-sessions popup is relevant so a stage-4 segment
--- never hides the results just because there is nothing to propose.
local function congressReview(ctx, out, congress, stage, status)
  local review = A.call('congress', congress, 'GetReview', ctx.pid)
  if review == A.null or type(review) ~= 'table' then
    return A.unavailable('congress', 'GetReview', 'World Congress review data unavailable')
  end
  local resolutions = A.array()
  for _, data in ipairs(sortedValues(review.Resolutions)) do
    if data.Type ~= nil then
      local row = A.row('Resolutions', data.Type)
      local forVotes, againstVotes = 0, 0
      if type(data.PlayerSelections) == 'table' then
        for _, selection in pairs(data.PlayerSelections) do
          if type(selection) == 'table' then
            local votes = number(selection.Votes) or 0
            if selection.OptionChosen == 1 then forVotes = forVotes + votes
            else againstVotes = againstVotes + votes end
          end
        end
      end
      resolutions[#resolutions+1] = {
        resolution = row ~= A.null and row.ResolutionType or A.null,
        label = row ~= A.null and A.loc(row.Name) or A.null,
        outcome = A.loc(data.ChosenOption),
        outcomeLabel = A.loc(data.ChosenLabel),
        targetType = data.TargetType or A.null,
        chosenThing = data.ChosenThing or A.null,
        chosenTarget = data.TargetType == 'PlayerType'
          and congressPlayerLabel(ctx, tonumber(data.ChosenThing)) or A.loc(data.ChosenThing),
        votesOption1 = forVotes,
        votesOption2 = againstVotes,
        tied = forVotes == againstVotes,
        isNew = data.IsNew == true,
      }
    end
  end
  out[#out+1] = {
    key = 'review:turn'..ctx.turn,
    kind = 'congress', actionType = 'congress', operation = 'review',
    operations = A.array(),
    label = 'World Congress results of the last session',
    mandatory = false, blocks = false,
    stage = stage,
    stageName = congressStageLabel(stage),
    inSession = A.call('congress', congress, 'IsInSession'),
    turnsToNextSession = type(status) == 'table' and status.TurnsLeft or A.null,
    resolutions = resolutions,
    options = A.array(),
    choiceHelp = 'Informational only: these outcomes are already decided and there is nothing to submit. Propose discussions with operation="proposal" or acknowledge the between-sessions reminder with operation="looked".',
  }
end

--- Out of session (including the results segment): emergency proposals for the next session.
local function congressProposals(ctx, out, congress, stage)
  local options = A.array()
  for _, proposal in ipairs(proposalValues(A.call('congress', congress, 'GetEmergencies', ctx.pid))) do
    if proposal.Disabled ~= true then
      options[#options+1] = {
        subject = 'discussion',
        available = true,
        label = A.loc(proposal.Name),
        description = A.loc(proposal.Description),
        category = proposal.categoryName or A.null,
        discussionType = proposal.TypeName,
        discussionTypeId = proposal.Type,
        target = proposal.Target,
        targetName = congressPlayerLabel(ctx, proposal.Target),
        favorCost = proposal.categoryCost,
        proposalBlocker = proposal.ProposalBlockerType or A.null,
        choice = {target = proposal.Target, discussionType = proposal.Type},
      }
    end
  end
  -- The results readback is what the between-sessions popup is for: the results segment, the
  -- "look at the congress" reminder, or a session that has something to propose. Outside those the
  -- review and its meeting status are not read at all.
  local resultsRelevant = stage == 4
    or blocking(ctx, 'ENDTURN_BLOCKING_WORLD_CONGRESS_LOOK')
    or #options > 0
  -- Guard: fetch session status once, then reuse it for the results readback.
  local status = resultsRelevant and A.call('congress', congress, 'GetMeetingStatus') or A.null
  if #options > 0 then
    local favor = A.call('congress', ctx.player, 'GetFavor')
    out[#out+1] = {
      key = 'proposals:turn'..ctx.turn,
      kind = 'congress', actionType = 'congress', operation = 'proposal',
      operations = A.array{'proposal','looked'},
      label = 'World Congress: propose discussions for the next session',
      mandatory = false,
      blocks = blocking(ctx, 'ENDTURN_BLOCKING_WORLD_CONGRESS_LOOK') or blocking(ctx, 'ENDTURN_BLOCKING_EMERGENCY_NEEDS_ATTENTION'),
      stage = stage,
      stageName = congressStageLabel(stage),
      inSession = A.call('congress', congress, 'IsInSession'),
      favor = favor,
      turnsToNextSession = type(status) == 'table' and status.TurnsLeft or A.null,
      options = options,
      choiceHelp = 'choices=[{target=<playerId>,discussionType=<engine discussion type from the option>}], at most one per target player, each spending its favorCost with no refund. '
        ..'operation="looked" sends the same WORLD_CONGRESS_LOOKED_AT_AVAILABLE request the native popup sends when it closes out of session; it votes and proposes nothing.',
    }
  end
  if resultsRelevant then congressReview(ctx, out, congress, stage, status) end
end

local function congressDecisions(ctx, out)
  local congress = A.static('congress', Game, 'GetWorldCongress')
  -- A missing congress object must not reach any session or emergency query.
  if congress == A.null then return A.unavailable('congress', 'GetWorldCongress', 'World Congress manager unavailable') end
  local stage = congressSegment()
  if stage == nil then
    A.unavailable('congress', 'stage', 'Game.GetCurrentTurnSegment / DB.MakeHash unavailable; congress stage is unknown and no congress decision is reported')
    return
  end
  if not congressReady(ctx, stage) then return end
  if stage == 1 or stage == 2 then
    congressSession(ctx, out, congress, stage)
  else
    congressProposals(ctx, out, congress, stage)
  end
end

--- Fresh revalidation of everything a vote request may target. Nothing here is trusted from the
--- record the caller read: the ballot, the target counts, the prices and the favor are re-read.
local function congressBallot(ctx, congress, stage)
  local resolutions, discussions = {}, {}
  if stage == 1 then
    for _, data in ipairs(sortedValues(A.call('congress', congress, 'GetResolutions', ctx.pid))) do
      if data.Type ~= nil then
        local row = A.row('Resolutions', data.Type)
        if row ~= A.null and row.ResolutionType ~= nil then
          local targets = 0
          if type(data.PossibleTargets) == 'table' then
            for _ in ipairs(data.PossibleTargets) do targets = targets + 1 end
          end
          resolutions[row.ResolutionType] = {hash = row.Hash, targets = targets}
        end
      end
    end
  end
  for _, proposal in ipairs(proposalValues(A.call('congress', congress, 'GetProposals', ctx.pid))) do
    discussions[tostring(proposal.Sender)..'>'..tostring(proposal.Target)] = proposal
  end
  local cumulative, perVote, maxVotes = favorCosts(A.call('congress', congress, 'GetVotesandFavorCost', ctx.pid))
  return {
    resolutions = resolutions,
    discussions = discussions,
    cumulative = cumulative,
    perVote = perVote,
    maxVotes = maxVotes,
    favor = number(A.call('congress', ctx.player, 'GetFavor')),
  }
end

--- Build the native vote requests for one submission. The native Accept sends exactly one request
--- per resolution and one per discussion (WorldCongressPopup.lua:2238-2262), so a duplicate entry
--- is refused rather than turned into a second native request. Returns the request items, the known
--- total favor cost (A.null when any price is undecodable) and a readback of what was submitted.
local function congressVoteItems(ctx, ballot, stage, votes)
  local items, ballotReadback, totalCost, priced = {}, A.array(), 0, true
  local seenResolution, seenDiscussion = {}, {}
  for _, vote in ipairs(votes) do
    assert(type(vote) == 'table', 'Each congress vote must be a table')
    local count = number(vote.votes)
    assert(count ~= nil and count % 1 == 0, 'Each congress vote needs an integer votes count')
    if vote.subject == 'discussion' then
      local sender, target = number(vote.sender), number(vote.target)
      assert(sender ~= nil and target ~= nil, 'A discussion vote needs sender and target player ids from the option')
      local discussionKey = tostring(sender)..'>'..tostring(target)
      assert(seenDiscussion[discussionKey] == nil,
        'That discussion appears twice in this submission; the native Accept sends one request per discussion')
      seenDiscussion[discussionKey] = true
      local proposal = ballot.discussions[discussionKey]
      assert(proposal ~= nil, 'That discussion is not on the current votable ballot: '..sender..'->'..target)
      assert(proposal.Disabled ~= true, 'That discussion is disabled on the current ballot and cannot be voted')
      local blocker = proposal.VotingRestriction ~= nil and A.row('VotingBlockers', proposal.VotingRestriction) or A.null
      if blocker ~= A.null then
        local note = tostring(A.loc(blocker.Description))
        assert(not (blocker.NoUpvote == true and blocker.NoDownvote == true),
          'That discussion cannot be voted in either direction: '..note)
        assert(not (blocker.NoUpvote == true and count > 0), 'That discussion accepts only votes against: '..note)
        assert(not (blocker.NoDownvote == true and count < 0), 'That discussion accepts only votes in favour: '..note)
      end
      assert(count ~= 0, 'A discussion vote needs a nonzero signed votes count: positive supports, negative opposes')
      if ballot.maxVotes ~= nil then
        assert(math.abs(count) <= ballot.maxVotes,
          'This session allows at most '..ballot.maxVotes..' vote(s) per proposal; '..math.abs(count)..' were given')
      end
      local cost = ballot.cumulative[math.abs(count)]
      if cost == nil then priced = false else totalCost = totalCost + cost end
      ballotReadback[#ballotReadback+1] = {subject='discussion', sender=sender, target=target, votes=count,
        favorCost = cost or A.null}
      items[#items+1] = {label = 'WORLD_CONGRESS_DISCUSSION_VOTE '..sender..'->'..target, run = function()
        local parameters = {}
        parameters[A.param(PlayerOperations, 'PARAM_PLAYER_ONE')] = sender
        parameters[A.param(PlayerOperations, 'PARAM_PLAYER_TWO')] = target
        parameters[A.param(PlayerOperations, 'PARAM_WORLD_CONGRESS_VOTES')] = count
        return playerOperation(ctx.pid, 'WORLD_CONGRESS_DISCUSSION_VOTE', parameters)
      end}
    else
      assert(vote.subject == nil or vote.subject == 'resolution', 'congress vote subject must be "resolution" or "discussion"')
      assert(stage == 1, 'Resolutions are only voted in the regular session; the special session has discussion votes only')
      assert(type(vote.resolution) == 'string', 'A resolution vote needs resolution=<ResolutionType>')
      local resolution = ballot.resolutions[vote.resolution]
      assert(resolution ~= nil, 'Resolution is not on this session ballot: '..vote.resolution)
      assert(seenResolution[vote.resolution] == nil,
        'Resolution '..vote.resolution..' appears twice in this submission; the native Accept sends one request per resolution')
      seenResolution[vote.resolution] = true
      local option = number(vote.option)
      assert(option == 1 or option == 2, 'A resolution vote needs option=1 or option=2')
      assert(count > 0, 'Resolution votes are positive; option 1 or 2 selects the side')
      assert(resolution.targets > 0, 'This resolution reported no possible targets; it cannot be voted')
      local selection = number(vote.selection)
      assert(selection ~= nil and selection % 1 == 0,
        'A resolution vote needs selection=<targets[].selection> from the decision record')
      assert(selection >= 0 and selection < resolution.targets,
        'Target '..selection..' is outside this resolution\'s '..resolution.targets..' possible target(s)')
      if ballot.maxVotes ~= nil then
        assert(count <= ballot.maxVotes,
          'This session allows at most '..ballot.maxVotes..' vote(s) per resolution; '..count..' were given')
      end
      local cost = ballot.cumulative[count]
      if cost == nil then priced = false else totalCost = totalCost + cost end
      ballotReadback[#ballotReadback+1] = {subject='resolution', resolution=vote.resolution, option=option,
        selection=selection, votes=count, favorCost = cost or A.null}
      items[#items+1] = {label = 'WORLD_CONGRESS_RESOLUTION_VOTE '..vote.resolution, run = function()
        local parameters = {}
        parameters[A.param(PlayerOperations, 'PARAM_RESOLUTION_TYPE')] = resolution.hash
        parameters[A.param(PlayerOperations, 'PARAM_WORLD_CONGRESS_VOTES')] = count
        parameters[A.param(PlayerOperations, 'PARAM_RESOLUTION_OPTION')] = option
        parameters[A.param(PlayerOperations, 'PARAM_RESOLUTION_SELECTION')] = selection
        return playerOperation(ctx.pid, 'WORLD_CONGRESS_RESOLUTION_VOTE', parameters)
      end}
    end
  end
  return items, priced and totalCost or A.null, ballotReadback
end

local function congressSubmit(ctx, operation, votes, proposals)
  local congress = A.static('congress', Game, 'GetWorldCongress')
  assert(congress ~= A.null, 'World Congress is not present in this ruleset')
  local stage = congressSegment()
  assert(stage ~= nil and congressReady(ctx, stage), 'World Congress is not ready')
  if operation == 'submit' then
    assert(stage == 1 or stage == 2, 'The World Congress is not currently in a voting stage')
    local items, ballot, cost, favorKnown = {}, nil, A.null, A.null
    -- The native Accept sends the votes and then the segment request, in that order
    -- (WorldCongressPopup.lua:2238-2262 then :2270-2271). Supplying votes here reproduces that
    -- whole sequence in one explicit call; omitting them means "my votes were already sent".
    if votes ~= nil then
      assert(type(votes) == 'table' and #votes > 0, 'congress submit votes must be a non-empty array when provided')
      local fresh = congressBallot(ctx, congress, stage)
      local voteItems, voteCost
      voteItems, voteCost, ballot = congressVoteItems(ctx, fresh, stage, votes)
      cost, favorKnown = voteCost, fresh.favor or A.null
      if cost ~= A.null and fresh.favor ~= nil and cost > fresh.favor then
        return refused('illegal', 'This ballot costs '..cost..' favor and only '..fresh.favor..' is available; nothing was submitted',
          {favor = fresh.favor, favorCost = cost})
      end
      for _, item in ipairs(voteItems) do items[#items+1] = item end
    end
    items[#items+1] = {label = 'WORLD_CONGRESS_SUBMIT_TURN', run = function()
      return playerOperation(ctx.pid, 'WORLD_CONGRESS_SUBMIT_TURN', {})
    end}
    -- Ending the turn is part of the native Accept, and the ordinary end_turn action cannot do it in
    -- this segment: all three congress segments clear AllowStrategicCommands and AllowTacticalCommands
    -- (Expansion2_TurnPhases.xml:12-14). Submitting the ballot is the explicit authorization, so this
    -- is the only request pair in the module that ends a turn and it never happens without 'submit'.
    items[#items+1] = {label = 'ACTION_ENDTURN', run = function()
      return request(UI.RequestAction, ActionTypes.ACTION_ENDTURN)
    end}
    local result = submit(items, 'Votes (when supplied), WORLD_CONGRESS_SUBMIT_TURN and ActionTypes.ACTION_ENDTURN were sent in that order, '
      ..'exactly the sequence the native Accept button performs. Submission is not completion: re-read civ.decisions/turnState before assuming the '
      ..'session advanced. The native congress screen is closed by the popup module, not by this request.')
    result.turnEnding = true
    result.sessionSubmitted = true
    result.ballot = ballot or A.array()
    result.favorCost = cost
    result.favor = favorKnown
    result.observed = congressObservation(ctx, congress)
    result.popup = 'popup:world-congress'
    -- The popup layer owns native teardown. After an explicit submit it closes the congress screen
    -- that matches this submitted session surface and reports the outcome in `popupClose` on this
    -- result (a failed teardown keeps the submitted result intact). This module only names the
    -- surface; an explicit civ.decide({id="popup:world-congress"}) remains for the case where the
    -- observation still reports the screen up.
    result.presentation = 'The ballot is submitted. The bridge closes the native congress screen that matches this submitted session and reports it in popupClose (this module never dismisses a screen); no screenshot or button click is needed. If the screen is still reported up, check civ.decisions({id="popup:world-congress"}) and close it with civ.decide({id="popup:world-congress"}).'
    return result
  elseif operation == 'looked' then
    assert(stage == 0 or stage == 4, 'The congress look acknowledgement belongs to the between-sessions screen, not a voting segment')
    local result = submit({{label = 'WORLD_CONGRESS_LOOKED_AT_AVAILABLE', run = function()
      return playerOperation(ctx.pid, 'WORLD_CONGRESS_LOOKED_AT_AVAILABLE', {})
    end}}, 'This is the request the native popup sends when it closes out of session (:2394-2408); it acknowledges the reminder and sends no vote and no proposal.')
    result.observed = congressObservation(ctx, congress)
    return result
  elseif operation == 'vote' then
    assert(type(votes) == 'table' and #votes > 0, 'congress vote needs votes=[{subject="resolution"|"discussion",...}]')
    assert(stage == 1 or stage == 2, 'The World Congress is not currently in a voting stage')
    local ballot = congressBallot(ctx, congress, stage)
    local items, cost, readback = congressVoteItems(ctx, ballot, stage, votes)
    -- The engine's own price table decides affordability, exactly as the native widget does
    -- (:983-1006). An undecodable price never refuses; a known overspend never reaches the engine.
    if cost ~= A.null and ballot.favor ~= nil and cost > ballot.favor then
      return refused('illegal', 'This ballot costs '..cost..' favor and only '..ballot.favor..' is available; nothing was submitted',
        {favor = ballot.favor, favorCost = cost})
    end
    local result = submit(items, 'Votes were submitted one native request at a time; requests[] and ballot[] report exactly which. '
      ..'The session is not released yet: civ.action(type="congress",operation="submit") sends WORLD_CONGRESS_SUBMIT_TURN and ACTION_ENDTURN like the native Accept, '
      ..'or pass the same votes to operation="submit" to vote and release the session in one call.')
    result.favor = ballot.favor or A.null
    result.favorCost = cost
    result.maxVotes = ballot.maxVotes or A.null
    result.ballot = readback
    return result
  elseif operation == 'proposal' then
    assert(stage == 0 or stage == 4, 'Emergency proposals cannot be selected during a voting segment')
    assert(type(proposals) == 'table' and #proposals > 0, 'congress proposal needs proposals=[{target=...,discussionType=...}]')
    local offered = {}
    for _, proposal in ipairs(proposalValues(A.call('congress', congress, 'GetEmergencies', ctx.pid))) do
      if proposal.Disabled ~= true then offered[tostring(proposal.Type)..'>'..tostring(proposal.Target)] = true end
    end
    local items, seenTarget = {}, {}
    for _, proposal in ipairs(proposals) do
      assert(type(proposal) == 'table', 'Each proposal must be a table')
      local target = number(proposal.target)
      assert(target ~= nil, 'Each proposal needs target=<playerId> from the option')
      assert(proposal.discussionType ~= nil, 'Each proposal needs discussionType from the option')
      local discussionType = proposal.discussionType
      assert(offered[tostring(discussionType)..'>'..tostring(target)] == true, 'Emergency proposal is not currently offered')
      -- The native proposals tab disables a second proposal for the same target (LOC_WORLD_
      -- CONGRESS_TT_MAX_ONE_PROPOSAL, :1393-1440); a duplicate selection is refused here instead.
      assert(seenTarget[target] == nil, 'The native screen allows at most one proposal per target player; target '..target..' was selected twice')
      seenTarget[target] = true
      items[#items+1] = {label = 'WORLD_CONGRESS_DISCUSSION_SELECTION target '..target, run = function()
        local parameters = {}
        parameters[A.param(PlayerOperations, 'PARAM_OTHER_PLAYER')] = target
        parameters[A.param(PlayerOperations, 'PARAM_DISCUSSION_TYPE')] = discussionType
        return playerOperation(ctx.pid, 'WORLD_CONGRESS_DISCUSSION_SELECTION', parameters)
      end}
    end
    local result = submit(items, 'Proposals spend favor with no refund. requests[] reports exactly which were submitted.')
    result.observed = congressObservation(ctx, congress)
    return result
  end
  error('congress operation must be vote, proposal, submit or looked')
end

-- ---------------------------------------------------------------------------
-- Espionage.
-- Native:
--   escape - Base/Assets/UI/Popups/EspionageEscape.lua: PlayerOperations.SET_ESCAPE_ROUTE
--     with PARAM_DISTRICT_TYPE = the Districts row *Index*; the spy is
--     player:GetDiplomacy():GetNextEscapingSpyID() and a route is offered only when the
--     spy's current city HasDistrict(index, true, true) (city centre is always offered).
--   mission - Base/Assets/UI/Choosers/EspionageChooser.lua + Popups/EspionagePopup.lua:
--     UnitOperations rows with CategoryInUI == "OFFENSIVESPY" (plus SPY_COUNTERSPY in an
--     own city), gated by UnitManager.CanStartOperation(spy, hash, cityPlot, false, true);
--     the request is UnitManager.RequestOperation(spy, hash) or, for a district-targeted
--     mission/counterspy, with PARAM_X/PARAM_Y of the target plot.
--   travel - UnitOperationTypes.SPY_TRAVEL_NEW_CITY with PARAM_X/PARAM_Y of the city.
-- ---------------------------------------------------------------------------
local ESCAPE_DISTRICTS = {'DISTRICT_AERODROME','DISTRICT_HARBOR','DISTRICT_COMMERCIAL_HUB','DISTRICT_CITY_CENTER'}

local function espionageEscapeDecision(ctx, out)
  -- Native GetNextEscapingSpyID dereferences the search result without checking for
  -- no escaping spy (GameCore_XP2 +0xB594A). It is not a safe availability probe.
  -- EspionageEscape.OnOpen is entered from the escape-choice notification; establish
  -- that pending choice through the native blocker list before touching the getter.
  if not ctx.blockersKnown then
    return A.unavailable('espionage', 'escapeReadiness', 'Escape-choice readiness unknown; escaping-spy lookup deferred')
  end
  if not blocking(ctx, 'ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE') then return end
  local diplomacy = A.call('espionage', ctx.player, 'GetDiplomacy')
  -- Guard: the player's Diplomacy manager can be absent; null must not reach GetNextEscapingSpyID.
  if diplomacy == A.null then return A.unavailable('espionage', 'GetDiplomacy', 'Diplomacy manager unavailable') end
  local spyId = number(A.call('espionage', diplomacy, 'GetNextEscapingSpyID'))
  if spyId == nil or spyId < 0 then return end
  local units = A.call('espionage', ctx.player, 'GetUnits')
  -- A missing unit collection or stale spy id must not reach the city lookup.
  if units == A.null then return A.unavailable('espionage', 'GetUnits', 'Unit collection unavailable') end
  local spy = exactIdentity('espionage', 'unit', ctx.pid, spyId, A.call('espionage', units, 'FindID', spyId))
  -- The escaping-spy getter and the unit collection are read at different moments; a slot reused in
  -- between must not turn into an escape route for a different unit.
  if spy == nil then return A.unavailable('espionage', 'FindID', 'Escaping spy lookup did not return the requested unit') end
  local city = A.static('espionage', Cities, 'GetPlotPurchaseCity', spy:GetX(), spy:GetY())
  -- District methods require a live city collection; city-centre escape remains available without it.
  local districts = city ~= A.null and A.call('espionage', city, 'GetDistricts') or A.null
  if city ~= A.null and districts == A.null then A.unavailable('espionage', 'GetDistricts', 'Escape city districts unavailable') end
  local options = A.array()
  for _, districtType in ipairs(ESCAPE_DISTRICTS) do
    local row = GameInfo.Districts and GameInfo.Districts[districtType]
    if row then
      local present = districtType == 'DISTRICT_CITY_CENTER'
      if not present and districts ~= A.null then
        present = A.call('espionage', districts, 'HasDistrict', row.Index, true, true) == true
      end
      options[#options+1] = {choice = districtType, available = present, label = A.loc(row.Name),
        travelTime = row.TravelTime}
    end
  end
  if #options == 0 then return end
  out[#out+1] = {
    key = 'escape:'..spyId,
    kind = 'espionage', actionType = 'espionage', operation = 'escape',
    operations = A.array{'escape'},
    label = 'Choose an escape route for '..tostring(A.loc(A.call('espionage', spy, 'GetName'))),
    mandatory = true,
    blocks = blocking(ctx, 'ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE'),
    unitId = entityId('unit', ctx.pid, spyId),
    cityId = (city ~= nil and city ~= A.null) and entityId('city', city:GetOwner(), city:GetID()) or A.null,
    loot = A.loc(A.call('espionage', spy, 'GetLootName')),
    pursuedBy = A.call('espionage', spy, 'GetPursuingSpyName'),
    options = options,
    choiceHelp = 'choice=<DistrictType> from the options; unavailable districts are absent from the spy\'s city.',
  }
end

local function spyMissionOptions(ctx, spy, city)
  local options = A.array()
  if GameInfo.UnitOperations == nil then return options end
  local plot = A.static('espionage', Map, 'GetPlot', city:GetX(), city:GetY())
  -- Never pass a missing target plot into native operation legality.
  if plot == A.null then A.unavailable('espionage', 'GetPlot', 'Spy mission city plot unavailable'); return options end
  local own = city:GetOwner() == ctx.pid
  for row in GameInfo.UnitOperations() do
    local relevant = (own and row.OperationType == 'UNITOPERATION_SPY_COUNTERSPY')
      or ((not own) and row.CategoryInUI == 'OFFENSIVESPY')
    if relevant then
      local can, results = false, nil
      local ok, a, b = pcall(function() return UnitManager.CanStartOperation(spy, row.Hash, plot, false, true) end)
      if ok and type(a) == 'boolean' then can, results = a, b
      else A.unavailable('espionage', 'CanStartOperation', ok and 'Spy mission legality unknown' or a) end
      local decoded = A.results(UnitOperationResults, results)
      local short = A.shortName(row.OperationType, 'UNITOPERATION_')
      local targets = decoded.plots
      if can and type(targets) == 'table' and #targets > 0 then
        for _, xy in ipairs(targets) do
          options[#options+1] = {choice = short..'@'..xy[1]..','..xy[2], available = true,
            operation = short, x = xy[1], y = xy[2], label = A.loc(row.Description)}
        end
      else
        options[#options+1] = {choice = short, available = can, operation = short,
          label = A.loc(row.Description), reasons = decoded.reasons or A.null}
      end
    end
  end
  return options
end

local function espionageMissionDecisions(ctx, out)
  local units = A.call('espionage', ctx.player, 'GetUnits')
  -- Do not walk a missing unit collection.
  if units == A.null then return A.unavailable('espionage', 'GetUnits', 'Unit collection unavailable') end
  local ok = pcall(function()
    for _, unit in units:Members() do
      local row = A.row('Units', A.call('espionage', unit, 'GetUnitType'))
      if row ~= A.null and row.Spy == true then
        local current = A.call('espionage', unit, 'GetSpyOperation')
        local idle = type(current) == 'number' and current < 0
        if current == A.null then A.unavailable('espionage', 'GetSpyOperation', 'Spy operation state unknown') end
        local ready = knownBoolean('espionage', unit, 'IsReadyToMove')
        local activity = A.static('espionage', UnitManager, 'GetActivityType', unit)
        if idle and ready == true and ActivityTypes ~= nil and activity == ActivityTypes.ACTIVITY_AWAKE then
          local city = A.static('espionage', Cities, 'GetPlotPurchaseCity', unit:GetX(), unit:GetY())
          if city ~= nil and city ~= A.null then
            local options = spyMissionOptions(ctx, unit, city)
            local anyLegal = false
            for _, option in ipairs(options) do if option.available then anyLegal = true; break end end
            if anyLegal then
              out[#out+1] = {
                key = 'mission:'..unit:GetID(),
                kind = 'espionage', actionType = 'espionage', operation = 'mission',
                operations = A.array{'mission','travel'},
                label = 'Spy '..tostring(A.loc(A.call('espionage', unit, 'GetName')))..' is idle in '
                  ..tostring(A.loc(A.call('espionage', city, 'GetName'))),
                mandatory = false,
                blocks = false,
                unitId = entityId('unit', ctx.pid, unit:GetID()),
                cityId = entityId('city', city:GetOwner(), city:GetID()),
                options = options,
                choiceHelp = 'choice=<OPERATION> or <OPERATION>@x,y when the option names a target district. operation="travel" with cityId moves the spy instead.',
              }
            end
          end
        end
      end
    end
  end)
  if not ok then A.unavailable('espionage', 'missions', 'Own unit walk failed; spy mission discovery is incomplete') end
end

local function espionageDecisions(ctx, out)
  espionageEscapeDecision(ctx, out)
  espionageMissionDecisions(ctx, out)
end

local function espionageSubmit(ctx, operation, unitIdValue, districtType, operationType, x, y, cityIdValue)
  local spy = A.ownedEntity('unit', unitIdValue, ctx.pid)
  if operation == 'escape' then
    assert(ctx.blockersKnown and blocking(ctx, 'ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE'),
      'No escape-route choice is known to be pending; reobserve decisions')
    assert(type(districtType) == 'string', 'espionage escape needs district=<DistrictType>')
    local row = GameInfo.Districts and GameInfo.Districts[districtType]
    assert(row, 'Unknown DistrictType: '..tostring(districtType))
    local parameters = {}
    parameters[A.param(PlayerOperations, 'PARAM_DISTRICT_TYPE')] = row.Index
    return submit({{label = 'SET_ESCAPE_ROUTE '..districtType, run = function()
      return playerOperation(ctx.pid, 'SET_ESCAPE_ROUTE', parameters)
    end}})
  elseif operation == 'mission' or operation == 'travel' then
    local name = operationType
    local parameters = {}
    if operation == 'travel' then
      name = 'SPY_TRAVEL_NEW_CITY'
      if cityIdValue ~= nil then
        local owner, cid = parseCityId(cityIdValue)
        local city, mismatch = cityById('espionage', ctx, owner, cid)
        if city == nil then
          return refused('stale', mismatch or ('Destination city '..tostring(cid)..' is not observable; nothing was submitted'),
            {operation = operation, cityId = cityIdValue})
        end
        x, y = city:GetX(), city:GetY()
      end
      assert(number(x) ~= nil and number(y) ~= nil, 'espionage travel needs cityId or x/y of the destination city')
    end
    assert(type(name) == 'string', 'espionage mission needs operationType=<spy UnitOperation short name>')
    local row = A.unitOperationRow(name)
    assert(row, 'Unknown spy unit operation: '..name)
    assert(row.CategoryInUI == 'OFFENSIVESPY' or row.OperationType == 'UNITOPERATION_SPY_COUNTERSPY'
      or row.OperationType == 'UNITOPERATION_SPY_TRAVEL_NEW_CITY',
      name..' is not an espionage operation; use civ.action(type="unit_operation") for ordinary unit orders')
    -- Native EspionageChooser tests legality against the target CITY plot even when the
    -- accepted request carries no plot parameters, so cityId here is a legality plot only.
    local plot
    if number(x) ~= nil and number(y) ~= nil then
      parameters[A.param(UnitOperationTypes, 'PARAM_X')] = x
      parameters[A.param(UnitOperationTypes, 'PARAM_Y')] = y
      plot = Map.GetPlot(x, y)
    elseif operation == 'mission' and cityIdValue ~= nil then
      local owner, cid = parseCityId(cityIdValue)
      local city, mismatch = cityById('espionage', ctx, owner, cid)
      if city == nil then
        return refused('stale', mismatch or ('Mission city '..tostring(cid)..' is not observable; nothing was submitted'),
          {operation = operation, cityId = cityIdValue})
      end
      plot = Map.GetPlot(city:GetX(), city:GetY())
    else
      plot = Map.GetPlot(spy:GetX(), spy:GetY())
    end
    local can, results = false, nil
    local ok, a, b = pcall(function() return UnitManager.CanStartOperation(spy, row.Hash, plot, false, true) end)
    if ok then can, results = a == true, b end
    if not can then
      local decoded = A.results(UnitOperationResults, results)
      return refused('illegal', 'Engine CanStartOperation refused '..name, {details = decoded.reasons or A.null, operation = name})
    end
    return submit({{label = name, run = function()
      return request(UnitManager.RequestOperation, spy, row.Hash, parameters)
    end}})
  end
  error('espionage operation must be mission, escape or travel')
end

-- ---------------------------------------------------------------------------
-- Diplomacy sessions moved to lua/diplomacy.lua. The collector, the dispatcher and the action
-- schema are resolved from A.diplomacyDecisions / A.diplomacyAction / A.diplomacyActionSpec at
-- call time (see COLLECTORS and dispatch below), so this file keeps the decision ids, the
-- pagination and the revalidation contract while the module owns the native session and deal
-- encodings. The shared submission helpers it uses are A.decisionRequest / A.decisionSubmit /
-- A.decisionRefused, exported above.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Envoys (influence tokens).
-- Native: Base/Assets/UI/PartialScreens/CityStates.lua. Sending is one native request per token
-- (OnConfirmPlacement, CityStates.lua:749-765):
--   parameters[PlayerOperations.PARAM_PLAYER_ONE] = cityStatePlayerID
--   UI.RequestPlayerOperation(localPlayer, PlayerOperations.GIVE_INFLUENCE_TOKEN, parameters)
-- Availability is read from the local player's Influence object, not guessed: GetTokensToGive() is
-- how many tokens may still be given (TopPanel.lua:245), CanGiveInfluence() gates giving at all, and
-- CanGiveTokensToPlayer(cityState) is the exact predicate the screen uses to enable a city-state's
-- envoy buttons (CityStates.lua:1499). Closing the native screen also records that the reminder was
-- considered: localPlayer:GetInfluence():SetGivingTokensConsidered(true) (CityStates.lua:446-455).
-- ---------------------------------------------------------------------------
local function envoyInfluence(ctx)
  local influence = A.call('envoy', ctx.player, 'GetInfluence')
  if influence == A.null then
    A.unavailable('envoy', 'GetInfluence', 'The local player Influence manager is unavailable')
    return nil
  end
  return influence
end

--- City-state candidates, read from PlayerManager.GetAliveMinors(), which returns player objects
--- (ReportScreen.lua:463 calls pMinorPlayer:GetInfluence() on each entry).
local function envoyCandidates(ctx, influence)
  local minors = A.static('envoy', PlayerManager, 'GetAliveMinors')
  if type(minors) ~= 'table' then
    A.unavailable('envoy', 'GetAliveMinors', 'Alive minor players are unavailable')
    return nil
  end
  local options = A.array()
  for _, minor in ipairs(minors) do
    local other = number(A.call('envoy', minor, 'GetID'))
    if other ~= nil and other ~= ctx.pid then
      local config = PlayerConfigurations and PlayerConfigurations[other]
      local legal = A.call('envoy', influence, 'CanGiveTokensToPlayer', other)
      local tokens = number(A.call('envoy', influence, 'GetTokensReceived', other))
      local name = config and A.call('envoy', config, 'GetCivilizationShortDescription') or A.null
      options[#options+1] = {
        choice = tostring(other),
        playerId = other,
        available = legal == true,
        label = type(name) == 'string' and A.loc(name) or ('city-state player '..other),
        tokensReceived = tokens or A.null,
        reasons = legal == A.null and A.array{'The engine did not answer CanGiveTokensToPlayer for this city-state'} or A.null,
      }
    end
  end
  return options
end

local function envoyDecisions(ctx, out)
  local influence = envoyInfluence(ctx)
  if influence == nil then return end
  local available = number(A.call('envoy', influence, 'GetTokensToGive'))
  if available == nil then
    A.unavailable('envoy', 'GetTokensToGive', 'Unassigned envoy count unavailable; envoy state is unknown')
    return
  end
  local canGive = A.call('envoy', influence, 'CanGiveInfluence')
  local reminder = blocking(ctx, 'ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN')
  -- The end-turn reminder can outlive the tokens (it is gated on the player having considered it),
  -- so the decision is reported whenever either the engine blocks or a token is really available.
  if available < 1 and not reminder then return end
  local options = envoyCandidates(ctx, influence)
  if options == nil then return end
  local label
  if available < 1 then label = 'Envoy reminder: no unassigned envoy tokens'
  elseif canGive ~= true then label = 'Envoy tokens are available but the engine currently disallows giving them'
  else label = 'Send '..available..' unassigned envoy(s) to a city-state' end
  out[#out+1] = {
    key = 'tokens:turn'..ctx.turn,
    kind = 'envoy', actionType = 'envoy', operation = 'send',
    operations = A.array{'send','consider'},
    label = label,
    mandatory = true,
    blocks = reminder,
    tokensToGive = available,
    canGiveInfluence = canGive,
    options = options,
    choiceHelp = 'choice=<city-state player id from the options>; civ.action(type="envoy",operation="send",target=<playerId>,count=<n>) sends that many tokens as one native request each. '..
      'operation="consider" records the same "reminder considered" flag the native City-States screen sets when it closes; it sends nothing.',
  }
end

local function envoySubmit(ctx, operation, target, count)
  local influence = envoyInfluence(ctx)
  assert(influence ~= A.null, 'The local player Influence manager is unavailable; envoy state is unknown')
  if operation == 'consider' then
    assert(target == nil and count == nil, 'envoy operation "consider" takes no target or count')
    local result = submit({{label = 'SetGivingTokensConsidered true', run = function()
      return request(influence.SetGivingTokensConsidered, influence, true)
    end}}, 'Recorded the envoy-reminder flag the native City-States screen sets when it closes (CityStates.lua:446-455). '..
      'No token was sent and no city-state influence changed. Reobserve turnState.blockers: whether the engine\'s end-turn '..
      'blocker is gated on this flag is not verifiable from Lua.')
    result.observed = A.section('observed', function()
      return {tokensToGive = number(A.call('envoy', influence, 'GetTokensToGive')) or A.null,
        considered = A.call('envoy', influence, 'IsGivingTokensConsidered')}
    end)
    return result
  end
  assert(operation == 'send', 'envoy operation must be send or consider')
  local wanted = count == nil and 1 or count
  assert(type(wanted) == 'number' and wanted % 1 == 0 and wanted >= 1, 'envoy count must be an integer >= 1')
  local cityState = number(target)
  assert(cityState ~= nil and cityState >= 0 and cityState % 1 == 0, 'envoy send needs target=<city-state player id from civ.decisions>')
  local available = number(A.call('envoy', influence, 'GetTokensToGive'))
  assert(available ~= nil, 'Unassigned envoy count unavailable; refusing to submit an unknown number of tokens')
  assert(wanted <= available, 'Only '..available..' unassigned envoy(s) remain; the request was not submitted')
  local legal = A.call('envoy', influence, 'CanGiveTokensToPlayer', cityState)
  if legal ~= true then
    return refused('illegal', 'The engine does not allow sending an envoy to player '..cityState..' right now',
      {target = cityState, canGiveTokensToPlayer = legal})
  end
  local operationId = A.param(PlayerOperations, 'GIVE_INFLUENCE_TOKEN')
  local paramOne = A.param(PlayerOperations, 'PARAM_PLAYER_ONE')
  local items = {}
  for index = 1, wanted do
    items[#items+1] = {label = 'GIVE_INFLUENCE_TOKEN '..index..'/'..wanted..' -> player '..cityState, run = function()
      local parameters = {}
      parameters[paramOne] = cityState
      return request(UI.RequestPlayerOperation, ctx.pid, operationId, parameters)
    end}
  end
  local result = submit(items, 'Each envoy is one native GIVE_INFLUENCE_TOKEN request (CityStates.lua:749-765); requests[] reports which were submitted. '..
    'Submission is not completion and nothing is replayed: re-read the city-state before assuming the envoy arrived.')
  result.observed = A.section('observed', function()
    return {tokensToGive = number(A.call('envoy', influence, 'GetTokensToGive')) or A.null,
      tokensReceived = number(A.call('envoy', influence, 'GetTokensReceived', cityState)) or A.null}
  end)
  return result
end

-- ---------------------------------------------------------------------------
-- End-turn blockers handled by other modules. These are reported, never re-implemented:
-- the record names the real action type and the real discovery call so the model does not
-- get a second, divergent path to research, civics, production, policies or unit orders.
-- ---------------------------------------------------------------------------
local BLOCKER_HANDLERS = {
  ENDTURN_BLOCKING_RESEARCH        = {subject='research',    actionType='research',  options='civ.options(operation="research")'},
  ENDTURN_BLOCKING_CIVIC           = {subject='civic',       actionType='civic',     options='civ.options(operation="civic")'},
  ENDTURN_BLOCKING_PRODUCTION      = {subject='production',  actionType='production', options='civ.options(cityId=...)'},
  ENDTURN_BLOCKING_FILL_CIVIC_SLOT = {subject='policies',    actionType='policies',  options='civ.options(operation="policies")'},
  ENDTURN_BLOCKING_CONSIDER_GOVERNMENT_CHANGE = {subject='government', actionType='government', options='civ.options(operation="government")'},
  ENDTURN_BLOCKING_UNITS           = {subject='unit_orders', actionType='unit_operation', options='civ.options(unitId=...)'},
  ENDTURN_BLOCKING_UNIT_NEEDS_ORDERS = {subject='unit_orders', actionType='unit_operation', options='civ.options(unitId=...)'},
  ENDTURN_BLOCKING_STACKED_UNITS   = {subject='unit_orders', actionType='unit_operation', options='civ.options(unitId=...)'},
  ENDTURN_BLOCKING_ARTIFACT        = {subject='artifact',    actionType='unit_operation', options='civ.options(unitId=...)',
    note='Archaeologist artifact choice runs through the unit EXCAVATE operation.'},
  ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN = {subject='envoy', actionType='envoy', options='civ.decisions(kind="envoy")',
    note='Envoy assignment is PlayerOperations.GIVE_INFLUENCE_TOKEN, one request per token (CityStates.lua:749-765). '..
      'civ.action(type="envoy",operation="send",target=<cityState player id>) sends tokens; operation="consider" records the '..
      'same reminder flag the native City-States screen sets when it closes.'},
  ENDTURN_BLOCKING_CLAIM_GREAT_PERSON = {subject='great_person', actionType='great_person', options='civ.decisions(kind="great_person")',
    note='The claim itself is PlayerOperations.RECRUIT_GREAT_PERSON / REJECT_GREAT_PERSON / PATRONIZE_GREAT_PERSON through civ.decide or '..
      'civ.action(type="great_person",...). Activating the claimed unit afterwards is civ.action(type="unit_command", unitId=..., command="ACTIVATE_GREAT_PERSON").'},
  ENDTURN_BLOCKING_WORLD_CONGRESS_SESSION = {subject='congress', actionType='congress', options='civ.decisions(kind="congress")',
    note='Vote and release in one explicit call: civ.action(type="congress",operation="submit",votes=[...]) sends the votes, then WORLD_CONGRESS_SUBMIT_TURN and ACTION_ENDTURN like the native Accept. '..
      'operation="vote" alone casts without releasing. Both command flags are cleared in this segment, so A.decisionReady only allows the congress family.'},
  ENDTURN_BLOCKING_WORLD_CONGRESS_LOOK = {subject='congress_available_proposals', actionType='congress', options='civ.decisions(kind="congress")',
    note='Between sessions this is the "look at the World Congress" reminder. Propose with operation="proposal", or acknowledge it with '..
      'operation="looked" (the request the native popup sends when it closes out of session, WorldCongressPopup.lua:2394-2408).'},
  ENDTURN_BLOCKING_EMERGENCY_NEEDS_ATTENTION = {subject='congress_emergency', actionType='congress', options='civ.decisions(kind="congress")',
    note='Emergency proposals are selected with civ.action(type="congress",operation="proposal",proposals=[{target=...,discussionType=...}]).'},
  ENDTURN_BLOCKING_SPY_CHOOSE_DRAGNET_PRIORITY = {subject='spy_dragnet', actionType=nil,
    note='Counterspy dragnet priority has no verified bridge handler; use the native Espionage screen.'},
}

local function blockerDecisions(ctx, out)
  -- No native calls here: ctx.blockers was decoded in context() through an A.static-guarded read.
  local names = {}
  for name in pairs(ctx.blockers) do names[#names+1] = name end
  table.sort(names)
  for _, name in ipairs(names) do
    local handler = BLOCKER_HANDLERS[name]
    if handler then
      out[#out+1] = {
        key = name,
        kind = 'blocker', actionType = handler.actionType or A.null,
        operations = A.array(),
        label = 'End-turn blocker: '..handler.subject,
        mandatory = true, blocks = true,
        subject = handler.subject,
        blockerType = name,
        handledHere = false,
        handler = handler.actionType ~= nil
          and ('civ.action(type="'..handler.actionType..'", ...)')
          or 'native GUI only',
        discovery = handler.options or A.null,
        note = handler.note or A.null,
        options = A.array(),
        choiceHelp = 'civ.decide does not answer this blocker; it is owned by the action/options modules named in handler.',
      }
    end
  end
end

-- ---------------------------------------------------------------------------
-- Collection, paging and the public read surface.
-- ---------------------------------------------------------------------------
--- The diplomacy collector lives in lua/diplomacy.lua and is resolved at call time, so a bridge
--- that loads this file without that module reports a missing module instead of losing the family
--- or crashing mid-observation. The kind stays in KINDS because it is still pageable and filterable.
local function diplomacyCollector(ctx, out)
  local fn = A.diplomacyDecisions
  if type(fn) ~= 'function' then
    return A.unavailable('diplomacy', 'module', 'lua/diplomacy.lua is not loaded in this bridge')
  end
  return fn(ctx, out)
end

local COLLECTORS = {
  commemoration = commemorationDecisions,
  pantheon = pantheonDecisions,
  great_person = greatPeopleDecisions,
  governor = governorDecisions,
  religion = religionDecisions,
  city_fate = cityFateDecisions,
  congress = congressDecisions,
  espionage = espionageDecisions,
  diplomacy = diplomacyCollector,
  envoy = envoyDecisions,
  blocker = blockerDecisions,
}

local function collect(ctx, kind)
  local out = {}
  for _, name in ipairs(KINDS) do
    if kind == nil or kind == name then
      local collector = COLLECTORS[name]
      local ok, err = pcall(collector, ctx, out)
      if not ok then A.unavailable('decisions', name, err) end
    end
  end
  local decisions = A.array()
  for _, record in ipairs(out) do
    record.id = decisionId(record.kind, record.key)
    record.key = nil
    decisions[#decisions+1] = record
  end
  return decisions
end

--- Default output is deliberately compact: identity, whether it blocks, a short label and
--- how many options exist. Descriptions, costs and full option lists arrive with
--- detail='full' or a specific id. Nothing is silently truncated; total/offset/more say so.
local SUMMARY_KEEP = {
  id=true, kind=true, actionType=true, operation=true, operations=true, label=true,
  mandatory=true, blocks=true, uiBlocking=true, selectCount=true, subject=true,
  blockerType=true, handler=true, discovery=true, handledHere=true, unitId=true,
  cityId=true, sessionId=true, otherPlayerId=true, governor=true, individual=true, stage=true, stageName=true,
  source=true, favor=true, favorCost=true, tokensToGive=true, canGiveInfluence=true,
}
local function summarise(record)
  local out = {}
  for key, value in pairs(record) do if SUMMARY_KEEP[key] then out[key] = value end end
  local options = record.options
  out.optionCount = type(options) == 'table' and #options or 0
  local legal, known = 0, true
  if type(options) == 'table' then
    for _, option in ipairs(options) do
      if option.available == true then legal = legal + 1
      elseif option.available ~= false then known = false end
    end
  end
  out.availableOptionCount = known and legal or A.null
  return out
end

function A.decisions(args)
  args = args or {}
  local detail = args.detail or 'summary'
  assert(detail == 'summary' or detail == 'full', 'detail must be "summary" or "full"')
  assert(args.kind == nil or (type(args.kind) == 'string' and KIND_SET[args.kind]),
    'Unknown decision kind. Valid kinds: '..KIND_HELP)
  local limit = args.limit or 50
  local offset = args.offset or 0
  assert(type(limit) == 'number' and limit % 1 == 0 and limit >= 1 and limit <= 500, 'limit must be 1..500')
  assert(type(offset) == 'number' and offset % 1 == 0 and offset >= 0, 'offset must be a nonnegative integer')
  local wanted, kindFilter = nil, args.kind
  if type(args.id) == 'string' then
    local session, kind = args.id:match('^([^:]+):decision:([^:]+):')
    assert(session == A.session, 'Decision id is from another loaded game instance; call civ.decisions again')
    assert(KIND_SET[kind], 'Unknown decision kind in id. Valid kinds: '..KIND_HELP)
    wanted, detail, kindFilter = args.id, 'full', kind
  end
  local ctx = context()
  ctx.wanted = wanted
  local all = collect(ctx, kindFilter)
  local matched = A.array()
  for _, record in ipairs(all) do
    if wanted == nil or record.id == wanted then matched[#matched+1] = record end
  end
  local decisions = A.array()
  for index = offset + 1, math.min(#matched, offset + limit) do
    local record = matched[index]
    if detail == 'full' then
      -- choiceHelp is contract, not state: identical for every record of a kind and unchanged
      -- between calls. It is worth its length when the model asked about one decision, and it was
      -- costing a multiple of itself on every list. civ.probe publishes the per-kind schema.
      --
      -- An opening catalog is ruleset data too. Its labels, statements and war types are the same
      -- for every counterpart, so a list of seven met players was carrying seven copies of one
      -- table; only the keys differ per player. Asking about one openings record (id=...) returns
      -- the full entries together with this pair's legality, which is where both are worth paying for.
      if wanted == nil then
        local copy = {}
        for key, value in pairs(record) do if key ~= 'choiceHelp' then copy[key] = value end end
        if copy.operation == 'open' and type(copy.options) == 'table' then
          local keys = A.array()
          for _, option in ipairs(copy.options) do keys[#keys+1] = option.choice end
          copy.options, copy.choices = nil, keys
        end
        record = copy
      end
      decisions[#decisions+1] = record
    else
      decisions[#decisions+1] = summarise(record)
    end
  end
  return {
    decisions = decisions,
    total = #matched,
    offset = offset,
    more = offset + #decisions < #matched,
    detail = detail,
    kinds = kindNames(),
    kind = kindFilter or A.null,
    turn = ctx.turn,
    blockersKnown = ctx.blockersKnown,
    turnState = ctx.turnState,
  }
end

-- ---------------------------------------------------------------------------
-- Answering. civ.decide re-collects the decision from live native state before
-- submitting, so a choice read one round trip ago is revalidated, not trusted.
-- ---------------------------------------------------------------------------
local function dispatch(ctx, args, record)
  local kind = args.type
  if kind == 'commemoration' then
    local list = args.commemorations
    if list == nil and args.commemoration ~= nil then list = {args.commemoration} end
    return commemorationSubmit(ctx, list)
  elseif kind == 'pantheon' then
    return pantheonSubmit(ctx, args.belief)
  elseif kind == 'great_person' then
    return greatPersonSubmit(ctx, args.operation, args.individual, args.currency)
  elseif kind == 'governor' then
    return governorSubmit(ctx, args.operation, args.governor, args.promotion, args.cityId)
  elseif kind == 'religion' then
    local beliefs = args.beliefs
    if beliefs == nil and args.belief ~= nil then beliefs = {args.belief} end
    return religionSubmit(ctx, args.operation, args.religion, args.name, beliefs)
  elseif kind == 'city_fate' then
    return cityFateSubmit(ctx, args.operation, args.cityId)
  elseif kind == 'congress' then
    return congressSubmit(ctx, args.operation, args.votes, args.proposals)
  elseif kind == 'envoy' then
    return envoySubmit(ctx, args.operation, args.target, args.count)
  elseif kind == 'espionage' then
    return espionageSubmit(ctx, args.operation, args.unitId, args.district, args.operationType, args.x, args.y, args.cityId)
  elseif kind == 'diplomacy' then
    -- lua/diplomacy.lua owns the session/deal encodings and is resolved here, at call time. When a
    -- record is supplied (an id-based civ.decide) the module validates the choice against the
    -- options that were just re-collected; a direct civ.action has no record and revalidates
    -- against live native state on its own.
    local fn = A.diplomacyAction
    assert(type(fn) == 'function', 'lua/diplomacy.lua is not loaded in this bridge; the diplomacy family cannot be answered')
    return fn(ctx, args, record)
  end
  error('Unsupported decision action type: '..tostring(kind))
end

--- Find the option whose `choice` a caller echoed back, so an id-based decide can be
--- validated against the option list the model actually read.
local function pickOption(record, choice)
  for _, option in ipairs(record.options or {}) do
    if type(option.choice) == 'string' and option.choice == choice then return option end
  end
  return nil
end

local function decideCommemoration(record, choice, choices)
  local list = choices
  if list == nil and choice ~= nil then list = {choice} end
  assert(type(list) == 'table' and #list > 0, 'This decision needs choice=<CommemorationType> or choices=[...]')
  for _, name in ipairs(list) do
    assert(pickOption(record, name) ~= nil, 'Commemoration is not among the current options: '..tostring(name))
  end
  return {type='commemoration', commemorations=list}
end

local function decideGreatPerson(record, choice)
  local option = pickOption(record, choice)
  assert(option ~= nil, 'choice must be one of the option choice tokens for this great person')
  assert(option.available, 'That option is not currently legal: '..tostring(choice))
  return {type='great_person', operation=option.operation, individual=record.individual, currency=option.currency}
end

local function decideEspionage(record, choice)
  if record.operation == 'escape' then
    local option = pickOption(record, choice)
    assert(option ~= nil and option.available, 'choice must be an available DistrictType from this decision')
    return {type='espionage', operation='escape', unitId=record.unitId, district=choice}
  end
  local option = pickOption(record, choice)
  assert(option ~= nil and option.available, 'choice must be an available mission token from this decision')
  return {type='espionage', operation='mission', unitId=record.unitId,
    operationType=option.operation, x=option.x, y=option.y, cityId=record.cityId}
end

local function decideValidated(args)
  assert(type(args.id) == 'string', 'civ.decide requires id=<decision id> from civ.decisions')
  assert(args.choice == nil or args.choices == nil, 'Pass either choice or choices, not both')
  local session, kind, key = args.id:match('^([^:]+):decision:([^:]+):(.*)$')
  assert(session == A.session and key ~= nil, 'Decision id is from another loaded game instance; call civ.decisions again')
  assert(KIND_SET[kind], 'Unknown decision kind in id. Valid kinds: '..KIND_HELP)
  assert(kind ~= 'blocker', 'This entry is an end-turn blocker owned by another module. Use the action type named in its handler field.')
  local ctx = context()
  -- Revalidation: the decision is re-derived from live native state, never from a cached row.
  local records = collect(ctx, kind)
  local record
  for _, candidate in ipairs(records) do if candidate.id == args.id then record = candidate; break end end
  if record == nil then
    return refused('stale', 'This decision is no longer offered by the engine. It was NOT submitted. Call civ.decisions again.', {id = args.id})
  end
  local choice, choices = args.choice, args.choices
  local call
  if kind == 'commemoration' then
    call = decideCommemoration(record, choice, choices)
  elseif kind == 'pantheon' then
    assert(pickOption(record, choice) ~= nil, 'choice must be an available BeliefType from this decision')
    call = {type='pantheon', belief=choice}
  elseif kind == 'great_person' then
    call = decideGreatPerson(record, choice)
  elseif kind == 'governor' then
    local option = pickOption(record, choice)
    assert(option ~= nil and option.available, 'choice must be an available option from this decision')
    call = {type='governor', operation=record.operation, governor=record.governor}
    if record.operation == 'appoint' then call.governor = choice
    elseif record.operation == 'promote' then call.promotion = choice
    else call.cityId = choice end
  elseif kind == 'religion' then
    if record.operation == 'found' then
      assert(pickOption(record, choice) ~= nil, 'choice must be an available ReligionType from this decision')
      call = {type='religion', operation='found', religion=choice, name=args.name, beliefs=args.beliefs}
    else
      local list = choices
      if list == nil and choice ~= nil then list = {choice} end
      assert(type(list) == 'table' and #list > 0, 'This decision needs choice=<BeliefType> or choices=[...]')
      for _, name in ipairs(list) do
        assert(pickOption(record, name) ~= nil, 'Belief is not among the current options: '..tostring(name))
      end
      call = {type='religion', operation='belief', beliefs=list}
    end
  elseif kind == 'city_fate' then
    local option = pickOption(record, choice)
    assert(option ~= nil and option.available, 'choice must be one of this city\'s currently legal fates')
    call = {type='city_fate', operation=choice, cityId=record.cityId}
  elseif kind == 'congress' then
    if record.operation == 'proposal' then
      assert(type(choices) == 'table' and #choices > 0, 'This decision needs choices=[{target=...,discussionType=...}]')
      call = {type='congress', operation='proposal', proposals=choices}
    else
      assert(type(choices) == 'table' and #choices > 0, 'This decision needs choices=[{subject=...,...}] vote entries')
      call = {type='congress', operation='vote', votes=choices}
    end
  elseif kind == 'envoy' then
    -- Sending is a real strategic choice, so the id path takes the city-state the model named and
    -- never picks one for it; operation="consider" is the separate explicit acknowledgement.
    if args.operation == 'consider' then
      call = {type='envoy', operation='consider'}
    else
      local option = pickOption(record, choice)
      assert(option ~= nil, 'choice must be one of the city-state ids from this decision')
      assert(option.available, 'The engine does not allow sending an envoy to that city-state right now')
      call = {type='envoy', operation='send', target=option.playerId, count=args.count}
    end
  elseif kind == 'espionage' then
    call = decideEspionage(record, choice)
  else
    -- diplomacy: lua/diplomacy.lua owns session/deal identity, the selection keys and the statement
    -- spelling. It receives the freshly re-collected record so the choice is validated against the
    -- options the caller actually read, and it returns the submission result this function stamps.
    local fn = A.diplomacyAction
    assert(type(fn) == 'function', 'lua/diplomacy.lua is not loaded in this bridge; the diplomacy family cannot be answered')
    local forwarded = {}
    for field, value in pairs(args) do forwarded[field] = value end
    forwarded.id, forwarded.type = nil, 'diplomacy'
    forwarded.sessionId = record.sessionId
    if forwarded.key == nil then forwarded.key = choice end
    local result = fn(ctx, forwarded, record)
    result.id = args.id
    result.kind = kind
    return result
  end
  local result = dispatch(ctx, call, record)
  result.id = args.id
  result.kind = kind
  return result
end

function A.decide(args)
  args = args or {}
  return A.entry(function()
    return decideValidated(args)
  end)
end

--- Whether a decision family may be submitted in the current turn segment. Ordinary strategic and
--- tactical command flags cannot answer this: DLC/Expansion2/Data/Expansion2_TurnPhases.xml:12-14
--- sets AllowStrategicCommands=false and AllowTacticalCommands=false for all three congress
--- segments (TURNSEG_WORLDCONGRESS_1/2/_RESOLUTION), and submitting the ballot or the available
--- proposals there is exactly what the native screen does (WorldCongressPopup.OnAccept,
--- WorldCongressPopup.lua:2222-2315). actions.lua calls this for decision families so the congress
--- family is not refused by a gate meant for ordinary unit/city/player requests.
function A.decisionReady(kind)
  local stage = congressSegment()
  local pid = A.localPlayer()
  if stage == 1 or stage == 2 or stage == 4 then return kind == 'congress' end
  return Game.IsAllowStrategicCommands(pid) == true or Game.IsAllowTacticalCommands(pid) == true
end

-- ---------------------------------------------------------------------------
-- The action-family surface. One action type per decision family plus an explicit
-- `operation` field; unit promotion stays on the existing unit_command PROMOTE path and
-- government/policies stay on their existing action.lua dispatcher names.
-- Only families with a verified native request path appear here: civ.probe publishes
-- this table as truth, so an entry means the bridge really can submit it.
-- ---------------------------------------------------------------------------
A.decisionActionTypes = {
  commemoration = {operations=A.array{'choose'},
    fields={commemoration='CommemorationType', commemorations='CommemorationType[]'},
    native='PlayerOperations.COMMEMORATE (one request per commemoration)'},
  pantheon = {operations=A.array{'found'}, fields={belief='BeliefType'},
    native='PlayerOperations.FOUND_PANTHEON'},
  great_person = {operations=A.array{'recruit','reject','patronize'},
    fields={operation='string', individual='the timeline individual value from civ.decisions or its GreatPersonIndividualType', currency='gold|faith (patronize)'},
    native='PlayerOperations.RECRUIT_GREAT_PERSON / REJECT_GREAT_PERSON / PATRONIZE_GREAT_PERSON with PARAM_GREAT_PERSON_INDIVIDUAL_TYPE'},
  governor = {operations=A.array{'appoint','assign','promote'},
    fields={operation='string', governor='GovernorType', promotion='GovernorPromotionType (promote, from this governor\'s GovernorPromotionSets)', cityId='cityId encoding the destination owner (assign)'},
    native='PlayerOperations.APPOINT_GOVERNOR / ASSIGN_GOVERNOR / PROMOTE_GOVERNOR'},
  religion = {operations=A.array{'found','belief'},
    fields={operation='string', religion='ReligionType (found)', name='string (found, when required)', belief='BeliefType', beliefs='BeliefType[]'},
    native='PlayerOperations.FOUND_RELIGION plus one ADD_BELIEF per belief'},
  city_fate = {operations=A.array{'keep','raze','liberate_founder','liberate_previous_owner','reject'},
    fields={operation='string', cityId='cityId'},
    native='CityManager.RequestCommand(city, CityCommandTypes.DESTROY, {PARAM_FLAGS=CityDestroyDirectives.*})'},
  congress = {operations=A.array{'vote','proposal','submit','looked'},
    fields={operation='string', votes='vote entry[] (operation=vote, or submit to vote and release in one call)', proposals='proposal entry[]'},
    native='PlayerOperations.WORLD_CONGRESS_RESOLUTION_VOTE / WORLD_CONGRESS_DISCUSSION_VOTE for votes; operation="submit" sends votes (when supplied), then WORLD_CONGRESS_SUBMIT_TURN and ActionTypes.ACTION_ENDTURN, exactly the native Accept sequence. WORLD_CONGRESS_DISCUSSION_SELECTION for proposals and WORLD_CONGRESS_LOOKED_AT_AVAILABLE for operation="looked". submit is turn-ending: keep it last in a batch.'},
  envoy = {operations=A.array{'send','consider'},
    fields={operation='string', target='city-state player id (send)', count='integer tokens to send, default 1'},
    native='PlayerOperations.GIVE_INFLUENCE_TOKEN with PARAM_PLAYER_ONE, one request per token (CityStates.lua:749-765); operation="consider" calls Influence:SetGivingTokensConsidered(true)'},
  espionage = {operations=A.array{'mission','escape','travel'},
    fields={operation='string', unitId='unitId', operationType='spy UnitOperation short name (mission)', x='integer', y='integer', district='DistrictType (escape)', cityId='destination city (travel) or the legality plot for an untargeted mission'},
    native='UnitManager.RequestOperation for missions/travel, PlayerOperations.SET_ESCAPE_ROUTE for escape'},
}

-- lua/diplomacy.lua publishes its own schema; it is copied here at load (the module is loaded
-- before this file) so civ.probe advertises exactly the module's supported operations, and a bridge
-- without the module advertises none instead of promising an unloaded family.
A.decisionActionTypes.diplomacy = A.diplomacyActionSpec

--- Whether a decision action ends the local player's turn. The congress submit reproduces the native
--- Accept, which sends ActionTypes.ACTION_ENDTURN (WorldCongressPopup.lua:2270-2271); it is the only
--- turn-ending request any decision family issues, and no other family infers one. actions.lua
--- resolves this at call time so a batch keeps it in the same final position as its own end_turn.
function A.decisionEndsTurn(args)
  return type(args) == 'table' and args.type == 'congress' and args.operation == 'submit'
end

function A.decisionAction(args)
  assert(type(args) == 'table' and type(args.type) == 'string', 'Decision action requires type')
  assert(A.decisionActionTypes[args.type] ~= nil, 'Not a supported decision action type: '..tostring(args.type))
  local ctx = context()
  local result = dispatch(ctx, args, nil)
  result.type = args.type
  return result
end
