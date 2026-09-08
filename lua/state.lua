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
local function id(kind, owner, index)
  if index == nil then return A.session..':'..kind..':'..owner end
  return A.session..':'..kind..':'..owner..':'..index
end
function A.localPlayer()
  local pid = Game.GetLocalPlayer()
  assert(pid and pid >= 0 and Players[pid], 'No local player. Load an active game; observer/hotseat transition is not supported.')
  return pid, Players[pid]
end
function A.turnState()
  local pid, player = A.localPlayer()
  local ids=A.static('notifications',NotificationManager,'GetAllEndTurnBlocking',pid)
  local blockers=A.array()
  if ids~=A.null then
    for _,bid in ipairs(ids) do
      local n=A.call('notifications',NotificationManager,'Find',pid,bid)
      blockers[#blockers+1]={id=bid, type=(n and A.call('notifications',n,'GetTypeName') or A.null), summary=(n and A.call('notifications',n,'GetSummary') or A.null)}
    end
  end
  return {
    turn=Game.GetCurrentGameTurn(), active=A.call('turn',player,'IsTurnActive'),
    processing=A.static('turn',UI,'IsProcessingMessages'),
    submitted=A.static('turn',UI,'HasSentTurnComplete'),
    canEndTurn=A.static('turn',UI,'CanEndTurn'),
    firstBlocker=A.static('notifications',NotificationManager,'GetFirstEndTurnBlocking',pid),
    blockers=blockers
  }
end

function A.dismiss_notifications(args)
  local pid = A.localPlayer()
  local dismissed = A.array()
  for _, nid in pairs(A.notificationIds[pid] or {}) do
    local n = A.call('dismiss', NotificationManager, 'Find', pid, nid)
    if n and n ~= A.null and A.call('dismiss', n, 'CanUserDismiss') == true then
      NotificationManager.Dismiss(pid, nid)
      dismissed[#dismissed+1] = id('notification', pid, nid)
    end
  end
  return { dismissed = dismissed, count = #dismissed }
end

function A.keybinds(args)
  return A.section('keybinds', function()
    local out, limit, offset = A.array(), math.min(tonumber(args and args.limit) or 400, 1000), math.max(tonumber(args and args.offset) or 0, 0)
    local category = args and args.category
    local count = Input.GetActionCount()
    local matched = 0
    for i = 0, (count or 0) - 1 do
      local actionId = Input.GetActionId(i)
      if actionId and Input.ShouldShowActionKeybinding(actionId) then
        local key = Input.GetGestureDisplayString(actionId, 0)
        local alt = Input.GetGestureDisplayString(actionId, 1)
        if (key and key ~= '') or (alt and alt ~= '') then
          local cat = Input.GetActionCategory(actionId)
          if not category or (cat and string.find(string.lower(cat), string.lower(category), 1, true)) then
            matched = matched + 1
            if matched > offset and #out < limit then
              out[#out+1] = { name = Input.GetActionName(actionId), category = cat, key = key or A.null, alt = alt or A.null }
            end
          end
        end
      end
    end
    return { actions = out, total = matched, more = matched > offset + #out }
  end)
end
local function yields(group, object)
  local out = {}
  for row in GameInfo.Yields() do out[row.YieldType]=A.call(group,object,'GetYield',row.Index) end
  return out
end
local function unitRecord(unit, own)
  local owner, uid = unit:GetOwner(), unit:GetID()
  local result = A.fields('units',unit,{
    x='GetX',y='GetY',typeIndex='GetUnitType',name='GetName',damage='GetDamage',
    maxDamage='GetMaxDamage',formation='GetMilitaryFormation',combat='GetCombat',rangedCombat='GetRangedCombat',range='GetRange'
  })
  result.id, result.owner, result.engineId, result.own = id('unit',owner,uid), owner, uid, own
  result.unitType = A.typeName('Units',result.typeIndex,'UnitType')
  assert(type(result.x)=='number' and type(result.y)=='number' and result.unitType~=A.null,'Core unit identity/position extraction failed')
  result.visibility, result.lastSeenTurn = 'visible', Game.GetCurrentGameTurn()
  if own then
    local extra = A.fields('units',unit,{moves='GetMovesRemaining',maxMoves='GetMaxMoves',buildCharges='GetBuildCharges',religiousStrength='GetReligiousStrength',spreadCharges='GetSpreadCharges',fortifyTurns='GetFortifyTurns'})
    extra.activity=A.static('units',UnitManager,'GetActivityType',unit)
    for key,value in pairs(extra) do result[key]=value end
    assert(type(result.moves)=='number' and type(result.maxMoves)=='number','Core unit movement extraction failed')
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
  local result = A.fields('cities',city,{name='GetName',x='GetX',y='GetY',population='GetPopulation'})
  result.id,result.owner,result.engineId,result.own=id('city',owner,cid),owner,cid,own
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
    out.queue=A.array()
    for index=0,queue:GetSize()-1 do out.queue[#out.queue+1]=queue:GetAt(index) end
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
    return A.fields('cityReligion',city:GetReligion(),{majority='GetMajorityReligion',religions='GetReligionsInCity'})
  end)
  result.citizens=A.section('cityCitizens',function()
    local citizens=city:GetCitizens()
    local out={plots=A.call('cityCitizens',Map.GetCityPlots(),'GetPurchasedPlots',city),focus={}}
    for row in GameInfo.Yields() do out.focus[row.YieldType]={favored=citizens:IsFavoredYield(row.Index),disfavored=citizens:IsDisfavoredYield(row.Index)} end
    return out
  end)
  return result
end
local function tileRecord(plot, resources, visibility)
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
  out.edges=A.array()
  -- Civ stores W/NW/NE boundaries on the plot. The opposite three live on neighbors.
  local edgeMethods={
    [0]={river='IsNEOfRiver',cliff='IsNEOfCliff',flow='GetRiverSWFlowDirection'},
    [1]={self=true,river='IsWOfRiver',cliff='IsWOfCliff',flow='GetRiverEFlowDirection'},
    [2]={self=true,river='IsNWOfRiver',cliff='IsNWOfCliff',flow='GetRiverSEFlowDirection'},
    [3]={self=true,river='IsNEOfRiver',cliff='IsNEOfCliff',flow='GetRiverSWFlowDirection'},
    [4]={river='IsWOfRiver',cliff='IsWOfCliff',flow='GetRiverEFlowDirection'},
    [5]={river='IsNWOfRiver',cliff='IsNWOfCliff',flow='GetRiverSEFlowDirection'}
  }
  for direction=0,5 do
    local neighbor=Map.GetAdjacentPlot(x,y,direction)
    local edge={direction=direction,neighbor=neighbor and id('tile',neighbor:GetIndex()) or A.null}
    local spec=edgeMethods[direction]
    local source=spec.self and plot or neighbor
    if source and (spec.self or visibility:IsVisible(source:GetX(),source:GetY())) then
      edge.river=A.call('mapEdges',source,spec.river); edge.cliff=A.call('mapEdges',source,spec.cliff); edge.flow=A.call('mapEdges',source,spec.flow)
    else edge.river=A.null;edge.cliff=A.null;edge.flow=A.null;edge.unavailable='Adjacent edge source is outside current sight or map' end
    out.edges[#out.edges+1]=edge
  end
  return out
end
local function research(player)
  local techs=player:GetTechs(); local out=A.fields('research',techs,{current='GetResearchingTech',sciencePerTurn='GetScienceYield'})
  out.technologies=A.array()
  for row in GameInfo.Technologies() do
    out.technologies[#out.technologies+1]={type=row.TechnologyType,index=row.Index,completed=A.call('research',techs,'HasTech',row.Index),available=A.call('research',techs,'CanResearch',row.Index),progress=A.call('research',techs,'GetResearchProgress',row.Index),cost=A.call('research',techs,'GetResearchCost',row.Index),boosted=A.call('research',techs,'HasBoostBeenTriggered',row.Index),turns=A.call('research',techs,'GetTurnsLeft',row.Index)}
  end
  return out
end
local function culture(player)
  local c=player:GetCulture(); local out=A.fields('culture',c,{current='GetProgressingCivic',culturePerTurn='GetCultureYield',government='GetCurrentGovernment',policyChangeCost='GetCostToUnlockPolicies',policyChangeMade='PolicyChangeMade'})
  out.canChangePolicies=(c:CivicCompletedThisTurn() or c:GetNumPolicySlotsOpen()>0) and not c:PolicyChangeMade()
  out.civics=A.array(); out.policies=A.array(); out.slots=A.array()
  for row in GameInfo.Civics() do out.civics[#out.civics+1]={type=row.CivicType,index=row.Index,completed=A.call('civics',c,'HasCivic',row.Index),available=A.call('civics',c,'CanProgress',row.Index),progress=A.call('civics',c,'GetCulturalProgress',row.Index),cost=A.call('civics',c,'GetCultureCost',row.Index),boosted=A.call('civics',c,'HasBoostBeenTriggered',row.Index),turns=A.call('civics',c,'GetTurnsLeft',row.Index)} end
  for row in GameInfo.Policies() do out.policies[#out.policies+1]={type=row.PolicyType,index=row.Index,unlocked=A.call('policies',c,'IsPolicyUnlocked',row.Index),active=A.call('policies',c,'IsPolicyActive',row.Index)} end
  for slot=0,c:GetNumPolicySlots()-1 do out.slots[#out.slots+1]={slot=slot,type=c:GetSlotType(slot),policy=c:GetSlotPolicy(slot)} end
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
        item.alliance=A.call('diplomacy',d,'GetAllianceType',other)
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
function A.snapshot(args)
  local pid,player=A.localPlayer()
  local visibility=PlayersVisibility[pid]
  assert(visibility,'Local visibility API unavailable; refusing unfiltered snapshot')
  local config=PlayerConfigurations[pid]
  local out={gameId=A.session,turn=Game.GetCurrentGameTurn(),playerId=pid,playerRecordId=id('player',pid),civilization=config:GetCivilizationTypeName(),leader=config:GetLeaderTypeName(),turnState=A.turnState()}
  assert(type(out.turnState.active)=='boolean' and type(out.turnState.processing)=='boolean' and type(out.turnState.submitted)=='boolean','Core turn-state extraction failed')
  out.configuration=A.section('configuration',function()
    local mods=A.array()
    for _,mod in ipairs(Modding.GetActiveMods()) do mods[#mods+1]={id=mod.Id,name=Locale.Lookup(mod.Name),version=mod.Version} end
    return {ruleset=GameConfiguration.GetRuleSet(),speed=GameInfo.GameSpeeds[GameConfiguration.GetGameSpeedType()].GameSpeedType,
      difficulty=GameInfo.Difficulties[config:GetHandicapTypeID()].DifficultyType,mapSize=GameInfo.Maps[Map.GetMapSize()].MapSizeType,
      participatingPlayers=GameConfiguration.GetParticipatingPlayerCount(),mods=mods}
  end)
  out.economy=A.section('economy',function()
    local treasury=player:GetTreasury()
    local result=A.fields('economy',treasury,{gold='GetGoldBalance',goldYield='GetGoldYield',maintenance='GetTotalMaintenance'})
    result.goldNet=treasury:GetGoldYield()-treasury:GetTotalMaintenance()
    result.faith=A.call('economy',player:GetReligion(),'GetFaithBalance');result.faithYield=A.call('economy',player:GetReligion(),'GetFaithYield')
    result.favor=A.call('economy',player,'GetFavor');result.favorPerTurn=A.call('economy',player,'GetFavorPerTurn')
    return result
  end)
  out.research=A.section('research',function() return research(player) end)
  out.culture=A.section('culture',function() return culture(player) end)
  assert(out.economy~=A.null and type(out.economy.gold)=='number' and out.research~=A.null and type(out.research.sciencePerTurn)=='number' and out.culture~=A.null and type(out.culture.culturePerTurn)=='number','Core economy/research/culture extraction failed')
  out.governors=A.section('governors',function() return governors(player) end)
  out.resources=A.section('resources',function()
    local resources=player:GetResources();local result=A.array()
    for row in GameInfo.Resources() do
      if resources:IsResourceVisible(row.Hash) then result[#result+1]={type=row.ResourceType,class=row.ResourceClassType,amount=A.call('resources',resources,'GetResourceAmount',row.ResourceType),accumulation=A.call('resources',resources,'GetResourceAccumulationPerTurn',row.ResourceType),stockpileCap=A.call('resources',resources,'GetResourceStockpileCap',row.ResourceType),exported=A.call('resources',resources,'GetExportedResourceAmount',row.ResourceType),imported=A.call('resources',resources,'GetResourceImportPerTurn',row.ResourceType)} end
    end
    return result
  end)
  out.religion=A.section('religion',function() return A.fields('religion',player:GetReligion(),{pantheon='GetPantheon',religion='GetReligionTypeCreated',faith='GetFaithBalance',faithYield='GetFaithYield',beliefs='GetBeliefs',canCreatePantheon='CanCreatePantheon'}) end)
  out.diplomacy=A.section('diplomacy',function() return diplomacy(pid,player) end)
  out.victory=A.section('victory',function()
    local stats=player:GetStats();local result={score=player:GetScore(),tourism=A.call('victory',stats,'GetTourism'),cities=player:GetCities():GetCount(),population=0}
    for _,city in player:GetCities():Members() do result.population=result.population+city:GetPopulation() end
    local c=player:GetCulture(); result.domesticTourists=A.call('victory',c,'GetStaycationers');result.visitingTourists=A.call('victory',c,'GetTouristsTo')
    result.diplomaticPoints=A.call('victory',stats,'GetDiplomaticVictoryPoints')
    result.scienceProjects=A.unavailable('victory','scienceProjects','Use own city completed-project records and the native World Rankings panel; no unfiltered opponent ranking query')
    result.opponentProgress=A.unavailable('victory','opponentProgress','Native World Rankings GUI required; opponent gameplay objects intentionally not queried')
    return result
  end)
  out.notifications=A.section('notifications',function()
    if A.notificationsRestoredFor ~= pid then
      NotificationManager.RestoreVisualState(pid)
      A.notificationsRestoredFor = pid
    end
    local result=A.array()
    for notificationId in pairs(A.notificationIds[pid] or {}) do
      local notification=NotificationManager.Find(pid,notificationId)
      if notification and notification:IsVisibleInUI() then
        local item=A.fields('notifications',notification,{type='GetType',summary='GetSummary',message='GetMessage',turn='GetTurn',dismissed='IsDismissed'})
        item.id=id('notification',pid,notificationId);item.engineId=notificationId;result[#result+1]=item
      end
    end
    return result
  end)
  out.trade=A.section('trade',function()
    local result={capacity=player:GetTrade():GetOutgoingRouteCapacity(),routes=A.array()}
    for _,city in player:GetCities():Members() do
      for _,route in ipairs(city:GetTrade():GetOutgoingRoutes()) do result.routes[#result.routes+1]=route end
    end
    result.incoming=A.unavailable('trade','incoming','Native Trade Overview required; opponent city collections intentionally not queried')
    return result
  end)
  out.cities=A.array();out.units=A.array();local citySeen,unitSeen={},{}
  for _,city in player:GetCities():Members() do local item=cityRecord(city,true);out.cities[#out.cities+1]=item;citySeen[item.id]=true end
  for _,unit in player:GetUnits():Members() do local item=unitRecord(unit,true);out.units[#out.units+1]=item;unitSeen[item.id]=true end
  local width,height=Map.GetGridSize()
  local start=args.mapOffset or 0;local limit=args.mapLimit or width*height
  assert(type(start)=='number' and start%1==0 and start>=0,'mapOffset must be a nonnegative integer')
  assert(type(limit)=='number' and limit%1==0 and limit>=1 and limit<=100000,'mapLimit must be 1..100000')
  out.map={width=width,height=height,offset=start,more=start+limit<width*height,tiles=A.array()}
  local resources=player:GetResources()
  for index=0,width*height-1 do
    local plot=Map.GetPlotByIndex(index);local x,y=plot:GetX(),plot:GetY()
    if visibility:IsVisible(x,y) then
      if index>=start and index<start+limit then out.map.tiles[#out.map.tiles+1]=tileRecord(plot,resources,visibility) end
      A.section('visibleEntities',function()
        local units=Units.GetUnitsInPlotLayerID(x,y,MapLayers.ANY) or {}
        for _,unit in ipairs(units) do
          local uid=id('unit',unit:GetOwner(),unit:GetID())
          -- Camouflaged/invisible units must also pass the UI unit visibility test.
          if not unitSeen[uid] and A.call('unitVisibility',visibility,'IsUnitVisible',unit)==true then
            local item=unitRecord(unit,false);out.units[#out.units+1]=item;unitSeen[uid]=true
          end
        end
        local city=Cities.GetCityInPlot(x,y)
        if city then local cid=id('city',city:GetOwner(),city:GetID());if not citySeen[cid] then local item=cityRecord(city,false);out.cities[#out.cities+1]=item;citySeen[cid]=true end end
      end)
    elseif index>=start and index<start+limit and visibility:IsRevealed(x,y) then
      out.map.tiles[#out.map.tiles+1]={id=id('tile',index),engineId=index,x=x,y=y,visibility='revealed_not_visible',lastSeenTurn=A.null,unavailable='Not currently visible; live terrain, owner, improvements, resources, yields and entities deliberately not read'}
    end
  end
  return out
end
