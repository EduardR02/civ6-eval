-- Trusted FireTuner module. No player-supplied source is evaluated.
AstraCiv = AstraCiv or {}
local A = AstraCiv
A.version = 1
A.null = A.null or {}
local arrayMeta = { __astraArray = true }
function A.array(t) return setmetatable(t or {}, arrayMeta) end
local function quote(s)
  return '"' .. s:gsub('[%z\1-\31\\"]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    return string.format('\\u%04x', string.byte(c))
  end) .. '"'
end
function A.json(value, depth)
  depth = depth or 0
  if depth > 32 then error('Response nesting exceeds 32') end
  if value == nil or value == A.null then return 'null' end
  local kind = type(value)
  if kind == 'string' then return quote(value) end
  if kind == 'boolean' then return value and 'true' or 'false' end
  if kind == 'number' then
    if value ~= value or value == math.huge or value == -math.huge then return 'null' end
    return tostring(value)
  end
  if kind ~= 'table' then error('Non-serializable response value: '..kind) end
  local out = {}
  local meta = getmetatable(value)
  if (meta and meta.__astraArray) or (#value > 0) then
    for i = 1, #value do out[#out+1] = A.json(value[i], depth+1) end
    return '['..table.concat(out, ',')..']'
  end
  for key, item in pairs(value) do out[#out+1] = quote(tostring(key))..':'..A.json(item, depth+1) end
  table.sort(out)
  return '{'..table.concat(out, ',')..'}'
end
function A.begin()
  A.diagnostics = {}
end
function A.unavailable(group, field, reason)
  local d = A.diagnostics[group]
  if not d then d = {}; A.diagnostics[group] = d end
  local entry = d[field]
  if entry then entry.count = entry.count + 1
  else d[field] = {reason=tostring(reason):match('^[^\r\n]*'), count=1} end
  return A.null
end
function A.call(group, object, method, ...)
  if object == nil or object == A.null then return A.unavailable(group, method, 'API object unavailable in this context') end
  local count = select('#', ...)
  local args = {...}
  local ok, result = pcall(function()
    local fn = object[method]
    if type(fn) ~= 'function' then error('API method unavailable') end
    return fn(object, unpack(args, 1, count))
  end)
  if not ok then return A.unavailable(group, method, result) end
  if result == nil then return A.null end
  return result
end
function A.static(group, object, method, ...)
  if object == nil then return A.unavailable(group, method, 'API namespace unavailable') end
  local count = select('#', ...)
  local args = {...}
  local ok, result = pcall(function()
    local fn = object[method]
    if type(fn) ~= 'function' then error('API function unavailable') end
    return fn(unpack(args, 1, count))
  end)
  if not ok then return A.unavailable(group, method, result) end
  if result == nil then return A.null end
  return result
end
function A.fields(group, object, methods)
  local result = {}
  for field, method in pairs(methods) do result[field] = A.call(group, object, method) end
  return result
end
function A.section(group, fn)
  local ok, value = pcall(fn)
  if not ok then return A.unavailable(group, 'section', value) end
  return value
end
function A.row(tableName, index)
  if index == nil or index == A.null or index == -1 then return A.null end
  local rows = GameInfo[tableName]
  local row = rows and rows[index]
  if not row then return A.null end
  return row
end
function A.typeName(tableName, index, field)
  local row = A.row(tableName, index)
  if row == A.null then return A.null end
  return row[field] or A.null
end
function A.emit(marker, fn)
  A.begin()
  local ok, result = pcall(fn)
  local response = {ok=ok}
  if ok then response.result = result else response.error = tostring(result) end
  response.unavailable = A.diagnostics
  local encodedOK, text = pcall(A.json, response)
  if not encodedOK then text = A.json({ok=false,error='Response encoding failed: '..tostring(text)}) end
  if #text > 16777216 then text = A.json({ok=false,error='Response exceeds 16 MiB; use map pagination'}) end
  local chunks = math.max(1, math.ceil(#text / 2500))
  for i = 1, chunks do
    local part = text:sub((i-1)*2500+1, i*2500)
    local hex = part:gsub('.', function(c) return string.format('%02x',string.byte(c)) end)
    print(marker..':'..i..':'..chunks..':'..hex)
  end
  print(marker..':DONE')
end
-- Shared v2 primitives. Every module below builds legality, geometry and naming on these so the
-- model never sees a raw hash, an undecoded enum, or an unexplained rejection.

--- Localise a LOC_* key, keeping the raw key when the ruleset has no string for it.
function A.loc(key)
  if key == nil or key == A.null then return A.null end
  if type(key) ~= 'string' then return key end
  local ok, text = pcall(Locale.Lookup, key)
  if ok and type(text) == 'string' and text ~= '' then return text end
  return key -- Ruleset has no string for this key; the raw key is still an honest identifier.
end

--- Plot index <-> coordinates. Engine lookup, never assumed row-major arithmetic.
function A.plotXY(index)
  if type(index) ~= 'number' then return A.null end
  local plot = Map.GetPlotByIndex(index)
  if not plot then return A.null end
  return A.array({ plot:GetX(), plot:GetY() })
end
function A.plotIndex(x, y)
  local plot = Map.GetPlot(x, y)
  if not plot then return A.null end
  return plot:GetIndex()
end
--- Convert an engine plot-index list into [[x,y],...]; unknown indices are dropped, not faked.
function A.plots(list)
  local out = A.array()
  if type(list) ~= 'table' then return out end
  for _, index in ipairs(list) do
    local xy = A.plotXY(index)
    if xy ~= A.null then out[#out+1] = xy end
  end
  return out
end

--- Reverse-map a numeric engine enum to its name. `label` only names the cache and diagnostics.
local enumNames = {}
function A.enumName(label, namespace, value)
  if type(value) ~= 'number' then return A.null end
  local cache = enumNames[label]
  if not cache then
    cache = {}
    if type(namespace) == 'table' then
      for name, item in pairs(namespace) do
        -- PARAM_/VALUE_ keys share the numeric space with real member names; never prefer them,
        -- and break ties deterministically so repeated snapshots stay byte-stable.
        if type(name) == 'string' and type(item) == 'number' then
          local previous = cache[item]
          local auxiliary = name:match('^PARAM_') or name:match('^VALUE_')
          if previous == nil then cache[item] = name
          elseif auxiliary == nil and (previous:match('^PARAM_') or previous:match('^VALUE_')) then cache[item] = name
          elseif auxiliary == nil and name < previous then cache[item] = name end
        end
      end
    end
    enumNames[label] = cache
  end
  local name = cache[value]
  if name == nil then return A.unavailable('enums', label, 'No enum name for value '..tostring(value)) end
  return name
end

--- GameInfo row lookup accepting either the full type string or its short form.
-- Dispatching on row.Hash is the only correct path: the UnitOperationTypes/UnitCommandTypes globals
-- exist for a subset only (HEAL, SLEEP and SKIP_TURN are nil there), and hashes pick up mod-added
-- operations automatically.
local infoRows = {}
local function rowIndex(tableName, keyField, prefix, wanted)
  local cache = infoRows[tableName]
  if cache then return cache end
  cache = {}
  local rows = GameInfo[tableName]
  if rows then
    local function add(row)
      if type(row) ~= 'table' and type(row) ~= 'userdata' then return end
      local key = row[keyField]
      if type(key) == 'string' then
        cache[key] = row
        local short = key:match('^' .. prefix .. '(.+)$')
        if short and cache[short] == nil then cache[short] = row end
      end
    end
    -- Civ's GameInfo collections also support direct string indexing.  The
    -- guarded iterator keeps fixtures and rulesets with a sparse collection
    -- honest without assuming one particular binding representation.
    add(rows[wanted])
    pcall(function() for row in rows() do add(row) end end)
  end
  infoRows[tableName] = cache
  return cache
end
function A.unitOperationRow(name) return rowIndex('UnitOperations', 'OperationType', 'UNITOPERATION_', name)[name] end
function A.unitCommandRow(name) return rowIndex('UnitCommands', 'CommandType', 'UNITCOMMAND_', name)[name] end
--- Short model-facing name for a GameInfo row (HEAL, not UNITOPERATION_HEAL).
function A.shortName(value, prefix)
  if type(value) ~= 'string' then return A.null end
  return value:match('^' .. prefix .. '(.+)$') or value
end

--- Hash -> type string, for engine results that report a hash.
local hashRows = {}
function A.typeFromHash(tableName, keyField, hash)
  if type(hash) ~= 'number' then return A.null end
  local cache = hashRows[tableName]
  if not cache then
    cache = {}
    local rows = GameInfo[tableName]
    if rows then for row in rows() do if type(row.Hash) == 'number' then cache[row.Hash] = row[keyField] end end end
    hashRows[tableName] = cache
  end
  return cache[hash] or A.null
end

--- Resolve the game-qualified id emitted by state.lua to a live owned object.
-- Keeping this in common.lua gives action and decision modules one authority for
-- ownership/session checks; an id from another game or player cannot be used.
function A.ownedEntity(kind, value, pid)
  assert(kind == 'unit' or kind == 'city', 'Entity kind must be unit or city')
  assert(type(value) == 'string', 'Use a game-qualified '..kind..'Id from a fresh snapshot')
  assert(type(pid) == 'number' and pid >= 0 and pid % 1 == 0, 'Entity owner must be a player id')
  local session, actualKind, owner, index = value:match('^([^:]+):([^:]+):(%d+):(%d+)$')
  assert(session == A.session and actualKind == kind and tonumber(owner) == pid,
    'Entity ID is from another game/player or is not an owned '..kind)
  local player = Players and Players[pid]
  assert(player, 'Owning player is unavailable; refresh the game state')
  local collection = kind == 'unit' and player:GetUnits() or player:GetCities()
  assert(collection, 'Owned '..kind..' collection is unavailable')
  local entity = collection:FindID(tonumber(index))
  assert(entity, 'Owned entity no longer exists; refresh the snapshot')
  return entity
end

--- Parameter key from an engine namespace, with a message the model can act on.
function A.param(namespace, name)
  local value = namespace and namespace[name]
  assert(value ~= nil, 'Parameter key unavailable in this ruleset: ' .. tostring(name))
  return value
end

--- Decode a CanStart*/Get*Targets results table. The engine reports *why* an action is unavailable;
-- returning null here (the v1 behaviour) turned every rejection into an unexplained dead end.
function A.results(namespace, results)
  local out = {}
  if type(results) ~= 'table' or type(namespace) ~= 'table' then return out end
  local function slot(key)
    local index = namespace[key]
    if index == nil then return nil end
    return results[index]
  end
  local function localised(key)
    local list = slot(key)
    if type(list) ~= 'table' then return nil end
    local out2 = A.array()
    for _, item in ipairs(list) do out2[#out2+1] = A.loc(item) end
    if #out2 == 0 then return nil end
    return out2
  end
  local function values(key, mapper)
    local list = slot(key)
    if type(list) ~= 'table' then return nil end
    local out2 = A.array()
    for _, item in ipairs(list) do
      local value = mapper and mapper(item) or item
      if value ~= nil and value ~= A.null then out2[#out2+1] = value end
    end
    if #out2 == 0 then return nil end
    return out2
  end
  out.reasons = localised('FAILURE_REASONS')
  out.notes = localised('ADDITIONAL_DESCRIPTION')
  local name = slot('ACTION_NAME')
  if type(name) == 'string' and name ~= '' then out.name = A.loc(name) end
  local plots = slot('PLOTS')
  local modifiers = slot('MODIFIERS')
  if type(plots) == 'table' then
    out.plots = A.plots(plots)
    -- PLOTS and MODIFIERS are positional native arrays. Keep their pairing;
    -- dropping the range overlay here would make attack discovery unsafe.
    if type(modifiers) == 'table' then
      out.modifiers = A.array()
      out.plotResults = A.array()
      out.targets = A.array()
      for index, plotId in ipairs(plots) do
        local xy = A.plotXY(plotId)
        local modifier = modifiers[index]
        local decoded = A.enumName('UnitOperationResults', namespace, modifier)
        out.modifiers[index] = decoded
        if xy ~= A.null then
          local pair = {plot=xy, modifier=decoded}
          out.plotResults[#out.plotResults+1] = pair
          if namespace.MODIFIER_IS_TARGET ~= nil and modifier == namespace.MODIFIER_IS_TARGET then
            out.targets[#out.targets+1] = xy
          end
        end
      end
    end
  end
  out.improvements = values('IMPROVEMENTS', function(item)
    if type(item) == 'string' then return item end
    if type(item) == 'number' then return A.typeFromHash('Improvements', 'ImprovementType', item) end
  end)
  out.promotions = values('PROMOTIONS', function(item)
    if type(item) == 'string' then return item end
    if type(item) == 'number' then return A.typeName('UnitPromotions', item, 'UnitPromotionType') end
  end)
  return out
end

-- Native operation/command codecs.  These are deliberately data, not a second
-- dispatcher: actions.lua uses them to encode requests and options.lua uses the
-- same records to describe exactly what can be submitted.  A row's GameInfo
-- Hash remains the only operation identity passed to the engine.
A.unitOperationSpecs = {
  MOVE_TO             = {fields={x='integer', y='integer'}, target='coordinate'},
  RANGE_ATTACK        = {fields={x='integer', y='integer'}, target='visible_coordinate'},
  AIR_ATTACK          = {fields={x='integer', y='integer'}, target='visible_coordinate'},
  FOUND_CITY          = {fields={}},
  FORTIFY             = {fields={}},
  HEAL                = {fields={}},
  SLEEP               = {fields={}},
  SKIP_TURN           = {fields={}},
  ALERT               = {fields={}},
  AUTOMATE_EXPLORE    = {fields={}},
  EMBARK              = {fields={}},
  DISEMBARK           = {fields={}},
  BUILD_IMPROVEMENT   = {fields={improvement='ImprovementType'}, currentPlot=true},
  BUILD_ROUTE         = {fields={}, currentPlot=true},
  REPAIR              = {fields={}, currentPlot=true},
  REPAIR_ROUTE        = {fields={}, currentPlot=true},
  REMOVE_FEATURE      = {fields={}, currentPlot=true},
  REMOVE_IMPROVEMENT  = {fields={}, currentPlot=true},
  HARVEST_RESOURCE    = {fields={}, currentPlot=true},
  PILLAGE             = {fields={}, currentPlot=true},
  PILLAGE_ROUTE       = {fields={}, currentPlot=true},
  SPREAD_RELIGION     = {fields={}, currentPlot=true},
  EVANGELIZE_BELIEF   = {fields={}, currentPlot=true},
  REMOVE_HERESY       = {fields={}, currentPlot=true},
  PLANT_FOREST        = {fields={}, currentPlot=true},
  EXCAVATE            = {fields={}, currentPlot=true},
  COASTAL_RAID        = {fields={x='integer', y='integer'}, target='visible_coordinate'},
  REBASE              = {fields={x='integer', y='integer'}, target='visible_coordinate'},
  DEPLOY              = {fields={x='integer', y='integer'}, target='visible_coordinate'},
  SWAP_UNITS          = {fields={x='integer', y='integer'}, target='coordinate'},
  ROUTE_TO            = {fields={x='integer', y='integer'}, target='coordinate', nativeUiOnly=true},
  MAKE_TRADE_ROUTE    = {fields={destinationX='integer', destinationY='integer'}, target='visible_coordinate'},
}

A.unitCommandSpecs = {
  AUTOMATE            = {fields={}},
  WAKE                = {fields={}},
  CANCEL              = {fields={}},
  STOP_AUTOMATION     = {fields={}},
  DELETE              = {fields={}},
  EXIT_FORMATION      = {fields={}},
  UPGRADE             = {fields={}},
  FORM_CORPS          = {fields={targetUnitId='unitId'}},
  FORM_ARMY           = {fields={targetUnitId='unitId'}},
  ENTER_FORMATION     = {fields={targetUnitId='unitId'}},
  PLUNDER_TRADE_ROUTE = {fields={}},
  CONDEMN_HERETIC     = {fields={}},
  WONDER_PRODUCTION   = {fields={}},
  HARVEST_WONDER      = {fields={}},
  PET_THE_DOG         = {fields={}},
}

local ruleTables = {
  Units=true, UnitPromotions=true, UnitPromotionPrereqs=true, UnitUpgrades=true,
  UnitOperations=true, UnitCommands=true, Buildings=true, BuildingPrereqs=true,
  Districts=true, District_Adjacencies=true, Adjacency_YieldChanges=true,
  Projects=true, Technologies=true, TechnologyPrereqs=true, Civics=true, CivicPrereqs=true,
  Policies=true, Governments=true, GovernmentSlots=true, Government_SlotCounts=true,
  Resources=true, Resource_YieldChanges=true, Terrains=true, Terrain_YieldChanges=true,
  Features=true, Feature_YieldChanges=true, Improvements=true, Improvement_YieldChanges=true,
  Improvement_ValidTerrains=true, Improvement_ValidFeatures=true, Routes=true, Yields=true,
  Religions=true, Beliefs=true, GreatPersonIndividuals=true, GreatPersonClasses=true,
  Governors=true, GovernorPromotions=true, GovernorPromotionPrereqs=true,
  Victories=true, Eras=true, GlobalParameters=true, Leaders=true, Civilizations=true,
  Traits=true, LeaderTraits=true, CivilizationTraits=true, Types=true
}
function A.rules(args)
  if not args.table then
    local names = A.array(); for name in pairs(ruleTables) do names[#names+1] = name end; table.sort(names)
    return {tables=names, filters='Exact scalar equality in where; limit <= 500, offset >= 0. No SQL or Lua.'}
  end
  if not ruleTables[args.table] then error('GameInfo table is not allowlisted') end
  local rows = GameInfo[args.table]
  if not rows then error('GameInfo table unavailable for this ruleset: '..args.table) end
  local limit, offset = args.limit or 100, args.offset or 0
  assert(type(limit)=='number' and limit >= 1 and limit <= 500 and limit%1==0, 'limit must be 1..500')
  assert(type(offset)=='number' and offset >= 0 and offset%1==0, 'offset must be a nonnegative integer')
  local result, matched = A.array(), 0
  for row in rows() do
    local accept = true
    for key, value in pairs(args.where or {}) do if row[key] ~= value then accept = false; break end end
    if accept then
      if matched >= offset and #result < limit then
        local copy = {}
        for key, value in pairs(row) do
          if type(value)=='string' or type(value)=='number' or type(value)=='boolean' then copy[key]=value end
        end
        result[#result+1] = copy
      end
      matched = matched+1
    end
  end
  return {table=args.table, rows=result, offset=offset, total=matched, more=matched>offset+#result}
end
