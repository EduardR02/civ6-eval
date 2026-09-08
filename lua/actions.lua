local A = AstraCiv
local operations={MOVE_TO=true,RANGE_ATTACK=true,AIR_ATTACK=true,FOUND_CITY=true,FORTIFY=true,HEAL=true,SLEEP=true,SKIP_TURN=true,BUILD_IMPROVEMENT=true,REPAIR=true,REMOVE_FEATURE=true,HARVEST_RESOURCE=true,PILLAGE=true,COASTAL_RAID=true,SPREAD_RELIGION=true,EVANGELIZE_BELIEF=true,REMOVE_HERESY=true,REBASE=true,SWAP_UNITS=true}
local commands={WAKE=true,CANCEL=true,UPGRADE=true,PROMOTE=true,DELETE=true,FORM_CORPS=true,FORM_ARMY=true,ENTER_FORMATION=true,EXIT_FORMATION=true}
local function ownEntity(kind,value,pid)
  assert(type(value)=='string','Use a game-qualified '..kind..'Id from a fresh snapshot')
  local session,actualKind,owner,index=value:match('^([^:]+):([^:]+):(%d+):(%d+)$')
  assert(session==A.session and actualKind==kind and tonumber(owner)==pid,'Entity ID is from another game/player or is not an owned '..kind)
  local collection=kind=='unit' and Players[pid]:GetUnits() or Players[pid]:GetCities()
  local entity=collection:FindID(tonumber(index))
  assert(entity,'Owned entity no longer exists; refresh the snapshot')
  return entity
end
local function enum(namespace,name)
  local value=namespace and namespace[name]
  assert(value~=nil,'Action enum unavailable in this ruleset: '..name)
  return value
end
local function coordinates(args,parameters,namespace,pid,visible)
  if args.x==nil and args.y==nil then return end
  assert(type(args.x)=='number' and type(args.y)=='number' and args.x%1==0 and args.y%1==0,'x/y must be integer map coordinates')
  local width,height=Map.GetGridSize()
  assert(args.x>=0 and args.x<width and args.y>=0 and args.y<height,'Target coordinates outside map')
  if visible then assert(PlayersVisibility[pid]:IsVisible(args.x,args.y),'Attack target must currently be visible') end
  parameters[enum(namespace,'PARAM_X')]=args.x
  parameters[enum(namespace,'PARAM_Y')]=args.y
end
local function rule(tableName,key)
  assert(type(key)=='string','Provide a GameInfo type string')
  local row=GameInfo[tableName] and GameInfo[tableName][key]
  assert(row,'Unknown '..tableName..' type: '..key)
  return row
