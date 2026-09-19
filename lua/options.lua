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

--- What the player can actually ask for right now. The full ruleset list is fifty operations and
--- twenty-six commands of which two or three are ever legal, and every ruled-out entry carries its
--- own sentence: a fixed catalog priced as a situation report. At the default detail this keeps the
--- entries the bridge can submit and that are legal or target-dependent, and names the rest in
--- `ruledOut` so nothing is hidden - detail='full', or naming the operation, still returns everything.
local function currentlyRelevant(entries, key, detail, requested)
  if detail == 'full' or requested ~= nil then return entries, nil end
  local kept, ruled = {}, A.array()
  for _, entry in ipairs(entries) do
    if entry.supported == true and entry.available ~= false then
      -- Everything that survives the filter is in the ruleset and submittable by this bridge, so
      -- those two flags say the same thing on every row. `available=null` plus `needs` already
      -- states that legality follows the target; the sentence repeating it per row does not.
      entry.ruleset, entry.supported = nil, nil
      if entry.available == A.null and entry.needs ~= nil then entry.reason = nil end
      kept[#kept + 1] = entry
    else
      ruled[#ruled + 1] = entry[key]
    end
  end
  if #ruled == 0 then return kept, nil end
  table.sort(ruled)
  return kept, ruled
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
        entry.reason = 'No verified request codec in the shipped Lua (VisibleInUI=false, interface mode with no Lua handler), '..
          'so this bridge never submits a guess. A plain move already performs a multi-turn native order; unit_command CANCEL clears one.'
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
        -- Declared fields are unit_operation arguments (same spec the dispatcher reads).
        if next(spec.fields) ~= nil then
          entry.needs = A.array()
          for field in pairs(spec.fields) do entry.needs[#entry.needs + 1] = field end
          table.sort(entry.needs)
        end
        -- Same parameters as the native check: the unit's own tile for current-plot operations
        -- (UnitPanel.lua:346-351), otherwise no parameters (`false`, UnitPanel.lua:676-678).
        local parameters = {}
        if spec.currentPlot and type(UnitOperationTypes) == 'table'
          and UnitOperationTypes.PARAM_X ~= nil and UnitOperationTypes.PARAM_Y ~= nil then
          parameters[UnitOperationTypes.PARAM_X] = unit:GetX()
          parameters[UnitOperationTypes.PARAM_Y] = unit:GetY()
        end
        local legal, results = UnitManager.CanStartOperation(unit, row.Hash, nil, next(parameters) and parameters or false, true)
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
    if row.VisibleInUI or A.unitCommandSpecs[shortName] then
      local short = shortName
      local spec = A.unitCommandSpecs[short]
      local entry = {cmd = short, category = row.CategoryInUI, ruleset = true, supported = spec ~= nil}
      if spec then
        -- Declared fields are unit_command arguments (same spec the dispatcher reads).
        local needs = A.array()
        for field in pairs(spec.fields) do needs[#needs + 1] = field end
        table.sort(needs)
        entry.needs = needs
      end
      if not spec then
        entry.available = A.null
        entry.reason = 'Present in this ruleset but this bridge has no verified parameter handling; use the native GUI.'
      else
        -- Four-argument check with `false` for a parameterless command (UnitPanel.lua:471-479); the
        -- formation family asks with nil and reads UnitCommandResults.UNITS (:396-431).
        local targetFamily = short == 'FORM_CORPS' or short == 'FORM_ARMY' or short == 'ENTER_FORMATION'
        local legal, results = UnitManager.CanStartCommand(unit, row.Hash, targetFamily and nil or false, true)
        local decoded = A.results(UnitCommandResults, results)
        entry.available = legal == true
        if not entry.available then entry.reasons = decoded.reasons end
        if targetFamily and results and UnitCommandResults and UnitCommandResults.UNITS then
          local units = results[UnitCommandResults.UNITS]
          if type(units) == 'table' then
            local owner = unit:GetOwner()
            entry.targets = A.array()
            for _, item in ipairs(units) do
              -- {player=, id=} entries resolved the way UnitPanel.lua:421-431 does, through the
              -- strict resolver: an id that does not verify exactly is reported, never remapped.
              if type(item) == 'table' and type(item.id) == 'number' and item.player == owner then
                local target, mismatch = A.resolveEntity('unit', item.player, item.id)
                if target then
                  entry.targets[#entry.targets + 1] = {
                    unitId = A.entityId('unit', item.player, item.id),
                    unitType = A.typeName('Units', A.call('units', target, 'GetUnitType'), 'UnitType'),
                  }
                else
                  entry.unresolvedTargets = entry.unresolvedTargets or A.array()
                  entry.unresolvedTargets[#entry.unresolvedTargets + 1] = {
                    owner = item.player, id = item.id, reason = mismatch,
                  }
                end
              end
            end
          end
        elseif short == 'PROMOTE' then
          -- UnitPromotionPopup.lua:81-82 reads the valid promotions from the test-only overload; the
          -- submitted value is the row Index.
          local ok, canStart, promotionResults = pcall(UnitManager.CanStartCommand, unit, row.Hash, true, true)
          if ok and canStart then
            local promotions = A.results(UnitCommandResults, promotionResults)
            entry.promotions = promotions.promotions
            entry.available = entry.promotions ~= nil and #entry.promotions > 0
          end
        elseif short == 'UPGRADE' then
          if results and UnitCommandResults and UnitCommandResults.UNIT_TYPE then
            entry.unitType = A.typeFromHash('Units', 'UnitType', results[UnitCommandResults.UNIT_TYPE])
          end
          -- The native tooltip's two numbers: gold price and strategic resource amount
          -- (UnitPanel.lua:474-486; Expansion2 AddUpgradeResourceCost reads both returns).
          entry.upgrade = {gold = A.call('upgrade', unit, 'GetUpgradeCost')}
          local gotResource, resource, amount = pcall(function() return unit:GetUpgradeResourceCost() end)
          if gotResource and type(resource) == 'number' and resource >= 0 then
            local resourceRow = A.row('Resources', resource)
            entry.upgrade.resource = {amount = amount}
            if resourceRow ~= A.null then
              entry.upgrade.resource.type = resourceRow.ResourceType
              entry.upgrade.resource.name = A.loc(resourceRow.Name)
            end
          end
        elseif short == 'ACTIVATE_GREAT_PERSON' then
          -- Activation plots are the engine's own (SelectedUnit.lua:118-140); the bridge reports them
          -- and never picks one.
          local greatPerson = A.call('greatPerson', unit, 'GetGreatPerson')
          if greatPerson ~= nil and greatPerson ~= A.null and A.call('greatPerson', greatPerson, 'IsGreatPerson') == true then
            local class = A.call('greatPerson', greatPerson, 'GetClass')
            entry.greatPerson = {
              class = type(class) == 'string' and class or A.typeName('GreatPersonClasses', class, 'GreatPersonClassType'),
              charges = A.call('greatPerson', greatPerson, 'GetActionCharges'),
              passive = A.call('greatPerson', greatPerson, 'HasPassiveEffect') == true
                and A.call('greatPerson', greatPerson, 'GetPassiveNameText') or A.null,
              activationPlots = A.plots(A.call('greatPerson', greatPerson, 'GetActivationHighlightPlots')),
            }
            local individual = A.call('greatPerson', greatPerson, 'GetIndividual')
            if type(individual) == 'number' and individual >= 0 then
              local individualRow = A.row('GreatPersonIndividuals', individual)
              if individualRow ~= A.null then
                entry.greatPerson.individual = individualRow.GreatPersonIndividualType
                entry.greatPerson.name = A.loc(individualRow.Name)
              end
            end
          end
        elseif short == 'CANCEL' then
          entry.note = 'Clears a queued or automated order for this unit; the engine answers whether anything was pending.'
        end
      end
      if requested == nil or requested == short then commands[#commands + 1] = entry end
    end
  end
  local operationsRuledOut, commandsRuledOut
  operations, operationsRuledOut = currentlyRelevant(operations, 'op', detail, requested)
  commands, commandsRuledOut = currentlyRelevant(commands, 'cmd', detail, requested)
  local ops, opTotal, opMore = page(operations, offset, limit)
  local cmds, cmdTotal, cmdMore = page(commands, offset, limit)
  local movement = A.section('movement', function()
    local reachable, reachTotal, reachCut = bounded(UnitManager.GetReachableMovement(unit), MAX_PLOTS)
    local attackable, attackTotal, attackCut = bounded(UnitManager.GetReachableTargets(unit), MAX_PLOTS)
    local zoc = A.array()
    if detail == 'full' then zoc = bounded(UnitManager.GetReachableZonesOfControl(unit, true), MAX_PLOTS) end
    -- A multi-turn order already queued in the engine is native state, not harness state:
    -- GetQueuedDestination is a static call returning the destination plot the unit is still walking
    -- to (WorldInput.lua:821,907,1165). unit_command CANCEL is the native way to drop it.
    local queued = A.static('movement', UnitManager, 'GetQueuedDestination', unit)
    local destination = type(queued) == 'number' and A.plotXY(queued) or A.null
    return {
      reachable = reachable, reachableTotal = reachTotal, reachableTruncated = reachCut,
      attackable = attackable, attackableTotal = attackTotal, attackableTruncated = attackCut,
      zoneOfControl = zoc,
      queuedDestination = destination,
    }
  end)
  return {
    scope = 'unit', unit = A.unitRecord(unit, true), movement = movement,
    operations = ops, commands = cmds,
    -- Named, not described: ask for one by name, or detail='full', for its reasons.
    ruledOut = (operationsRuledOut or commandsRuledOut)
      and {operations = operationsRuledOut or A.array(), commands = commandsRuledOut or A.array()} or A.null,
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

--- Per-currency purchase facts, checked the way the native purchase button is checked:
--- CityManager.CanStartCommand(city, PURCHASE, false, parameters, true) with PARAM_YIELD_TYPE
--- (ProductionPanel.lua ComposeUnitForPurchase / ComposeBuildingForPurchase).
local function purchaseOptions(city, kind, row, player)
  local out = {
    note = 'cost = the exact native price for that currency (CityGold:GetPurchaseCost), balance = this player\'s treasury/faith, '..
      'covers = cost <= balance, legal = the engine\'s CanStartCommand answer for that currency (so locked or unaffordable '..
      'alternatives stay visible), reasons = the engine\'s failure reasons when legal is false, enabled = the native '..
      'Is*FaithPurchaseEnabled flag (faith, units/buildings).',
  }
  local formation = kind == 'unit' and MilitaryFormationTypes.STANDARD_MILITARY_FORMATION or nil
  for _, currency in ipairs({'gold', 'faith'}) do
    local entry = A.purchasePrice(city, kind, row, currency, formation, player)
    local ok, legal, results = pcall(function()
      local parameters = {}
      parameters[A.param(CityCommandTypes, 'PARAM_'..kind:upper()..'_TYPE')] = row.Hash
      parameters[A.param(CityCommandTypes, 'PARAM_YIELD_TYPE')] = GameInfo.Yields['YIELD_'..currency:upper()].Index
      if formation ~= nil then
        parameters[A.param(CityCommandTypes, 'PARAM_MILITARY_FORMATION_TYPE')] = formation
      end
      return CityManager.CanStartCommand(city, CityCommandTypes.PURCHASE, false, parameters, true)
    end)
    entry.legal = ok and legal == true
    if not entry.legal then
      local decoded = A.results(CityCommandResults, ok and results or nil)
      entry.reasons = decoded.reasons or A.array()
      if decoded.notes then entry.notes = decoded.notes end
    end
    out[currency] = entry
  end
  return out
end

local function cityOptions(args, pid, detail, offset, limit, wantTargets)
  local city = A.ownedEntity('city', args.cityId, pid)
  local player = Players[pid]
  local queue = city:GetBuildQueue()
  local requested = args.operation
  local wantPlacement = wantTargets or requested == 'place_district' or detail == 'full'
  local production = {}
  for _, definition in ipairs(productionTables) do
    local tableName, keyField, kind, prefix = definition[1], definition[2], definition[3], definition[4]
    for row in GameInfo[tableName]() do
      -- Two native answers, as the production panel uses them: CanProduce(hash,true) decides whether
      -- the item is offered at all, CanProduce(hash,false,true) is current legality plus reasons
      -- (ProductionPanel.lua:1911-1913,1943-1955,2214-2216). Listing only legal items would hide what
      -- the engine knows is blocked and why.
      if A.call('production', queue, 'CanProduce', row.Hash, true) == true then
        local item = row[keyField]
        if requested == nil or requested == item or requested == 'place_district' or requested == 'purchase' then
          local entry = {
            kind = kind, item = item,
            cost = A.call('production', queue, 'Get'..prefix..'Cost', row.Index),
            progress = A.call('production', queue, 'Get'..prefix..'Progress', row.Index),
            turns = A.call('production', queue, 'GetTurnsLeft', item),
          }
          -- Both returns matter, so this is a direct protected call (A.call keeps only the first).
          local checked, producible, produceResults = pcall(function() return queue:CanProduce(row.Hash, false, true) end)
          if not checked then
            entry.available = A.null
            entry.reason = 'The engine build queue could not be asked whether this item is producible now; availability is unknown here, not false.'
          else
            entry.available = producible == true
            if not entry.available then
              local decoded = A.results(CityCommandResults, produceResults)
              entry.reasons = decoded.reasons or A.array()
              if decoded.notes then entry.notes = decoded.notes end
            end
          end
          if kind == 'unit' then
            -- Strategic resource cost of producing this unit, as the Expansion2 tooltip prints it
            -- (ToolTipLoader_Expansion2.lua:105-121).
            local amount = A.call('production', queue, 'GetUnitResourceCost', row.Index)
            if type(amount) == 'number' and amount > 0 then
              entry.resource = {amount = amount}
              local resourceRow = A.row('Resources', row.StrategicResource)
              if resourceRow ~= A.null then
                entry.resource.type = resourceRow.ResourceType
                entry.resource.name = A.loc(resourceRow.Name)
              end
            end
          end
          if kind == 'district' and (wantPlacement or requested == item) then
            entry.plots = districtPlots(city, row)
            if entry.plots ~= nil then entry.placementRequired = true end
          elseif kind == 'district' then
            entry.placementRequired = true
            entry.note = 'Needs a plot; request operation="place_district" or targets=true for legal locations.'
          end
          -- Native PURCHASE covers units, buildings and districts only (ProductionPanel's purchase
          -- tabs); a project is listed as production but has no price to report.
          if kind ~= 'project' and (requested == 'purchase' or requested == item) then
            entry.purchase = purchaseOptions(city, kind, row, player)
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
    tile_purchase = 'Buying a map tile is a native city command whose plot comes from the interface mode '..
      '(CityCommandTypes.PARAM_PLOT_PURCHASE), so this bridge does not submit it: use the native GUI. '..
      'Unit/building/district purchases are the civ.action type="purchase" action with an exact price from this record.',
    manage_citizens = 'MANAGE and SWAP_TILE_OWNER read their parameter values from the native interface mode; SET_FOCUS is the '..
      'submitted citizen command (see the citizens block).',
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
    -- The native queue itself, so the caller sees what the engine accepted rather than assuming the
    -- last submission landed.
    result.researchQueue = A.researchQueue(player, 'research')
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
    result.civicQueue = A.researchQueue(player, 'civic')
  end
  if requested == nil or requested == 'government' then
    -- The same flags the native GovernmentScreen predicates read (GovernmentScreen.lua:848,859-880).
    result.governments = {
      canChange = A.call('government', civics, 'CanChangeGovernmentAtAll'),
      current = A.typeName('Governments', A.call('government', civics, 'GetCurrentGovernment'), 'GovernmentType'),
      changeMade = A.call('government', civics, 'GovernmentChangeMade'),
      civicCompletedThisTurn = A.call('government', civics, 'CivicCompletedThisTurn'),
      anarchy = A.call('government', civics, 'IsInAnarchy'),
      available = A.array(),
    }
    for row in GameInfo.Governments() do
      if A.call('government', civics, 'IsGovernmentUnlocked', row.Index) == true then
        result.governments.available[#result.governments.available + 1] = {item = row.GovernmentType}
      end
    end
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
      local cost = A.call('policies', civics, 'GetCostToUnlockPolicies')
      local changeMade = A.call('policies', civics, 'PolicyChangeMade')
      local completed = A.call('policies', civics, 'CivicCompletedThisTurn')
      local open = A.call('policies', civics, 'GetNumPolicySlotsOpen')
      return {
        -- The native eligibility predicate, flag by flag (GovernmentScreen.lua:848).
        canChange = (completed == true or (type(open) == 'number' and open > 0)) and changeMade == false,
        changeMade = changeMade,
        civicCompletedThisTurn = completed,
        slotsOpen = open,
        unlockCost = cost,
        freeUnlock = type(cost) == 'number' and cost == 0 or A.null,
        slots = slots, unlocked = unlocked,
        note = 'slots[] is the committed assignment the engine reports; cards staged in the native screen are not engine state. '..
          'policies takes only the slots you are changing; policy=nil clears one. unlock_policies is the separate paid request.',
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
  -- The native movement UI skips path work while the game core is busy (WorldInput.lua:818,884,1163
  -- guard the same helpers), so this reports the deferral instead of querying during a busy frame.
  if A.static('path', UI, 'IsGameCoreBusy') == true then
    return {plots = A.array(), turns = A.array(), obstacles = A.array(), totalTurns = A.null,
      blocked = A.null, deferred = true,
      reason = 'The game core is busy, so path computation is deferred the way the native UI defers it. Nothing was queried; ask again when the turn is ready.'}
  end
  local ok, info = pcall(UnitManager.GetMoveToPathEx, unit, destination)
  if not ok or type(info) ~= 'table' or type(info.plots) ~= 'table' then
    return {blocked = true, deferred = false, plots = A.array(), turns = A.array(),
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
    deferred = false,
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
    if verbose or spec then
      local entry = {cmd = short, category = row.CategoryInUI, visibleInUI = row.VisibleInUI == true,
        ruleset = true, supported = spec ~= nil}
      if spec then
        entry.fields = A.array()
        for field in pairs(spec.fields) do entry.fields[#entry.fields + 1] = field end
        table.sort(entry.fields)
        if short == 'PROMOTE' then
          entry.note = 'promotion takes a UnitPromotions type; the request carries that row\'s Index in PARAM_PROMOTION_TYPE.'
        elseif short == 'ACTIVATE_GREAT_PERSON' then
          entry.note = 'No fields: the Great Person activates in place. civ.options(unitId=...).commands reports the engine\'s valid plots and reasons.'
        elseif next(spec.fields) == nil then
          entry.note = 'No fields; submitted as UnitManager.RequestCommand(unit, command) exactly as the native action list does.'
        end
      end
      commands[#commands + 1] = entry
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
  -- Action schemas come from the dispatcher's own publication (A.actionSpecs), so a listed type is a
  -- type whose arguments are known.
  local actions = A.array()
  if type(A.actionSpecs) == 'table' then
    for name in pairs(A.actionTypes or {}) do
      local spec = A.actionSpecs[name]
      if spec then
        actions[#actions + 1] = {type = name, fields = spec.fields or A.array(),
          native = spec.native or A.null, note = spec.note or A.null}
      else
        actions[#actions + 1] = {type = name, fields = A.array(), native = A.null}
      end
    end
    table.sort(actions, function(left, right) return left.type < right.type end)
  end
  -- Decision families come from the decision module's own published table, so the probe cannot
  -- advertise a kind it does not handle.
  local decisions = A.null
  if type(A.decisionKinds) == 'table' then decisions = A.decisionKinds
  elseif type(A.decisionActionTypes) == 'table' then
    decisions = A.array()
    for kind, spec in pairs(A.decisionActionTypes) do
      decisions[#decisions + 1] = {kind = kind, operations = type(spec) == 'table' and spec.operations or A.null,
        fields = type(spec) == 'table' and spec.fields or A.null,
        help = type(spec) == 'table' and spec.help or A.null,
        native = type(spec) == 'table' and spec.native or A.null}
    end
    table.sort(decisions, function(left, right) return left.kind < right.kind end)
  end
  return {
    actionTypes = types,
    actions = actions,
    unitOperations = operations,
    unitCommands = commands,
    decisionKinds = decisions,
    map = {adjacency = adjacency},
    meaning = {
      ruleset = 'The operation exists in the loaded ruleset (mods included).',
      supported = 'This bridge has verified parameter handling and will submit it.',
      legality = 'Whether it can be done right now comes from civ.options, never from this catalog.',
      actions = 'actions[] gives each dispatched action type\'s arguments; unitOperations/unitCommands add the per-operation fields.',
      movement = 'A move past this turn\'s movement is a native multi-turn order answered by MOVE_TO; '..
        'civ.options(unitId=...).movement.queuedDestination reports the pending destination and unit_command CANCEL clears it. '..
        'Nothing is reissued or planned automatically.',
    },
  }
end
