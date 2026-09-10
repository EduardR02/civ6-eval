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

local KINDS = {'commemoration','pantheon','great_person','governor','religion','city_fate','congress','espionage','diplomacy','blocker'}
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

--- One native request. Submission is never completion: UI.RequestPlayerOperation and the
--- managers return nothing observable, so an untorn call is 'submitted' with the
--- acknowledgement explicitly marked unobservable, a thrown call is 'unknown' and stops
--- everything after it, and an explicit false is a refusal.
local function request(fn, ...)
  local count = select('#', ...)
  local args = {...}
  local ok, value = pcall(function() return fn(unpack(args, 1, count)) end)
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
  out.note = note or 'Submission is not completion. Native decision requests are queued; re-observe (civ.decisions, civ.snapshot, civ.inspect) before assuming the outcome.'
  return out
end

local function refused(status, reason, extra)
  local out = extra or {}
  out.accepted, out.completed, out.status = false, false, status
  out.reasons = A.array{reason}
  out.turnState = A.turnState()
  return out
end

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
-- Native: Base/Assets/UI/Popups/GreatPeoplePopup.lua. Legality and costs come from
--   Game.GetGreatPeople(): CanRecruitPerson / CanRejectPerson+GetRejectCost /
--   CanPatronizePerson+GetPatronizeCost(player, individual, YieldTypes.GOLD|FAITH).
--   Requests are PlayerOperations.RECRUIT_GREAT_PERSON / REJECT_GREAT_PERSON /
--   PATRONIZE_GREAT_PERSON with PARAM_GREAT_PERSON_INDIVIDUAL_TYPE = the individual id
--   from the timeline entry and, for patronage, PARAM_YIELD_TYPE.
-- Recruiting is only an *opportunity* unless ENDTURN_BLOCKING_CLAIM_GREAT_PERSON is up.
-- ---------------------------------------------------------------------------
local function greatPeopleDecisions(ctx, out)
  local people = A.static('greatPeople', Game, 'GetGreatPeople')
  -- Do not query a missing great-people manager.
  if people == A.null then return A.unavailable('greatPeople', 'GetGreatPeople', 'Great-people manager unavailable') end
  local timeline = A.call('greatPeople', people, 'GetTimeline')
  -- Guard: GetTimeline is only usable as a table; anything else means no data, not a crash.
  if timeline == A.null or type(timeline) ~= 'table' then return A.unavailable('greatPeople', 'GetTimeline', 'Great-people timeline unavailable') end
  local claimBlocks = blocking(ctx, 'ENDTURN_BLOCKING_CLAIM_GREAT_PERSON')
  for _, entry in ipairs(timeline) do
    local individual = type(entry) == 'table' and entry.Individual or nil
    -- Guard: entries without an Individual id (or already claimed) are skipped, not queried.
    if individual ~= nil and entry.Claimant == nil then
      local canRecruit = A.call('greatPeople', people, 'CanRecruitPerson', ctx.pid, individual) == true
      local canReject = A.call('greatPeople', people, 'CanRejectPerson', ctx.pid, individual) == true
      local goldYield = YieldTypes and YieldTypes.GOLD
      local faithYield = YieldTypes and YieldTypes.FAITH
      local canGold = goldYield ~= nil and A.call('greatPeople', people, 'CanPatronizePerson', ctx.pid, individual, goldYield) == true
      local canFaith = faithYield ~= nil and A.call('greatPeople', people, 'CanPatronizePerson', ctx.pid, individual, faithYield) == true
      if canRecruit or canReject or canGold or canFaith then
        local row = A.row('GreatPersonIndividuals', individual)
        local options = A.array()
        options[#options+1] = {choice='recruit', operation='recruit', available=canRecruit, cost=entry.Cost}
        if canReject then
          options[#options+1] = {choice='reject', operation='reject', available=true,
            cost=A.call('greatPeople', people, 'GetRejectCost', ctx.pid, individual), currency='great_person_points'}
        end
        if canGold then
          options[#options+1] = {choice='patronize_gold', operation='patronize', currency='gold', available=true,
            cost=A.call('greatPeople', people, 'GetPatronizeCost', ctx.pid, individual, goldYield)}
        end
        if canFaith then
          options[#options+1] = {choice='patronize_faith', operation='patronize', currency='faith', available=true,
            cost=A.call('greatPeople', people, 'GetPatronizeCost', ctx.pid, individual, faithYield)}
        end
        out[#out+1] = {
          key = 'individual'..tostring(individual),
          kind = 'great_person', actionType = 'great_person',
          operations = A.array{'recruit','reject','patronize'},
          label = (row ~= A.null and A.loc(row.Name) or ('Great person '..tostring(individual))),
          mandatory = claimBlocks and canRecruit,
          blocks = claimBlocks and canRecruit,
          individual = row ~= A.null and row.GreatPersonIndividualType or A.null,
          individualIndex = individual,
          class = A.typeName('GreatPersonClasses', entry.Class, 'GreatPersonClassType'),
          era = A.typeName('Eras', entry.Era, 'EraType'),
          actionName = A.loc(entry.ActionNameText),
          actionEffect = A.loc(entry.ActionEffectText),
          passiveEffect = A.loc(entry.PassiveEffectText),
          earnConditions = A.loc(A.call('greatPeople', people, 'GetEarnConditionsText', ctx.pid, individual)),
          options = options,
          choiceHelp = 'choice=recruit|reject|patronize_gold|patronize_faith. Patronage and rejection spend real currency; nothing is paid implicitly.',
        }
      end
    end
  end
end

local function greatPersonSubmit(ctx, operation, individualType, currency)
  local people = A.static('greatPeople', Game, 'GetGreatPeople')
  assert(people ~= A.null, 'Game.GetGreatPeople is unavailable in this context')
  assert(type(individualType) == 'string', 'great_person needs individual=<GreatPersonIndividualType>')
  local row = GameInfo.GreatPersonIndividuals[individualType]
  assert(row, 'Unknown GreatPersonIndividualType: '..individualType)
  local individual = row.Index
  local parameters = {}
  parameters[A.param(PlayerOperations, 'PARAM_GREAT_PERSON_INDIVIDUAL_TYPE')] = individual
  local nativeOperation
  if operation == 'recruit' then
    assert(A.call('greatPeople', people, 'CanRecruitPerson', ctx.pid, individual) == true, 'Engine refuses recruitment of '..individualType)
    nativeOperation = 'RECRUIT_GREAT_PERSON'
  elseif operation == 'reject' then
    assert(A.call('greatPeople', people, 'CanRejectPerson', ctx.pid, individual) == true, 'Engine refuses rejection of '..individualType)
    nativeOperation = 'REJECT_GREAT_PERSON'
  elseif operation == 'patronize' then
    assert(currency == 'gold' or currency == 'faith', 'patronize needs currency="gold" or "faith"; the cost is never chosen for you')
    local yield = YieldTypes and (currency == 'gold' and YieldTypes.GOLD or YieldTypes.FAITH)
    assert(yield ~= nil, 'YieldTypes is unavailable in this context')
    assert(A.call('greatPeople', people, 'CanPatronizePerson', ctx.pid, individual, yield) == true,
      'Engine refuses '..currency..' patronage of '..individualType)
    parameters[A.param(PlayerOperations, 'PARAM_YIELD_TYPE')] = yield
    nativeOperation = 'PATRONIZE_GREAT_PERSON'
  else
    error('great_person operation must be recruit, reject or patronize')
  end
  return submit({{label = nativeOperation..' '..individualType, run = function()
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
      -- Promotion
      if A.call('governors', governors, 'CanPromoteGovernor', row.Hash) == true and GameInfo.GovernorPromotions ~= nil then
        local options = A.array()
        for promotion in GameInfo.GovernorPromotions() do
          if promotion.GovernorType == row.GovernorType
            and A.call('governors', governor, 'HasPromotion', promotion.Hash) ~= true
            and A.call('governors', governors, 'CanEarnPromotion', row.Hash, promotion.Hash) == true then
            options[#options+1] = {choice = promotion.GovernorPromotionType, available = true,
              label = A.loc(promotion.Name), description = A.loc(promotion.Description)}
          end
        end
        if #options > 0 then
          out[#out+1] = {
            key = 'promote:'..row.GovernorType,
            kind = 'governor', actionType = 'governor', operation = 'promote',
            operations = A.array{'promote'},
            label = 'Promote '..tostring(A.loc(row.Name)),
            mandatory = false,
            blocks = blocking(ctx, 'ENDTURN_BLOCKING_GOVERNOR_PROMOTION'),
            governor = row.GovernorType,
            options = options,
            choiceHelp = 'choice=<GovernorPromotionType>',
          }
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
    assert(GameInfo.GovernorPromotions ~= nil, 'GovernorPromotions is absent from this ruleset')
    local promotion = GameInfo.GovernorPromotions[promotionType]
    assert(promotion, 'Unknown GovernorPromotionType: '..promotionType)
    assert(promotion.GovernorType == governorType, promotionType..' does not belong to '..governorType)
    assert(A.call('governors', governors, 'CanPromoteGovernor', row.Hash) == true, governorType..' cannot be promoted now')
    assert(A.call('governors', governors, 'CanEarnPromotion', row.Hash, promotion.Hash) == true,
      'Engine refuses promotion '..promotionType)
    parameters[A.param(PlayerOperations, 'PARAM_GOVERNOR_PROMOTION_TYPE')] = promotion.Index
    return submit({{label = 'PROMOTE_GOVERNOR '..governorType..' '..promotionType, run = function()
      return playerOperation(ctx.pid, 'PROMOTE_GOVERNOR', parameters)
    end}})
  elseif operation == 'assign' then
    local owner, cid = parseCityId(cityIdValue)
    local city
    if owner == ctx.pid then city = A.call('governors', ctx.player:GetCities(), 'FindID', cid)
    else city = A.static('governors', CityManager, 'GetCity', owner, cid) end
    assert(city ~= nil and city ~= A.null, 'Destination city no longer exists; call civ.decisions again')
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
  local city
  if owner == ctx.pid then city = A.call('cityFate', ctx.player:GetCities(), 'FindID', cid)
  else city = A.static('cityFate', CityManager, 'GetCity', owner, cid) end
  assert(city ~= nil and city ~= A.null, 'City no longer exists; call civ.decisions again')
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
-- Native: DLC/Expansion2/UI/Additions/WorldCongressPopup.lua OnAccept.
--   In session (Game.GetCurrentTurnSegment() == TURNSEG_WORLDCONGRESS_1/2):
--     resolutions -> PlayerOperations.WORLD_CONGRESS_RESOLUTION_VOTE with
--       PARAM_RESOLUTION_TYPE = Resolutions row Hash, PARAM_WORLD_CONGRESS_VOTES = the
--       vote count (1..MaxVotes, always positive; the A/B option is the direction),
--       PARAM_RESOLUTION_OPTION = 1 or 2 and PARAM_RESOLUTION_SELECTION = targetIndex-1.
--     discussions -> WORLD_CONGRESS_DISCUSSION_VOTE with PARAM_PLAYER_ONE = Sender,
--       PARAM_PLAYER_TWO = Target and PARAM_WORLD_CONGRESS_VOTES = signed votes.
--     the native Accept then sends WORLD_CONGRESS_SUBMIT_TURN and ACTION_ENDTURN.
--   Out of session, the available-proposals tab submits new discussions with
--     WORLD_CONGRESS_DISCUSSION_SELECTION (PARAM_OTHER_PLAYER = Target,
--     PARAM_DISCUSSION_TYPE = Type) after an explicit favor-cost confirmation.
-- This module never sends ACTION_ENDTURN: end_turn stays an explicit civ.action.
-- ---------------------------------------------------------------------------
--- 1 or 2 while the congress is voting, 0 when it is not in session, nil when the turn
--- segment cannot be resolved. nil is honest ignorance: no congress decision is emitted
--- rather than guessing the wrong stage.
local function congressSegment()
  local segment = A.static('congress', Game, 'GetCurrentTurnSegment')
  local one = A.static('congress', DB, 'MakeHash', 'TURNSEG_WORLDCONGRESS_1')
  local two = A.static('congress', DB, 'MakeHash', 'TURNSEG_WORLDCONGRESS_2')
  if type(segment) ~= 'number' or type(one) ~= 'number' or type(two) ~= 'number' then return nil end
  if segment == one then return 1 end
  if segment == two then return 2 end
  return 0
end

--- Native congress collections are keyed maps; sort them so repeated reads are byte-stable.
local function sortedValues(map, keyOf)
  local list = {}
  if type(map) ~= 'table' then return list end
  for key, value in pairs(map) do
    if type(value) == 'table' then list[#list+1] = {sort = keyOf(key, value), value = value} end
  end
  table.sort(list, function(a, b) return a.sort < b.sort end)
  local out = {}
  for _, entry in ipairs(list) do out[#out+1] = entry.value end
  return out
end

local function proposalKey(proposal)
  return tostring(proposal.TypeName)..'_'..tostring(proposal.Target)..'_'..tostring(proposal.Sender)
end

local function proposalValues(result)
  local out = {}
  if result == A.null or type(result) ~= 'table' or type(result.Proposals) ~= 'table' then
    A.unavailable('congress', 'proposals', 'Native proposal categories unavailable')
    return out
  end
  for _, category in pairs(result.Proposals) do
    if type(category) == 'table' and type(category.ProposalsOfType) == 'table' then
      for _, proposal in pairs(category.ProposalsOfType) do
        if type(proposal) == 'table' and proposal.Type ~= nil and proposal.Target ~= nil then
          out[#out+1] = proposal
        else
          A.unavailable('congress', 'proposal', 'Native proposal identity unavailable')
        end
      end
    else
      A.unavailable('congress', 'proposals', 'Native ProposalsOfType unavailable')
    end
  end
  table.sort(out, function(a, b) return proposalKey(a) < proposalKey(b) end)
  return out
end

local function congressReady(ctx, stage)
  local capability = A.static('congress', GameCapabilities, 'HasCapability', 'CAPABILITY_WORLD_CONGRESS')
  if capability ~= true then
    if capability ~= false then A.unavailable('congress', 'readiness', 'World Congress capability unknown') end
    return false
  end
  -- Voting and notification-opened emergency proposals are independent of ordinary era access.
  if stage == 1 or stage == 2 then return true end
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
  -- Meeting and favor queries require an actual ballot or emergency, not merely a congress wrapper.
  if stage == 1 or stage == 2 then
    local options = A.array()
    if stage == 1 then
      local resolutions = A.call('congress', congress, 'GetResolutions', ctx.pid)
      -- GetResolutions carries a non-numeric "Stage" key alongside the numbered entries.
      for _, data in ipairs(sortedValues(resolutions, function(key) return tostring(key) end)) do
        if data.Type ~= nil then
          local row = A.row('Resolutions', data.Type)
          local targets = A.array()
          if type(data.PossibleTargets) == 'table' then
            for i, value in ipairs(data.PossibleTargets) do
              targets[#targets+1] = {selection = i - 1, value = value,
                label = data.TargetType == 'PlayerType' and tostring(value) or A.loc(value)}
            end
          end
          options[#options+1] = {
            subject = 'resolution',
            resolution = row ~= A.null and row.ResolutionType or A.null,
            available = row ~= A.null,
            label = row ~= A.null and A.loc(row.Name) or A.null,
            effect1 = row ~= A.null and A.loc(row.Effect1Description) or A.null,
            effect2 = row ~= A.null and A.loc(row.Effect2Description) or A.null,
            targetType = data.TargetType,
            targets = targets,
            choice = {subject='resolution', resolution = row ~= A.null and row.ResolutionType or A.null,
              option = 1, selection = 0, votes = 1},
          }
        end
      end
    end
    local proposals = A.call('congress', congress, 'GetProposals', ctx.pid)
    if type(proposals) == 'table' then
      for _, proposal in ipairs(proposalValues(proposals)) do
        options[#options+1] = {
          subject = 'discussion',
          available = proposal.Disabled ~= true,
          label = A.loc(proposal.Name),
          description = A.loc(proposal.Description),
          discussionType = proposal.TypeName,
          sender = proposal.Sender, target = proposal.Target,
          choice = {subject='discussion', sender=proposal.Sender, target=proposal.Target, votes=1},
        }
      end
    end
    local anyLegal = false
    for _, option in ipairs(options) do if option.available then anyLegal = true; break end end
    if anyLegal then
      -- Guard: only touch GetVotesandFavorCost/GetFavor once a votable ballot exists.
      local costs = A.call('congress', congress, 'GetVotesandFavorCost', ctx.pid)
      local favor = A.call('congress', ctx.player, 'GetFavor')
      out[#out+1] = {
        key = 'session:stage'..stage..':turn'..ctx.turn,
        kind = 'congress', actionType = 'congress', operation = 'vote',
        operations = A.array{'vote','submit'},
        label = 'World Congress stage '..stage..': cast votes',
        mandatory = true,
        blocks = blocking(ctx, 'ENDTURN_BLOCKING_WORLD_CONGRESS_SESSION'),
        stage = stage,
        favor = favor, maxVotes = type(costs) == 'table' and costs.MaxVotes or A.null, favorCostByVotes = costs,
        options = options,
        choiceHelp = 'choices=[{subject="resolution",resolution=<ResolutionType>,option=1|2,selection=<0-based target index>,votes=<n>}, {subject="discussion",sender=<playerId>,target=<playerId>,votes=<signed n>}]. Votes cost favor: favorCostByVotes[n-1]. Then civ.action(type="congress",operation="submit") sends WORLD_CONGRESS_SUBMIT_TURN; ending the turn stays a separate explicit civ.action(type="end_turn").',
      }
    end
  else
    -- Out of session, defer meeting status and favor until a proposal is available.
    local emergencies = A.call('congress', congress, 'GetEmergencies', ctx.pid)
    local options = A.array()
    if type(emergencies) == 'table' then
      for _, proposal in ipairs(proposalValues(emergencies)) do
        if proposal.Disabled ~= true then
          options[#options+1] = {
            available = true,
            label = A.loc(proposal.Name),
            description = A.loc(proposal.Description),
            discussionType = proposal.TypeName,
            target = proposal.Target,
            choice = {target = proposal.Target, discussionType = proposal.Type},
          }
        end
      end
    end
    if #options > 0 then
      -- Guard: fetch session status and favor only once a proposalable emergency exists.
      local status = A.call('congress', congress, 'GetMeetingStatus')
      local favor = A.call('congress', ctx.player, 'GetFavor')
      out[#out+1] = {
        key = 'proposals:turn'..ctx.turn,
        kind = 'congress', actionType = 'congress', operation = 'proposal',
        operations = A.array{'proposal'},
        label = 'World Congress: propose discussions for the next session',
        mandatory = false,
        blocks = blocking(ctx, 'ENDTURN_BLOCKING_WORLD_CONGRESS_LOOK') or blocking(ctx, 'ENDTURN_BLOCKING_EMERGENCY_NEEDS_ATTENTION'),
        favor = favor,
        turnsToNextSession = type(status) == 'table' and status.TurnsLeft or A.null,
        options = options,
        choiceHelp = 'choices=[{target=<playerId>,discussionType=<engine discussion type from the option>}]. Each proposal spends favor with no refund.',
      }
    end
  end
end

local function congressSubmit(ctx, operation, votes, proposals)
  local congress = A.static('congress', Game, 'GetWorldCongress')
  assert(congress ~= A.null, 'World Congress is not present in this ruleset')
  local stage = congressSegment()
  assert(stage ~= nil and congressReady(ctx, stage), 'World Congress is not ready')
  if operation == 'submit' then
    assert(stage == 1 or stage == 2, 'The World Congress is not currently in a voting stage')
    return submit({{label = 'WORLD_CONGRESS_SUBMIT_TURN', run = function()
      return playerOperation(ctx.pid, 'WORLD_CONGRESS_SUBMIT_TURN', {})
    end}}, 'The congress turn was submitted. Ending the game turn is a separate explicit civ.action(type="end_turn").')
  elseif operation == 'vote' then
    assert(type(votes) == 'table' and #votes > 0, 'congress vote needs votes=[{subject="resolution"|"discussion",...}]')
    assert(stage == 1 or stage == 2, 'The World Congress is not currently in a voting stage')
    local resolutionHash = {}
    if stage == 1 then
      local resolutions = A.call('congress', congress, 'GetResolutions', ctx.pid)
      if type(resolutions) == 'table' then
        for index, data in pairs(resolutions) do
          if type(index) == 'number' and type(data) == 'table' then
            local row = A.row('Resolutions', data.Type)
            if row ~= A.null then resolutionHash[row.ResolutionType] = row.Hash end
          end
        end
      end
    end
    -- Discussion votes are revalidated against the live ballot; a sender/target pair that
    -- is not on it is refused before any request, not sent and hoped for.
    local ballot = {}
    local proposals = A.call('congress', congress, 'GetProposals', ctx.pid)
    for _, proposal in ipairs(proposalValues(proposals)) do
      if proposal.Disabled ~= true and proposal.Sender ~= nil then
        ballot[tostring(proposal.Sender)..'>'..tostring(proposal.Target)] = true
      end
    end
    local items = {}
    for _, vote in ipairs(votes) do
      assert(type(vote) == 'table', 'Each congress vote must be a table')
      local count = number(vote.votes)
      assert(count ~= nil and count % 1 == 0 and count ~= 0, 'Each congress vote needs a nonzero integer votes count')
      if vote.subject == 'discussion' then
        local sender, target = number(vote.sender), number(vote.target)
        assert(sender ~= nil and target ~= nil, 'A discussion vote needs sender and target player ids from the option')
        assert(ballot[tostring(sender)..'>'..tostring(target)] == true,
          'That discussion is not on the current votable ballot: '..sender..'->'..target)
        items[#items+1] = {label = 'WORLD_CONGRESS_DISCUSSION_VOTE '..sender..'->'..target, run = function()
          local parameters = {}
          parameters[A.param(PlayerOperations, 'PARAM_PLAYER_ONE')] = sender
          parameters[A.param(PlayerOperations, 'PARAM_PLAYER_TWO')] = target
          parameters[A.param(PlayerOperations, 'PARAM_WORLD_CONGRESS_VOTES')] = count
          return playerOperation(ctx.pid, 'WORLD_CONGRESS_DISCUSSION_VOTE', parameters)
        end}
      else
        assert(vote.subject == nil or vote.subject == 'resolution', 'congress vote subject must be "resolution" or "discussion"')
        assert(stage == 1, 'Resolutions are only voted in stage 1')
        assert(type(vote.resolution) == 'string', 'A resolution vote needs resolution=<ResolutionType>')
        local hash = resolutionHash[vote.resolution]
        assert(hash ~= nil, 'Resolution is not on this session ballot: '..vote.resolution)
        local option = number(vote.option)
        assert(option == 1 or option == 2, 'A resolution vote needs option=1 or option=2')
        assert(count > 0, 'Resolution votes are positive; option 1 or 2 selects the side')
        local selection = number(vote.selection)
        items[#items+1] = {label = 'WORLD_CONGRESS_RESOLUTION_VOTE '..vote.resolution, run = function()
          local parameters = {}
          parameters[A.param(PlayerOperations, 'PARAM_RESOLUTION_TYPE')] = hash
          parameters[A.param(PlayerOperations, 'PARAM_WORLD_CONGRESS_VOTES')] = count
          parameters[A.param(PlayerOperations, 'PARAM_RESOLUTION_OPTION')] = option
          if selection ~= nil then
            parameters[A.param(PlayerOperations, 'PARAM_RESOLUTION_SELECTION')] = selection
          end
          return playerOperation(ctx.pid, 'WORLD_CONGRESS_RESOLUTION_VOTE', parameters)
        end}
      end
    end
    return submit(items, 'Votes were submitted one native request at a time; requests[] reports which. Call civ.action(type="congress",operation="submit") when the ballot is complete.')
  elseif operation == 'proposal' then
    assert(stage == 0, 'Emergency proposals cannot be selected during voting')
    assert(type(proposals) == 'table' and #proposals > 0, 'congress proposal needs proposals=[{target=...,discussionType=...}]')
    local offered = {}
    for _, proposal in ipairs(proposalValues(A.call('congress', congress, 'GetEmergencies', ctx.pid))) do
      if proposal.Disabled ~= true then offered[tostring(proposal.Type)..'>'..tostring(proposal.Target)] = true end
    end
    local items = {}
    for _, proposal in ipairs(proposals) do
      assert(type(proposal) == 'table', 'Each proposal must be a table')
      local target = number(proposal.target)
      assert(target ~= nil, 'Each proposal needs target=<playerId> from the option')
      assert(proposal.discussionType ~= nil, 'Each proposal needs discussionType from the option')
      local discussionType = proposal.discussionType
      assert(offered[tostring(discussionType)..'>'..tostring(target)] == true, 'Emergency proposal is not currently offered')
      items[#items+1] = {label = 'WORLD_CONGRESS_DISCUSSION_SELECTION target '..target, run = function()
        local parameters = {}
        parameters[A.param(PlayerOperations, 'PARAM_OTHER_PLAYER')] = target
        parameters[A.param(PlayerOperations, 'PARAM_DISCUSSION_TYPE')] = discussionType
        return playerOperation(ctx.pid, 'WORLD_CONGRESS_DISCUSSION_SELECTION', parameters)
      end}
    end
    return submit(items, 'Proposals spend favor with no refund. requests[] reports exactly which were submitted.')
  end
  error('congress operation must be vote, proposal or submit')
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
  local spy = A.call('espionage', units, 'FindID', spyId)
  if spy == A.null then return A.unavailable('espionage', 'FindID', 'Escaping spy unavailable') end
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
        local city
        if owner == ctx.pid then city = A.call('espionage', ctx.player:GetCities(), 'FindID', cid)
        else city = A.static('espionage', CityManager, 'GetCity', owner, cid) end
        assert(city ~= nil and city ~= A.null, 'Destination city is not observable; call civ.decisions again')
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
      local city
      if owner == ctx.pid then city = A.call('espionage', ctx.player:GetCities(), 'FindID', cid)
      else city = A.static('espionage', CityManager, 'GetCity', owner, cid) end
      assert(city ~= nil and city ~= A.null, 'Mission city is not observable; call civ.decisions again')
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
-- Diplomacy sessions.
-- Native: Base/Assets/UI/DiplomacyActionView.lua. Discovery is
--   DiplomacyManager.HasQueuedSession(pid) plus DiplomacyManager.FindOpenSessionID(pid,
--   other) / GetSessionInfo(sessionID). The live statement arrives on the
--   Events.DiplomacyStatement stream, so this module caches the last variants per session
--   the same way state.lua caches notification ids; nothing is mutated by listening.
--   Answers are DiplomacyManager.AddResponse(sessionID, pid, key) and
--   DiplomacyManager.AddStatement(sessionID, pid, key).
--   Selection keys come from the native DiplomacyStatements/DiplomacySelections tables
--   (DiplomacyStatementSupport.lua) filtered by GetDiplomacy():IsDiplomaticActionValid;
--   when that derivation is unavailable only the always-present generic responses are
--   listed, and the record says so rather than inventing keys.
-- ---------------------------------------------------------------------------
if not A.diplomacyStatementsInitialized then
  A.diplomacyStatements = {}
  local ok = pcall(function()
    Events.DiplomacyStatement.Add(function(fromPlayer, toPlayer, variants)
      if type(variants) ~= 'table' then return end
      local sessionID = variants.SessionID
      if sessionID == nil then return end
      A.diplomacyStatements[sessionID] = {
        fromPlayer = fromPlayer, toPlayer = toPlayer,
        statementType = variants.StatementType, statementSubType = variants.StatementSubType,
        fromPlayerMood = variants.FromPlayerMood, initiator = variants.Initiator,
        turn = Game.GetCurrentGameTurn(),
      }
    end)
  end)
  A.diplomacyStatementsInitialized = ok
  if not ok then A.diplomacyStatements = {} end
end

local GENERIC_RESPONSES = {
  {choice = 'POSITIVE', kindOfAnswer = 'response'},
  {choice = 'NEGATIVE', kindOfAnswer = 'response'},
  {choice = 'RESPONSE_IGNORE', kindOfAnswer = 'response'},
}

--- Reproduce the native selection lookup for one statement. Same fixed queries and same
--- IsDiplomaticActionValid gate as DiplomacyStatementSupport.lua; no model-supplied SQL.
local function statementSelections(ctx, cached, otherPlayerID)
  if cached == nil then return nil, 'No statement has been observed on this session since the bridge attached' end
  local typeName = A.static('diplomacy', DiplomacyManager, 'GetKeyName', cached.statementType)
  local subTypeName = A.static('diplomacy', DiplomacyManager, 'GetKeyName', cached.statementSubType)
  if type(typeName) ~= 'string' then return nil, 'Statement type could not be decoded' end
  if type(subTypeName) ~= 'string' then subTypeName = 'NONE' end
  local leader = 'ANY'
  local config = PlayerConfigurations and PlayerConfigurations[cached.fromPlayer]
  if config then
    local name = A.call('diplomacy', config, 'GetLeaderTypeName')
    if type(name) == 'string' then leader = name end
  end
  local mood = A.static('diplomacy', DiplomacyManager, 'GetKeyName', cached.fromPlayerMood)
  if type(mood) ~= 'string' then mood = 'ANY' end
  local initiator = 'HUMAN'
  if cached.initiator ~= nil and PlayerConfigurations and PlayerConfigurations[cached.initiator] then
    initiator = A.call('diplomacy', PlayerConfigurations[cached.initiator], 'IsHuman') == true and 'HUMAN' or 'AI'
  end
  local selectionsKey
  for _, leaderKey in ipairs({leader, 'ANY'}) do
    for _, moodKey in ipairs({mood, 'ANY'}) do
      if selectionsKey == nil then
        local rows = A.static('diplomacy', DB, 'Query',
          'SELECT Selections from DiplomacyStatements WHERE Type = ? AND SubType = ? AND Initiator = ? AND Leader = ? AND Mood = ?',
          typeName, subTypeName, initiator, leaderKey, moodKey)
        if type(rows) == 'table' then
          for _, row in ipairs(rows) do if row.Selections ~= nil then selectionsKey = row.Selections; break end end
        end
      end
    end
  end
  if selectionsKey == nil then return nil, 'No DiplomacySelections row matched this statement in this ruleset' end
  local diplomacy = A.call('diplomacy', ctx.player, 'GetDiplomacy')
  -- Without the manager, native selection legality is unknown rather than implicitly true.
  if diplomacy == A.null then
    A.unavailable('diplomacy', 'GetDiplomacy', 'Diplomacy manager unavailable')
    return nil, 'Diplomacy manager unavailable for native selection legality'
  end
  local options = A.array()
  for _, leaderKey in ipairs({leader, 'ANY'}) do
    for _, moodKey in ipairs({mood, 'ANY'}) do
      if #options == 0 then
        local rows = A.static('diplomacy', DB, 'Query',
          'SELECT Text, Tooltip, Key, Sort, DiplomaticActionType from DiplomacySelections WHERE Type = ? AND Leader = ? AND Mood = ?',
          selectionsKey, leaderKey, moodKey)
        if type(rows) == 'table' then
          for _, row in ipairs(rows) do
            local available, reasons = true, nil
            if row.DiplomaticActionType ~= nil and diplomacy ~= A.null then
              local ok, valid, results = pcall(function()
                return diplomacy:IsDiplomaticActionValid(row.DiplomaticActionType, otherPlayerID, true)
              end)
              available = ok and valid == true
              if not ok or type(valid) ~= 'boolean' then
                A.unavailable('diplomacy', 'IsDiplomaticActionValid', ok and 'Diplomatic selection legality unknown' or valid)
              end
              if ok then
                if not available and type(results) == 'table' and type(results.FailureReasons) == 'table' then
                  reasons = A.array()
                  for _, text in ipairs(results.FailureReasons) do reasons[#reasons+1] = A.loc(text) end
                end
              end
            end
            options[#options+1] = {choice = row.Key, available = available, label = A.loc(row.Text),
              tooltip = A.loc(row.Tooltip), diplomaticAction = row.DiplomaticActionType or A.null,
              reasons = reasons or A.null, kindOfAnswer = 'response'}
          end
        end
      end
    end
  end
  if #options == 0 then return nil, 'DiplomacySelections returned no rows for this statement' end
  return options, nil
end

local function diplomacyDecisions(ctx, out)
  if DiplomacyManager == nil then return A.unavailable('diplomacy', 'DiplomacyManager', 'Diplomacy namespace unavailable') end
  local queued = A.static('diplomacy', DiplomacyManager, 'HasQueuedSession', ctx.pid)
  -- A missing player manager cannot answer HasMet or native selection legality.
  local diplomacy = A.call('diplomacy', ctx.player, 'GetDiplomacy')
  if diplomacy == A.null then return A.unavailable('diplomacy', 'GetDiplomacy', 'Diplomacy manager unavailable') end
  local seen, found = {}, 0
  for other = 0, 63 do
    if other ~= ctx.pid and Players and Players[other] and A.call('diplomacy', diplomacy, 'HasMet', other) == true then
      local sessionID = A.static('diplomacy', DiplomacyManager, 'FindOpenSessionID', ctx.pid, other)
      if type(sessionID) == 'number' and not seen[sessionID] then
        seen[sessionID] = true
        local info = A.static('diplomacy', DiplomacyManager, 'GetSessionInfo', sessionID)
        local cached = A.diplomacyStatements[sessionID]
        local options, note = statementSelections(ctx, cached, other)
        if options == nil then
          options = A.array()
          for _, generic in ipairs(GENERIC_RESPONSES) do
            options[#options+1] = {choice = generic.choice, available = true, kindOfAnswer = 'response',
              label = generic.choice, generic = true}
          end
        end
        local config = PlayerConfigurations and PlayerConfigurations[other]
        found = found + 1
        out[#out+1] = {
          key = tostring(sessionID),
          kind = 'diplomacy', actionType = 'diplomacy', operation = 'response',
          operations = A.array{'response','statement'},
          label = 'Diplomacy session with '..(config and tostring(A.loc(A.call('diplomacy', config, 'GetLeaderName'))) or ('player '..other)),
          mandatory = true,
          blocks = false,
          uiBlocking = true,
          sessionId = sessionID,
          otherPlayerId = other,
          initiatedBy = (type(info) == 'table' and info.FromPlayer ~= nil) and info.FromPlayer or A.null,
          statementType = cached and A.static('diplomacy', DiplomacyManager, 'GetKeyName', cached.statementType) or A.null,
          statementSubType = cached and A.static('diplomacy', DiplomacyManager, 'GetKeyName', cached.statementSubType) or A.null,
          selectionSource = note == nil and 'native_diplomacy_tables' or 'generic_responses_only',
          selectionNote = note or A.null,
          options = options,
          choiceHelp = 'choice=<selection key> answers with DiplomacyManager.AddResponse. operation="statement" with key=<STATEMENT> uses AddStatement instead (MAKE_PEACE, MAKE_DEAL, DECLARE_FORMAL_WAR, ...). A diplomacy window is live shared UI: it blocks native input until answered.',
        }
      end
    end
  end
  if queued == true and found == 0 then
    out[#out+1] = {
      key = 'queued',
      kind = 'diplomacy', actionType = 'diplomacy', operation = 'response',
      operations = A.array{'response','statement'},
      label = 'A diplomacy session is queued but not yet open',
      mandatory = false, blocks = false, uiBlocking = true,
      options = A.array(),
      choiceHelp = 'No open session id yet; observe again once the native window opens.',
    }
  end
end

local function diplomacySubmit(ctx, operation, sessionId, key)
  assert(DiplomacyManager ~= nil, 'DiplomacyManager is unavailable in this context')
  local session = number(sessionId)
  assert(session ~= nil, 'diplomacy needs sessionId from civ.decisions')
  assert(type(key) == 'string' and key ~= '', 'diplomacy needs key=<selection or statement key>')
  local info = A.static('diplomacy', DiplomacyManager, 'GetSessionInfo', session)
  if info == A.null then
    return refused('illegal', 'Diplomacy session '..session..' is no longer open; call civ.decisions again', {sessionId = session})
  end
  if operation == 'response' then
    return submit({{label = 'AddResponse '..key, run = function()
      return request(DiplomacyManager.AddResponse, session, ctx.pid, key)
    end}})
  elseif operation == 'statement' then
    return submit({{label = 'AddStatement '..key, run = function()
      return request(DiplomacyManager.AddStatement, session, ctx.pid, key)
    end}})
  end
  error('diplomacy operation must be response or statement')
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
  ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN = {subject='envoy', actionType=nil,
    note='Envoy assignment has no verified bridge handler; use the native City-States screen.'},
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
local COLLECTORS = {
  commemoration = commemorationDecisions,
  pantheon = pantheonDecisions,
  great_person = greatPeopleDecisions,
  governor = governorDecisions,
  religion = religionDecisions,
  city_fate = cityFateDecisions,
  congress = congressDecisions,
  espionage = espionageDecisions,
  diplomacy = diplomacyDecisions,
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
  cityId=true, sessionId=true, governor=true, individual=true, stage=true, source=true,
}
local function summarise(record)
  local out = {}
  for key, value in pairs(record) do if SUMMARY_KEEP[key] then out[key] = value end end
  local options = record.options
  out.optionCount = type(options) == 'table' and #options or 0
  local legal = 0
  if type(options) == 'table' then
    for _, option in ipairs(options) do if option.available then legal = legal + 1 end end
  end
  out.availableOptionCount = legal
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
  local all = collect(ctx, kindFilter)
  local matched = A.array()
  for _, record in ipairs(all) do
    if wanted == nil or record.id == wanted then matched[#matched+1] = record end
  end
  local decisions = A.array()
  for index = offset + 1, math.min(#matched, offset + limit) do
    local record = matched[index]
    decisions[#decisions+1] = (detail == 'full') and record or summarise(record)
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
    note = detail == 'summary'
      and 'Summary rows carry ids, blocking status and option counts only. Use detail="full" or id=<decision id> for options, costs and descriptions. Popup observations are merged in by the bridge and use popup: ids.'
      or A.null,
  }
end

-- ---------------------------------------------------------------------------
-- Answering. civ.decide re-collects the decision from live native state before
-- submitting, so a choice read one round trip ago is revalidated, not trusted.
-- ---------------------------------------------------------------------------
local function dispatch(ctx, args)
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
  elseif kind == 'espionage' then
    return espionageSubmit(ctx, args.operation, args.unitId, args.district, args.operationType, args.x, args.y, args.cityId)
  elseif kind == 'diplomacy' then
    return diplomacySubmit(ctx, args.operation, args.sessionId, args.key)
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

function A.decide(args)
  args = args or {}
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
  elseif kind == 'espionage' then
    call = decideEspionage(record, choice)
  else
    assert(type(choice) == 'string', 'This decision needs choice=<selection key>')
    local operation = args.operation or 'response'
    -- Only validate against the option list when it really came from the native tables;
    -- the generic fallback is not a complete list and must not reject a valid key.
    if operation == 'response' and record.selectionSource == 'native_diplomacy_tables' then
      local option = pickOption(record, choice)
      assert(option ~= nil and option.available, 'choice must be an available selection key from this session')
    end
    call = {type='diplomacy', operation=operation, sessionId=record.sessionId, key=choice}
  end
  local result = dispatch(ctx, call)
  result.id = args.id
  result.kind = kind
  return result
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
    fields={operation='string', individual='GreatPersonIndividualType', currency='gold|faith (patronize)'},
    native='PlayerOperations.RECRUIT_GREAT_PERSON / REJECT_GREAT_PERSON / PATRONIZE_GREAT_PERSON'},
  governor = {operations=A.array{'appoint','assign','promote'},
    fields={operation='string', governor='GovernorType', promotion='GovernorPromotionType (promote)', cityId='cityId encoding the destination owner (assign)'},
    native='PlayerOperations.APPOINT_GOVERNOR / ASSIGN_GOVERNOR / PROMOTE_GOVERNOR'},
  religion = {operations=A.array{'found','belief'},
    fields={operation='string', religion='ReligionType (found)', name='string (found, when required)', belief='BeliefType', beliefs='BeliefType[]'},
    native='PlayerOperations.FOUND_RELIGION plus one ADD_BELIEF per belief'},
  city_fate = {operations=A.array{'keep','raze','liberate_founder','liberate_previous_owner','reject'},
    fields={operation='string', cityId='cityId'},
    native='CityManager.RequestCommand(city, CityCommandTypes.DESTROY, {PARAM_FLAGS=CityDestroyDirectives.*})'},
  congress = {operations=A.array{'vote','proposal','submit'},
    fields={operation='string', votes='vote entry[]', proposals='proposal entry[]'},
    native='PlayerOperations.WORLD_CONGRESS_RESOLUTION_VOTE / WORLD_CONGRESS_DISCUSSION_VOTE / WORLD_CONGRESS_DISCUSSION_SELECTION / WORLD_CONGRESS_SUBMIT_TURN. Never sends ACTION_ENDTURN.'},
  espionage = {operations=A.array{'mission','escape','travel'},
    fields={operation='string', unitId='unitId', operationType='spy UnitOperation short name (mission)', x='integer', y='integer', district='DistrictType (escape)', cityId='destination city (travel) or the legality plot for an untargeted mission'},
    native='UnitManager.RequestOperation for missions/travel, PlayerOperations.SET_ESCAPE_ROUTE for escape'},
  diplomacy = {operations=A.array{'response','statement'},
    fields={operation='string', sessionId='integer', key='selection or statement key'},
    native='DiplomacyManager.AddResponse / AddStatement'},
}

function A.decisionAction(args)
  assert(type(args) == 'table' and type(args.type) == 'string', 'Decision action requires type')
  assert(A.decisionActionTypes[args.type] ~= nil, 'Not a supported decision action type: '..tostring(args.type))
  local ctx = context()
  local result = dispatch(ctx, args)
  result.type = args.type
  return result
end