end
function A.action(args)
  local pid,player=A.localPlayer()
  assert(type(args.type)=='string','Action requires type; use civ.probe for action help')
  local before=A.turnState()
  if args.expectedTurn~=nil then assert(args.expectedTurn==before.turn,'Turn changed; refresh before submitting action') end
  if args.type=='end_turn' then
    if before.processing==true or before.active==false or before.submitted==true or A.endTurnSubmitted==before.turn then
      return {accepted=false,completed=false,status='processing_or_already_submitted',turnState=before}
    end
    assert(before.canEndTurn~=A.null and before.firstBlocker~=A.null,'End-turn safety APIs unavailable; use native GUI')
    if before.canEndTurn~=true or before.firstBlocker~=EndTurnBlockingTypes.NO_ENDTURN_BLOCKING then
      return {accepted=false,completed=false,status='blocked',turnState=before}
    end
    A.endTurnSubmitted=before.turn
    UI.RequestAction(ActionTypes.ACTION_ENDTURN)
    return {accepted=true,completed=false,status='submitted',turnState=A.turnState(),note='Submission is not turn completion. Refresh until turn advances; never resubmit this turn.'}
  end
  assert(before.active==true and before.processing==false and before.submitted==false,'Local turn not ready for actions; wait for processing and refresh')
  assert(Game.IsAllowStrategicCommands(pid) or Game.IsAllowTacticalCommands(pid),'Engine currently disallows local commands')
  local accepted
  if args.type=='move' or args.type=='attack' or args.type=='found' or args.type=='unit_operation' then
    assert(Game.IsAllowTacticalCommands(pid),'Tactical commands unavailable in current phase')
    local unit=ownEntity('unit',args.unitId,pid)
    local name=args.operation
    if args.type=='move' then name='MOVE_TO'
    elseif args.type=='found' then name='FOUND_CITY'
    elseif args.type=='attack' then
      assert(args.mode=='melee' or args.mode=='ranged' or args.mode=='air','attack mode must be melee, ranged or air')
      name=args.mode=='melee' and 'MOVE_TO' or (args.mode=='air' and 'AIR_ATTACK' or 'RANGE_ATTACK')
    end
    assert(operations[name],'Unit operation is not allowlisted; use native GUI for specialized interactions')
    local operation=enum(UnitOperationTypes,name);local parameters={}
    if name=='MOVE_TO' or name=='RANGE_ATTACK' or name=='AIR_ATTACK' or name=='REBASE' or name=='SWAP_UNITS' or name=='COASTAL_RAID' then assert(args.x~=nil and args.y~=nil,'This operation requires x/y') end
    coordinates(args,parameters,UnitOperationTypes,pid,args.type=='attack' or name=='RANGE_ATTACK' or name=='AIR_ATTACK' or name=='COASTAL_RAID')
    if name=='BUILD_IMPROVEMENT' then parameters[enum(UnitOperationTypes,'PARAM_IMPROVEMENT_TYPE')]=rule('Improvements',args.improvement).Hash end
    local legal,results=UnitManager.CanStartOperation(unit,operation,nil,parameters,true)
    if not legal then return {accepted=false,completed=false,status='illegal',reason='Engine CanStartOperation rejected request',details=results or A.null,turnState=before} end
    accepted=UnitManager.RequestOperation(unit,operation,parameters)
  elseif args.type=='unit_command' then
    assert(Game.IsAllowTacticalCommands(pid),'Tactical commands unavailable in current phase')
    local unit=ownEntity('unit',args.unitId,pid);local name=args.command
    assert(commands[name],'Unit command is not allowlisted; use native GUI')
    local command=enum(UnitCommandTypes,name);local parameters={}
    if name=='PROMOTE' then parameters[enum(UnitCommandTypes,'PARAM_PROMOTION_TYPE')]=rule('UnitPromotions',args.promotion).Hash end
    if name=='FORM_CORPS' or name=='FORM_ARMY' or name=='ENTER_FORMATION' then
      local other=ownEntity('unit',args.targetUnitId,pid)
      parameters[enum(UnitCommandTypes,'PARAM_UNIT_PLAYER')]=pid
      parameters[enum(UnitCommandTypes,'PARAM_UNIT_ID')]=other:GetID()
    end
    local legal,results=UnitManager.CanStartCommand(unit,command,parameters,false,true)
    if not legal then return {accepted=false,completed=false,status='illegal',reason='Engine CanStartCommand rejected request',details=results or A.null} end
    accepted=UnitManager.RequestCommand(unit,command,parameters)
  elseif args.type=='production' or args.type=='purchase' then
    assert(Game.IsAllowStrategicCommands(pid),'Strategic commands unavailable in current phase')
    local city=ownEntity('city',args.cityId,pid)
    local tables={unit='Units',building='Buildings',district='Districts',project='Projects'}
    assert(tables[args.kind],'kind must be unit, building, district or project')
    local row=rule(tables[args.kind],args.item)
    local purchase=args.type=='purchase';local namespace=purchase and CityCommandTypes or CityOperationTypes;local parameters={}
    parameters[enum(namespace,'PARAM_'..args.kind:upper()..'_TYPE')]=row.Hash
    coordinates(args,parameters,namespace,pid,false)
    if purchase then
      assert(args.kind~='project','Projects cannot be purchased')
      assert(args.currency=='gold' or args.currency=='faith','purchase currency must be gold or faith')
      parameters[enum(namespace,'PARAM_YIELD_TYPE')]=GameInfo.Yields['YIELD_'..args.currency:upper()].Index
      if args.kind=='unit' then parameters[enum(namespace,'PARAM_MILITARY_FORMATION_TYPE')]=MilitaryFormationTypes.STANDARD_MILITARY_FORMATION end
      local legal,results=CityManager.CanStartCommand(city,CityCommandTypes.PURCHASE,false,parameters,true)
      if not legal then return {accepted=false,completed=false,status='illegal',reason='Engine rejected purchase (cost, placement or prerequisites)',details=results or A.null} end
      accepted=CityManager.RequestCommand(city,CityCommandTypes.PURCHASE,parameters)
    else
      assert(args.mode==nil or args.mode=='replace' or args.mode=='append','production mode must be replace or append')
      if args.mode=='append' then parameters[enum(namespace,'PARAM_INSERT_MODE')]=enum(namespace,'VALUE_APPEND')
      else parameters[enum(namespace,'PARAM_INSERT_MODE')]=enum(namespace,'VALUE_REPLACE_AT');parameters[enum(namespace,'PARAM_QUEUE_DESTINATION_LOCATION')]=0 end
      assert(city:GetBuildQueue():CanProduce(row.Hash,false),'Engine rejected production prerequisites')
      -- Build request is the native authority for placement legality; it never grants free production.
      accepted=CityManager.RequestOperation(city,CityOperationTypes.BUILD,parameters)
    end
  elseif args.type=='research' or args.type=='civic' then
    assert(Game.IsAllowStrategicCommands(pid),'Strategic commands unavailable in current phase')
    local isTech=args.type=='research';local row=rule(isTech and 'Technologies' or 'Civics',args.item)
    local subsystem=isTech and player:GetTechs() or player:GetCulture()
    assert(isTech and subsystem:CanResearch(row.Index) or (not isTech and subsystem:CanProgress(row.Index)),'Research/civic is not currently selectable')
    local parameters={}
    parameters[enum(PlayerOperations,isTech and 'PARAM_TECH_TYPE' or 'PARAM_CIVIC_TYPE')]=row.Hash
    parameters[enum(PlayerOperations,'PARAM_INSERT_MODE')]=enum(PlayerOperations,'VALUE_EXCLUSIVE')
    accepted=UI.RequestPlayerOperation(pid,enum(PlayerOperations,isTech and 'RESEARCH' or 'PROGRESS_CIVIC'),parameters)
  elseif args.type=='government' then
    assert(Game.IsAllowStrategicCommands(pid),'Strategic commands unavailable in current phase')
    local c=player:GetCulture();assert(c:CanChangeGovernmentAtAll(),'Government cannot be changed now')
    accepted=c:RequestChangeGovernment(rule('Governments',args.item).Hash)
  elseif args.type=='policies' then
    assert(Game.IsAllowStrategicCommands(pid),'Strategic commands unavailable in current phase')
    local c=player:GetCulture();local count=c:GetNumPolicySlots()
    assert(type(args.slots)=='table' and #args.slots==count,'Provide complete slots array of {slot,policy} for all policy slots')
    assert((c:CivicCompletedThisTurn() or c:GetNumPolicySlotsOpen()>0) and not c:PolicyChangeMade(),'Policies locked; use unlock_policies (pays native cost) or the GUI')
    local clear,add,seen,policies={},{},{},{}
    for _,entry in ipairs(args.slots) do
      local slot=entry.slot;assert(type(slot)=='number' and slot%1==0 and slot>=0 and slot<count and not seen[slot],'Duplicate or invalid policy slot')
      local row=rule('Policies',entry.policy);assert(not policies[row.Hash],'Duplicate policy');assert(c:IsPolicyUnlocked(row.Index),'Policy is not unlocked')
      local slotType=GameInfo.GovernmentSlots[c:GetSlotType(slot)].GovernmentSlotType
      assert(slotType=='SLOT_WILDCARD' or slotType==row.GovernmentSlotType,'Policy does not fit this slot')
      seen[slot]=true;policies[row.Hash]=true;clear[#clear+1]=slot;add[slot]=row.Hash
    end
    accepted=c:RequestPolicyChanges(clear,add)
  elseif args.type=='unlock_policies' then
    assert(Game.IsAllowStrategicCommands(pid),'Strategic commands unavailable in current phase')
    accepted=UI.RequestPlayerOperation(pid,PlayerOperations.UNLOCK_POLICIES,{})
  elseif args.type=='city_attack' then
    local city=ownEntity('city',args.cityId,pid);local parameters={}
    assert(args.x~=nil and args.y~=nil,'city_attack requires x/y')
    coordinates(args,parameters,UnitOperationTypes,pid,true)
    assert(CityManager.CanStartCommand(city,CityCommandTypes.RANGE_ATTACK,parameters),'Engine rejected city ranged attack')
    accepted=CityManager.RequestCommand(city,CityCommandTypes.RANGE_ATTACK,parameters)
  else error('Unsupported action type. Use civ.probe for fixed action schema; native GUI handles diplomacy, governors, religion founding, great people, espionage and other specialized interactions.') end
  if accepted==false then return {accepted=false,completed=false,status='rejected',turnState=A.turnState()} end
  return {accepted=true,completed=false,status='submitted',turnState=A.turnState(),note='Native request queued; accepted means submission, not engine completion. Observe the refreshed snapshot before deciding the outcome.'}
end
