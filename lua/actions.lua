-- Trusted FireTuner module. No player-supplied source is evaluated.
-- Native legal requests only. Operation identity is always a GameInfo Hash: the
-- UnitOperationTypes/UnitCommandTypes globals expose only a subset of the ruleset
-- (HEAL, SLEEP and SKIP_TURN are absent there), so name-based dispatch silently
-- refused operations the ruleset really has.
local A = AstraCiv
local MAX_BATCH = 64


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
  -- `status = 'submitted'` is the whole statement. The contract that submission is not completion
  -- is in the system prompt and in civ.probe; repeating it on every accepted request was not
  -- making it truer.
  local out = {accepted = true, completed = false, status = 'submitted', turnState = turnStateUnlessBatched()}
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
local function operationParameters(spec, args, pid, unit)
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
  if spec == A.unitOperationSpecs.MAKE_TRADE_ROUTE then
    -- TradeRouteChooser.lua:829-835 sends the trader's current tile as the origin, in addition
    -- to destination X0/Y0, for both its legality check and its request.
    parameters[A.param(UnitOperationTypes, 'PARAM_X1')] = unit:GetX()
    parameters[A.param(UnitOperationTypes, 'PARAM_Y1')] = unit:GetY()
  end
  if spec.currentPlot and unit ~= nil and type(UnitOperationTypes) == 'table'
    and UnitOperationTypes.PARAM_X ~= nil and UnitOperationTypes.PARAM_Y ~= nil then
    -- Native build operations carry the unit's own tile (GetBuildImprovementParameters, UnitPanel.lua:346-351).
    parameters[UnitOperationTypes.PARAM_X] = unit:GetX()
    parameters[UnitOperationTypes.PARAM_Y] = unit:GetY()
  end
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

--- Native operation shape: a parameterless operation is checked and requested with no parameter table
--- (UnitPanel.lua:676-678, :2621-2647).
local function startOperation(unit, row, parameters, observe)
  local hasParameters = next(parameters) ~= nil
  local legal, results = UnitManager.CanStartOperation(unit, row.Hash, nil, hasParameters and parameters or false, true)
  if not legal then return illegal('Engine CanStartOperation rejected this request', UnitOperationResults, results, {turnState = turnStateUnlessBatched()}) end
  local accepted
  if hasParameters then accepted = A.mutate(UnitManager.RequestOperation, unit, row.Hash, parameters)
  else accepted = A.mutate(UnitManager.RequestOperation, unit, row.Hash) end
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(observe and A.section('observed', function() return A.unitRecord(unit, true) end) or nil)
end

--- Native command shape: CanStartCommand takes four arguments (unit, commandType, unitCommandParameters,
--- returnResults) -- UnitPanel.lua:471 passes `false` there for a parameterless command -- and such a
--- command is requested as RequestCommand(unit, commandType) with no table at all (:2493-2531).
local function startCommand(unit, row, parameters, observe)
  local hasParameters = next(parameters) ~= nil
  local legal, results = UnitManager.CanStartCommand(unit, row.Hash, hasParameters and parameters or false, true)
  if not legal then return illegal('Engine CanStartCommand rejected this request', UnitCommandResults, results, {turnState = turnStateUnlessBatched()}) end
  local accepted
  if hasParameters then accepted = A.mutate(UnitManager.RequestCommand, unit, row.Hash, parameters)
  else accepted = A.mutate(UnitManager.RequestCommand, unit, row.Hash) end
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
  return startOperation(unit, row, operationParameters(spec, args, pid, unit), true)
end

--- Argument name -> native parameter key for commands, shared with A.unitCommandSpecs so discovery
--- and dispatch describe the same request.
local commandParams = {
  targetUnitId = 'PARAM_UNIT_ID',
  promotion = 'PARAM_PROMOTION_TYPE',
}

