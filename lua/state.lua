local A = AstraCiv
-- Observe the native notification event stream and ask the UI to replay its current list.
-- RestoreVisualState changes no game state; it is the same replay used when NotificationPanel reloads.
if not A.notificationsInitialized then
  A.notificationIds = {}
  Events.NotificationAdded.Add(function(playerId, notificationId)
    A.notificationIds[playerId] = A.notificationIds[playerId] or {}
    A.notificationIds[playerId][notificationId] = true
  end)
  Events.NotificationDismissed.Add(function(playerId, notificationId)
    if A.notificationIds[playerId] then A.notificationIds[playerId][notificationId] = nil end
  end)
  A.notificationsRestoredFor = nil
  A.notificationsInitialized = true
end
local function restoreNotifications(pid)
  if A.notificationsRestoredFor ~= pid then
    NotificationManager.RestoreVisualState(pid)
    A.notificationsRestoredFor = pid
  end
end

function A.hasCongressNotification(pid)
  restoreNotifications(pid)
  local types = NotificationTypes or {}
  for notificationId in pairs(A.notificationIds[pid] or {}) do
    local notification = A.static('congress', NotificationManager, 'Find', pid, notificationId)
    if notification ~= A.null and A.call('congress', notification, 'IsDismissed') == false then
      local kind = A.call('congress', notification, 'GetType')
      for _, name in ipairs({
        'NOTIFICATION_WORLD_CONGRESS_SPECIAL_SESSION_BLOCKING',
        'NOTIFICATION_WORLD_CONGRESS_SPECIAL_SESSION_NON_BLOCKING',
        'NOTIFICATION_WORLD_CONGRESS_SPECIAL_SESSION_CAN_BE_CALLED',
        'NOTIFICATION_WORLD_CONGRESS_EMERGENCY_CAN_BE_CALLED',
      }) do
        if types[name] ~= nil and kind == types[name] then return true end
      end
    end
  end
  return false
end
local blockerNames = {}
for name, value in pairs(EndTurnBlockingTypes or {}) do
  if type(name) == 'string' and type(value) == 'number' then blockerNames[value] = name end
end
-- What each end-turn blocker actually wants from the player. `units`/`cities` name entities;
-- `needs` names the decision, so the model never has to guess what an opaque blocker type means.
local blockerUnits = {ENDTURN_BLOCKING_UNITS=true, ENDTURN_BLOCKING_UNIT_NEEDS_ORDERS=true, ENDTURN_BLOCKING_STACKED_UNITS=true}
local blockerNeeds = {
  ENDTURN_BLOCKING_PRODUCTION='production', ENDTURN_BLOCKING_RESEARCH='research', ENDTURN_BLOCKING_CIVIC='civic',
  ENDTURN_BLOCKING_FILL_CIVIC_SLOT='policies', ENDTURN_BLOCKING_CONSIDER_GOVERNMENT_CHANGE='government',
  ENDTURN_BLOCKING_CONSIDER_RAZE_CITY='razeOrKeep', ENDTURN_BLOCKING_PANTHEON='pantheon',
  ENDTURN_BLOCKING_RELIGION='religion', ENDTURN_BLOCKING_BELIEF='belief',
  ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN='influenceToken', ENDTURN_BLOCKING_CLAIM_GREAT_PERSON='greatPerson',
  ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE='spyEscapeRoute', ENDTURN_BLOCKING_SPY_CHOOSE_DRAGNET_PRIORITY='spyDragnetPriority',
  ENDTURN_BLOCKING_ARTIFACT='artifact'
}
local function id(kind, owner, index)
  if index == nil then return A.session..':'..kind..':'..owner end
  return A.session..':'..kind..':'..owner..':'..index
end
function A.localPlayer()
  local pid = Game.GetLocalPlayer()
  assert(pid and pid >= 0 and Players[pid], 'No local player. Load an active game; observer/hotseat transition is not supported.')
  return pid, Players[pid]
end
-- "Ready" mirrors the native rule: awake, still has movement, and not holding a fortify/sleep/skip
-- posture. IsReadyToMove is the engine's own answer (UnitFlagManager/CityBannerManager use it) and
-- only ever narrows the result, so a missing API degrades to the documented composite test.
local function unitIsReady(unit)
  local activity = A.static('units', UnitManager, 'GetActivityType', unit)
  local moves = A.call('units', unit, 'GetMovesRemaining')
  local fortify = A.call('units', unit, 'GetFortifyTurns')
  local awake = ActivityTypes ~= nil and activity == ActivityTypes.ACTIVITY_AWAKE
  local ready = awake and type(moves) == 'number' and moves > 0 and (fortify == A.null or fortify == 0)
  if not ready then return false end
  return A.call('units', unit, 'IsReadyToMove') ~= false
