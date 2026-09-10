-- Trusted FireTuner module. No player-supplied source is evaluated.
-- Discovery: what is legal right now, with the engine's own reasons for what is not.
-- Three states are always distinct: present in this ruleset, supported by this bridge, and
-- currently legal for this entity. A missing bridge handler is never reported as a missing
-- engine operation.
local A = AstraCiv

local MAX_PLOTS = 200
local DEFAULT_LIMIT = 50

local function page(list, offset, limit)
  local out, total = A.array(), #list
  for index = offset + 1, math.min(total, offset + limit) do out[#out + 1] = list[index] end
  return out, total, offset + #out < total
end

local function bounded(list, cap)
  local out = A.array()
  if type(list) ~= 'table' then return out, 0, false end
  local total = #list
  for index = 1, math.min(total, cap) do
    local xy = A.plotXY(list[index])
    if xy ~= A.null then out[#out + 1] = xy end
  end
  return out, total, total > cap
end

local function selectors(args)
  local detail = args.detail or 'summary'
  assert(detail == 'summary' or detail == 'full', "detail must be 'summary' or 'full'")
  local offset = args.offset or 0
  local limit = args.limit or DEFAULT_LIMIT
  assert(type(offset) == 'number' and offset % 1 == 0 and offset >= 0, 'offset must be a nonnegative integer')
  assert(type(limit) == 'number' and limit % 1 == 0 and limit >= 1 and limit <= 500, 'limit must be 1..500')
  return detail, offset, limit, args.targets == true
end

-- ------------------------------------------------------------------ unit scope

--- Operations whose legality cannot be decided without a destination. Reporting them as
--- unavailable would be a lie; they are reported as needing a target, with the engine's own
--- target list on request.
local function targetedOperation(spec)
  return spec.target == 'coordinate' or spec.target == 'visible_coordinate'
end

local function operationTargets(unit, row)
  local ok, results = pcall(UnitManager.GetOperationTargets, unit, row.Hash)
  if not ok then return nil end
  local decoded = A.results(UnitOperationResults, results)
  -- PLOTS and MODIFIERS are positional and paired; only MODIFIER_IS_TARGET plots are legal
  -- attack targets. Returning every plot as a target would be unsafe.
  if decoded.targets and #decoded.targets > 0 then return decoded.targets, decoded.plotResults end
  return decoded.plots, decoded.plotResults
end

local function unitOptions(args, pid, detail, offset, limit, wantTargets)
  local unit = A.ownedEntity('unit', args.unitId, pid)
  local requested = args.operation
  local operations, commands = {}, {}
  for row in GameInfo.UnitOperations() do
    local shortName = A.shortName(row.OperationType, 'UNITOPERATION_')
    -- The native unit panel filters on VisibleInUI. An operation this bridge supports is listed
    -- even if a ruleset omits that column, so a supported action can never silently disappear.
    if row.VisibleInUI or A.unitOperationSpecs[shortName] then
      local short = shortName
      local spec = A.unitOperationSpecs[short]
      local entry = {op = short, category = row.CategoryInUI, ruleset = true, supported = spec ~= nil}
      if not spec then
        entry.available = A.null
        entry.reason = 'Present in this ruleset but this bridge has no verified parameter handling; use the native GUI.'
      elseif spec.nativeUiOnly then
        entry.available = false
        entry.reason = 'Deliberately routed to the native GUI in this bridge.'
      elseif targetedOperation(spec) then
        entry.needs = A.array()
        for field in pairs(spec.fields) do entry.needs[#entry.needs + 1] = field end
        table.sort(entry.needs)
        entry.available = A.null
        entry.reason = 'Legality depends on the target; request targets=true or operation="'..short..'".'
        if wantTargets or requested == short then
          local targets, pairsList = operationTargets(unit, row)
          if targets then
            entry.targets = targets
            entry.available = #targets > 0
            if detail == 'full' then entry.plotResults = pairsList end
          end
        end
      else
        local parameters = {}
        local legal, results = UnitManager.CanStartOperation(unit, row.Hash, nil, parameters, true)
        local decoded = A.results(UnitOperationResults, results)
        entry.available = legal == true
        if not entry.available then entry.reasons = decoded.reasons end
        if decoded.name then entry.name = decoded.name end
        if decoded.improvements then
          entry.improvements = decoded.improvements
          -- Firaxis's own recommendation, never ours and never the model's.
          local best = results and UnitOperationResults and UnitOperationResults.BEST_IMPROVEMENT
            and results[UnitOperationResults.BEST_IMPROVEMENT]
          if best ~= nil then entry.engineSuggested = A.typeFromHash('Improvements', 'ImprovementType', best) end
        end
        if detail == 'full' and decoded.notes then entry.notes = decoded.notes end
      end
      if requested == nil or requested == short then operations[#operations + 1] = entry end
    end
  end
  for row in GameInfo.UnitCommands() do
    local shortName = A.shortName(row.CommandType, 'UNITCOMMAND_')
    if row.VisibleInUI or A.unitCommandSpecs[shortName] or shortName == 'PROMOTE' then
      local short = shortName
      local spec = A.unitCommandSpecs[short]
      local entry = {cmd = short, category = row.CategoryInUI, ruleset = true, supported = spec ~= nil}
      if not spec and short ~= 'PROMOTE' then
        entry.available = A.null
        entry.reason = 'Present in this ruleset but this bridge has no verified parameter handling; use the native GUI.'
      else
        local legal, results = UnitManager.CanStartCommand(unit, row.Hash, {}, false, true)
        local decoded = A.results(UnitCommandResults, results)
        entry.available = legal == true
        if not entry.available then entry.reasons = decoded.reasons end
        if short == 'PROMOTE' then
          entry.supported = true
          -- UnitPromotionPopup reads the valid promotions from the test-only overload.
          local ok, canStart, promotionResults = pcall(UnitManager.CanStartCommand, unit, row.Hash, true, true)
          if ok and canStart then
            local promotions = A.results(UnitCommandResults, promotionResults)
            entry.promotions = promotions.promotions
            entry.available = entry.promotions ~= nil and #entry.promotions > 0
          end
        elseif short == 'UPGRADE' and results and UnitCommandResults and UnitCommandResults.UNIT_TYPE then
          entry.unitType = A.typeFromHash('Units', 'UnitType', results[UnitCommandResults.UNIT_TYPE])
        end
      end
      if requested == nil or requested == short then commands[#commands + 1] = entry end
    end
  end
  local ops, opTotal, opMore = page(operations, offset, limit)
  local cmds, cmdTotal, cmdMore = page(commands, offset, limit)
  local movement = A.section('movement', function()
    local reachable, reachTotal, reachCut = bounded(UnitManager.GetReachableMovement(unit), MAX_PLOTS)
    local attackable, attackTotal, attackCut = bounded(UnitManager.GetReachableTargets(unit), MAX_PLOTS)
    local zoc = A.array()
    if detail == 'full' then zoc = bounded(UnitManager.GetReachableZonesOfControl(unit, true), MAX_PLOTS) end
    return {
      reachable = reachable, reachableTotal = reachTotal, reachableTruncated = reachCut,
      attackable = attackable, attackableTotal = attackTotal, attackableTruncated = attackCut,
      zoneOfControl = zoc,
      note = 'Reachable plots come from the engine for this turn only and follow the same visibility limits as the native UI.',
    }
  end)
  return {
    scope = 'unit', unit = A.unitRecord(unit, true), movement = movement,
    operations = ops, commands = cmds,
    total = opTotal + cmdTotal, offset = offset, more = opMore or cmdMore,
  }
end

-- ------------------------------------------------------------------ city scope

local productionTables = {
  {'Units', 'UnitType', 'unit', 'Unit'},
  {'Buildings', 'BuildingType', 'building', 'Building'},
  {'Districts', 'DistrictType', 'district', 'District'},
  {'Projects', 'ProjectType', 'project', 'Project'},
}

local function districtPlots(city, row)
  local parameters = {}
  parameters[A.param(CityOperationTypes, 'PARAM_DISTRICT_TYPE')] = row.Hash
  local ok, results = pcall(CityManager.GetOperationTargets, city, CityOperationTypes.BUILD, parameters)
  if not ok or type(results) ~= 'table' then return nil end
  local plots = CityOperationResults and CityOperationResults.PLOTS and results[CityOperationResults.PLOTS]
  if type(plots) ~= 'table' then return nil end
  local list = bounded(plots, MAX_PLOTS)
  return list
end

local function purchasePrice(city, kind, row)
  for _, currency in ipairs({'gold', 'faith'}) do
    local ok, legal, results = pcall(function()
      local parameters = {}
      parameters[A.param(CityCommandTypes, 'PARAM_'..kind:upper()..'_TYPE')] = row.Hash
      parameters[A.param(CityCommandTypes, 'PARAM_YIELD_TYPE')] = GameInfo.Yields['YIELD_'..currency:upper()].Index
      if kind == 'unit' then
        parameters[A.param(CityCommandTypes, 'PARAM_MILITARY_FORMATION_TYPE')] = MilitaryFormationTypes.STANDARD_MILITARY_FORMATION
      end
      return CityManager.CanStartCommand(city, CityCommandTypes.PURCHASE, false, parameters, true)
    end)
    if ok and legal then return currency, A.results(CityCommandResults, results) end
  end
  return nil
end

local function cityOptions(args, pid, detail, offset, limit, wantTargets)
  local city = A.ownedEntity('city', args.cityId, pid)
  local queue = city:GetBuildQueue()
  local requested = args.operation
  local wantPlacement = wantTargets or requested == 'place_district' or detail == 'full'
  local production = {}
  for _, definition in ipairs(productionTables) do
    local tableName, keyField, kind, prefix = definition[1], definition[2], definition[3], definition[4]
    for row in GameInfo[tableName]() do
      if A.call('production', queue, 'CanProduce', row.Hash, true) == true then
        local item = row[keyField]
        if requested == nil or requested == item or requested == 'place_district' or requested == 'purchase' then
          local entry = {
            kind = kind, item = item,
            cost = A.call('production', queue, 'Get'..prefix..'Cost', row.Index),
            progress = A.call('production', queue, 'Get'..prefix..'Progress', row.Index),
            turns = A.call('production', queue, 'GetTurnsLeft', item),
          }
          if kind == 'district' and (wantPlacement or requested == item) then
            entry.plots = districtPlots(city, row)
            if entry.plots ~= nil then entry.placementRequired = true end
          elseif kind == 'district' then
            entry.placementRequired = true
            entry.note = 'Needs a plot; request operation="place_district" or targets=true for legal locations.'
          end
          if requested == 'purchase' or requested == item then
            local currency, results = purchasePrice(city, kind, row)
            if currency then entry.purchase = {currency = currency, notes = results and results.notes} end
          end
          if requested ~= 'place_district' or kind == 'district' then production[#production + 1] = entry end
        end
      end
    end
  end
  local items, total, more = page(production, offset, limit)
  local result = {
    scope = 'city', city = A.cityRecord(city, true), production = items,
    total = total, offset = offset, more = more,
  }
  if requested == 'citizens' or detail == 'full' then
    result.citizens = A.section('citizens', function()
      local citizens = city:GetCitizens()
      local focus = {}
      for row in GameInfo.Yields() do
        focus[row.YieldType] = {favored = citizens:IsFavoredYield(row.Index), disfavored = citizens:IsDisfavoredYield(row.Index)}
      end
      return {focus = focus, command = 'city_command operation=SET_FOCUS with yield, mode=favored|ignored and enabled'}
    end)
  end
  result.unsupported = {
    tile_purchase = 'Plot purchase, MANAGE and SWAP_TILE_OWNER take their parameter values from the native interface mode, so this bridge does not submit them. Use the native GUI.',
  }
  return result
end

-- ---------------------------------------------------------------- player scope

local function playerOptions(args, pid, player, detail, offset, limit)
  local requested = args.operation
  local result = {scope = 'player'}
  local techs, civics = player:GetTechs(), player:GetCulture()
  if requested == nil or requested == 'research' then
    local list = {}
    for row in GameInfo.Technologies() do
      if A.call('research', techs, 'CanResearch', row.Index) == true and A.call('research', techs, 'HasTech', row.Index) ~= true then
        list[#list + 1] = {item = row.TechnologyType, cost = A.call('research', techs, 'GetResearchCost', row.Index),
          turns = A.call('research', techs, 'GetTurnsLeft', row.Index), boosted = A.call('research', techs, 'HasBoostBeenTriggered', row.Index)}
      end
    end
    result.research, result.researchTotal = page(list, offset, limit)
  end
  if requested == nil or requested == 'civic' then
    local list = {}
    for row in GameInfo.Civics() do
      if A.call('civics', civics, 'CanProgress', row.Index) == true and A.call('civics', civics, 'HasCivic', row.Index) ~= true then
        list[#list + 1] = {item = row.CivicType, cost = A.call('civics', civics, 'GetCultureCost', row.Index),
          turns = A.call('civics', civics, 'GetTurnsLeft', row.Index), boosted = A.call('civics', civics, 'HasBoostBeenTriggered', row.Index)}
      end
    end
    result.civics, result.civicsTotal = page(list, offset, limit)
  end
  if requested == nil or requested == 'government' then
    local canChange = A.call('government', civics, 'CanChangeGovernmentAtAll')
    local list = {}
    for row in GameInfo.Governments() do
      if A.call('government', civics, 'IsGovernmentUnlocked', row.Index) == true then list[#list + 1] = {item = row.GovernmentType} end
    end
    result.governments = {canChange = canChange, current = A.typeName('Governments', A.call('government', civics, 'GetCurrentGovernment'), 'GovernmentType'), available = A.array(list)}
  end
  if requested == nil or requested == 'policies' then
    result.policies = A.section('policies', function()
      local count = civics:GetNumPolicySlots()
      local slots = A.array()
      for slot = 0, count - 1 do
        local slotRow = GameInfo.GovernmentSlots[civics:GetSlotType(slot)]
        local index = A.call('policies', civics, 'GetSlotPolicy', slot)
        local policy = A.null
        if type(index) == 'number' and index >= 0 then policy = A.typeName('Policies', index, 'PolicyType') end
        slots[#slots + 1] = {slot = slot, slotType = slotRow and slotRow.GovernmentSlotType or A.null, policy = policy}
      end
      local unlocked = A.array()
      for row in GameInfo.Policies() do
        if A.call('policies', civics, 'IsPolicyUnlocked', row.Index) == true then
          unlocked[#unlocked + 1] = {item = row.PolicyType, slotType = row.GovernmentSlotType,
            active = A.call('policies', civics, 'IsPolicyActive', row.Index)}
        end
      end
      return {
        canChange = (civics:CivicCompletedThisTurn() or civics:GetNumPolicySlotsOpen() > 0) and not civics:PolicyChangeMade(),
        unlockCost = A.call('policies', civics, 'GetCostToUnlockPolicies'),
        slots = slots, unlocked = unlocked,
        note = 'policies takes only the slots you are changing; untouched slots keep their current policy. policy=nil clears a slot.',
      }
    end)
  end
  result.offset, result.more = offset, false
  return result
end

function A.options(args)
  args = args or {}
  local detail, offset, limit, wantTargets = selectors(args)
  assert(args.operation == nil or (type(args.operation) == 'string' and args.operation ~= ''), 'operation must be a nonempty string')
  assert(args.unitId == nil or args.cityId == nil, 'Pass unitId, cityId, or neither for player scope')
  local pid, player = A.localPlayer()
  if args.unitId ~= nil then return unitOptions(args, pid, detail, offset, limit, wantTargets) end
  if args.cityId ~= nil then return cityOptions(args, pid, detail, offset, limit, wantTargets) end
  return playerOptions(args, pid, player, detail, offset, limit)
end

--- Engine-authorised path. `turns` is the native per-plot cumulative turn array, matched to
--- `plots`; the total is its last entry. A path may cross plots this player cannot currently see,
--- so reaching the destination is not guaranteed.
function A.path(args)
  args = args or {}
  local pid = A.localPlayer()
  local unit = A.ownedEntity('unit', args.unitId, pid)
  assert(type(args.x) == 'number' and type(args.y) == 'number' and args.x % 1 == 0 and args.y % 1 == 0, 'x/y must be integer map coordinates')
  local width, height = Map.GetGridSize()
  assert(args.x >= 0 and args.x < width and args.y >= 0 and args.y < height, 'Destination is outside the map')
  local destination = A.plotIndex(args.x, args.y)
  assert(destination ~= A.null, 'Destination plot is unavailable')
  local ok, info = pcall(UnitManager.GetMoveToPathEx, unit, destination)
  if not ok or type(info) ~= 'table' or type(info.plots) ~= 'table' then
    return {blocked = true, plots = A.array(), turns = A.array(),
      reason = 'The engine returned no path for this unit and destination.'}
  end
  local plots, total, truncated = bounded(info.plots, MAX_PLOTS)
  local turns = A.array()
  if type(info.turns) == 'table' then
    for index = 1, math.min(#info.turns, MAX_PLOTS) do turns[#turns + 1] = info.turns[index] end
  end
  local obstacles = A.array()
  if type(info.obstacles) == 'table' then obstacles = bounded(info.obstacles, MAX_PLOTS) end
  return {
    plots = plots, plotsTotal = total, truncated = truncated,
    turns = turns, obstacles = obstacles,
    totalTurns = (type(info.turns) == 'table' and #info.turns > 0) and info.turns[#info.turns] or A.null,
    blocked = total < 2,
    busy = A.call('path', unit, 'GetMovesRemaining') == 0,
    note = 'turns is the native per-plot cumulative array matched to plots; a path may cross plots outside current visibility, so arrival is not guaranteed.',
  }
end

--- Runtime capability generation. The bridge publishes exactly this; there is no hand-written
--- action table anywhere, which is what previously let the probe advertise operations that always
--- threw.
function A.capabilities(args)
  local verbose = args and args.verbose == true
  local types = A.array()
  local seen = {}
  for name in pairs(A.actionTypes or {}) do if not seen[name] then seen[name] = true; types[#types + 1] = name end end
  if type(A.decisionActionTypes) == 'table' then
    for name in pairs(A.decisionActionTypes) do if not seen[name] then seen[name] = true; types[#types + 1] = name end end
  end
  table.sort(types)
  local operations, commands = A.array(), A.array()
  for row in GameInfo.UnitOperations() do
    local short = A.shortName(row.OperationType, 'UNITOPERATION_')
    local spec = A.unitOperationSpecs[short]
    if verbose or spec then
      local entry = {op = short, category = row.CategoryInUI, visibleInUI = row.VisibleInUI == true,
        ruleset = true, supported = spec ~= nil and not spec.nativeUiOnly}
      if spec then
        entry.fields = A.array()
        for field in pairs(spec.fields) do entry.fields[#entry.fields + 1] = field end
        table.sort(entry.fields)
        if spec.nativeUiOnly then entry.note = 'Routed to the native GUI in this bridge.' end
      end
      operations[#operations + 1] = entry
    end
  end
  for row in GameInfo.UnitCommands() do
    local short = A.shortName(row.CommandType, 'UNITCOMMAND_')
    local spec = A.unitCommandSpecs[short]
    if verbose or spec or short == 'PROMOTE' then
      commands[#commands + 1] = {cmd = short, category = row.CategoryInUI, visibleInUI = row.VisibleInUI == true,
        ruleset = true, supported = spec ~= nil or short == 'PROMOTE'}
    end
  end
  -- Adjacency is measured from the live map rather than assumed, so the model can stop paying for
  -- six neighbour-id strings on every tile.
  local adjacency = A.section('adjacency', function()
    local width, height = Map.GetGridSize()
    local out = {}
    for _, parity in ipairs({{'evenRow', 2}, {'oddRow', 3}}) do
      local y = parity[2]
      local x = 3
      if x < width and y < height then
        local offsets = A.array()
        for direction = 0, 5 do
          local neighbour = Map.GetAdjacentPlot(x, y, direction)
          offsets[#offsets + 1] = neighbour and A.array({neighbour:GetX() - x, neighbour:GetY() - y}) or A.null
        end
        out[parity[1]] = offsets
      end
    end
    out.note = 'Direction index 0..5 maps to these [dx,dy] offsets; rows alternate. Measured from this map, not assumed.'
    return out
  end)
  -- Decision families come from the decision module's own published table, so the probe cannot
  -- advertise a kind it does not handle.
  local decisions = A.null
  if type(A.decisionKinds) == 'table' then decisions = A.decisionKinds
  elseif type(A.decisionActionTypes) == 'table' then
    decisions = A.array()
    for kind, spec in pairs(A.decisionActionTypes) do
      decisions[#decisions + 1] = {kind = kind, operations = type(spec) == 'table' and spec.operations or A.null,
        native = type(spec) == 'table' and spec.native or A.null}
    end
    table.sort(decisions, function(left, right) return left.kind < right.kind end)
  end
  return {
    actionTypes = types,
    unitOperations = operations,
    unitCommands = commands,
    decisionKinds = decisions,
    map = {adjacency = adjacency},
    meaning = {
      ruleset = 'The operation exists in the loaded ruleset (mods included).',
      supported = 'This bridge has verified parameter handling and will submit it.',
      legality = 'Whether it can be done right now comes from civ.options, never from this catalog.',
    },
  }
end
