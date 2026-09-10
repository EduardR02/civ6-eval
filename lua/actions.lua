-- Trusted FireTuner module. No player-supplied source is evaluated.
-- Native legal requests only. Operation identity is always a GameInfo Hash: the
-- UnitOperationTypes/UnitCommandTypes globals expose only a subset of the ruleset
-- (HEAL, SLEEP and SKIP_TURN are absent there), so name-based dispatch silently
-- refused operations the ruleset really has.
local A = AstraCiv
local MAX_BATCH = 64

local SUBMIT_NOTE = 'Native request queued. Accepted means submitted, not completed: observe refreshed state before deciding the outcome.'

local function rule(tableName, key)
  assert(type(key) == 'string', 'Provide a GameInfo type string for '..tableName)
  local row = GameInfo[tableName] and GameInfo[tableName][key]
  assert(row, 'Unknown '..tableName..' type: '..tostring(key))
  return row
end

local function illegal(reason, namespace, results, extra)
  local decoded = namespace and A.results(namespace, results) or {}
  local out = extra or {}
  out.accepted, out.completed, out.status = false, false, 'illegal'
  out.reason = reason
  out.reasons = decoded.reasons or A.array()
  out.notes = decoded.notes
  return out
end

-- Inside a batch the caller reports one turnState for the whole run, so per-item reads are skipped.
local inBatch = false
local function turnStateUnlessBatched()
  if inBatch then return nil end
  return A.turnState()
end

--- Every mutation answers in this shape. `observed` is a targeted post-submission read of the
--- entity acted on; it is not a completion claim and says nothing about other entities.
local function submitted(observed)
  local out = {accepted = true, completed = false, status = 'submitted', turnState = turnStateUnlessBatched(), note = SUBMIT_NOTE}
  if observed ~= nil then out.observed = observed end
  return out
end

local function coordinates(x, y, pid, requireVisible)
  assert(type(x) == 'number' and type(y) == 'number' and x % 1 == 0 and y % 1 == 0, 'x/y must be integer map coordinates')
  local width, height = Map.GetGridSize()
  assert(x >= 0 and x < width and y >= 0 and y < height, 'Target coordinates are outside the map')
  if requireVisible then
    assert(PlayersVisibility[pid]:IsVisible(x, y), 'Target must be currently visible to this player')
  end
end

-- Argument name -> native parameter key, shared with A.unitOperationSpecs so discovery and
-- dispatch describe the same request.
local operationParams = {
  x = 'PARAM_X', y = 'PARAM_Y',
  destinationX = 'PARAM_X0', destinationY = 'PARAM_Y0',
  improvement = 'PARAM_IMPROVEMENT_TYPE',
}

local function operationFor(name)
  assert(type(name) == 'string' and name ~= '', 'operation must be a GameInfo UnitOperations name')
  local row = A.unitOperationRow(name)
  assert(row, 'Unit operation is not present in this ruleset: '..name)
  local short = A.shortName(row.OperationType, 'UNITOPERATION_')
  local spec = A.unitOperationSpecs[short]
  assert(spec, 'Unit operation '..short..' exists in this ruleset but this bridge has no verified parameter handling for it; use the native GUI.')
  return row, spec, short
end

local function commandFor(name)
  assert(type(name) == 'string' and name ~= '', 'command must be a GameInfo UnitCommands name')
  local row = A.unitCommandRow(name)
  assert(row, 'Unit command is not present in this ruleset: '..name)
  local short = A.shortName(row.CommandType, 'UNITCOMMAND_')
  local spec = A.unitCommandSpecs[short]
  assert(spec, 'Unit command '..short..' exists in this ruleset but this bridge has no verified parameter handling for it; use the native GUI.')
  return row, spec, short
end