end
local function readyUnitIds(pid, player)
  local out = A.array()
  for _, unit in player:GetUnits():Members() do
    if unitIsReady(unit) then out[#out+1] = id('unit', pid, unit:GetID()) end
  end
  return out
end
local function idleProductionCityIds(pid, player)
  local out = A.array()
  for _, city in player:GetCities():Members() do
    -- Hash 0 is the engine's "nothing being produced" sentinel (Base/Assets/UI/CitySupport.lua).
    if A.call('cityProduction', A.call('cityProduction', city, 'GetBuildQueue'), 'GetCurrentProductionTypeHash') == 0 then
      out[#out+1] = id('city', pid, city:GetID())
    end
  end
  return out
end
function A.turnState()
  local pid, player = A.localPlayer()
  -- ActionPanel.UpdateEndTurn waits for these before entering blocker bindings.
  local alive=A.call('turn',player,'IsAlive')
  local complete=A.call('turn',player,'IsTurnActiveComplete')
  local processing=A.static('turn',UI,'IsProcessingMessages')
  local ready=alive==true and complete==true and processing==false
  local types=A.null
  if ready then
    types=A.static('notifications',NotificationManager,'GetAllEndTurnBlocking',pid)
  else
    A.unavailable('notifications','readiness','Blocker observation deferred until the local player is alive, turn activation is complete, and UI messages have drained')
  end
  local blockers=A.null
  if types~=A.null and type(types)=='table' then
    blockers=A.array()
    for _,blockingType in ipairs(types) do
      local n=A.static('notifications',NotificationManager,'FindEndTurnBlocking',blockingType,pid)
      local summaryKey=n~=A.null and A.call('notifications',n,'GetSummary') or A.null
      local name=blockerNames[blockingType]
      -- id is an EndTurnBlockingTypes identifier, not a notification ID; unit orders may have no notification.
      local blocker={id=blockingType, type=name or A.null, summaryKey=summaryKey, summary=A.loc(summaryKey)}
      if name and blockerUnits[name] then blocker.units=A.section('turnBlockers',function() return readyUnitIds(pid,player) end) end
      if name=='ENDTURN_BLOCKING_PRODUCTION' then blocker.cities=A.section('turnBlockers',function() return idleProductionCityIds(pid,player) end) end
      if name and blockerNeeds[name] then blocker.needs=blockerNeeds[name] end
      blockers[#blockers+1]=blocker
    end
  end
  local canEndTurn,firstBlocker=A.null,A.null
  if ready then
    canEndTurn=A.static('turn',UI,'CanEndTurn')
    firstBlocker=A.static('notifications',NotificationManager,'GetFirstEndTurnBlocking',pid)
  end
  return {
    turn=Game.GetCurrentGameTurn(), active=A.call('turn',player,'IsTurnActive'),
    processing=processing, blockersReady=ready,
    submitted=A.static('turn',UI,'HasSentTurnComplete'),
    canEndTurn=canEndTurn, firstBlocker=firstBlocker,
    blockers=blockers
  }
end

function A.dismiss_notifications(args)
  local pid = A.localPlayer()
  restoreNotifications(pid)
  local dismissed = A.array()
  for nid in pairs(A.notificationIds[pid] or {}) do
    local n = A.static('dismiss', NotificationManager, 'Find', pid, nid)
    if n and n ~= A.null and A.call('dismiss', n, 'CanUserDismiss') == true then
      NotificationManager.Dismiss(pid, nid)
      dismissed[#dismissed+1] = id('notification', pid, nid)
    end
  end
  return { dismissed = dismissed, count = #dismissed }
end

function A.keybinds(args)
  args = args or {}
  local limit, offset = args.limit or 400, args.offset or 0
  assert(type(limit)=='number' and limit>=1 and limit<=1000 and limit%1==0, 'limit must be 1..1000')
  assert(type(offset)=='number' and offset>=0 and offset%1==0, 'offset must be a nonnegative integer')
  assert(args.category==nil or type(args.category)=='string', 'category must be a string')
  local category = args.category and string.lower(args.category)
  return A.section('keybinds', function()
    local out = A.array()
    local count = Input.GetActionCount()
    local matched = 0
    for i = 0, count - 1 do
      local actionId = Input.GetActionId(i)
      if Input.ShouldShowActionKeybinding(actionId) then
        local categoryKey = Input.GetActionCategory(actionId)
        local cat = Locale.Lookup(categoryKey)
        if not category or string.find(string.lower(cat), category, 1, true) or string.find(string.lower(categoryKey), category, 1, true) then
          matched = matched + 1
          if matched > offset and #out < limit then
            out[#out+1] = { name = Locale.Lookup(Input.GetActionName(actionId)), category = cat,
              key = Input.GetGestureDisplayString(actionId, 0) or A.null, alt = Input.GetGestureDisplayString(actionId, 1) or A.null }
          end
        end
      end
    end
    return { actions = out, offset = offset, total = matched, more = matched > offset + #out }
  end)
end
-- ---------------------------------------------------------------------------
-- Decoding. The model never sees a raw hash or engine index without the type string beside it.
-- ---------------------------------------------------------------------------
--- GameInfo tables accept an index, a hash or a type string (Base/Assets/UI/CitySupport.lua
--- FilterUnitStats names its parameter `hashOrType`), so resolve index first, hash second, and
--- return the whole row whenever one is found so callers can decode name and type together.
local function rowFromValue(tableName, keyField, value)
  if type(value) == 'string' then return GameInfo[tableName][value] end
  if type(value) ~= 'number' then return nil end
  local row = A.row(tableName, value)
  if row ~= A.null then return row end
  local name = A.typeFromHash(tableName, keyField, value)
  if name ~= A.null then return GameInfo[tableName][name] end
  return nil
end
local productionKinds={{'Units','UnitType','unit'},{'Buildings','BuildingType','building'},{'Districts','DistrictType','district'},{'Projects','ProjectType','project'}}
--- Current-production hash -> type string, owning kind and the GameInfo row. 0 means idle.
local function productionFromHash(hash)
  if type(hash) ~= 'number' or hash == 0 then return A.null, A.null, nil end
  for _, spec in ipairs(productionKinds) do
    local name = A.typeFromHash(spec[1], spec[2], hash)
    if name ~= A.null then return name, spec[3], GameInfo[spec[1]][name] end
  end
  return A.null, A.null, nil
end
--- Localised display name of a GameInfo row; null when the row is absent, never a guess.
local function locName(tableName, index)
  local row = A.row(tableName, index)
  if row == A.null or row.Name == nil then return A.null end
  return A.loc(row.Name)
end
--- Religions index 0 is RELIGION_PANTHEON; negative means "no religion here", never a fabricated one.
local function religionType(index)
  if type(index) ~= 'number' or index < 0 then return A.null end
  return A.typeName('Religions', index, 'ReligionType')
end
local function beliefType(index)
  if type(index) ~= 'number' or index < 0 then return A.null end
  return A.typeName('Beliefs', index, 'BeliefType')
end
--- One build-queue entry. Field set depends on Directive (Base/Assets/UI/ProductionHelper.lua).
local function queueEntry(entry, index)
  local item = {index=index}
  if type(entry) ~= 'table' then return item end
  for key, value in pairs(entry) do
    if type(value)=='string' or type(value)=='number' or type(value)=='boolean' then item[key]=value end
  end
  item.directive = A.enumName('CityProductionDirectives', CityProductionDirectives, entry.Directive)
  local kinds={{'UnitType','Units','UnitType','unit'},{'BuildingType','Buildings','BuildingType','building'},{'DistrictType','Districts','DistrictType','district'},{'ProjectType','Projects','ProjectType','project'}}
  for _, kind in ipairs(kinds) do
    if entry[kind[1]] ~= nil then
      local row = rowFromValue(kind[2], kind[3], entry[kind[1]])
      item.kind = kind[4]
      item.item = row and row[kind[3]] or A.null
      item.name = row and A.loc(row.Name) or A.null
      break
    end
  end
  if entry.MilitaryFormationType ~= nil then item.formation=A.enumName('MilitaryFormationTypes',MilitaryFormationTypes,entry.MilitaryFormationType) end
  -- Only the head node carries a real placement; the rest report the (-9999,-9999) sentinel.
  if type(entry.Location)=='table' and type(entry.Location.x)=='number' and entry.Location.x>=0 then
    item.x, item.y = entry.Location.x, entry.Location.y
  end
  return item
end
local function yields(group, object)
  local out = {}
  for row in GameInfo.Yields() do out[row.YieldType]=A.call(group,object,'GetYield',row.Index) end
  return out
end
local function unitRecord(unit, own)
  local owner, uid = unit:GetOwner(), unit:GetID()
  local result = A.fields('units',unit,{
    x='GetX',y='GetY',typeIndex='GetUnitType',nameKey='GetName',damage='GetDamage',
    maxDamage='GetMaxDamage',formationIndex='GetMilitaryFormation',combat='GetCombat',rangedCombat='GetRangedCombat',range='GetRange'
  })
  result.id, result.owner, result.engineId, result.own = id('unit',owner,uid), owner, uid, own
  local unitRow = rowFromValue('Units','UnitType',result.typeIndex)
  result.unitType = unitRow and unitRow.UnitType or A.null
  result.unitName = unitRow and A.loc(unitRow.Name) or A.null
  result.name = A.loc(result.nameKey)
  result.formation = A.enumName('MilitaryFormationTypes', MilitaryFormationTypes, result.formationIndex)
  assert(type(result.x)=='number' and type(result.y)=='number' and result.unitType~=A.null,'Core unit identity/position extraction failed')
  result.visibility, result.lastSeenTurn = 'visible', Game.GetCurrentGameTurn()
  if own then
    local extra = A.fields('units',unit,{moves='GetMovesRemaining',maxMoves='GetMaxMoves',buildCharges='GetBuildCharges',religiousStrength='GetReligiousStrength',spreadCharges='GetSpreadCharges',fortifyTurns='GetFortifyTurns'})
    -- The raw activity value is an opaque enum number; only the decoded name is emitted.
    extra.activity=A.enumName('ActivityTypes',ActivityTypes,A.static('units',UnitManager,'GetActivityType',unit))
    for key,value in pairs(extra) do result[key]=value end
    assert(type(result.moves)=='number' and type(result.maxMoves)=='number','Core unit movement extraction failed')
    result.ready = unitIsReady(unit)
    result.experience = A.section('unitExperience',function()
      local experience=unit:GetExperience()
      local values=A.fields('unitExperience',experience,{experience='GetExperiencePoints',level='GetLevel'})
      values.promotions=A.array()
      for row in GameInfo.UnitPromotions() do if experience:HasPromotion(row.Index) then values.promotions[#values.promotions+1]=row.UnitPromotionType end end
      return values
    end)
  end
  return result
end
local function cityRecord(city, own)
  local owner,cid=city:GetOwner(),city:GetID()
  local result = A.fields('cities',city,{nameKey='GetName',x='GetX',y='GetY',population='GetPopulation'})
  result.id,result.owner,result.engineId,result.own=id('city',owner,cid),owner,cid,own
  result.name=A.loc(result.nameKey)
  result.visibility,result.lastSeenTurn='visible',Game.GetCurrentGameTurn()
  if not own then return result end
  result.yields=yields('cityYields',city)
  result.growth=A.section('cityGrowth',function()
    return A.fields('cityGrowth',city:GetGrowth(),{food='GetFood',foodSurplus='GetFoodSurplus',growthThreshold='GetGrowthThreshold',turnsUntilGrowth='GetTurnsUntilGrowth',turnsUntilStarvation='GetTurnsUntilStarvation',housing='GetHousing',amenities='GetAmenities',amenitiesNeeded='GetAmenitiesNeeded',happiness='GetHappiness',growthModifier='GetOverallGrowthModifier',housingModifier='GetHousingGrowthModifier'})
  end)
  result.loyalty=A.section('cityLoyalty',function()
    return A.fields('cityLoyalty',city:GetCulturalIdentity(),{loyalty='GetLoyalty',loyaltyPerTurn='GetLoyaltyPerTurn',maxLoyalty='GetMaxLoyalty'})
  end)
  result.production=A.section('cityProduction',function()
    local queue=city:GetBuildQueue()
    local out=A.fields('cityProduction',queue,{currentHash='GetCurrentProductionTypeHash',currentModifier='GetCurrentProductionTypeModifier'})
    out.current,out.currentKind,out.currentRow=productionFromHash(out.currentHash)
    out.currentName=out.currentRow and A.loc(out.currentRow.Name) or A.null
    out.currentRow=nil
    out.queue=A.array()
    for index=0,queue:GetSize()-1 do out.queue[#out.queue+1]=queueEntry(queue:GetAt(index),index) end
    out.options=A.array()
    for _, definition in ipairs({{'Units','UnitType','Unit'},{'Buildings','BuildingType','Building'},{'Districts','DistrictType','District'},{'Projects','ProjectType','Project'}}) do
      for row in GameInfo[definition[1]]() do
        local legal=A.call('cityProduction',queue,'CanProduce',row.Hash,true)
        if legal == true then
          out.options[#out.options+1]={type=row[definition[2]],hash=row.Hash,kind=definition[3]:lower(),cost=A.call('cityProduction',queue,'Get'..definition[3]..'Cost',row.Index),progress=A.call('cityProduction',queue,'Get'..definition[3]..'Progress',row.Index),turns=A.call('cityProduction',queue,'GetTurnsLeft',row[definition[2]])}
        end
      end
    end
    return out
  end)
  result.buildings=A.section('cityBuildings',function()
    local out=A.array(); local buildings=city:GetBuildings()
    for row in GameInfo.Buildings() do if buildings:HasBuilding(row.Index) then out[#out+1]={type=row.BuildingType,pillaged=buildings:IsPillaged(row.Index)} end end
    return out
  end)
  result.districts=A.section('cityDistricts',function()
    local out=A.array()
    for _,district in city:GetDistricts():Members() do
      local item=A.fields('cityDistricts',district,{typeIndex='GetType',x='GetX',y='GetY',complete='IsComplete'})
      item.type=A.typeName('Districts',item.typeIndex,'DistrictType'); item.yields=yields('cityDistrictYields',district)
      item.garrisonDamage=A.call('cityDefense',district,'GetDamage',DefenseTypes.DISTRICT_GARRISON)
      item.garrisonMaxDamage=A.call('cityDefense',district,'GetMaxDamage',DefenseTypes.DISTRICT_GARRISON)
      item.wallDamage=A.call('cityDefense',district,'GetDamage',DefenseTypes.DISTRICT_OUTER)
      item.wallMaxDamage=A.call('cityDefense',district,'GetMaxDamage',DefenseTypes.DISTRICT_OUTER)
      item.defense=A.call('cityDefense',district,'GetDefenseStrength')
      out[#out+1]=item
    end
    return out
  end)
  result.religion=A.section('cityReligion',function()
    local api=city:GetReligion()
    local out=A.fields('cityReligion',api,{majorityIndex='GetMajorityReligion',present='GetReligionsInCity'})
    out.majority=religionType(out.majorityIndex)
    out.majorityName=locName('Religions',out.majorityIndex)
    out.religions=A.array()
    if type(out.present)=='table' then
      for _,entry in pairs(out.present) do
        if type(entry)=='table' then out.religions[#out.religions+1]={religionIndex=entry.Religion,type=religionType(entry.Religion),name=locName('Religions',entry.Religion),followers=entry.Followers,pressure=entry.Pressure} end
      end
    end
    out.present=nil
    return out
  end)
  result.citizens=A.section('cityCitizens',function()
    local citizens=city:GetCitizens()
    local plots=A.call('cityCitizens',Map.GetCityPlots(),'GetPurchasedPlots',city)
    local out={plots=plots,tiles=A.plots(plots),focus={}}
    for row in GameInfo.Yields() do out.focus[row.YieldType]={favored=citizens:IsFavoredYield(row.Index),disfavored=citizens:IsDisfavoredYield(row.Index)} end
    return out
  end)
  return result
end
-- Civ stores each river/cliff edge on exactly one of its two plots: the plot on the west, NE or NW
-- side of the edge. IsWOfRiver therefore means "a river runs along my EAST edge" (this plot is the
-- west side of it), IsNWOfRiver the SE edge, IsNEOfRiver the SW edge; the opposite three edges are
-- read from the respective neighbours, which must themselves be in sight. The WorldBuilder map
-- schema pairs IsWOfRiver with EFlowDirection, IsNWOfRiver with SEFlowDirection and IsNEOfRiver
-- with SWFlowDirection, and cliffs use the same three-flag scheme with no flow.
local edgeBit={[0]=1,2,4,8,16,32}
local edgeMethods={
  [0]={river='IsNEOfRiver',cliff='IsNEOfCliff',flow='GetRiverSWFlowDirection'},
  [1]={self=true,river='IsWOfRiver',cliff='IsWOfCliff',flow='GetRiverEFlowDirection'},
  [2]={self=true,river='IsNWOfRiver',cliff='IsNWOfCliff',flow='GetRiverSEFlowDirection'},
  [3]={self=true,river='IsNEOfRiver',cliff='IsNEOfCliff',flow='GetRiverSWFlowDirection'},
  [4]={river='IsWOfRiver',cliff='IsWOfCliff',flow='GetRiverEFlowDirection'},
  [5]={river='IsNWOfRiver',cliff='IsNWOfCliff',flow='GetRiverSEFlowDirection'}
}
local function tileRecord(plot, resources, visibility, fullEdges)
  local index,x,y=plot:GetIndex(),plot:GetX(),plot:GetY()
  local out={id=id('tile',index),engineId=index,x=x,y=y,visibility='visible',lastSeenTurn=Game.GetCurrentGameTurn()}
  local fields=A.fields('map',plot,{terrainIndex='GetTerrainType',featureIndex='GetFeatureType',owner='GetOwner',improvementIndex='GetImprovementType',districtIndex='GetDistrictType',route='GetRouteType',water='IsWater',hills='IsHills',mountain='IsMountain',lake='IsLake',impassable='IsImpassable',river='IsRiver',freshWater='IsFreshWater',coastalLand='IsCoastalLand',improvementPillaged='IsImprovementPillaged',routePillaged='IsRoutePillaged',appeal='GetAppeal',continent='GetContinentType'})
  for key,value in pairs(fields) do out[key]=value end
  out.terrain=A.typeName('Terrains',out.terrainIndex,'TerrainType')
  out.feature=A.typeName('Features',out.featureIndex,'FeatureType')
  out.improvement=A.typeName('Improvements',out.improvementIndex,'ImprovementType')
  out.district=A.typeName('Districts',out.districtIndex,'DistrictType')
  -- Resource type is deliberately never returned before this player's reveal gate succeeds.
  local resourceIndex=plot:GetResourceType()
  out.resource=A.null; out.resourceCount=0; out.resourceKnowledge='no_visible_resource'
  if resourceIndex ~= -1 then
    local row=GameInfo.Resources[resourceIndex]
    local revealed=row and A.call('resourceVisibility',resources,'IsResourceVisible',row.Hash)
    if revealed == true then
      out.resource=row.ResourceType; out.resourceCount=A.call('map',plot,'GetResourceCount');out.resourceKnowledge='visible'
    end
  end
  out.yields=yields('tileYields',plot)
  -- riverMask/cliffMask: bit d set means direction d carries a river/cliff. riverKnownMask/
  -- cliffKnownMask carry the same bits for directions whose read actually succeeded: a direction
  -- whose source is out of sight, off the map, or whose read failed leaves both its value bit
  -- unset and its known bit unset, so "no river" is a fact only where the known bit is set.
  -- Direction offsets are documented once in civ.probe rather than shipping neighbour ids.
  local riverMask,cliffMask,riverKnown,cliffKnown=0,0,0,0
  if fullEdges then out.edges=A.array() end
  for direction=0,5 do
    local neighbor=Map.GetAdjacentPlot(x,y,direction)
    local spec=edgeMethods[direction]
    local source=spec.self and plot or neighbor
    local known=source~=nil and (spec.self==true or visibility:IsVisible(source:GetX(),source:GetY())==true)
    local river,cliff=A.null,A.null
    if known then
      river=A.call('mapEdges',source,spec.river); cliff=A.call('mapEdges',source,spec.cliff)
      if river==true then riverMask=riverMask+edgeBit[direction] end
      if river~=A.null then riverKnown=riverKnown+edgeBit[direction] end
      if cliff==true then cliffMask=cliffMask+edgeBit[direction] end
      if cliff~=A.null then cliffKnown=cliffKnown+edgeBit[direction] end
    end
    if fullEdges then
      local edge={direction=direction,neighbor=neighbor and id('tile',neighbor:GetIndex()) or A.null,river=river,cliff=cliff}
      if known then
        edge.flow=A.enumName('FlowDirectionTypes',FlowDirectionTypes,A.call('mapEdges',source,spec.flow))
      else
        edge.flow=A.null;edge.unavailable='Adjacent edge source is outside current sight or map'
      end
      out.edges[#out.edges+1]=edge
    end
  end
  out.riverMask,out.cliffMask=riverMask,cliffMask
  out.riverKnownMask,out.cliffKnownMask=riverKnown,cliffKnown
  return out
end
--- Exact shape the TypeScript last-known merge keys on; do not vary it.
local function revealedPlaceholder(index,x,y)
  return {id=id('tile',index),engineId=index,x=x,y=y,visibility='revealed_not_visible',lastSeenTurn=A.null,unavailable='Not currently visible; live terrain, owner, improvements, resources, yields and entities deliberately not read'}
end
local function research(player, full)
  local techs=player:GetTechs()
  local out=A.fields('research',techs,{currentIndex='GetResearchingTech',sciencePerTurn='GetScienceYield'})
  out.perTurn=out.sciencePerTurn
  out.current=A.typeName('Technologies',out.currentIndex,'TechnologyType')
  out.currentName=locName('Technologies',out.currentIndex)
  if out.current~=A.null then
    out.currentCost=A.call('research',techs,'GetResearchCost',out.currentIndex)
    out.currentProgress=A.call('research',techs,'GetResearchProgress',out.currentIndex)
    out.currentTurns=A.call('research',techs,'GetTurnsLeft',out.currentIndex)
    out.currentBoosted=A.call('research',techs,'HasBoostBeenTriggered',out.currentIndex)
  end
  out.technologies=A.array(); out.completed=A.array()
  for row in GameInfo.Technologies() do
    local completed=A.call('research',techs,'HasTech',row.Index)
    if completed==true then out.completed[#out.completed+1]=row.TechnologyType end
    local available=A.call('research',techs,'CanResearch',row.Index)
    local progress=A.call('research',techs,'GetResearchProgress',row.Index)
    if full or available==true or (type(progress)=='number' and progress>0 and completed~=true) then
      out.technologies[#out.technologies+1]={type=row.TechnologyType,index=row.Index,name=A.loc(row.Name),completed=completed,available=available,progress=progress,cost=A.call('research',techs,'GetResearchCost',row.Index),boosted=A.call('research',techs,'HasBoostBeenTriggered',row.Index),turns=A.call('research',techs,'GetTurnsLeft',row.Index)}
    end
  end
  out.detail = full and 'full' or 'summary'
  if not full then out.note='technologies lists only selectable or partially researched entries; completed holds the rest. Use detail="full" or civ.rules(table="Technologies") for the whole tree.' end
  return out
end
local function culture(player, full)
  local c=player:GetCulture()
  local out=A.fields('culture',c,{currentIndex='GetProgressingCivic',culturePerTurn='GetCultureYield',governmentIndex='GetCurrentGovernment',policyChangeCost='GetCostToUnlockPolicies',policyChangeMade='PolicyChangeMade'})
  out.perTurn=out.culturePerTurn
  out.current=A.typeName('Civics',out.currentIndex,'CivicType')
  out.currentName=locName('Civics',out.currentIndex)
  out.government=A.typeName('Governments',out.governmentIndex,'GovernmentType')
  out.governmentName=locName('Governments',out.governmentIndex)
  if out.current~=A.null then
    out.currentCost=A.call('culture',c,'GetCultureCost',out.currentIndex)
    out.currentProgress=A.call('culture',c,'GetCulturalProgress',out.currentIndex)
    out.currentTurns=A.call('culture',c,'GetTurnsLeft',out.currentIndex)
    out.currentBoosted=A.call('culture',c,'HasBoostBeenTriggered',out.currentIndex)
  end
  out.canChangePolicies=(c:CivicCompletedThisTurn() or c:GetNumPolicySlotsOpen()>0) and not c:PolicyChangeMade()
  out.civics=A.array(); out.completed=A.array(); out.policies=A.array(); out.slots=A.array()
  for row in GameInfo.Civics() do
    local completed=A.call('civics',c,'HasCivic',row.Index)
    if completed==true then out.completed[#out.completed+1]=row.CivicType end
    local available=A.call('civics',c,'CanProgress',row.Index)
    local progress=A.call('civics',c,'GetCulturalProgress',row.Index)
    if full or available==true or (type(progress)=='number' and progress>0 and completed~=true) then
      out.civics[#out.civics+1]={type=row.CivicType,index=row.Index,name=A.loc(row.Name),completed=completed,available=available,progress=progress,cost=A.call('civics',c,'GetCultureCost',row.Index),boosted=A.call('civics',c,'HasBoostBeenTriggered',row.Index),turns=A.call('civics',c,'GetTurnsLeft',row.Index)}
    end
  end
  for row in GameInfo.Policies() do
    local unlocked=A.call('policies',c,'IsPolicyUnlocked',row.Index)
    local active=A.call('policies',c,'IsPolicyActive',row.Index)
    if full or unlocked==true or active==true then
      out.policies[#out.policies+1]={type=row.PolicyType,index=row.Index,name=A.loc(row.Name),slotType=row.GovernmentSlotType,unlocked=unlocked,active=active}
    end
  end
  for slot=0,c:GetNumPolicySlots()-1 do
    local slotIndex=A.call('policies',c,'GetSlotType',slot)
    local policyIndex=A.call('policies',c,'GetSlotPolicy',slot)
    out.slots[#out.slots+1]={slot=slot,typeIndex=slotIndex,type=A.typeName('GovernmentSlots',slotIndex,'GovernmentSlotType'),policyIndex=policyIndex,policy=A.typeName('Policies',policyIndex,'PolicyType'),policyName=locName('Policies',policyIndex)}
  end
  out.detail = full and 'full' or 'summary'
  if not full then out.note='civics lists only selectable or partially progressed entries and policies only unlocked/active ones; completed holds finished civics. Use detail="full" or civ.rules for the whole tree.' end
  return out
end
local function governors(player)
  local g=player:GetGovernors(); local out=A.fields('governors',g,{points='GetGovernorPoints',spent='GetGovernorPointsSpent',canAppoint='CanAppoint'})
  out.governors=A.array()
  for row in GameInfo.Governors() do
    local governor=g:GetGovernor(row.Hash)
    local item={type=row.GovernorType,appointed=governor~=nil}
    if governor then
      local values=A.fields('governors',governor,{established='IsEstablished',turnsOnSite='GetTurnsOnSite',turnsToEstablish='GetTurnsToEstablish',neutralizedTurns='GetNeutralizedTurns'})
      for key,value in pairs(values) do item[key]=value end
      local city=governor:GetAssignedCity();item.cityId=city and id('city',city:GetOwner(),city:GetID()) or A.null
      item.promotions=A.array()
      for promotion in GameInfo.GovernorPromotions() do if governor:HasPromotion(promotion.Hash) then item.promotions[#item.promotions+1]=promotion.GovernorPromotionType end end
    end
    out.governors[#out.governors+1]=item
  end
  return out
end
local function diplomacy(pid,player)
  local d=player:GetDiplomacy();local out=A.array()
  -- Player configurations are accessed only after the local diplomacy met gate.
  for other=0,63 do
    if other~=pid and d:HasMet(other) then
      local config=PlayerConfigurations[other]
      if config then
        local item={id=id('player',other),engineId=other,met=true,civilization=config:GetCivilizationTypeName(),leader=config:GetLeaderTypeName(),atWar=d:IsAtWarWith(other)}
        item.relationship=A.call('diplomacy',player:GetDiplomaticAI(),'GetDiplomaticStateIndex',other)
        item.relationshipType=A.typeName('DiplomaticStates',item.relationship,'StateType')
        item.alliance=A.call('diplomacy',d,'GetAllianceType',other)
        item.allianceType=A.typeName('Alliances',item.alliance,'AllianceType')
        item.allianceLevel=A.call('diplomacy',d,'GetAllianceLevel',other)
        item.openBorders=A.call('diplomacy',d,'HasOpenBordersFrom',other)
        item.delegation=A.call('diplomacy',d,'HasDelegationAt',other)
        item.embassy=A.call('diplomacy',d,'HasEmbassyAt',other)
        item.visibility=A.call('diplomacy',d,'GetVisibilityOn',other)
        out[#out+1]=item
      end
    end
  end
  return out
end
-- ---------------------------------------------------------------------------
-- Sectioning and region selection.
-- ---------------------------------------------------------------------------
local sectionList={'core','economy','units','cities','map','research','culture','resources','diplomacy','governors','religion','trade','victory','notifications','configuration'}
local sectionSet={}
for _,name in ipairs(sectionList) do sectionSet[name]=true end
local defaultSections={'core','units','cities','notifications'}
local sectionHelp=table.concat(sectionList,', ')..', or "all"'
local function selectSections(include)
  local chosen={}
  if include==nil then
    for _,name in ipairs(defaultSections) do chosen[name]=true end
  else
    if type(include)=='string' then include={include} end
    assert(type(include)=='table','include must be a section name or an array of them. Valid sections: '..sectionHelp)
    for _,name in ipairs(include) do
      assert(type(name)=='string','include entries must be strings. Valid sections: '..sectionHelp)
      if name=='all' then for _,every in ipairs(sectionList) do chosen[every]=true end
      else
        assert(sectionSet[name],'Unknown snapshot section "'..name..'". Valid sections: '..sectionHelp)
        chosen[name]=true
      end
    end
  end
  chosen.core=true -- core identity and turn state are never optional.
  local names=A.array()
  for _,name in ipairs(sectionList) do if chosen[name] then names[#names+1]=name end end
  return chosen,names
end
--- Returns an accept(plot,x,y) predicate (or nil for "everything") plus the normalised description.
-- Region only decides which tile *records* are emitted; the plot walk still visits every plot so a
-- visible enemy unit or city is never missed. Entity collections are therefore never narrowed by
-- region, and their coverage says so independently of the map request.
local function regionFilter(region, pid, visibility)
  if region==nil or region=='all' then return nil,'all' end
  if region=='visible' then return function(plot,x,y) return visibility:IsVisible(x,y)==true end,'visible' end
  if region=='owned' then
    -- Ownership is only read where sight allows it, so "owned" never emits remembered-only tiles.
    return function(plot,x,y) return visibility:IsVisible(x,y)==true and plot:GetOwner()==pid end,'owned'
  end
  assert(type(region)=='table','region must be "owned", "visible", "all", {x=,y=,radius=} or {x0=,y0=,x1=,y1=}')
  local function integer(value,name)
    assert(type(value)=='number' and value%1==0,'region.'..name..' must be an integer')
    return value
  end
  if region.x0~=nil or region.y0~=nil or region.x1~=nil or region.y1~=nil then
    local x0,y0,x1,y1=integer(region.x0,'x0'),integer(region.y0,'y0'),integer(region.x1,'x1'),integer(region.y1,'y1')
    if x0>x1 then x0,x1=x1,x0 end
    if y0>y1 then y0,y1=y1,y0 end
    return function(plot,x,y) return x>=x0 and x<=x1 and y>=y0 and y<=y1 end,{x0=x0,y0=y0,x1=x1,y1=y1}
  end
  local cx,cy=integer(region.x,'x'),integer(region.y,'y')
  local radius=region.radius==nil and 0 or integer(region.radius,'radius')
  assert(radius>=0 and radius<=128,'region.radius must be 0..128')
  return function(plot,x,y) return Map.GetPlotDistance(cx,cy,x,y)<=radius end,{x=cx,y=cy,radius=radius}
end
function A.snapshot(args)
  args = args or {}
  local sections,sectionNames = selectSections(args.include)
  local detail = args.detail or 'summary'
  assert(detail=='summary' or detail=='full','detail must be "summary" or "full"')
  local full = detail=='full'
  assert(args.edges==nil or type(args.edges)=='boolean','edges must be a boolean')
  local fullEdges = args.edges==true
  -- Selectors are validated before any collection work: unknown sections or malformed
  -- map paging fail up front, never mid-walk.
  assert(args.mapOffset==nil or (type(args.mapOffset)=='number' and args.mapOffset%1==0 and args.mapOffset>=0),'mapOffset must be a nonnegative integer')
  assert(args.mapLimit==nil or (type(args.mapLimit)=='number' and args.mapLimit%1==0 and args.mapLimit>=1 and args.mapLimit<=100000),'mapLimit must be 1..100000')
  local pid,player=A.localPlayer()
  local visibility=PlayersVisibility[pid]
  assert(visibility,'Local visibility API unavailable; refusing unfiltered snapshot')
  local accept,regionLabel=regionFilter(args.region,pid,visibility)
  local config=PlayerConfigurations[pid]
  assert(config,'Local player configuration unavailable')
  local out={gameId=A.session,turn=Game.GetCurrentGameTurn(),playerId=pid,playerRecordId=id('player',pid),civilization=config:GetCivilizationTypeName(),leader=config:GetLeaderTypeName(),turnState=A.turnState(),sections=sectionNames,detail=detail}
  assert(type(out.turnState.active)=='boolean' and type(out.turnState.processing)=='boolean' and type(out.turnState.submitted)=='boolean','Core turn-state extraction failed')
  if sections.configuration then
    out.configuration=A.section('configuration',function()
      local mods=A.array()
      for _,mod in ipairs(Modding.GetActiveMods()) do mods[#mods+1]={id=mod.Id,name=Locale.Lookup(mod.Name),version=mod.Version} end
      return {ruleset=GameConfiguration.GetRuleSet(),speed=GameInfo.GameSpeeds[GameConfiguration.GetGameSpeedType()].GameSpeedType,
        difficulty=GameInfo.Difficulties[config:GetHandicapTypeID()].DifficultyType,mapSize=GameInfo.Maps[Map.GetMapSize()].MapSizeType,
        participatingPlayers=GameConfiguration.GetParticipatingPlayerCount(),mods=mods}
    end)
  end
  if sections.economy then
    out.economy=A.section('economy',function()
      local treasury=player:GetTreasury()
      local result=A.fields('economy',treasury,{gold='GetGoldBalance',goldYield='GetGoldYield',maintenance='GetTotalMaintenance'})
      result.goldNet=treasury:GetGoldYield()-treasury:GetTotalMaintenance()
      result.faith=A.call('economy',player:GetReligion(),'GetFaithBalance');result.faithYield=A.call('economy',player:GetReligion(),'GetFaithYield')
      result.favor=A.call('economy',player,'GetFavor');result.favorPerTurn=A.call('economy',player,'GetFavorPerTurn')
      return result
    end)
    assert(out.economy~=A.null and type(out.economy.gold)=='number','Core economy extraction failed')
  end
  if sections.research then
    out.research=A.section('research',function() return research(player,full) end)
    assert(out.research~=A.null and type(out.research.sciencePerTurn)=='number','Core research extraction failed')
  end
  if sections.culture then
    out.culture=A.section('culture',function() return culture(player,full) end)
    assert(out.culture~=A.null and type(out.culture.culturePerTurn)=='number','Core culture extraction failed')
  end
  if sections.governors then out.governors=A.section('governors',function() return governors(player) end) end
  if sections.resources then
    out.resources=A.section('resources',function()
      local resources=player:GetResources();local result=A.array()
      for row in GameInfo.Resources() do
        if resources:IsResourceVisible(row.Hash) then result[#result+1]={type=row.ResourceType,class=row.ResourceClassType,amount=A.call('resources',resources,'GetResourceAmount',row.ResourceType),accumulation=A.call('resources',resources,'GetResourceAccumulationPerTurn',row.ResourceType),stockpileCap=A.call('resources',resources,'GetResourceStockpileCap',row.ResourceType),exported=A.call('resources',resources,'GetExportedResourceAmount',row.ResourceType),imported=A.call('resources',resources,'GetResourceImportPerTurn',row.ResourceType)} end
      end
      return result
    end)
  end
  if sections.religion then
    out.religion=A.section('religion',function()
      local api=player:GetReligion()
      local result=A.fields('religion',api,{pantheonIndex='GetPantheon',religionIndex='GetReligionTypeCreated',faith='GetFaithBalance',faithYield='GetFaithYield',beliefIndexes='GetBeliefs',canCreatePantheon='CanCreatePantheon'})
      result.pantheon=beliefType(result.pantheonIndex)
      result.pantheonName=locName('Beliefs',result.pantheonIndex)
      result.religion=religionType(result.religionIndex)
      result.religionName=locName('Religions',result.religionIndex)
      result.beliefs=A.array()
      if type(result.beliefIndexes)=='table' then
        for _,belief in ipairs(result.beliefIndexes) do
          local name=beliefType(belief)
          if name~=A.null then result.beliefs[#result.beliefs+1]={type=name,name=locName('Beliefs',belief)} end
        end
      end
      return result
    end)
  end
  if sections.diplomacy then out.diplomacy=A.section('diplomacy',function() return diplomacy(pid,player) end) end
  if sections.victory then
    out.victory=A.section('victory',function()
      local stats=player:GetStats();local result={score=player:GetScore(),tourism=A.call('victory',stats,'GetTourism'),cities=player:GetCities():GetCount(),population=0}
      for _,city in player:GetCities():Members() do result.population=result.population+city:GetPopulation() end
      local c=player:GetCulture(); result.domesticTourists=A.call('victory',c,'GetStaycationers');result.visitingTourists=A.call('victory',c,'GetTouristsTo')
      result.diplomaticPoints=A.call('victory',stats,'GetDiplomaticVictoryPoints')
      result.scienceProjects=A.unavailable('victory','scienceProjects','Use own city completed-project records and the native World Rankings panel; no unfiltered opponent ranking query')
      result.opponentProgress=A.unavailable('victory','opponentProgress','Native World Rankings GUI required; opponent gameplay objects intentionally not queried')
      return result
    end)
  end
  if sections.notifications then
    out.notifications=A.section('notifications',function()
      restoreNotifications(pid)
      local result=A.array()
      for notificationId in pairs(A.notificationIds[pid] or {}) do
        local notification=NotificationManager.Find(pid,notificationId)
        if notification and notification:IsVisibleInUI() then
          local item=A.fields('notifications',notification,{typeHash='GetType',summaryKey='GetSummary',messageKey='GetMessage',turn='GetTurn',dismissed='IsDismissed'})
          item.type=A.typeFromHash('Notifications','NotificationType',item.typeHash)
          item.summary=A.loc(item.summaryKey);item.message=A.loc(item.messageKey)
          item.id=id('notification',pid,notificationId);item.engineId=notificationId;result[#result+1]=item
        end
      end
      return result
    end)
  end
  if sections.trade then
    out.trade=A.section('trade',function()
      local result={capacity=player:GetTrade():GetOutgoingRouteCapacity(),routes=A.array()}
      for _,city in player:GetCities():Members() do
        for _,route in ipairs(city:GetTrade():GetOutgoingRoutes()) do
          local item={route=route}
          if type(route)=='table' then
            if route.OriginCityPlayer~=nil and route.OriginCityID~=nil then item.originCityId=id('city',route.OriginCityPlayer,route.OriginCityID) end
            if route.DestinationCityPlayer~=nil and route.DestinationCityID~=nil then item.destinationCityId=id('city',route.DestinationCityPlayer,route.DestinationCityID) end
            if route.TraderUnitID~=nil then item.traderUnitId=id('unit',route.OriginCityPlayer or pid,route.TraderUnitID) end
          end
          result.routes[#result.routes+1]=item
        end
      end
      result.incoming=A.unavailable('trade','incoming','Native Trade Overview required; opponent city collections intentionally not queried')
      return result
    end)
  end
  -- Omitted sections stay ABSENT keys, never empty arrays: an empty array means an INCLUDED
  -- collection whose covered query genuinely returned none. A failed enumeration instead marks
  -- that collection 'partial' in coverage, so the bridge never sweeps or deletes on it.
  local citySeen,unitSeen={},{}
  local citiesPartial,unitsPartial,mapPartial=false,false,false
  if sections.cities then
    out.cities=A.array()
    local ok, collectionError = pcall(function()
      for _,city in player:GetCities():Members() do
        local ok, item = pcall(cityRecord, city, true)
        if ok and type(item)=='table' then out.cities[#out.cities+1]=item;citySeen[item.id]=true
        else citiesPartial=true;A.unavailable('cities','record',item) end
      end
    end)
    if not ok then citiesPartial=true;A.unavailable('cities','own collection',collectionError) end
  end
  if sections.units then
    out.units=A.array()
    local ok, collectionError = pcall(function()
      for _,unit in player:GetUnits():Members() do
        local ok, item = pcall(unitRecord, unit, true)
        if ok and type(item)=='table' then out.units[#out.units+1]=item;unitSeen[item.id]=true
        else unitsPartial=true;A.unavailable('units','record',item) end
      end
    end)
    if not ok then unitsPartial=true;A.unavailable('units','own collection',collectionError) end
  end
  local width,height=Map.GetGridSize()
  local start=args.mapOffset or 0
  local limit=args.mapLimit or width*height
  local more=start+limit<width*height
  if sections.map then
    out.map={width=width,height=height,offset=start,limit=limit,more=more,region=regionLabel,edgeDetail=fullEdges and 'edges' or 'masks',count=0,tiles=A.array()}
  end
  -- Foreign entity discovery is a visible-plot scan, exactly what the native UI does; region and
  -- page only bound tile records, never the entity scan. Per-record extraction failure skips the
  -- record and marks its collection partial instead of silently pretending completeness.
  local function scanVisibleEntities(x, y)
    if sections.units then
      local units=Units.GetUnitsInPlotLayerID(x,y,MapLayers.ANY) or {}
      for _,unit in ipairs(units) do
        local uid=id('unit',unit:GetOwner(),unit:GetID())
        -- Camouflaged/invisible units must also pass the UI unit visibility test; a failed
        -- visibility read is an unknown plot, never a hidden-free one.
        local visible=A.call('unitVisibility',visibility,'IsUnitVisible',unit)
        if not unitSeen[uid] and visible==true then
          local ok, item = pcall(unitRecord, unit, false)
          if ok and type(item)=='table' then out.units[#out.units+1]=item;unitSeen[item.id]=true
          else unitsPartial=true;A.unavailable('units','foreign record',item) end
        elseif visible~=true and visible~=false then
          unitsPartial=true;A.unavailable('unitVisibility','IsUnitVisible','read failed; plot entities unknown')
        end
      end
    end
    if sections.cities then
      local city=Cities.GetCityInPlot(x,y)
      if city then
        local cid=id('city',city:GetOwner(),city:GetID())
        if not citySeen[cid] then
          local ok, item = pcall(cityRecord, city, false)
          if ok and type(item)=='table' then out.cities[#out.cities+1]=item;citySeen[item.id]=true
          else citiesPartial=true;A.unavailable('cities','foreign record',item) end
        end
      end
    end
  end
  if sections.map or sections.units or sections.cities then
    local resources=player:GetResources()
    for index=0,width*height-1 do
      local ok, walkError = pcall(function()
        local plot=Map.GetPlotByIndex(index)
        local x,y=plot:GetX(),plot:GetY()
        local paged=index>=start and index<start+limit
        local inRegion=accept==nil or accept(plot,x,y)
        if visibility:IsVisible(x,y)==true then
          if sections.map and paged and inRegion then
            local okTile, tile = pcall(tileRecord, plot, resources, visibility, fullEdges)
            if okTile and type(tile)=='table' then out.map.tiles[#out.map.tiles+1]=tile
            else mapPartial=true;A.unavailable('map','tile record',tile) end
          end
          if sections.units or sections.cities then
            local okScan, scanError = pcall(scanVisibleEntities, x, y)
            if not okScan then
              if sections.units then unitsPartial=true end
              if sections.cities then citiesPartial=true end
              A.unavailable('visibleEntities','plot scan',scanError)
            end
          end
        elseif sections.map and paged and inRegion and visibility:IsRevealed(x,y)==true then
          out.map.tiles[#out.map.tiles+1]=revealedPlaceholder(index,x,y)
        end
      end)
      if not ok then
        mapPartial=true
        if sections.units then unitsPartial=true end
        if sections.cities then citiesPartial=true end
        A.unavailable('map','plot walk',walkError)
      end
    end
    if sections.map then out.map.count=#out.map.tiles end
  end
  -- Coverage describes the queried player-observable collection, not omniscient world state:
  -- a regional or paged map request is partial even when units/cities were enumerated completely.
  local function coverageFlag(included, partial)
    if not included then return 'omitted' end
    if partial then return 'partial' end
    return 'complete'
  end
  local mapComplete = sections.map and not mapPartial and regionLabel=='all' and start==0 and more==false
  out.coverage={
    units=coverageFlag(sections.units,unitsPartial),
    cities=coverageFlag(sections.cities,citiesPartial),
    map=coverageFlag(sections.map,not mapComplete)
  }
  return out
end
--- Single-record lookup with exactly the snapshot's fog rules and record shapes. Replaces taking a
--- full unpaged snapshot in the bridge just to search it; reads one plot or one entity, never the map.
function A.inspect(args)
  args = args or {}
  local pid,player=A.localPlayer()
  local visibility=PlayersVisibility[pid]
  assert(visibility,'Local visibility API unavailable; refusing unfiltered inspect')
  assert(args.edges==nil or type(args.edges)=='boolean','edges must be a boolean')
  local fullEdges=args.edges==true
  local hasXY=args.x~=nil or args.y~=nil
  assert(type(args.id)=='string' or hasXY,'inspect requires a game-qualified id or integer x/y')
  local out={gameId=A.session,turn=Game.GetCurrentGameTurn()}
  local kind,owner,index='tile',nil,nil
  if type(args.id)=='string' then
    local session,named,first,second=args.id:match('^([^:]+):([^:]+):(%-?%d+):(%-?%d+)$')
    if session==nil then session,named,first=args.id:match('^([^:]+):([^:]+):(%-?%d+)$') end
    assert(session==A.session,'ID is from another loaded game instance; refresh with civ.snapshot')
    kind=named
    assert(kind=='tile' or kind=='unit' or kind=='city','inspect supports tile, unit and city ids')
    if kind=='tile' then index=tonumber(first) else owner,index=tonumber(first),tonumber(second) end
    assert(index~=nil,'Malformed '..kind..' id')
  else
    assert(type(args.x)=='number' and type(args.y)=='number' and args.x%1==0 and args.y%1==0,'x/y must be integer map coordinates')
  end
  out.kind=kind
  --- Not-observed result: record stays null and `identity` carries the stable id the bridge's
  --- remembered-record fallback keys on; lastSeenTurn is unknown here by construction.
  local function missing(reason)
    out.record=A.null
    out.status='not_observed'
    out.reason=reason
  end
  local function identified(engineIndex, entityOwner)
    local identity={id=(kind=='tile' and id('tile',engineIndex) or id(kind,entityOwner,engineIndex)),engineId=engineIndex,lastSeenTurn=A.null}
    if entityOwner~=nil then identity.owner=entityOwner end
    out.identity=identity
  end
  local function observed(builder)
    local ok,record=pcall(builder)
    if ok and type(record)=='table' then
      out.record=record
      out.status='observed'
    else
      missing('Live record extraction failed')
    end
  end
  if kind=='tile' then
    local plot
    if type(args.id)=='string' then plot=Map.GetPlotByIndex(index) else plot=Map.GetPlot(args.x,args.y) end
    if plot==nil then
      missing('No such plot on this map')
      if index~=nil then identified(index) end
      return out
    end
    local x,y=plot:GetX(),plot:GetY()
    local engineIndex=plot:GetIndex()
    if visibility:IsVisible(x,y)==true then
      observed(function() return tileRecord(plot,player:GetResources(),visibility,fullEdges) end)
      if out.record==A.null then identified(engineIndex) end
    elseif visibility:IsRevealed(x,y)==true then
      out.record=revealedPlaceholder(engineIndex,x,y)
      out.status='observed'
    else
      missing('Tile has never been revealed to this player; unseen live state is never queried')
      identified(engineIndex)
    end
  elseif kind=='unit' then
    local unit
    if owner==pid then unit=A.call('inspect',player:GetUnits(),'FindID',index)
    else unit=A.static('inspect',UnitManager,'GetUnit',owner,index) end
    local function identify() identified(index,owner) end
    if unit==nil or unit==A.null then
      missing('No live unit with this id; it may have died, or was never observed by this player')
      identify()
    elseif owner==pid then
      observed(function() return unitRecord(unit,true) end)
      if out.record==A.null then identify() end
    -- IsUnitVisible needs no positional read, so the fog gate runs before anything is extracted.
    elseif A.call('unitVisibility',visibility,'IsUnitVisible',unit)==true then
      observed(function() return unitRecord(unit,false) end)
      if out.record==A.null then identify() end
    else
      missing('Foreign unit is not currently visible; live observation refused by the fog gate')
      identify()
    end
  else
    local city
    if owner==pid then city=A.call('inspect',player:GetCities(),'FindID',index)
    else city=A.static('inspect',CityManager,'GetCity',owner,index) end
    local function identify() identified(index,owner) end
    if city==nil or city==A.null then
      missing('No live city with this id; it may have been destroyed, or was never observed by this player')
      identify()
    elseif owner==pid then
      observed(function() return cityRecord(city,true) end)
      if out.record==A.null then identify() end
    else
      -- Position is the only field read before the gate, and solely to run the gate.
      local cx,cy=A.call('inspect',city,'GetX'),A.call('inspect',city,'GetY')
      if type(cx)=='number' and type(cy)=='number' and visibility:IsVisible(cx,cy)==true then
        observed(function() return cityRecord(city,false) end)
        if out.record==A.null then identify() end
      else
        missing('Foreign city plot is not currently visible; live observation refused by the fog gate')
        identify()
      end
    end
  end
  return out
end
-- Targeted post-submission observations for actions and decisions: one entity, snapshot record
-- shapes, no map walk, never a full snapshot. `own` selects which extras the record carries.
function A.unitRecord(unit, own)
  assert(unit~=nil and unit~=A.null,'unitRecord needs a native unit object from civ.snapshot or civ.inspect')
  assert(type(own)=='boolean','unitRecord own must be a boolean')
  return unitRecord(unit, own)
end
function A.cityRecord(city, own)
  assert(city~=nil and city~=A.null,'cityRecord needs a native city object from civ.snapshot or civ.inspect')
  assert(type(own)=='boolean','cityRecord own must be a boolean')
  return cityRecord(city, own)
end