--- Encode a unit command's declared fields into native parameters. PARAM_UNIT_PLAYER/PARAM_UNIT_ID
--- carry the *target* unit's owner and id (UnitPanel.lua:2597-2604, WorldInput.lua:2879-2882), and
--- PARAM_PROMOTION_TYPE carries the UnitPromotions row Index (UnitPromotionPopup.lua:81-82,286-291).
local function commandParameters(spec, args, pid)
  local parameters = {}
  for field, codec in pairs(spec.fields) do
    local value = args[field]
    assert(value ~= nil, 'Command requires '..field)
    local key = commandParams[field]
    assert(key, 'No native parameter mapping for command field '..field)
    if codec == 'unitId' then
      local other = A.ownedEntity('unit', value, pid)
      parameters[A.param(UnitCommandTypes, 'PARAM_UNIT_PLAYER')] = other:GetOwner()
      parameters[A.param(UnitCommandTypes, 'PARAM_UNIT_ID')] = other:GetID()
    elseif codec == 'UnitPromotion' then
      parameters[A.param(UnitCommandTypes, 'PARAM_PROMOTION_TYPE')] = rule('UnitPromotions', value).Index
    else
      error('Unsupported command parameter codec '..tostring(codec))
    end
  end
  return parameters
end

handlers.unit_command = function(args, pid)
  local unit = A.ownedEntity('unit', args.unitId, pid)
  local row, spec = commandFor(args.command)
  return startCommand(unit, row, commandParameters(spec, args, pid), true)
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
  -- The native two-answer pattern: display filter CanProduce(hash,true), then current legality with
  -- reasons from CanProduce(hash,false,true)[CityCommandResults.FAILURE_REASONS]
  -- (ProductionPanel.lua:1911-1913,1943-1955,2214-2216). Both returns matter, hence the direct pcall;
  -- if the check is unavailable the native request below stays the authority.
  local queue = city:GetBuildQueue()
  local checked, producible, produceResults = pcall(function() return queue:CanProduce(row.Hash, false, true) end)
  if checked and producible ~= true then
    local decoded = A.results(CityCommandResults, produceResults)
    local extra = {
      item = args.item, kind = args.kind,
      reasons = decoded.reasons or A.array(),
      turnState = turnStateUnlessBatched(),
      note = 'This is the engine build queue rejecting the item (prerequisites, population, resource or placement); '..
        'civ.options(cityId=...) lists the same item with its availability and reasons before submitting.',
    }
    if decoded.notes then extra.notes = decoded.notes end
    return illegal('Engine build queue rejected this item; its prerequisites are not met', nil, nil, extra)
  end
  local accepted = A.mutate(CityManager.RequestOperation, city, CityOperationTypes.BUILD, parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(cityObservation(city))
end

handlers.purchase = function(args, pid, player)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local city = A.ownedEntity('city', args.cityId, pid)
  assert(args.kind == 'unit' or args.kind == 'building' or args.kind == 'district', 'purchase kind must be unit, building or district')
  assert(args.currency == 'gold' or args.currency == 'faith', 'purchase currency must be gold or faith')
  local row = rule(productionTables[args.kind], args.item)
  local formation = args.kind == 'unit' and MilitaryFormationTypes.STANDARD_MILITARY_FORMATION or nil
  local parameters = {}
  parameters[A.param(CityCommandTypes, 'PARAM_'..args.kind:upper()..'_TYPE')] = row.Hash
  parameters[A.param(CityCommandTypes, 'PARAM_YIELD_TYPE')] = GameInfo.Yields['YIELD_'..args.currency:upper()].Index
  if formation ~= nil then
    parameters[A.param(CityCommandTypes, 'PARAM_MILITARY_FORMATION_TYPE')] = formation
  end
  if args.x ~= nil or args.y ~= nil then
    coordinates(args.x, args.y, pid, false)
    parameters[A.param(CityCommandTypes, 'PARAM_X')] = args.x
    parameters[A.param(CityCommandTypes, 'PARAM_Y')] = args.y
  end
  local legal, results = CityManager.CanStartCommand(city, CityCommandTypes.PURCHASE, false, parameters, true)
  if not legal then
    -- A refusal is only actionable with the numbers the native button shows: the exact price in the
    -- requested currency and the balance it is compared against (ProductionPanel.lua:1673,1770,1820).
    return illegal('Engine rejected the purchase (cost, placement or prerequisites)', CityCommandResults, results,
      {price = A.purchasePrice(city, args.kind, row, args.currency, formation, player), turnState = turnStateUnlessBatched()})
  end
  local accepted = A.mutate(CityManager.RequestCommand, city, CityCommandTypes.PURCHASE, parameters)
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
  assert(args.operation == 'SET_FOCUS', 'city_command supports SET_FOCUS only. Tile purchase has its own action (type="purchase"; '..
    'district placement is production/purchase with x/y -- see civ.probe actions[] for the exact fields); '..
    'MANAGE and SWAP_TILE_OWNER read their parameters from the native interface mode and stay in the GUI.')
  assert(args.mode == 'favored' or args.mode == 'ignored', 'SET_FOCUS mode must be favored or ignored')
  assert(type(args.enabled) == 'boolean', 'SET_FOCUS requires enabled=true/false')
  local yield = GameInfo.Yields[args.yield]
  assert(yield, 'Unknown yield type: '..tostring(args.yield))
  local parameters = {}
  parameters[A.param(CityCommandTypes, 'PARAM_FLAGS')] = args.mode == 'favored' and 0 or 1
  parameters[A.param(CityCommandTypes, 'PARAM_YIELD_TYPE')] = yield.Index
  parameters[A.param(CityCommandTypes, 'PARAM_DATA0')] = args.enabled and 1 or 0
  local accepted = A.mutate(CityManager.RequestCommand, city, CityCommandTypes.SET_FOCUS, parameters)
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
  local accepted = A.mutate(CityManager.RequestCommand, city, CityCommandTypes.RANGE_ATTACK, parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted(cityObservation(city))
end

--- Research/civic selection, encoded exactly like the native tree node click (TechTree.lua:231-247,
--- CivicsTree.lua:233-249): the request carries the complete prerequisite path from
--- GetResearchPath(hash)/GetCivicPath(hash), and only PARAM_INSERT_MODE differs -- VALUE_EXCLUSIVE
--- replaces the current plan, VALUE_APPEND adds this path to it. A distant goal is therefore
--- selectable through its path; there is no "is it researchable right now" veto, because the native
--- tree does not have one either.
local function playerResearch(args, pid, player, isTech)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local tableName = isTech and 'Technologies' or 'Civics'
  local row = rule(tableName, args.item)
  assert(args.mode == nil or args.mode == 'replace' or args.mode == 'append',
    'mode must be replace (default) or append')
  local subsystem = isTech and player:GetTechs() or player:GetCulture()
  local pathMethod = isTech and 'GetResearchPath' or 'GetCivicPath'
  -- An unavailable read is not "no path exists": it refuses (nothing reached the engine) instead of
  -- producing a verdict from a query that never happened.
  local readPath = subsystem and subsystem[pathMethod]
  assert(type(readPath) == 'function',
    'Native '..pathMethod..' is unavailable in this context, so the prerequisite path cannot be read; nothing was submitted.')
  local readOK, path = pcall(readPath, subsystem, row.Hash)
  assert(readOK, 'Native '..pathMethod..' failed for '..args.item..': '..tostring(path):match('^[^\r\n]*')..
    '; nothing was submitted.')
  if type(path) ~= 'table' or #path == 0 then
    -- No path means the engine has nothing to queue for this item. Report the engine's own reads --
    -- never a fabricated selectability veto -- and submit nothing. The field is `alreadyResearched`,
    -- not `completed`: the envelope's `completed` means "the mutation finished" and is always false here.
    local label = isTech and 'Technology' or 'Civic'
    local alreadyResearched = A.call('research', subsystem, isTech and 'HasTech' or 'HasCivic', row.Index)
    return illegal(label..' has no native research path'..
      (alreadyResearched == true and ' because it is already completed' or '')..'; nothing was submitted.', nil, nil, {
        item = args.item,
        alreadyResearched = alreadyResearched,
        queue = A.researchQueue(player, isTech and 'research' or 'civic'),
        note = 'The path comes from '..(isTech and 'PlayerTechs:GetResearchPath' or 'PlayerCulture:GetCivicPath')..
          ', the same call the native tree uses; an empty path means there is nothing left to queue.',
        turnState = turnStateUnlessBatched(),
      })
  end
  local parameters = {}
  parameters[A.param(PlayerOperations, isTech and 'PARAM_TECH_TYPE' or 'PARAM_CIVIC_TYPE')] = path
  parameters[A.param(PlayerOperations, 'PARAM_INSERT_MODE')] =
    args.mode == 'append' and A.param(PlayerOperations, 'VALUE_APPEND') or A.param(PlayerOperations, 'VALUE_EXCLUSIVE')
  local accepted = A.mutate(UI.RequestPlayerOperation, pid, A.param(PlayerOperations, isTech and 'RESEARCH' or 'PROGRESS_CIVIC'), parameters)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  local out = submitted()
  -- mode echoes the argument with its default applied, so it already says which end of the native
  -- queue the path went to; planned is the engine's own path, returned verbatim.
  out.item, out.mode = args.item, args.mode or 'replace'
  out.planned = path
  return out
end

handlers.research = function(args, pid, player) return playerResearch(args, pid, player, true) end
handlers.civic = function(args, pid, player) return playerResearch(args, pid, player, false) end

--- Government change, gated by the native predicates (GovernmentScreen.lua:859-880):
--- CanChangeGovernmentAtAll, no change made this turn, and a civic completed this turn unless the
--- player is in anarchy (PlayerCulture:IsInAnarchy, the engine's own "no government" state).
--- Each refusal names the flag that blocks it.
handlers.government = function(args, pid, player)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local culture = player:GetCulture()
  local flags = {
    canChange = A.call('government', culture, 'CanChangeGovernmentAtAll'),
    changeMade = A.call('government', culture, 'GovernmentChangeMade'),
    civicCompletedThisTurn = A.call('government', culture, 'CivicCompletedThisTurn'),
    anarchy = A.call('government', culture, 'IsInAnarchy'),
    current = A.typeName('Governments', A.call('government', culture, 'GetCurrentGovernment'), 'GovernmentType'),
    turnState = turnStateUnlessBatched(),
  }
  if flags.canChange ~= true then
    return illegal('Government cannot be changed right now', nil, nil, flags)
  end
  if flags.changeMade == true then
    return illegal('A government or policy change was already made this turn; the engine allows one per turn.',
      nil, nil, flags)
  end
  if flags.civicCompletedThisTurn ~= true and flags.anarchy ~= true and flags.current ~= A.null then
    return illegal('Changing government now needs a civic completed this turn (the free change window); '..
      'none was completed, so the engine would refuse this request.', nil, nil, flags)
  end
  local accepted = A.mutate(culture.RequestChangeGovernment, culture, rule('Governments', args.item).Hash)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted()
end

--- Partial policy changes. RequestPolicyChanges takes the complete final assignment (the native screen
--- clears every slot, then re-adds all of them: GovernmentScreen.lua:1553-1570), so untouched slots are
--- read back and preserved rather than silently emptied.
---
--- Eligibility is the native predicate itself (GovernmentScreen.lua:848): (CivicCompletedThisTurn() or
--- GetNumPolicySlotsOpen() > 0) and not PolicyChangeMade(). The two failure causes are reported
--- separately, because only one of them is what unlock_policies pays for. Cards staged in the native
--- screen (m_ActivePoliciesBySlot) never reach the engine, so everything read here is committed state.
handlers.policies = function(args, pid, player)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local culture = player:GetCulture()
  local count = culture:GetNumPolicySlots()
  local lifecycle = {
    changeMade = A.call('policies', culture, 'PolicyChangeMade'),
    civicCompletedThisTurn = A.call('policies', culture, 'CivicCompletedThisTurn'),
    slotsOpen = A.call('policies', culture, 'GetNumPolicySlotsOpen'),
    unlockCost = A.call('policies', culture, 'GetCostToUnlockPolicies'),
    turnState = turnStateUnlessBatched(),
  }
  if lifecycle.changeMade == true then
    return illegal('A policy change was already made this turn ('..
      'PlayerCulture:PolicyChangeMade() is true); the engine allows one change per turn and gold does not unlock a second.',
      nil, nil, lifecycle)
  end
  if lifecycle.civicCompletedThisTurn ~= true and not (type(lifecycle.slotsOpen) == 'number' and lifecycle.slotsOpen > 0) then
    return illegal('Policies are locked: no civic was completed this turn and no policy slot is open '..
      '(PlayerCulture:CivicCompletedThisTurn() / GetNumPolicySlotsOpen()). unlock_policies pays the native cost '..
      '(GetCostToUnlockPolicies) to unlock a change; this action never pays it implicitly.',
      nil, nil, lifecycle)
  end
  assert(type(args.slots) == 'table' and #args.slots > 0,
    'Provide slots={{slot=<zero-based>, policy="POLICY_*" or nil to clear}, ...} for the slots you are changing')
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
  local accepted = A.mutate(culture.RequestPolicyChanges, culture, clear, add)
  if accepted == false then return {accepted = false, completed = false, status = 'rejected', turnState = turnStateUnlessBatched()} end
  return submitted()
end

handlers.unlock_policies = function(args, pid)
  assert(Game.IsAllowStrategicCommands(pid), 'Strategic commands are unavailable in the current phase')
  local accepted = A.mutate(UI.RequestPlayerOperation, pid, A.param(PlayerOperations, 'UNLOCK_POLICIES'), {})
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

--- Per-action-type argument schemas, published by A.capabilities (civ.probe) so an action's shape is
--- known without discovering it by refusal. `fields` names each argument; unit_operation/unit_command
--- add the per-operation fields from A.unitOperationSpecs/A.unitCommandSpecs.
A.actionSpecs = {
  move = {
    fields = {unitId='unitId', x='integer map x', y='integer map y'},
    native = 'UnitManager.RequestOperation(unit, MOVE_TO, {PARAM_X, PARAM_Y, PARAM_MODIFIERS=NONE})',
    note = 'Never attacks or starts a war. A destination beyond this turn\'s movement is a native multi-turn order; UnitManager.GetQueuedDestination reports it and unit_command CANCEL clears it.',
  },
  attack = {
    fields = {unitId='unitId', x='integer map x', y='integer map y', mode='melee|ranged|air'},
    native = 'MOVE_TO + PARAM_MODIFIERS=ATTACK (melee) / RANGE_ATTACK / AIR_ATTACK',
    note = 'Target must be currently visible. Melee is encoded like Civ6Common.RequestMoveOperation (ATTACK + MOVE_IGNORE_UNEXPLORED_DESTINATION) so the unit attacks instead of only walking.',
  },
  found = {
    fields = {unitId='unitId'},
    native = 'UnitManager.RequestOperation(unit, FOUND_CITY)',
  },
  unit_operation = {
    fields = {unitId='unitId', operation='UnitOperations short name (or UNITOPERATION_* type)'},
    native = 'UnitManager.RequestOperation(unit, row.Hash, parameters)',
    note = 'Adds the operation\'s declared fields (civ.probe unitOperations[].fields): x/y, destinationX/destinationY or improvement. Operations without a verified codec, and ROUTE_TO, stay in the native GUI.',
  },
  unit_command = {
    fields = {unitId='unitId', command='UnitCommands short name (or UNITCOMMAND_* type)'},
    native = 'UnitManager.RequestCommand(unit, row.Hash[, parameters])',
    note = 'Adds the command\'s declared fields: promotion (UnitPromotions type, sent as the row Index) for PROMOTE, targetUnitId for the formation family. ACTIVATE_GREAT_PERSON takes no fields; CANCEL clears a queued order.',
  },
  production = {
    fields = {cityId='cityId', kind='unit|building|district|project', item='the ruleset type for kind', x='integer map x (district placement, optional)', y='integer map y (optional)', mode='replace (default) | append'},
    native = 'CityManager.RequestOperation(city, BUILD, {PARAM_*_TYPE, PARAM_INSERT_MODE[, PARAM_X, PARAM_Y]})',
    note = 'replace puts the item at the head of the native queue, append adds it to the end (ProductionPanel.GetBuildInsertMode). A refusal carries the engine\'s own build-queue reasons.',
  },
  purchase = {
    fields = {cityId='cityId', kind='unit|building|district', item='the ruleset type for kind', currency='gold|faith', x='integer map x (district placement, optional)', y='integer map y (optional)'},
    native = 'CityManager.RequestCommand(city, PURCHASE, {PARAM_*_TYPE, PARAM_YIELD_TYPE[, PARAM_MILITARY_FORMATION_TYPE][, PARAM_X, PARAM_Y]})',
    note = 'civ.options(cityId=..., operation="purchase") reports the exact per-currency price, balance and the engine\'s legality before submitting.',
  },
  city_command = {
    fields = {cityId='cityId', operation='SET_FOCUS', yield='YIELD_* type', mode='favored|ignored', enabled='boolean'},
    native = 'CityManager.RequestCommand(city, SET_FOCUS, {PARAM_FLAGS, PARAM_YIELD_TYPE, PARAM_DATA0})',
    note = 'Only SET_FOCUS is submitted; tile purchase, MANAGE and SWAP_TILE_OWNER read their values from the native interface mode.',
  },
  city_attack = {
    fields = {cityId='cityId', x='integer map x', y='integer map y'},
    native = 'CityManager.RequestCommand(city, RANGE_ATTACK, {PARAM_X, PARAM_Y})',
    note = 'Target must be currently visible.',
  },
  research = {
    fields = {item='TECH_* type', mode='replace (default) | append'},
    native = 'UI.RequestPlayerOperation(pid, RESEARCH, {PARAM_TECH_TYPE = native path, PARAM_INSERT_MODE})',
    note = 'Both modes carry the engine\'s own prerequisite path from GetResearchPath(hash); replace (VALUE_EXCLUSIVE) replaces the queue, append (VALUE_APPEND) adds to it. A distant goal is selectable this way.',
  },
  civic = {
    fields = {item='CIVIC_* type', mode='replace (default) | append'},
    native = 'UI.RequestPlayerOperation(pid, PROGRESS_CIVIC, {PARAM_CIVIC_TYPE = native path, PARAM_INSERT_MODE})',
    note = 'Same path/insert-mode semantics as research, via GetCivicPath(hash).',
  },
  government = {
    fields = {item='GOVERNMENT_* type'},
    native = 'PlayerCulture:RequestChangeGovernment(hash)',
    note = 'Refused with the native flag that blocks it: CanChangeGovernmentAtAll, a change already made this turn, or no civic completed this turn.',
  },
  policies = {
    fields = {slots='array of {slot=<zero-based integer>, policy="POLICY_*" or null to clear}'},
    native = 'PlayerCulture:RequestPolicyChanges(clearList, addList) with every slot cleared then re-added',
    note = 'Only the named slots change; untouched slots keep their committed policy. Gold is never spent implicitly -- unlock_policies is the separate paid request.',
  },
  unlock_policies = {
    fields = {},
    native = 'UI.RequestPlayerOperation(pid, UNLOCK_POLICIES, {})',
    note = 'Pays the native gold cost (GetCostToUnlockPolicies). Never called implicitly by policies.',
  },
  end_turn = {
    fields = {},
    native = 'UI.RequestAction(ACTION_ENDTURN)',
    note = 'Refused while the engine reports an outstanding submission (UI.HasSentTurnComplete) or while a blocker is active; blockers are named by type.',
  },
}

--- Dispatch one already-validated action. Returns the mutation envelope; raises on argument
--- problems, which A.entry marks as a refusal (nothing reached the engine) or as unknown.
local function dispatch(args)
  local pid, player = A.localPlayer()
  local kind = args.type
  if kind == 'end_turn' then
    local before = A.turnState()
    -- state.lua's submitted flag IS UI.HasSentTurnComplete(): the engine's own record that this
    -- client already asked to end the current turn, and the same guard ActionPanel.CheckAutoEndTurn
    -- uses before it fires ACTION_ENDTURN (Base/Assets/UI/ActionPanel.lua:505-509). A second,
    -- client-side memory of the submission outlives that flag: after an interruption (pending popups
    -- or a blocking notification held the transition) the engine clears it while the local latch
    -- still refused a legitimate resubmission for the rest of the turn.
    if before.processing == true or before.active == false or before.submitted == true then
      return {accepted = false, completed = false, status = 'processing_or_already_submitted', turnState = before}
    end
    assert(before.canEndTurn ~= A.null and before.firstBlocker ~= A.null, 'End-turn safety APIs are unavailable; use the native GUI')
    if before.canEndTurn ~= true or before.firstBlocker ~= EndTurnBlockingTypes.NO_ENDTURN_BLOCKING then
      -- ActionPanel.DoEndTurn does not end the turn while a blocker is active: it selects a unit for
      -- unit blockers and activates the blocker's notification otherwise, and only falls back to
      -- ACTION_ENDTURN when the blocker has no notification at all (ActionPanel.lua:556-595). This
      -- bridge reports the blocker instead of guessing which case the engine is in, so the model can
      -- see which real action resolves it.
      return {accepted = false, completed = false, status = 'blocked', turnState = before,
        blockers = before.blockers}
    end
    A.mutate(UI.RequestAction, ActionTypes.ACTION_ENDTURN)
    return {accepted = true, completed = false, status = 'submitted', turnState = turnStateUnlessBatched()}
  end
  local before = A.turnState()
  assert(before.active == true and before.processing == false and before.submitted == false,
    'The local turn is not ready for actions; wait for processing to finish and refresh')
  local handler = handlers[kind]
  if handler then
    -- Ordinary unit, city and player requests exist only in an ordinary playing turn segment:
    -- TURNSEG_STRATEGIC/TACTICAL separate them (Base/Assets/Gameplay/Data/TurnPhases.xml) and the
    -- World Congress segments set both flags false (DLC/Expansion2/Data/Expansion2_TurnPhases.xml).
    assert(Game.IsAllowStrategicCommands(pid) or Game.IsAllowTacticalCommands(pid),
      'Engine currently disallows local commands in this turn segment; observe civ.snapshot(core) for the current turn state')
    if TACTICAL[kind] then assert(Game.IsAllowTacticalCommands(pid), 'Tactical commands are unavailable in the current phase') end
    return handler(args, pid, player)
  end
  -- Decision families live in decisions.lua and are only dispatched when that module published them.
  -- Their prerequisites are family-specific and must not be inferred from the ordinary command
  -- flags: the congress family is legal exactly when those flags are false. decisions.lua owns that
  -- rule; a missing check is reported instead of being treated as "allowed".
  if type(A.decisionActionTypes) == 'table' and A.decisionActionTypes[kind] and type(A.decisionAction) == 'function' then
    assert(type(A.decisionReady) == 'function', 'Decision readiness check unavailable; refresh the bridge modules before submitting '..kind)
    assert(A.decisionReady(kind), 'Engine currently disallows '..kind..' requests in this turn segment')
    return A.decisionAction(args)
  end
  local names = {}
  for name in pairs(A.actionTypes) do names[#names + 1] = name end
  if type(A.decisionActionTypes) == 'table' then for name in pairs(A.decisionActionTypes) do names[#names + 1] = name end end
  table.sort(names)
  error('Unsupported action type: '..tostring(kind)..'. Supported: '..table.concat(names, ', ')..
    '. Use civ.probe for the generated catalog and civ.options for what is legal now.')
end

--- Whether an action ends the turn: our own end_turn, or a decision family that submits a turn-ending
--- request. decisions.lua owns that rule and publishes A.decisionEndsTurn (congress submit sends
--- ACTION_ENDTURN itself); the field-pair fallback mirrors it for a module set without decisions.lua.
local function turnEnding(action)
  if action.type == 'end_turn' then return true end
  if type(A.decisionEndsTurn) == 'function' then return A.decisionEndsTurn(action) == true end
  return action.type == 'congress' and action.operation == 'submit'
end

--- Batch semantics. A batch is NOT a transaction: each item is an independent native request and the
--- engine may not have processed earlier ones. An unknown acknowledgement always stops admission of
--- later items regardless of stopOnError, because their preconditions are unknown.
local function runBatch(args)
  local actions = args.actions
  assert(type(actions) == 'table' and #actions > 0, 'actions must be a nonempty array of action objects')
  assert(#actions <= MAX_BATCH, 'A batch may contain at most '..MAX_BATCH..' actions; a partially executed batch is never replayed')
  local stopOnError = args.stopOnError ~= false
  local results, submittedCount, stoppedAt = A.array(), 0, A.null
  inBatch = true
  for index, action in ipairs(actions) do
    assert(type(action) == 'table' and type(action.type) == 'string' and action.type ~= '', 'actions['..index..'] needs a type')
    assert(not turnEnding(action) or index == #actions, 'A turn-ending action may only be the last action in a batch')
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
        A.nativeIssued = false
        local ok, outcome = pcall(dispatch, action)
        if ok then
          outcome.index, outcome.type = index, action.type
          outcome.turnState = nil -- one turnState for the batch, not one per item
          results[#results + 1] = outcome
          if outcome.status == 'submitted' then
            submittedCount = submittedCount + 1
          elseif outcome.status == 'unknown' then
            -- An unobservable acknowledgement is not a known failure. decisions.lua reports
            -- {status='unknown'} when a request reached the engine and then threw or lost its
            -- answer; later items would be admitted on unknown preconditions, so admission stops
            -- regardless of stopOnError, exactly as it does for a thrown ASTRA_UNKNOWN.
            stoppedAt = index
          elseif stopOnError then
            stoppedAt = index
          end
        elseif A.nativeIssued then
          -- A request already reached the engine. Nothing after it can assume its preconditions,
          -- and it is never replayed.
          results[#results + 1] = {index = index, type = action.type, status = 'unknown',
            reason = tostring(outcome),
            note = 'Outcome unknown: this request may or may not have been applied. It was NOT replayed.'}
          stoppedAt = index
        else
          -- Raised before any native call: this item never reached the engine.
          results[#results + 1] = {index = index, type = action.type, status = 'refused',
            reason = tostring(outcome),
            note = 'Refused before submission: nothing reached the engine, so there is no unknown outcome here.'}
          stoppedAt = index
        end
      end
    end
  end
  inBatch = false
  return {
    turn = Game.GetCurrentGameTurn(), results = results, submitted = submittedCount,
    stoppedAt = stoppedAt, count = #actions, turnState = A.turnState(),
  }
end

function A.action(args)
  inBatch = false -- a batch that raised during validation must not suppress the next call's turnState
  return A.entry(function()
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
  end)
end
