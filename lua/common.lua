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
  local args = {...}
  local ok, result = pcall(function()
    local fn = object[method]
    if type(fn) ~= 'function' then error('API method unavailable') end
    return fn(object, unpack(args))
  end)
  if not ok then return A.unavailable(group, method, result) end
  if result == nil then return A.null end
  return result
end
function A.static(group, object, method, ...)
  if object == nil then return A.unavailable(group, method, 'API namespace unavailable') end
  local args = {...}
  local ok, result = pcall(function()
    local fn = object[method]
    if type(fn) ~= 'function' then error('API function unavailable') end
    return fn(unpack(args))
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