--- Encode a unit operation's declared fields into native parameters.
local function operationParameters(spec, args, pid)
  local parameters = {}
  local wantsX, wantsY = spec.fields.x ~= nil, spec.fields.destinationX ~= nil
  for field, codec in pairs(spec.fields) do
    local value = args[field]
    assert(value ~= nil, 'Operation requires '..field)
    local key = operationParams[field]
    assert(key, 'No native parameter mapping for '..field)
    if codec == 'integer' then
      parameters[A.param(UnitOperationTypes, key)] = value
    elseif codec == 'ImprovementType' then
      parameters[A.param(UnitOperationTypes, key)] = rule('Improvements', value).Hash
    elseif codec == 'unitId' then
      local other = A.ownedEntity('unit', value, pid)
      parameters[A.param(UnitOperationTypes, 'PARAM_UNIT_PLAYER')] = pid
      parameters[A.param(UnitOperationTypes, 'PARAM_UNIT_ID')] = other:GetID()
    else
      error('Unsupported parameter codec '..tostring(codec))
    end
  end
  if wantsX then coordinates(args.x, args.y, pid, spec.target == 'visible_coordinate') end
  if wantsY then coordinates(args.destinationX, args.destinationY, pid, spec.target == 'visible_coordinate') end
  return parameters
end

--- Melee attacks move onto the target plot, but a bare MOVE_TO path-moves WITHOUT attacking:
--- PARAM_MODIFIERS defaults to NONE. Base/Assets/UI/Civ6Common.lua RequestMoveOperation sets
--- ATTACK (plus MOVE_IGNORE_UNEXPLORED_DESTINATION) before requesting the move. Omitting it is
--- why melee requests were accepted and then did nothing.
local function moveModifiers(attack)
  local namespace = UnitOperationMoveModifiers
  local key = A.param(UnitOperationTypes, 'PARAM_MODIFIERS')
  if not attack then
    if type(namespace) == 'table' and type(namespace.NONE) == 'number' then return key, namespace.NONE end
    return nil
  end
  assert(type(namespace) == 'table' and type(namespace.ATTACK) == 'number',
    'UnitOperationMoveModifiers.ATTACK is unavailable in this ruleset. Refusing to submit a plain move that would not attack.')
  local value = namespace.ATTACK
  if type(namespace.MOVE_IGNORE_UNEXPLORED_DESTINATION) == 'number' then
    value = value + namespace.MOVE_IGNORE_UNEXPLORED_DESTINATION
  end
  return key, value
end

local function startOperation(unit, row, parameters, observe)
  local legal, results = UnitManager.CanStartOperation(unit, row.Hash, nil, parameters, true)
  if not legal then return illegal('Engine CanStartOperation rejected this request', UnitOperationResults, results, {turnState = turnStateUnlessBatched()}) end
  local accepted = UnitManager.RequestOperation(unit, row.Hash, parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(observe and A.section('observed', function() return A.unitRecord(unit, true) end) or nil)
end

local function startCommand(unit, row, parameters, observe)
  local legal, results = UnitManager.CanStartCommand(unit, row.Hash, parameters, false, true)
  if not legal then return illegal('Engine CanStartCommand rejected this request', UnitCommandResults, results, {turnState = turnStateUnlessBatched()}) end
  local accepted = UnitManager.RequestCommand(unit, row.Hash, parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(observe and A.section('observed', function() return A.unitRecord(unit, true) end) or nil)
end

local function cityObservation(city)
  return A.section('observed', function() return A.cityRecord(city, true) end)
end

-- ---------------------------------------------------------------- action types

local handlers = {}

handlers.move = function(args, pid)
  local unit = A.ownedEntity('unit', args.unitId, pid)
  local row = A.unitOperationRow('MOVE_TO')
  assert(row, 'MOVE_TO is unavailable in this ruleset')
  coordinates(args.x, args.y, pid, false)
  local parameters = {}
  parameters[A.param(UnitOperationTypes, 'PARAM_X')] = args.x
  parameters[A.param(UnitOperationTypes, 'PARAM_Y')] = args.y
  -- A move never starts a war by accident; attacking is an explicit action type.
  local key, value = moveModifiers(false)
  if key then parameters[key] = value end
  local result = startOperation(unit, row, parameters, true)
  if result.status == 'illegal' then
    -- The engine rejects moving onto an occupied plot; name the operations that would apply.
    local swap = A.unitOperationRow('SWAP_UNITS')
    if swap then
      local swapParameters = {}
      swapParameters[A.param(UnitOperationTypes, 'PARAM_X')] = args.x
      swapParameters[A.param(UnitOperationTypes, 'PARAM_Y')] = args.y
      if UnitManager.CanStartOperation(unit, swap.Hash, nil, swapParameters, false) then
        result.alternative = 'This plot holds one of your own units. unit_operation SWAP_UNITS is currently legal for it.'
      end
    end
  end
  return result
end

handlers.attack = function(args, pid)
  local unit = A.ownedEntity('unit', args.unitId, pid)
  assert(args.mode == 'melee' or args.mode == 'ranged' or args.mode == 'air', 'attack mode must be melee, ranged or air')
  coordinates(args.x, args.y, pid, true)
  local name = args.mode == 'melee' and 'MOVE_TO' or (args.mode == 'air' and 'AIR_ATTACK' or 'RANGE_ATTACK')
  local row = A.unitOperationRow(name)
  assert(row, 'Attack operation '..name..' is unavailable in this ruleset')
  local parameters = {}
  parameters[A.param(UnitOperationTypes, 'PARAM_X')] = args.x
  parameters[A.param(UnitOperationTypes, 'PARAM_Y')] = args.y
  local key, value = moveModifiers(args.mode ~= 'ranged')
  if key then parameters[key] = value end
  return startOperation(unit, row, parameters, true)
end

handlers.found = function(args, pid)
  local unit = A.ownedEntity('unit', args.unitId, pid)
  local row = A.unitOperationRow('FOUND_CITY')
  assert(row, 'FOUND_CITY is unavailable in this ruleset')
  return startOperation(unit, row, {}, true)
end

handlers.unit_operation = function(args, pid)
  local unit = A.ownedEntity('unit', args.unitId, pid)
  local row, spec = operationFor(args.operation)
  assert(not spec.nativeUiOnly, 'Operation '..args.operation..' needs the native GUI in this bridge; it is not submitted here.')
  return startOperation(unit, row, operationParameters(spec, args, pid), true)
end

handlers.unit_command = function(args, pid)
  local unit = A.ownedEntity('unit', args.unitId, pid)
  local row, spec, short = commandFor(args.command)
  local parameters = {}
  if short == 'FORM_CORPS' or short == 'FORM_ARMY' or short == 'ENTER_FORMATION' then
    local other = A.ownedEntity('unit', args.targetUnitId, pid)
    parameters[A.param(UnitCommandTypes, 'PARAM_UNIT_PLAYER')] = pid
    parameters[A.param(UnitCommandTypes, 'PARAM_UNIT_ID')] = other:GetID()
  end
  if short == 'PROMOTE' then
    parameters[A.param(UnitCommandTypes, 'PARAM_PROMOTION_TYPE')] = rule('UnitPromotions', args.promotion).Hash
  end
  return startCommand(unit, row, parameters, true)
end

local productionTables = {unit = 'Units', building = 'Buildings', district = 'Districts', project = 'Projects'}

handlers.production = function(args, pid)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local city = A.ownedEntity('city', args.cityId, pid)
  assert(productionTables[args.kind], 'kind must be unit, building, district or project')
  local row = rule(productionTables[args.kind], args.item)
  local parameters = {}
  parameters[A.param(CityOperationTypes, 'PARAM_'..args.kind:upper()..'_TYPE')] = row.Hash
  if args.x ~= nil or args.y ~= nil then
    coordinates(args.x, args.y, pid, false)
    parameters[A.param(CityOperationTypes, 'PARAM_X')] = args.x
    parameters[A.param(CityOperationTypes, 'PARAM_Y')] = args.y
  end
  assert(args.mode == nil or args.mode == 'replace' or args.mode == 'append', 'production mode must be replace or append')
  if args.mode == 'append' then
    parameters[A.param(CityOperationTypes, 'PARAM_INSERT_MODE')] = A.param(CityOperationTypes, 'VALUE_APPEND')
  else
    parameters[A.param(CityOperationTypes, 'PARAM_INSERT_MODE')] = A.param(CityOperationTypes, 'VALUE_REPLACE_AT')
    parameters[A.param(CityOperationTypes, 'PARAM_QUEUE_DESTINATION_LOCATION')] = 0
  end
  if A.call('production', city:GetBuildQueue(), 'CanProduce', row.Hash, false) ~= true then
    return illegal('Engine build queue rejected this item; its prerequisites are not met', nil, nil, {turnState = turnStateUnlessBatched()})
  end
  -- The build request is the native authority for placement legality; it never grants free production.
  local accepted = CityManager.RequestOperation(city, CityOperationTypes.BUILD, parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(cityObservation(city))
end

handlers.purchase = function(args, pid)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local city = A.ownedEntity('city', args.cityId, pid)
  assert(args.kind == 'unit' or args.kind == 'building' or args.kind == 'district', 'purchase kind must be unit, building or district')
  assert(args.currency == 'gold' or args.currency == 'faith', 'purchase currency must be gold or faith')
  local row = rule(productionTables[args.kind], args.item)
  local parameters = {}
  parameters[A.param(CityCommandTypes, 'PARAM_'..args.kind:upper()..'_TYPE')] = row.Hash
  parameters[A.param(CityCommandTypes, 'PARAM_YIELD_TYPE')] = GameInfo.Yields['YIELD_'..args.currency:upper()].Index
  if args.kind == 'unit' then
    parameters[A.param(CityCommandTypes, 'PARAM_MILITARY_FORMATION_TYPE')] = MilitaryFormationTypes.STANDARD_MILITARY_FORMATION
  end
  if args.x ~= nil or args.y ~= nil then
    coordinates(args.x, args.y, pid, false)
    parameters[A.param(CityCommandTypes, 'PARAM_X')] = args.x
    parameters[A.param(CityCommandTypes, 'PARAM_Y')] = args.y
  end
  local legal, results = CityManager.CanStartCommand(city, CityCommandTypes.PURCHASE, false, parameters, true)
  if not legal then return illegal('Engine rejected the purchase (cost, placement or prerequisites)', CityCommandResults, results, {turnState = turnStateUnlessBatched()}) end
  local accepted = CityManager.RequestCommand(city, CityCommandTypes.PURCHASE, parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(cityObservation(city))
end

--- Citizen focus is the one city command whose parameter values the native source states literally
--- (Base/Assets/UI/Panels/CityPanel.lua:444-477: PARAM_FLAGS 0=favored/1=ignored, PARAM_DATA0 as a
--- 0/1 boolean). Tile purchase, MANAGE and SWAP_TILE_OWNER read their values from the interface
--- mode instead, so they are deliberately not advertised here.
handlers.city_command = function(args, pid)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local city = A.ownedEntity('city', args.cityId, pid)
  assert(args.operation == 'SET_FOCUS', 'city_command supports SET_FOCUS; other city commands need the native GUI in this bridge.')
  assert(args.mode == 'favored' or args.mode == 'ignored', 'SET_FOCUS mode must be favored or ignored')
  assert(type(args.enabled) == 'boolean', 'SET_FOCUS requires enabled=true/false')
  local yield = GameInfo.Yields[args.yield]
  assert(yield, 'Unknown yield type: '..tostring(args.yield))
  local parameters = {}
  parameters[A.param(CityCommandTypes, 'PARAM_FLAGS')] = args.mode == 'favored' and 0 or 1
  parameters[A.param(CityCommandTypes, 'PARAM_YIELD_TYPE')] = yield.Index
  parameters[A.param(CityCommandTypes, 'PARAM_DATA0')] = args.enabled and 1 or 0
  local accepted = CityManager.RequestCommand(city, CityCommandTypes.SET_FOCUS, parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(cityObservation(city))
end

handlers.city_attack = function(args, pid)
  local city = A.ownedEntity('city', args.cityId, pid)
  coordinates(args.x, args.y, pid, true)
  local parameters = {}
  parameters[A.param(CityCommandTypes, 'PARAM_X')] = args.x
  parameters[A.param(CityCommandTypes, 'PARAM_Y')] = args.y
  local legal, results = CityManager.CanStartCommand(city, CityCommandTypes.RANGE_ATTACK, false, parameters, true)
  if not legal then return illegal('Engine rejected the city ranged attack', CityCommandResults, results, {turnState = turnStateUnlessBatched()}) end
  local accepted = CityManager.RequestCommand(city, CityCommandTypes.RANGE_ATTACK, parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(cityObservation(city))
end

local function playerResearch(args, pid, player, isTech)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local row = rule(isTech and 'Technologies' or 'Civics', args.item)
  local subsystem = isTech and player:GetTechs() or player:GetCulture()
  local can = isTech and subsystem:CanResearch(row.Index) or subsystem:CanProgress(row.Index)
  if can ~= true then
    return illegal((isTech and 'Technology' or 'Civic')..' is not currently selectable', nil, nil, {turnState = turnStateUnlessBatched()})
  end
  local parameters = {}
  parameters[A.param(PlayerOperations, isTech and 'PARAM_TECH_TYPE' or 'PARAM_CIVIC_TYPE')] = row.Hash
  parameters[A.param(PlayerOperations, 'PARAM_INSERT_MODE')] = A.param(PlayerOperations, 'VALUE_EXCLUSIVE')
  local accepted = UI.RequestPlayerOperation(pid, A.param(PlayerOperations, isTech and 'RESEARCH' or 'PROGRESS_CIVIC'), parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted()
end

handlers.research = function(args, pid, player) return playerResearch(args, pid, player, true) end
handlers.civic = function(args, pid, player) return playerResearch(args, pid, player, false) end

handlers.government = function(args, pid, player)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local culture = player:GetCulture()
  if culture:CanChangeGovernmentAtAll() ~= true then
    return illegal('Government cannot be changed right now', nil, nil, {turnState = turnStateUnlessBatched()})
  end
  local accepted = culture:RequestChangeGovernment(rule('Governments', args.item).Hash)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted()
end

--- Partial policy changes. RequestPolicyChanges takes the complete final assignment (the native
--- screen clears every slot, then re-adds all of them: GovernmentScreen.lua OnConfirmPolicies), so
--- untouched slots are read back and preserved rather than silently emptied.
handlers.policies = function(args, pid, player)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local culture = player:GetCulture()
  local count = culture:GetNumPolicySlots()
  assert(type(args.slots) == 'table' and #args.slots > 0,
    'Provide slots={{slot=<zero-based>, policy="POLICY_*" or nil to clear}, ...} for the slots you are changing')
  if not ((culture:CivicCompletedThisTurn() or culture:GetNumPolicySlotsOpen() > 0) and not culture:PolicyChangeMade()) then
    return illegal('Policies are locked right now. unlock_policies pays the native cost; this action never pays it implicitly.',
      nil, nil, {turnState = turnStateUnlessBatched()})
  end
  local final = {}
  for slot = 0, count - 1 do
    local index = A.call('policies', culture, 'GetSlotPolicy', slot)
    if type(index) == 'number' and index >= 0 then
      local row = A.row('Policies', index)
      if row ~= A.null then final[slot] = row end
    end
  end
  local seen = {}
  for _, entry in ipairs(args.slots) do
    local slot = entry.slot
    assert(type(slot) == 'number' and slot % 1 == 0 and slot >= 0 and slot < count and not seen[slot],
      'Duplicate or out-of-range policy slot; slots are zero-based and this government has '..count)
    seen[slot] = true
    if entry.policy == nil or entry.policy == A.null then
      final[slot] = nil
    else
      local row = rule('Policies', entry.policy)
      assert(culture:IsPolicyUnlocked(row.Index), 'Policy is not unlocked: '..entry.policy)
      final[slot] = row
    end
  end
  local used, clear, add = {}, {}, {}
  for slot, row in pairs(final) do
    assert(not used[row.Hash], 'Duplicate policy in the resulting assignment: '..row.PolicyType)
    used[row.Hash] = true
    local slotRow = GameInfo.GovernmentSlots[culture:GetSlotType(slot)]
    assert(slotRow, 'Government slot type is unavailable for slot '..slot)
    assert(slotRow.GovernmentSlotType == 'SLOT_WILDCARD' or slotRow.GovernmentSlotType == row.GovernmentSlotType,
      'Policy '..row.PolicyType..' does not fit slot '..slot..' ('..slotRow.GovernmentSlotType..')')
  end
  for slot = 0, count - 1 do
    clear[#clear + 1] = slot
    if final[slot] then add[slot] = final[slot].Hash end
  end
  local accepted = culture:RequestPolicyChanges(clear, add)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted()
end

handlers.unlock_policies = function(args, pid)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local accepted = UI.RequestPlayerOperation(pid, A.param(PlayerOperations, 'UNLOCK_POLICIES'), {})
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted()
end

local TACTICAL = {move = true, attack = true, found = true, unit_operation = true, unit_command = true}

--- Local action types this module implements. A.capabilities merges this with the decision
--- module's own table at call time so the probe never advertises an absent handler.
A.actionTypes = {
  move = true, attack = true, found = true, unit_operation = true, unit_command = true,
  production = true, purchase = true, city_command = true, city_attack = true,
  research = true, civic = true, government = true, policies = true, unlock_policies = true,
  end_turn = true,
}

--- Dispatch one already-validated action. Returns the mutation envelope; raises on argument
--- problems so the caller can report an unknown outcome distinctly from a legal rejection.
local function dispatch(args)
  local pid, player = A.localPlayer()
  local kind = args.type
  if kind == 'end_turn' then
    local before = A.turnState()
    if before.processing == true or before.active == false or before.submitted == true or A.endTurnSubmitted == before.turn then
      return {accepted = false, completed = false, status = 'processing_or_already_submitted', turnState = before}
    end
    assert(before.canEndTurn ~= A.null and before.firstBlocker ~= A.null, 'End-turn safety APIs are unavailable; use the native GUI')
    if before.canEndTurn ~= true or before.firstBlocker ~= EndTurnBlockingTypes.NO_ENDTURN_BLOCKING then
      return {accepted = false, completed = false, status = 'blocked', turnState = before}
    end
    A.endTurnSubmitted = before.turn
    UI.RequestAction(ActionTypes.ACTION_ENDTURN)
    return {accepted = true, completed = false, status = 'submitted', turnState = turnStateUnlessBatched(),
      note = 'Submission is not turn completion. Refresh until the turn advances; never resubmit this turn.'}
  end
  local before = A.turnState()
  assert(before.active == true and before.processing == false and before.submitted == false,
    'The local turn is not ready for actions; wait for processing to finish and refresh')
  assert(Game.IsAllowStrategicCommands(pid) or Game.IsAllowTacticalCommands(pid), 'Engine currently disallows local commands')
  if TACTICAL[kind] then assert(Game.IsAllowTacticalCommands(pid), 'Tactical commands are unavailable in the current phase') end
  local handler = handlers[kind]
  if handler then return handler(args, pid, player) end
  -- Decision families live in decisions.lua and are only dispatched when that module published them.
  if type(A.decisionActionTypes) == 'table' and A.decisionActionTypes[kind] and type(A.decisionAction) == 'function' then
    return A.decisionAction(args)
  end
  local names = {}
  for name in pairs(A.actionTypes) do names[#names + 1] = name end
  if type(A.decisionActionTypes) == 'table' then for name in pairs(A.decisionActionTypes) do names[#names + 1] = name end end
  table.sort(names)
  error('Unsupported action type: '..tostring(kind)..'. Supported: '..table.concat(names, ', ')..
    '. Use civ.probe for the generated catalog and civ.options for what is legal now.')
end

--- Batch semantics. A batch is NOT a transaction: each item is an independent native request and
--- the engine may not have processed earlier ones. An unknown acknowledgement always stops
--- admission of later items regardless of stopOnError, because their preconditions are unknown.
local function runBatch(args)
  local actions = args.actions
  assert(type(actions) == 'table' and #actions > 0, 'actions must be a nonempty array of action objects')
  assert(#actions <= MAX_BATCH, 'A batch may contain at most '..MAX_BATCH..' actions; a partially executed batch is never replayed')
  local stopOnError = args.stopOnError ~= false
  local results, submittedCount, stoppedAt = A.array(), 0, A.null
  inBatch = true
  for index, action in ipairs(actions) do
    assert(type(action) == 'table' and type(action.type) == 'string' and action.type ~= '', 'actions['..index..'] needs a type')
    assert(action.type ~= 'end_turn' or index == #actions, 'end_turn may only be the last action in a batch')
  end
  for index, action in ipairs(actions) do
    if stoppedAt ~= A.null then
      results[#results + 1] = {index = index, type = action.type, status = 'not_attempted'}
    else
      if args.expectedTurn ~= nil then
        local now = Game.GetCurrentGameTurn()
        if now ~= args.expectedTurn then
          results[#results + 1] = {index = index, type = action.type, status = 'not_attempted',
            reason = 'Turn changed to '..tostring(now)..' during the batch'}
          stoppedAt = index
        end
      end
      if stoppedAt == A.null then
        local ok, outcome = pcall(dispatch, action)
        if ok then
          outcome.index, outcome.type = index, action.type
          outcome.turnState = nil -- one turnState for the batch, not one per item
          results[#results + 1] = outcome
          if outcome.status == 'submitted' then submittedCount = submittedCount + 1
          elseif stopOnError then stoppedAt = index end
        else
          -- The request may or may not have reached the engine. Nothing after it can assume
          -- its preconditions, and it is never replayed.
          results[#results + 1] = {index = index, type = action.type, status = 'unknown',
            reason = tostring(outcome),
            note = 'Outcome unknown: this request may or may not have been applied. It was NOT replayed.'}
          stoppedAt = index
        end
      end
    end
  end
  inBatch = false
  return {
    turn = Game.GetCurrentGameTurn(), results = results, submitted = submittedCount,
    stoppedAt = stoppedAt, count = #actions, turnState = A.turnState(),
    note = 'Batches are not transactions and are never replayed. Accepted items are submitted, not completed; '..
      'an unknown acknowledgement stops later items regardless of stopOnError. Observed records cover only the '..
      'entity acted on and imply nothing about combat results, other entities, economy or visibility.',
  }
end

function A.action(args)
  inBatch = false -- a batch that raised during validation must not suppress the next call's turnState
  assert(type(args) == 'table', 'civ.action requires an argument table')
  if args.actions ~= nil then
    assert(args.type == nil, 'Pass a single action (type=...) or a batch (actions=[...]), not both')
    return runBatch(args)
  end
  assert(type(args.type) == 'string' and args.type ~= '', 'Action requires type; use civ.probe for the generated catalog')
  if args.expectedTurn ~= nil then
    assert(args.expectedTurn == Game.GetCurrentGameTurn(), 'Turn changed; refresh observations before submitting this action')
  end
  return dispatch(args)
end
