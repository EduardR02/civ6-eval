-- Deterministic native API fixtures for the Fengari regression VM.
--
-- These are deliberately small, explicit objects rather than a fake Civ game.  They expose
-- only the engine calls exercised by the tests, record legal-request parameters, and make
-- unavailable/failing calls visible.  They do not implement game rules or pretend that a
-- successful native request has completed.  STUB_INSTALL(name) installs one named scenario;
-- tests may then change the documented STUB_* knobs before invoking a trusted module.
--
-- =====================================================================================
-- WHAT THIS FIXTURE IS FAITHFUL ABOUT (verified against the installed game at
-- Base/Assets/, cited inline where it matters):
--
--   * UnitOperationTypes deliberately OMITS HEAL, SLEEP and SKIP_TURN while
--     GameInfo.UnitOperations has rows for them.  Any dispatch that reads the global
--     instead of the row Hash must fail here, exactly as it would in a live game.
--     (Evidence: no shipped UI file references UnitOperationTypes.HEAL/.SLEEP/.SKIP_TURN;
--     FORTIFY *is* referenced, so FORTIFY is present in this global too.)
--   * UnitOperations/UnitCommands rows carry OperationType/CommandType, Description,
--     VisibleInUI and CategoryInUI -- the real schema columns
--     (Gameplay/Data/Schema/01_GameplaySchema.sql:3006 and :2975).  There is NO Name
--     column on those two tables, so the fixture does not invent one.  At least one row
--     of each table has VisibleInUI=false so the native-UI discovery filter is exercised.
--   * GetOperationTargets returns positionally paired PLOTS and MODIFIERS, and only
--     MODIFIER_IS_TARGET entries are real targets (Base/Assets/UI/WorldInput.lua:975-985).
--   * GetMoveToPathEx returns {plots=, turns=, obstacles=}; turns is matched positionally
--     to plots and the total is its last entry (Base/Assets/UI/WorldInput.lua:961-1100).
--   * GetReachableMovement/GetReachableTargets/GetReachableZonesOfControl return plain
--     plot-index arrays (Base/Assets/UI/WorldView/SelectedUnit.lua:47-54).
--   * Units.GetUnitsInPlotLayerID(x, y, layer) and Cities.GetCityInPlot(x, y) are static
--     three/two-argument calls, not methods (UnitFlagManager.lua:1233, WorldInput.lua:1039,
--     Choosers/TradeRouteChooser.lua:1219).
--   * Culture:RequestPolicyChanges(clearList, addList) takes an array of slot indices to
--     clear and a table of policy hashes KEYED BY SLOT INDEX
--     (Base/Assets/UI/Screens/GovernmentScreen.lua:1558-1570).
--   * BuildQueue:CanProduce answers its two native questions (ProductionPanel.lua:1911-1913,
--     :2026-2038): (hash,true) is the panel visibility filter and (hash,false,true) is current
--     startability plus a results table; only that second form returns two values.
--   * District pillage is answered per instance (pDistrict:IsPillaged(),
--     WorldBuilderPlayerEditor.lua:732) and through the city collection as (districtType, plotId)
--     (CitySupport.lua:665, MapSearchPanel.lua:617). The optional district's instance method can be
--     made to fail so the collection fallback is exercised.
--   * Own-unit order reads are separate calls: UnitManager.GetActivityType (UnitPanel.lua:2147),
--     Unit:GetOperationType / HasPendingOperations / IsAutomated (Objects.csv Q-Unit rows) and
--     UnitManager.GetQueuedDestination (WorldInput.lua:821, :907, :1165). A trader is a type row with
--     MakeTradeRoute and its route is matched by route.TraderUnitID (UnitPanel.lua:2165, :2170-2190).
--   * Queues are position -> row index tables from the calls the native trees use:
--     PlayerTechs:GetResearchQueue/GetResearchingTech (TechTree.lua:264, ResearchChooser.lua:63) and
--     PlayerCulture:GetCivicQueue/GetProgressingCivic (CivicsTree.lua:252).
--
-- SIMPLIFICATIONS -- every one of these is a place where a passing test proves less than
-- it looks like it proves:
--
--   1. No game rules at all.  CanStart*/Request* answer from STUB_* knobs, so "legal" here
--      means "the fixture was told to say yes".  These tests prove which native call the
--      module makes and with which parameters; they prove NOTHING about whether the real
--      engine would accept it, or about what happens after it accepts.
--   2. Request* acknowledgement is a knob (accepted/rejected/unknown/throw) driven by a
--      single shared counter (STUB_REQUEST_INDEX) across unit, city and player requests.
--      Real acknowledgement loss is a transport event, not a return value.
--   3. The map is a 3x3 grid with row-major plot indices and a hand-written six-direction
--      neighbour table.  The real map is a wrapped hex grid; adjacency parity, wrapping and
--      off-map behaviour are NOT modelled.
--   4. One own unit, one own city, one foreign city on a separately gated visible plot, no
--      districts, buildings, notifications or religions in play. Anything that only
--      misbehaves at scale or with several entities cannot be caught here.
--   5. Yields, costs, combat values and turn counts are constants.  No arithmetic the game
--      would do is reproduced.
--   6. Events/LuaEvents record subscriptions and never fire.  state.lua's notification
--      bookkeeping is therefore only ever observed in its empty state.
--   7. GameInfo tables hold a handful of rows and only the columns our modules read.  A
--      ruleset column our code does not touch is simply absent, so "the code ignored it"
--      and "the fixture never had it" are indistinguishable.
--   8. Hashes are small readable integers (2000, 2001, ...), not FNV hashes of the type
--      string.  Hash *identity* is tested; hash *derivation* is not.
--   9. UnitManager.CanStartCommand accepts the parameters table in its third position.  The
--      shipped UI uses (unit, cmd, tParameters), (unit, cmd, nil, tParameters),
--      (unit, cmd, bool) and (unit, cmd, bool, bool); no shipped call uses the five-argument
--      (unit, cmd, tParameters, bool, bool) form our actions.lua/options.lua send.  The C++
--      binding appears to dispatch on argument type, but that could not be confirmed from
--      static files, so this fixture is MORE PERMISSIVE than the engine may be.
--  10. Order, route, production and queue state are single knobs, never derived. Nothing here runs
--      an operation, walks a route or consumes production, so the fixture cannot show that a queued
--      order is still queued next turn, that an active route ends, or that a pillaged district
--      becomes repaired. It shows only that the module reads and reports the engine's own answers.
--      The city has at most one district, and that district's type, pillage and completion state are
--      the STUB_DISTRICT_* values.
--  11. copyTable keeps scalar values only, so a traced parameter table omits nested tables (for
--      example a native path array) instead of showing them. Tests that must observe a table-valued
--      argument wrap the entry point instead of reading the trace.
-- =====================================================================================

AstraCiv = AstraCiv or {}
TRACE = {}
STUB_SCENARIO = nil
STUB_TURN = 10
STUB_SUBMITTED = false
STUB_PROCESSING = false
STUB_ACTIVE = true
STUB_ALLOW_TACTICAL = true
STUB_ALLOW_STRATEGIC = true
STUB_CAN_END = true
STUB_FIRST_BLOCKER = 0
STUB_BLOCKERS = {}
STUB_VISIBLE = {}
STUB_REVEALED = {}
STUB_FOREIGN_UNIT_VISIBLE = false
STUB_FOREIGN_CITY_VISIBLE = false
STUB_BROKEN_PLOT = -1
STUB_EDGE_ERROR = false
STUB_PANTHEON_AVAILABLE = true
STUB_GOVERNOR_AVAILABLE = true
STUB_GOVERNOR_APPOINTED = true
STUB_GOVERNOR_PROMOTABLE = false
STUB_GOVERNOR_ASSIGNABLE = true
STUB_GOVERNOR_ASSIGN_RESULTS = {}
STUB_MINOR_MET = true
STUB_TOKENS_TO_GIVE = 0
STUB_CAN_GIVE_INFLUENCE = true
STUB_CAN_GIVE_TOKENS_TO = true
STUB_TOKENS_RECEIVED = 0
STUB_TOKENS_CONSIDERED = false
STUB_POLICY_CHANGE_AVAILABLE = true
STUB_OPERATION_LEGAL = true
STUB_COMMAND_LEGAL = true
STUB_CITY_OPERATION_LEGAL = true
STUB_CITY_COMMAND_LEGAL = true
STUB_OPERATION_RESULTS = {}
STUB_COMMAND_RESULTS = {}
STUB_CITY_OPERATION_RESULTS = {}
STUB_CITY_COMMAND_RESULTS = {}
STUB_OPERATION_TARGETS = {}
STUB_CITY_OPERATION_TARGETS = {}
STUB_CITY_COMMAND_TARGETS = {}
-- TradeRouteChooser checks destination X0/Y0 and origin X1/Y1, then asks for a route path.
-- These independent knobs let tests distinguish illegal operations, no path and missing APIs.
STUB_TRADE_LEGAL = {}
STUB_TRADE_PATHS = {}
-- Each one-based yield array matches the TradeSupport.lua manager calls; receiving-player
-- multipliers are keyed by zero-based YieldTypes and intentionally differ across owners.
STUB_TRADE_YIELDS = {}
STUB_TRADE_MULTIPLIERS = {}
STUB_TRADE_POSTS = {}
STUB_TRADE_QUESTS = {}
STUB_REQUEST_INDEX = 0
STUB_REQUEST_MODES = {}
STUB_COMMAND_REQUEST_MODES = {}
STUB_CITY_REQUEST_MODES = {}
STUB_PLAYER_REQUEST_MODES = {}
-- Reachability/path knobs. Plain plot-index arrays, as the native calls return.
STUB_REACHABLE = {}
STUB_REACHABLE_TARGETS = {}
STUB_REACHABLE_ZOC = {}
-- GetMoveToPathEx result, or nil to make the call fail the way an unreachable destination does.
STUB_PATH = nil
-- Own-unit order state. These are the native reads state.lua reports truthfully; nil means "the
-- engine records nothing" and is NOT the same as a failed read (tests make a read fail by replacing
-- the method). ActivityTypes.ACTIVITY_AWAKE is 0.
STUB_UNIT_ACTIVITY = 0
STUB_UNIT_OPERATION = nil
STUB_UNIT_PENDING = nil
STUB_UNIT_AUTOMATED = nil
STUB_UNIT_QUEUED_DESTINATION = nil
-- GameInfo.Units index for the single own unit's type (1 = the fixture's trader row).
STUB_UNIT_TYPE = 0
-- Own outgoing trade routes, in the shape UnitPanel.lua:2176-2185 walks
-- (OriginCityPlayer/OriginCityID/DestinationCityPlayer/DestinationCityID/TraderUnitID), or nil for
-- none. STUB_ROUTES_BROKEN makes GetOutgoingRoutes return a non-table, the unreadable-list case.
STUB_OUTGOING_ROUTES = nil
STUB_ROUTES_BROKEN = false
-- Production asks two different questions on one native method
-- (ProductionPanel.lua:1911-1912 CanProduce(hash,true) and :2038 CanProduce(hash,false,true)):
-- panel visibility, then current startability plus the engine's own results table.
STUB_PRODUCTION_IN_PANEL = true
STUB_PRODUCTION_AVAILABLE = true
STUB_PRODUCTION_RESULTS = {}
-- One optional own-city district (GameInfo.Districts index). nil means the city has none, so
-- scenarios that assume no districts keep their meaning.
STUB_DISTRICT_TYPE = nil
STUB_DISTRICT_PILLAGED = false
STUB_DISTRICT_COMPLETE = true
-- Makes district:IsPillaged() throw so the collection read (CitySupport.lua:665) is exercised.
STUB_DISTRICT_INSTANCE_READ_FAILS = false
-- Research/civic queue observations, as the native queue methods return them: queue position ->
-- row index (TechTree.lua:264, CivicsTree.lua:252).
STUB_RESEARCH_QUEUE = {}
STUB_CIVIC_QUEUE = {}
STUB_RESEARCHING_TECH = -1
STUB_PROGRESSING_CIVIC = -1
-- Current policy assignment as GameInfo.Policies indices keyed by zero-based slot.
STUB_POLICY_SLOTS = {}
-- Recorded Events/LuaEvents subscriptions: {event = 'NotificationAdded', bus = 'Events'}.
STUB_EVENT_SUBSCRIPTIONS = {}

local function trace(name, data)
  TRACE[#TRACE + 1] = { call = name, data = data or {} }
end

local function copyTable(source)
  local result = {}
  if type(source) ~= 'table' then return result end
  for key, value in pairs(source) do
    if type(value) == 'number' or type(value) == 'string' or type(value) == 'boolean' then
      result[key] = value
    end
  end
  return result
end

local function rows(definitions)
  local result = {}
  for _, row in ipairs(definitions) do
    if row.Index ~= nil then result[row.Index] = row end
    for _, key in ipairs({'Type', 'UnitType', 'BuildingType', 'DistrictType', 'ProjectType',
      'ImprovementType', 'TerrainType', 'FeatureType', 'ResourceType', 'YieldType',
      'TechnologyType', 'CivicType', 'PolicyType', 'GovernmentType', 'BeliefType',
      'ReligionType', 'GovernorType', 'GovernorPromotionType', 'UnitPromotionType',
      'OperationType', 'CommandType'}) do
      if row[key] ~= nil then result[row[key]] = row end
    end
  end
  local function iterate()
    local index = 0
    return function()
      index = index + 1
      return definitions[index]
    end
  end
  return setmetatable(result, { __call = iterate })
end

local function collection(items)
  local result = { items = items }
  function result:Members() return ipairs(self.items) end
  function result:FindID(id)
    for _, item in ipairs(self.items) do
      if item:GetID() == id then return item end
    end
    return nil
  end
  function result:GetCount() return #self.items end
  function result:GetNumDistricts() return #self.items end
  function result:GetNumZonedDistrictsRequiringPopulation() return 0 end
  function result:GetNumAllowedDistrictsRequiringPopulation() return 3 end
  function result:IsPillaged() return false end
  function result:HasDistrict() return false end
  function result:HasBuilding() return false end
  return result
end

local function coordKey(x, y) return tostring(x) .. ',' .. tostring(y) end
local function visible(x, y) return STUB_VISIBLE[coordKey(x, y)] == true end
local function revealed(x, y) return STUB_REVEALED[coordKey(x, y)] == true end

local plots = {}
local function plotAt(index, x, y)
  local plot = { index = index, x = x, y = y }
  function plot:GetIndex() return self.index end
  function plot:GetX() return self.x end
  function plot:GetY() return self.y end
  function plot:GetTerrainType()
    if self.index == STUB_BROKEN_PLOT then error('fixture terrain read failed') end
    return 0
  end
  function plot:GetFeatureType() return -1 end
  function plot:GetOwner() return -1 end
  function plot:GetImprovementType() return -1 end
  function plot:GetDistrictType() return -1 end
  function plot:GetRouteType() return -1 end
  function plot:IsWater() return false end
  function plot:IsHills() return self.index == 4 end
  function plot:IsMountain() return false end
  function plot:IsLake() return false end
  function plot:IsImpassable() return false end
  function plot:IsRiver() return self.index == 4 end
  function plot:IsFreshWater() return false end
  function plot:IsCoastalLand() return true end
  function plot:IsImprovementPillaged() return false end
  function plot:IsRoutePillaged() return false end
  function plot:GetAppeal() return 1 end
  function plot:GetContinentType() return 0 end
  function plot:GetResourceType() return -1 end
  function plot:GetResourceCount() return 0 end
  function plot:GetYield(index)
    if index == 0 then return 2 end
    return 0
  end
  function plot:IsNEOfRiver() if STUB_EDGE_ERROR then error('fixture edge read failed') end return self.index == 4 end
  function plot:IsWOfRiver() if STUB_EDGE_ERROR then error('fixture edge read failed') end return false end
  function plot:IsNWOfRiver() if STUB_EDGE_ERROR then error('fixture edge read failed') end return false end
  function plot:IsNEOfCliff() if STUB_EDGE_ERROR then error('fixture edge read failed') end return false end
  function plot:IsWOfCliff() if STUB_EDGE_ERROR then error('fixture edge read failed') end return false end
  function plot:IsNWOfCliff() if STUB_EDGE_ERROR then error('fixture edge read failed') end return false end
  function plot:GetRiverSWFlowDirection() if STUB_EDGE_ERROR then error('fixture edge read failed') end return 0 end
  function plot:GetRiverEFlowDirection() if STUB_EDGE_ERROR then error('fixture edge read failed') end return 0 end
  function plot:GetRiverSEFlowDirection() if STUB_EDGE_ERROR then error('fixture edge read failed') end return 0 end
  function plot:CanHaveDistrict() return self.index == 2 or self.index == 4 end
  function plot:GetAdjacencyBonus() return 2 end
  function plot:GetAdjacencyYield() return 1 end
  function plot:GetAdjacencyBonusTooltip() return 'LOC_TEST_ADJACENCY', '' end
  plots[index] = plot
  return plot
end

local directions = {
  [0] = { 1, 0 }, [1] = { 1, -1 }, [2] = { 0, -1 },
  [3] = { -1, 0 }, [4] = { -1, 1 }, [5] = { 0, 1 },
}
local function adjacent(plot, direction)
  local delta = directions[direction]
  if not delta then return nil end
  local x, y = plot:GetX() + delta[1], plot:GetY() + delta[2]
  if x < 0 or x >= 3 or y < 0 or y >= 3 then return nil end
  return plots[y * 3 + x]
end

local experience = {}
function experience:GetExperiencePoints() return 12 end
function experience:GetLevel() return 2 end
function experience:HasPromotion(index) return index == 0 end

local ownUnit = {}
function ownUnit:GetOwner() return 0 end
function ownUnit:GetID() return 7 end
function ownUnit:GetX() return 1 end
function ownUnit:GetY() return 1 end
function ownUnit:GetUnitType() return STUB_UNIT_TYPE end
function ownUnit:GetName() return 'LOC_TEST_WARRIOR' end
function ownUnit:GetDamage() return 5 end
function ownUnit:GetMaxDamage() return 100 end
function ownUnit:GetMilitaryFormation() return 0 end
function ownUnit:GetCombat() return 20 end
function ownUnit:GetRangedCombat() return 10 end
function ownUnit:GetRange() return 1 end
function ownUnit:GetMovesRemaining() return 2 end
function ownUnit:GetMaxMoves() return 2 end
function ownUnit:GetBuildCharges() return 0 end
function ownUnit:GetReligiousStrength() return 0 end
function ownUnit:GetSpreadCharges() return 0 end
function ownUnit:GetFortifyTurns() return 0 end
function ownUnit:GetExperience() return experience end
function ownUnit:IsReadyToMove() return true end
function ownUnit:GetPlotId() return 4 end
-- Native order state. Each read answers exactly one documented question
-- (Objects.csv Q-UnitGetOperationType, Q-UnitHasPendingOperations, Q-UnitIsAutomated): no pending
-- operations, no automation and no operation in progress unless a scenario configures them.
function ownUnit:GetOperationType() return STUB_UNIT_OPERATION end
function ownUnit:HasPendingOperations() return STUB_UNIT_PENDING == true end
function ownUnit:IsAutomated() return STUB_UNIT_AUTOMATED == true end

local foreignUnit = {}
function foreignUnit:GetOwner() return 1 end
function foreignUnit:GetID() return 9 end
function foreignUnit:GetX() return 2 end
function foreignUnit:GetY() return 2 end
function foreignUnit:GetUnitType() return 0 end
function foreignUnit:GetName() return 'LOC_SECRET_UNIT' end
function foreignUnit:GetDamage() error('hidden unit field must not be read') end
function foreignUnit:GetMaxDamage() error('hidden unit field must not be read') end
function foreignUnit:GetCombat() error('hidden unit field must not be read') end
function foreignUnit:GetRangedCombat() error('hidden unit field must not be read') end
function foreignUnit:GetRange() error('hidden unit field must not be read') end
function foreignUnit:GetMilitaryFormation() error('hidden unit field must not be read') end

local buildQueue = {}
function buildQueue:GetCurrentProductionTypeHash() return 0 end
function buildQueue:GetCurrentProductionTypeModifier() return 0 end
function buildQueue:GetSize() return 0 end
function buildQueue:GetAt() return nil end
-- One native method, two questions (ProductionPanel.lua:1911-1912, :2026-2038):
--   CanProduce(hash, true)            -> panel visibility, bare boolean
--   CanProduce(hash, false, true)     -> startability plus the engine's own results table
function buildQueue:CanProduce(hash, inPanel, returnResults)
  trace('BuildQueue.CanProduce', { hash = hash, inPanel = inPanel, returnResults = returnResults })
  if inPanel == true then return STUB_PRODUCTION_IN_PANEL end
  if returnResults == true then return STUB_PRODUCTION_AVAILABLE, STUB_PRODUCTION_RESULTS end
  return STUB_PRODUCTION_AVAILABLE
end
function buildQueue:GetUnitCost() return 40 end
function buildQueue:GetBuildingCost() return 100 end
function buildQueue:GetDistrictCost() return 60 end
function buildQueue:GetProjectCost() return 80 end
function buildQueue:GetUnitProgress() return 0 end
function buildQueue:GetBuildingProgress() return 0 end
function buildQueue:GetDistrictProgress() return 0 end
function buildQueue:GetProjectProgress() return 0 end
function buildQueue:GetTurnsLeft() return 4 end

local cityGrowth = {}
function cityGrowth:GetFood() return 5 end
function cityGrowth:GetFoodSurplus() return 2 end
function cityGrowth:GetGrowthThreshold() return 15 end
function cityGrowth:GetTurnsUntilGrowth() return 5 end
function cityGrowth:GetTurnsUntilStarvation() return 20 end
function cityGrowth:GetHousing() return 5 end
function cityGrowth:GetAmenities() return 1 end
function cityGrowth:GetAmenitiesNeeded() return 0 end
function cityGrowth:GetHappiness() return 1 end
function cityGrowth:GetOverallGrowthModifier() return 0 end
function cityGrowth:GetHousingGrowthModifier() return 0 end

local cityLoyalty = {}
function cityLoyalty:GetLoyalty() return 100 end
function cityLoyalty:GetLoyaltyPerTurn() return 0 end
function cityLoyalty:GetMaxLoyalty() return 100 end

local cityReligion = {}
function cityReligion:GetMajorityReligion() return -1 end
function cityReligion:GetReligionsInCity() return {} end

local citizens = {}
function citizens:IsFavoredYield() return false end
function citizens:IsDisfavoredYield() return false end

local cityDistricts = collection({})
-- The optional own-city district. Its method set is the shipped District query set used by the
-- observation path: GetType/GetX/GetY/IsComplete/IsPillaged/GetYield plus the defense reads
-- (Objects.csv Q-CityGetDistrictsGetDistrict*; WorldBuilderPlayerEditor.lua:732 calls
-- district:IsPillaged() directly).
local district = {}
function district:GetType() return STUB_DISTRICT_TYPE end
function district:GetID() return 1 end
function district:GetX() return 1 end
function district:GetY() return 1 end
function district:IsComplete() return STUB_DISTRICT_COMPLETE == true end
function district:IsPillaged()
  if STUB_DISTRICT_INSTANCE_READ_FAILS then error('fixture district pillage read failed') end
  return STUB_DISTRICT_PILLAGED == true
end
function district:GetYield(index) if index == 0 then return 1 end return 0 end
function district:GetDamage(defenseType) return defenseType == DefenseTypes.DISTRICT_GARRISON and 20 or 0 end
function district:GetMaxDamage(defenseType) return defenseType == DefenseTypes.DISTRICT_GARRISON and 200 or 100 end
function district:GetDefenseStrength() return 10 end
local districtCollection = collection({ district })
-- The city's district collection answers IsPillaged for a district type index (ProductionPanel.lua:1996)
-- or for (districtType, plotId) (CitySupport.lua:665, MapSearchPanel.lua:617): only the configured
-- district is pillaged, and only while this city has it. Both the empty collection and the one with
-- the district answer the same way, exactly as the engine's collection does.
local function districtPillaged(districtType, plotId)
  trace('CityDistricts.IsPillaged', { districtType = districtType, plotId = plotId })
  if STUB_DISTRICT_TYPE == nil or districtType == nil then return false end
  return districtType == STUB_DISTRICT_TYPE and STUB_DISTRICT_PILLAGED == true
end
function cityDistricts:IsPillaged(districtType, plotId) return districtPillaged(districtType, plotId) end
function districtCollection:IsPillaged(districtType, plotId) return districtPillaged(districtType, plotId) end
local ownCity = {}
function ownCity:GetOwner() return 0 end
function ownCity:GetID() return 3 end
function ownCity:GetName() return 'LOC_TEST_CITY' end
function ownCity:GetX() return 1 end
function ownCity:GetY() return 1 end
function ownCity:GetPopulation() return 4 end
function ownCity:GetGrowth() return cityGrowth end
function ownCity:GetCulturalIdentity() return cityLoyalty end
function ownCity:GetBuildQueue() return buildQueue end
function ownCity:GetBuildings() return collection({}) end
-- None unless a scenario installs one, matching every scenario written before districts existed.
function ownCity:GetDistricts() return STUB_DISTRICT_TYPE == nil and cityDistricts or districtCollection end
function ownCity:GetReligion() return cityReligion end
function ownCity:GetCitizens() return citizens end
-- The route list is what a trader's own unit record joins against (UnitPanel.lua:2170-2190).
function ownCity:GetTrade()
  return {
    GetOutgoingRoutes = function()
      if STUB_ROUTES_BROKEN then return 'unreadable route list' end
      return STUB_OUTGOING_ROUTES or {}
    end,
    HasActiveTradingPost = function(_, owner) return STUB_TRADE_POSTS['0:3'] == true end,
  }
end
function ownCity:GetDistrictID() return -1 end

local foreignCity = {}
function foreignCity:GetOwner() assert(visible(2, 2), 'foreign city read under fog') return 1 end
function foreignCity:GetID() assert(visible(2, 2), 'foreign city read under fog') return 12 end
function foreignCity:GetX() return 2 end -- coordinates only; all other foreign fields need visibility
function foreignCity:GetY() return 2 end
function foreignCity:GetName() assert(visible(2, 2), 'foreign city name read under fog') return 'LOC_FOREIGN_CITY' end
function foreignCity:GetTrade()
  assert(visible(2, 2), 'foreign city trade read under fog')
  return {HasActiveTradingPost = function(_, owner) return STUB_TRADE_POSTS['1:12'] == true end}
end

local units = collection({ ownUnit })
local cities = collection({ ownCity })
local foreignCities = collection({ foreignCity })

local religion = {}
function religion:GetPantheon() return -1 end
function religion:GetReligionTypeCreated() return -1 end
function religion:GetFaithBalance() return 100 end
function religion:GetFaithYield() return 5 end
function religion:GetBeliefs() return {} end
function religion:CanCreatePantheon() return STUB_PANTHEON_AVAILABLE end

local culture = {}
function culture:GetCultureYield() return 5 end
function culture:GetCultureNeeded() return 20 end
function culture:GetCivicProgress() return 4 end
function culture:GetCivicType() return 0 end
function culture:GetProgressingCivic() return STUB_PROGRESSING_CIVIC end
-- Queue position -> Civics row index (CivicsTree.lua:252), same contract as the research queue.
function culture:GetCivicQueue() return STUB_CIVIC_QUEUE or {} end
function culture:GetNumPolicySlots() return 2 end
function culture:GetNumPolicySlotsOpen() return STUB_POLICY_CHANGE_AVAILABLE and 1 or 0 end
function culture:CivicCompletedThisTurn() return STUB_POLICY_CHANGE_AVAILABLE end
function culture:PolicyChangeMade() return false end
function culture:IsPolicyUnlocked() return true end
function culture:GetSlotType(index) return index == 0 and 0 or 1 end
--- Current occupant of a zero-based government slot, as a GameInfo.Policies index (-1 = empty).
function culture:GetSlotPolicy(slot)
  local index = STUB_POLICY_SLOTS[slot]
  if index == nil then return -1 end
  return index
end
function culture:CanChangeGovernmentAtAll() return true end
function culture:RequestChangeGovernment(hash)
  trace('Culture.RequestChangeGovernment', { hash = hash })
  return true
end
function culture:RequestPolicyChanges(clear, add)
  trace('Culture.RequestPolicyChanges', { clear = copyTable(clear), add = copyTable(add) })
  if not STUB_POLICY_CHANGE_AVAILABLE then return false end
  return true
end

local techs = {}
function techs:GetScienceYield() return 6 end
function techs:GetResearchCost() return 20 end
function techs:GetResearchProgress() return 4 end
function techs:GetResearchingTech() return STUB_RESEARCHING_TECH end
function techs:CanResearch() return true end
-- Queue position -> Technologies row index (TechTree.lua:264). An empty queue is a real answer, not
-- an unavailable one; a scenario making the read fail replaces this method.
function techs:GetResearchQueue() return STUB_RESEARCH_QUEUE or {} end

local treasury = {}
function treasury:GetGoldBalance() return 100 end
function treasury:GetGoldYield() return 10 end
function treasury:GetTotalMaintenance() return 2 end

local resources = {}
function resources:IsResourceVisible() return true end
function resources:GetResourceAmount() return 0 end
function resources:GetResourceAccumulationPerTurn() return 0 end
function resources:GetResourceStockpileCap() return 0 end
function resources:GetExportedResourceAmount() return 0 end
function resources:GetResourceImportPerTurn() return 0 end

-- Governors. GOVERNOR_AMANI is appointed and can govern city-states; GOVERNOR_MAGNUS is not
-- appointed, so the appoint decision has something to offer. The legality calls take row
-- HASHES while the request parameters take row INDEXES (GovernorPanel.lua /
-- GovernorAssignmentChooser.lua), so both are traced separately and must not be confused.
local amaniGovernor = {}
function amaniGovernor:IsGovernCityState() return true end
function amaniGovernor:GetNeutralizedTurns() return 0 end
function amaniGovernor:GetAssignedCity() return nil end
function amaniGovernor:IsEstablished() return false end
function amaniGovernor:HasPromotion() return false end

local governors = {}
function governors:GetGovernorPoints() return 1 end
function governors:GetGovernorPointsSpent() return 0 end
function governors:CanAppoint() return STUB_GOVERNOR_AVAILABLE end
function governors:HasGovernor(hash) return hash == 3500 and STUB_GOVERNOR_APPOINTED end
function governors:CanEverAppointGovernor(hash) return true end
function governors:GetGovernor(hash)
  if hash == 3500 and STUB_GOVERNOR_APPOINTED then return amaniGovernor end
  return nil
end
function governors:CanPromoteGovernor(hash) return STUB_GOVERNOR_PROMOTABLE end
function governors:CanEarnPromotion(governorHash, promotionHash) return true end
function governors:CanAssignGovernor(governorHash, city, wantResults)
  trace('Governors.CanAssignGovernor', { governor = governorHash, cityOwner = city:GetOwner(), cityId = city:GetID() })
  if not STUB_GOVERNOR_ASSIGNABLE then return false, STUB_GOVERNOR_ASSIGN_RESULTS end
  return true, STUB_GOVERNOR_ASSIGN_RESULTS
end

-- One met city-state (player 2) with one city, so a governor assignment whose destination is
-- NOT owned by the local player can be exercised.
local minorCity = {}
function minorCity:GetOwner() return 2 end
function minorCity:GetID() return 11 end
function minorCity:GetName() return 'LOC_TEST_CITY_STATE' end
function minorCity:GetX() return 2 end
function minorCity:GetY() return 0 end
function minorCity:GetPopulation() return 2 end

function minorCity:GetTrade()
  assert(visible(2, 0), 'minor city trade read under fog')
  return {HasActiveTradingPost = function(_, owner) return STUB_TRADE_POSTS['2:11'] == true end}
end
local minorInfluence = {}
function minorInfluence:CanReceiveInfluence() return true end
function minorInfluence:GetTokensReceived(pid) return STUB_TOKENS_RECEIVED end

-- The local player's Influence object is the authority for envoy tokens: how many may still be
-- given (TopPanel.lua:245), whether giving is allowed at all, and which city-state may receive one
-- (CityStates.lua:1499 CanGiveTokensToPlayer). Setting the "considered" flag is what the native
-- City-States screen does when it closes (CityStates.lua:446-455).
local influence = {}
function influence:GetTokensToGive() return STUB_TOKENS_TO_GIVE end
function influence:CanGiveInfluence() return STUB_CAN_GIVE_INFLUENCE end
function influence:GetTokensReceived(pid)
  trace('Influence.GetTokensReceived', { player = pid })
  return STUB_TOKENS_RECEIVED
end
function influence:CanGiveTokensToPlayer(pid)
  trace('Influence.CanGiveTokensToPlayer', { player = pid })
  return STUB_CAN_GIVE_TOKENS_TO
end
function influence:IsGivingTokensConsidered() return STUB_TOKENS_CONSIDERED end
function influence:SetGivingTokensConsidered(value)
  trace('Influence.SetGivingTokensConsidered', { value = value and true or false })
  STUB_TOKENS_CONSIDERED = value and true or false
  return true
end

local minorPlayer = {}
function minorPlayer:GetID() return 2 end
function minorPlayer:GetInfluence() return minorInfluence end
function minorPlayer:GetCities() return collection({ minorCity }) end
function minorPlayer:GetUnits() return collection({}) end
function minorPlayer:GetTrade()
  return {GetInternationalYieldModifier = function(_, index) return STUB_TRADE_MULTIPLIERS[2][index] end}
end

local diplomacyApi = {}
function diplomacyApi:HasMet(pid) return STUB_MINOR_MET end

PlayerManager = { GetAliveMinors = function() return { minorPlayer } end }

local player = {}
function player:GetID() return 0 end
function player:IsTurnActive() return STUB_ACTIVE end
function player:IsAlive() return true end
function player:IsTurnActiveComplete() return STUB_ACTIVE end
function player:GetUnits() return units end
function player:GetCities() return cities end
function player:GetTechs() return techs end
function player:GetCulture() return culture end
function player:GetReligion() return religion end
function player:GetTreasury() return treasury end
function player:GetResources() return resources end
function player:GetGovernors() return governors end
function player:GetTrade()
  return {
    GetOutgoingRouteCapacity = function() return 1 end,
    GetInternationalYieldModifier = function(_, index) return STUB_TRADE_MULTIPLIERS[0][index] end,
  }
end
function player:GetDiplomacy() return diplomacyApi end
function player:GetInfluence() return influence end
function player:GetStats() return {} end
function player:GetScore() return 10 end
function player:GetFavor() return 0 end
function player:GetFavorPerTurn() return 0 end
function player:GetDistricts() return collection({}) end

local function requestMode(modes)
  STUB_REQUEST_INDEX = STUB_REQUEST_INDEX + 1
  return modes[STUB_REQUEST_INDEX] or modes.default or 'accepted'
end

local function operationResult()
  if not STUB_OPERATION_LEGAL then return false, STUB_OPERATION_RESULTS end
  return true, STUB_OPERATION_RESULTS
end

local function commandResult()
  if not STUB_COMMAND_LEGAL then return false, STUB_COMMAND_RESULTS end
  return true, STUB_COMMAND_RESULTS
end

UnitManager = {
  CanStartOperation = function(unit, operation, _, parameters)
    trace('UnitManager.CanStartOperation', { operation = operation, parameters = copyTable(parameters) })
    if operation == 2013 then
      assert(type(parameters) == 'table' and parameters[UnitOperationTypes.PARAM_X1] == unit:GetX()
        and parameters[UnitOperationTypes.PARAM_Y1] == unit:GetY(), 'trade check lacks native origin')
      local destination = coordKey(parameters[UnitOperationTypes.PARAM_X0], parameters[UnitOperationTypes.PARAM_Y0])
      if STUB_TRADE_LEGAL[destination] == false then return false, {} end
    end
    return operationResult()
  end,
  RequestOperation = function(unit, operation, parameters)
    trace('UnitManager.RequestOperation', { operation = operation, parameters = copyTable(parameters) })
    local mode = requestMode(STUB_REQUEST_MODES)
    if mode == 'throw' then error('fixture request acknowledgement unavailable') end
    if mode == 'rejected' then return false end
    if mode == 'unknown' then return nil end
    return true
  end,
  CanStartCommand = function(unit, command, parameters)
    trace('UnitManager.CanStartCommand', { command = command, parameters = copyTable(parameters) })
    return commandResult()
  end,
  RequestCommand = function(unit, command, parameters)
    trace('UnitManager.RequestCommand', { command = command, parameters = copyTable(parameters) })
    local mode = requestMode(STUB_COMMAND_REQUEST_MODES)
    if mode == 'throw' then error('fixture command acknowledgement unavailable') end
    if mode == 'rejected' then return false end
    if mode == 'unknown' then return nil end
    return true
  end,
  GetOperationTargets = function(unit, operation)
    trace('UnitManager.GetOperationTargets', { operation = operation })
    return STUB_OPERATION_TARGETS
  end,
  GetUnit = function(owner, id)
    if owner == 0 and id == 7 then return ownUnit end
    if owner == 1 and id == 9 then return foreignUnit end
    return nil
  end,
  GetActivityType = function() return STUB_UNIT_ACTIVITY end,
  -- The queued move destination, or nil when the engine records none. The native UI uses this to
  -- know a move is still queued and to redraw that path (WorldInput.lua:821,907,1165).
  GetQueuedDestination = function(unit)
    trace('UnitManager.GetQueuedDestination', {})
    return STUB_UNIT_QUEUED_DESTINATION
  end,
  -- Plain plot-index arrays; SelectedUnit.lua:47-54 passes them straight to the lens layers.
  GetReachableMovement = function(unit)
    trace('UnitManager.GetReachableMovement', {})
    return STUB_REACHABLE
  end,
  GetReachableTargets = function(unit)
    trace('UnitManager.GetReachableTargets', {})
    return STUB_REACHABLE_TARGETS
  end,
  GetReachableZonesOfControl = function(unit, visibleOnly)
    trace('UnitManager.GetReachableZonesOfControl', { visibleOnly = visibleOnly })
    return STUB_REACHABLE_ZOC
  end,
  -- {plots=, turns=, obstacles=}; turns is positionally matched to plots and its last entry is
  -- the total turn count (WorldInput.lua:961-1100). A destination with no path raises, which is
  -- how options.lua's pcall distinguishes "no path" from a malformed answer.
  GetMoveToPathEx = function(unit, destination)
    trace('UnitManager.GetMoveToPathEx', { destination = destination })
    if STUB_PATH == nil then error('fixture has no path for this unit and destination') end
    return STUB_PATH
  end,
}

CityManager = {
  CanStartOperation = function(city, operation, parameters)
    trace('CityManager.CanStartOperation', { operation = operation, parameters = copyTable(parameters) })
    if not STUB_CITY_OPERATION_LEGAL then return false, STUB_CITY_OPERATION_RESULTS end
    return true, STUB_CITY_OPERATION_RESULTS
  end,
  RequestOperation = function(city, operation, parameters)
    trace('CityManager.RequestOperation', { operation = operation, parameters = copyTable(parameters) })
    local mode = requestMode(STUB_CITY_REQUEST_MODES)
    if mode == 'throw' then error('fixture city request acknowledgement unavailable') end
    if mode == 'rejected' then return false end
    if mode == 'unknown' then return nil end
    return true
  end,
  CanStartCommand = function(city, command, ...)
    local args = { ... }
    local parameters = args[#args]
    trace('CityManager.CanStartCommand', { command = command, parameters = copyTable(parameters) })
    if not STUB_CITY_COMMAND_LEGAL then return false, STUB_CITY_COMMAND_RESULTS end
    return true, STUB_CITY_COMMAND_RESULTS
  end,
  RequestCommand = function(city, command, parameters)
    trace('CityManager.RequestCommand', { command = command, parameters = copyTable(parameters) })
    local mode = requestMode(STUB_CITY_REQUEST_MODES)
    if mode == 'throw' then error('fixture city command acknowledgement unavailable') end
    if mode == 'rejected' then return false end
    if mode == 'unknown' then return nil end
    return true
  end,
  GetOperationTargets = function(city, operation, parameters)
    trace('CityManager.GetOperationTargets', { operation = operation, parameters = copyTable(parameters) })
    return STUB_CITY_OPERATION_TARGETS
  end,
  GetCommandTargets = function(city, command, parameters)
    trace('CityManager.GetCommandTargets', { command = command, parameters = copyTable(parameters) })
    return STUB_CITY_COMMAND_TARGETS
  end,
  GetCity = function(owner, id)
    if owner == 0 and id == 3 then return ownCity end
    if owner == 2 and id == 11 then return minorCity end
    return nil
  end,
}

UI = {
  IsProcessingMessages = function() return STUB_PROCESSING end,
  HasSentTurnComplete = function() return STUB_SUBMITTED end,
  CanEndTurn = function() return STUB_CAN_END end,
  RequestAction = function(action)
    trace('UI.RequestAction', { action = action })
    STUB_SUBMITTED = true
    return true
  end,
  RequestPlayerOperation = function(owner, operation, parameters)
    trace('UI.RequestPlayerOperation', { owner = owner, operation = operation, parameters = copyTable(parameters) })
    local mode = requestMode(STUB_PLAYER_REQUEST_MODES)
    if mode == 'throw' then error('fixture player request acknowledgement unavailable') end
    if mode == 'rejected' then return false end
    if mode == 'unknown' then return nil end
    return true
  end,
}

local tradeManager = {
  GetTradeRoutePath = function(_, originOwner, originId, destinationOwner, destinationId)
    trace('TradeManager.GetTradeRoutePath', {
      originOwner = originOwner, originId = originId,
      destinationOwner = destinationOwner, destinationId = destinationId,
    })
    return STUB_TRADE_PATHS[tostring(destinationOwner)..':'..tostring(destinationId)]
  end,
}
-- Native TradeSupport.lua invokes six distinct array methods (route/path/modifiers for each
-- receiver); making them independent catches omitted path yields and wrong-side computations.
for _, side in ipairs({'Origin', 'Destination'}) do
  for _, part in ipairs({'YieldsFromPotentialRoute', 'YieldsFromPath', 'YieldsFromModifiers'}) do
    local name = 'Calculate'..side..part
    tradeManager[name] = function(_, originOwner, originId, owner, id)
      trace('TradeManager.'..name, {originOwner = originOwner, originId = originId, owner = owner, id = id})
      return STUB_TRADE_YIELDS[side][part]
    end
  end
end
local questsManager = {
  HasActiveQuestFromPlayer = function(_, pid, owner, quest)
    assert(owner ~= 1 or visible(2, 2), 'foreign quest read under fog')
    assert(owner ~= 2 or visible(2, 0), 'minor quest read under fog')
    trace('Quests.HasActiveQuestFromPlayer', {player = pid, owner = owner, quest = quest})
    return STUB_TRADE_QUESTS[owner] == true
  end,
}

Game = {
  GetLocalPlayer = function() return 0 end,
  GetPlayers = function() return {player, Players[1], minorPlayer} end,
  GetTradeManager = function() return tradeManager end,
  GetQuestsManager = function() return questsManager end,
  GetCurrentGameTurn = function() return STUB_TURN end,
  IsAllowTacticalCommands = function() return STUB_ALLOW_TACTICAL end,
  IsAllowStrategicCommands = function() return STUB_ALLOW_STRATEGIC end,
}

Players = {
  [0] = player,
  [1] = {
    GetID = function() return 1 end,
    GetUnits = function() return collection({ foreignUnit }) end,
    GetCities = function() return foreignCities end,
    GetTrade = function()
      return {GetInternationalYieldModifier = function(_, index) return STUB_TRADE_MULTIPLIERS[1][index] end}
    end,
  },
  [2] = minorPlayer,
}
PlayersVisibility = { [0] = {
  IsVisible = function(_, x, y) return visible(x, y) end,
  IsRevealed = function(_, x, y) return revealed(x, y) end,
  IsUnitVisible = function(_, unit) return unit:GetOwner() == 0 or STUB_FOREIGN_UNIT_VISIBLE end,
} }
PlayerConfigurations = { [0] = {
  GetCivilizationTypeName = function() return 'CIVILIZATION_TEST' end,
  GetLeaderTypeName = function() return 'LEADER_TEST' end,
  GetHandicapTypeID = function() return 0 end,
},
-- City-state (minor) player 2: the envoy decision labels its options from here, and a diplomacy
-- session with a city-state would read its leader name the same way.
[2] = {
  GetCivilizationShortDescription = function() return 'LOC_TEST_CITY_STATE_NAME' end,
  GetCivilizationTypeName = function() return 'CIVILIZATION_TEST_CITY_STATE' end,
  GetLeaderTypeName = function() return 'LEADER_TEST_CITY_STATE' end,
} }

Map = {
  GetGridSize = function() return 3, 3 end,
  GetPlotByIndex = function(index) return plots[index] end,
  GetPlot = function(x, y)
    if x < 0 or x >= 3 or y < 0 or y >= 3 then return nil end
    return plots[y * 3 + x]
  end,
  GetAdjacentPlot = function(x, y, direction)
    local plot = Map.GetPlot(x, y)
    return plot and adjacent(plot, direction) or nil
  end,
  GetPlotDistance = function(x0, y0, x1, y1)
    return math.max(math.abs(x1 - x0), math.abs(y1 - y0))
  end,
  GetCityPlots = function() return {} end,
}
for y = 0, 2 do
  for x = 0, 2 do plotAt(y * 3 + x, x, y) end
end

-- Static three-argument call: Units.GetUnitsInPlotLayerID(x, y, MapLayers.ANY).
MapLayers = { ANY = 0, UNITS = 1, TRADE = 2, RELIGIOUS = 3, SPIES = 4 }
Units = { GetUnitsInPlotLayerID = function(x, y, layer)
  if x == 1 and y == 1 then return { ownUnit } end
  if x == 2 and y == 2 then return { foreignUnit } end
  return {}
end }
-- Static two-argument call: Cities.GetCityInPlot(x, y).
Cities = { GetCityInPlot = function(x, y)
  if x == 1 and y == 1 then return ownCity end
  if x == 2 and y == 2 then return foreignCity end
  if x == 2 and y == 0 then return minorCity end
  return nil
end }

NotificationManager = {
  GetAllEndTurnBlocking = function() return STUB_BLOCKERS end,
  GetFirstEndTurnBlocking = function() return STUB_FIRST_BLOCKER end,
  FindEndTurnBlocking = function() return nil end,
  GetEvents = function() return {} end,
  RegisterEvent = function() end,
  Find = function() return nil end,
  FindType = function() return nil end,
  -- Replay of the current notification list; changes no game state (ActionPanel.lua:1085).
  RestoreVisualState = function(pid) trace('NotificationManager.RestoreVisualState', { player = pid }) end,
  Dismiss = function(pid, nid) trace('NotificationManager.Dismiss', { player = pid, notification = nid }) end,
}

-- Engine event buses. Subscriptions are recorded and never fired: nothing in this harness
-- simulates a notification arriving, so state.lua's notification bookkeeping is only ever
-- exercised in its empty state.
local function eventBus(label)
  return setmetatable({}, { __index = function(_, name)
    return { Add = function(handler)
      STUB_EVENT_SUBSCRIPTIONS[#STUB_EVENT_SUBSCRIPTIONS + 1] = { bus = label, event = name }
      return handler
    end, Remove = function() end }
  end })
end
Events = eventBus('Events')
LuaEvents = eventBus('LuaEvents')
Modding = { GetActiveMods = function() return {} end }
GameConfiguration = {
  GetRuleSet = function() return 'RULESET_STANDARD' end,
  GetGameSpeedType = function() return 0 end,
  GetParticipatingPlayerCount = function() return 1 end,
  GetMapSize = function() return 0 end,
}
Locale = { Lookup = function(key) return key end }

EndTurnBlockingTypes = {
  NO_ENDTURN_BLOCKING = 0,
  ENDTURN_BLOCKING_UNITS = 1,
  ENDTURN_BLOCKING_PRODUCTION = 2,
  ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE = 3,
  ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN = 4,
  -- The rest of the installed enum. Names are the engine's own (every one appears in shipped Lua,
  -- e.g. ActionPanel.lua:100-114 and ActionPanel_Expansion2.lua for the two congress blockers);
  -- the numbers are fixture-local identities, exactly like the hash simplification above, so a
  -- scenario can select one by name without claiming its engine value. state.lua builds its
  -- name->blocker table at load time, so these must exist before it is loaded.
  ENDTURN_BLOCKING_UNIT_NEEDS_ORDERS = 5,
  ENDTURN_BLOCKING_STACKED_UNITS = 6,
  ENDTURN_BLOCKING_RESEARCH = 7,
  ENDTURN_BLOCKING_CIVIC = 8,
  ENDTURN_BLOCKING_FILL_CIVIC_SLOT = 9,
  ENDTURN_BLOCKING_CONSIDER_GOVERNMENT_CHANGE = 10,
  ENDTURN_BLOCKING_CONSIDER_RAZE_CITY = 11,
  ENDTURN_BLOCKING_PANTHEON = 12,
  ENDTURN_BLOCKING_RELIGION = 13,
  ENDTURN_BLOCKING_BELIEF = 14,
  ENDTURN_BLOCKING_CLAIM_GREAT_PERSON = 15,
  ENDTURN_BLOCKING_SPY_CHOOSE_DRAGNET_PRIORITY = 16,
  ENDTURN_BLOCKING_ARTIFACT = 17,
  ENDTURN_BLOCKING_COMMEMORATION_AVAILABLE = 18,
  ENDTURN_BLOCKING_CONSIDER_DISLOYAL_CITY = 19,
  ENDTURN_BLOCKING_EMERGENCY_NEEDS_ATTENTION = 20,
  ENDTURN_BLOCKING_GOVERNOR_APPOINTMENT = 21,
  ENDTURN_BLOCKING_GOVERNOR_PROMOTION = 22,
  ENDTURN_BLOCKING_GOVERNOR_IDLE = 23,
  ENDTURN_BLOCKING_GOVERNOR_OPPORTUNITY = 24,
  ENDTURN_BLOCKING_WORLD_CONGRESS_SESSION = 25,
  ENDTURN_BLOCKING_WORLD_CONGRESS_LOOK = 26,
}
ActionTypes = { ACTION_ENDTURN = 900 }
ActivityTypes = { ACTIVITY_AWAKE = 0, ACTIVITY_OPERATION = 1, ACTIVITY_SLEEP = 2, ACTIVITY_HOLD = 3 }
MilitaryFormationTypes = { STANDARD_MILITARY_FORMATION = 0 }
UnitOperationMoveModifiers = { NONE = 0, ATTACK = 1, MOVE_IGNORE_UNEXPLORED_DESTINATION = 2 }
UnitOperationResults = {
  FAILURE_REASONS = 1, ADDITIONAL_DESCRIPTION = 2, ACTION_NAME = 3,
  PLOTS = 4, MODIFIERS = 5, MODIFIER_IS_TARGET = 1,
  IMPROVEMENTS = 6, BEST_IMPROVEMENT = 7,
}
-- Distinct namespace from UnitOperationResults; UnitPanel.lua:421-479 reads UNITS, PROMOTIONS
-- and UNIT_TYPE from it.
UnitCommandResults = {
  FAILURE_REASONS = 1, ADDITIONAL_DESCRIPTION = 2, ACTION_NAME = 3,
  PLOTS = 4, MODIFIERS = 5, UNITS = 6, PROMOTIONS = 7, UNIT_TYPE = 8,
}
CityOperationResults = { FAILURE_REASONS = 1, ADDITIONAL_DESCRIPTION = 2, ACTION_NAME = 3, PLOTS = 4, MODIFIERS = 5 }
CityCommandResults = { FAILURE_REASONS = 1, ADDITIONAL_DESCRIPTION = 2, ACTION_NAME = 3, PLOTS = 4, MODIFIERS = 5 }
FlowDirectionTypes = { FLOW_DIRECTION_NORTHWEST = 0 }
DefenseTypes = { DISTRICT_GARRISON = 0, DISTRICT_OUTER = 1 }
-- The installed enum also carries PRODUCTION, SCIENCE and CULTURE; this fixture models the three
-- yields its GameInfo.Yields rows carry, with values that are fixture-local identities matching
-- those rows' Index (the hash note above applies), so GameInfo.Yields[YieldTypes.GOLD] resolves to
-- the gold row here. Native call sites pass these values as YieldTypes parameters
-- (Objects.csv Q-UnitGetGreatPerson..., Q-CityGetYield; GreatPeoplePopup.lua:913, :925).
YieldTypes = { FOOD = 0, GOLD = 1, FAITH = 2 }

-- DELIBERATELY INCOMPLETE, exactly as the engine's global is.  HEAL, SLEEP and SKIP_TURN have
-- GameInfo.UnitOperations rows but are absent here, so any name-based dispatch through this
-- global must fail.  FORTIFY is present because the shipped UI does reference
-- UnitOperationTypes.FORTIFY.
UnitOperationTypes = {
  MOVE_TO = 10, RANGE_ATTACK = 11, AIR_ATTACK = 12, FOUND_CITY = 13,
  BUILD_IMPROVEMENT = 14, COASTAL_RAID = 15, REBASE = 16, SWAP_UNITS = 17,
  FORTIFY = 18, DEPLOY = 19, MAKE_TRADE_ROUTE = 25,
  PARAM_X = 100, PARAM_Y = 101, PARAM_MODIFIERS = 102,
  PARAM_IMPROVEMENT_TYPE = 103, PARAM_X0 = 104, PARAM_Y0 = 105,
  PARAM_X1 = 109, PARAM_Y1 = 110,
  PARAM_UNIT_PLAYER = 106, PARAM_UNIT_ID = 107, PARAM_FLAGS = 108,
}
UnitCommandTypes = {
  PROMOTE = 20, UPGRADE = 21, FORM_CORPS = 22, FORM_ARMY = 23,
  ENTER_FORMATION = 24, PARAM_PROMOTION_TYPE = 200, PARAM_UNIT_PLAYER = 201,
  PARAM_UNIT_ID = 202,
}
CityOperationTypes = {
  BUILD = 30, PARAM_UNIT_TYPE = 300, PARAM_BUILDING_TYPE = 301,
  PARAM_DISTRICT_TYPE = 302, PARAM_PROJECT_TYPE = 303, PARAM_INSERT_MODE = 304,
  PARAM_QUEUE_DESTINATION_LOCATION = 305, VALUE_APPEND = 1, VALUE_REPLACE_AT = 2,
  PARAM_X = 306, PARAM_Y = 307,
}
CityCommandTypes = {
  PURCHASE = 40, RANGE_ATTACK = 41, SET_FOCUS = 42, PARAM_UNIT_TYPE = 400, PARAM_BUILDING_TYPE = 401,
  PARAM_DISTRICT_TYPE = 402, PARAM_PROJECT_TYPE = 403, PARAM_YIELD_TYPE = 404,
  PARAM_PLOT_PURCHASE = 405, PARAM_MILITARY_FORMATION_TYPE = 406,
  PARAM_X = 407, PARAM_Y = 408, PARAM_FLAGS = 409, PARAM_DATA0 = 410,
}
PlayerOperations = {
  RESEARCH = 50, PROGRESS_CIVIC = 51, UNLOCK_POLICIES = 52,
  FOUND_PANTHEON = 53, PARAM_TECH_TYPE = 500, PARAM_CIVIC_TYPE = 501,
  PARAM_BELIEF_TYPE = 502, PARAM_INSERT_MODE = 503, VALUE_EXCLUSIVE = 3,
  -- Queue vs. replace for PARAM_INSERT_MODE: TechTree.lua:241-243 and CivicsTree.lua:241-243 send
  -- VALUE_APPEND when queueing and VALUE_EXCLUSIVE when replacing. Fixture-local identities.
  VALUE_APPEND = 4,
  PARAM_GOVERNOR_TYPE = 504, PARAM_PLAYER_ONE = 505, PARAM_CITY_DEST = 506,
  APPOINT_GOVERNOR = 54, ASSIGN_GOVERNOR = 55, PROMOTE_GOVERNOR = 56,
  PARAM_GOVERNOR_PROMOTION_TYPE = 507,
  -- Envoy tokens: Base/Assets/UI/PartialScreens/CityStates.lua:749-765 sends one request per token
  -- with PARAM_PLAYER_ONE set to the city-state player id.
  GIVE_INFLUENCE_TOKEN = 57,
  -- The rest of the installed PlayerOperations enum, named by the engine. Values are fixture-local
  -- identities (see the hash note above). Call sites: COMMEMORATE and PARAM_COMMEMORATION_TYPE
  -- (Expansion2/UI/Additions/DedicationPopup.lua:213-214); GREAT PERSON operations with
  -- PARAM_GREAT_PERSON_INDIVIDUAL_TYPE and PARAM_YIELD_TYPE
  -- (Base/Assets/UI/Popups/GreatPeoplePopup.lua:890-928); congress operations with
  -- PARAM_RESOLUTION_TYPE/PARAM_RESOLUTION_OPTION/PARAM_RESOLUTION_SELECTION/
  -- PARAM_WORLD_CONGRESS_VOTES/PARAM_DISCUSSION_TYPE
  -- (Expansion2/UI/Additions/WorldCongressPopup.lua:2242-2402); SET_ESCAPE_ROUTE, ADD_BELIEF,
  -- FOUND_RELIGION, LEVY_MILITARY, the clan operations, MOVE_GREAT_WORK and NAME_CORPORATION appear
  -- in the same shipped screen set.
  COMMEMORATE = 58, SET_ESCAPE_ROUTE = 59, CHOOSE_ARTIFACT_PLAYER = 60, ADD_BELIEF = 61,
  FOUND_RELIGION = 62, RECRUIT_GREAT_PERSON = 63, REJECT_GREAT_PERSON = 64, PATRONIZE_GREAT_PERSON = 65,
  WORLD_CONGRESS_RESOLUTION_VOTE = 66, WORLD_CONGRESS_DISCUSSION_VOTE = 67,
  WORLD_CONGRESS_DISCUSSION_SELECTION = 68, WORLD_CONGRESS_SUBMIT_TURN = 69,
  WORLD_CONGRESS_LOOKED_AT_AVAILABLE = 70, ACCEPT_EMERGENCY = 71, REJECT_EMERGENCY = 72,
  MOVE_GREAT_WORK = 73, NAME_CORPORATION = 74, DIPLOMACY_DECLARE_WAR = 75, DIPLOMACY_MAKE_PEACE = 76,
  LEVY_MILITARY = 77, INCITE_CLAN = 78, HIRE_CLAN = 79, RANSOM_CLAN = 80, BRIBE_CLAN = 81,
  START_OBSERVER_MODE = 82, EXECUTE_SCRIPT = 83,
  PARAM_COMMEMORATION_TYPE = 508, PARAM_GREAT_PERSON_INDIVIDUAL_TYPE = 509, PARAM_YIELD_TYPE = 510,
  PARAM_RESOLUTION_TYPE = 511, PARAM_WORLD_CONGRESS_VOTES = 512, PARAM_RESOLUTION_OPTION = 513,
  PARAM_RESOLUTION_SELECTION = 514, PARAM_OTHER_PLAYER = 515, PARAM_DISCUSSION_TYPE = 516,
  PARAM_PLAYER_TWO = 517, PARAM_DISTRICT_TYPE = 518, PARAM_BUILDING_SRC = 519,
  PARAM_BUILDING_DEST = 520, PARAM_CITY_SRC = 521, PARAM_RELIGION_TYPE = 522,
  PARAM_RELIGION_CUSTOM_NAME = 523, PARAM_EMERGENCY_TYPE = 524, PARAM_GREAT_WORK_INDEX = 525,
  PARAM_SLOT = 526, PARAM_RESOURCE_TYPE = 527, PARAM_CORPORATION_CUSTOM_NAME = 528,
}
PlayerOperationResults = { FAILURE_REASONS = 1, ADDITIONAL_DESCRIPTION = 2 }

GameInfo = {
  Units = rows({
    { Index = 0, Hash = 1000, UnitType = 'UNIT_WARRIOR', Name = 'LOC_TEST_WARRIOR' },
    -- The trader marker is a unit-type column, and trader detection is a type-row lookup
    -- (UnitPanel.lua:2165, :3975). The fixture's own unit takes this type when STUB_UNIT_TYPE = 1.
    { Index = 1, Hash = 1001, UnitType = 'UNIT_TRADER', Name = 'LOC_TEST_TRADER', MakeTradeRoute = true },
  }),
  -- Real column set: OperationType, Description, VisibleInUI, CategoryInUI (no Name column).
  -- HEAL/SLEEP/SKIP_TURN exist here while UnitOperationTypes omits them, which is the whole
  -- point of hash dispatch. TELEPORT_TO and EXECUTE_SCRIPT are VisibleInUI=false rows this
  -- bridge does not support, so the native-UI discovery filter must hide them.
  UnitOperations = rows({
    { Index = 0, Hash = 2000, OperationType = 'UNITOPERATION_MOVE_TO', Description = 'LOC_MOVE', VisibleInUI = true, CategoryInUI = 'MOVE' },
    { Index = 1, Hash = 2001, OperationType = 'UNITOPERATION_HEAL', Description = 'LOC_HEAL', VisibleInUI = true, CategoryInUI = 'INPLACE' },
    { Index = 2, Hash = 2002, OperationType = 'UNITOPERATION_RANGE_ATTACK', Description = 'LOC_RANGE_ATTACK', VisibleInUI = true, CategoryInUI = 'ATTACK' },
    { Index = 3, Hash = 2003, OperationType = 'UNITOPERATION_AIR_ATTACK', Description = 'LOC_AIR_ATTACK', VisibleInUI = true, CategoryInUI = 'ATTACK' },
    { Index = 4, Hash = 2004, OperationType = 'UNITOPERATION_FOUND_CITY', Description = 'LOC_FOUND_CITY', VisibleInUI = true, CategoryInUI = 'SPECIFIC' },
    { Index = 5, Hash = 2005, OperationType = 'UNITOPERATION_BUILD_IMPROVEMENT', Description = 'LOC_BUILD', VisibleInUI = true, CategoryInUI = 'BUILD' },
    { Index = 6, Hash = 2006, OperationType = 'UNITOPERATION_FORTIFY', Description = 'LOC_FORTIFY', VisibleInUI = true, CategoryInUI = 'INPLACE' },
    { Index = 7, Hash = 2007, OperationType = 'UNITOPERATION_SLEEP', Description = 'LOC_SLEEP', VisibleInUI = true, CategoryInUI = 'INPLACE' },
    { Index = 8, Hash = 2008, OperationType = 'UNITOPERATION_SKIP_TURN', Description = 'LOC_SKIP_TURN', VisibleInUI = true, CategoryInUI = 'INPLACE' },
    { Index = 9, Hash = 2009, OperationType = 'UNITOPERATION_SWAP_UNITS', Description = 'LOC_SWAP', VisibleInUI = false, CategoryInUI = 'SPECIFIC' },
    { Index = 10, Hash = 2010, OperationType = 'UNITOPERATION_ROUTE_TO', Description = 'LOC_ROUTE_TO', VisibleInUI = false, CategoryInUI = 'MOVE' },
    { Index = 11, Hash = 2011, OperationType = 'UNITOPERATION_TELEPORT_TO', Description = 'LOC_TELEPORT', VisibleInUI = false, CategoryInUI = 'MOVE' },
    { Index = 12, Hash = 2012, OperationType = 'UNITOPERATION_REST_REPAIR', Description = 'LOC_REST_REPAIR', VisibleInUI = true, CategoryInUI = 'INPLACE' },
    { Index = 13, Hash = 2013, OperationType = 'UNITOPERATION_MAKE_TRADE_ROUTE', Description = 'LOC_TRADE', VisibleInUI = true, CategoryInUI = 'SPECIFIC' },
  }),
  UnitCommands = rows({
    { Index = 0, Hash = 2100, CommandType = 'UNITCOMMAND_PROMOTE', Description = 'LOC_PROMOTE', VisibleInUI = true, CategoryInUI = 'SPECIFIC' },
    { Index = 1, Hash = 2101, CommandType = 'UNITCOMMAND_UPGRADE', Description = 'LOC_UPGRADE', VisibleInUI = true, CategoryInUI = 'SPECIFIC' },
    { Index = 2, Hash = 2102, CommandType = 'UNITCOMMAND_FORM_CORPS', Description = 'LOC_CORPS', VisibleInUI = true, CategoryInUI = 'SPECIFIC' },
    { Index = 3, Hash = 2103, CommandType = 'UNITCOMMAND_DELETE', Description = 'LOC_DELETE', VisibleInUI = true, CategoryInUI = 'SPECIFIC' },
    { Index = 4, Hash = 2104, CommandType = 'UNITCOMMAND_AUTOMATE', Description = 'LOC_AUTOMATE', VisibleInUI = false, CategoryInUI = 'SPECIFIC' },
    { Index = 5, Hash = 2105, CommandType = 'UNITCOMMAND_EXECUTE_SCRIPT', Description = 'LOC_EXECUTE_SCRIPT', VisibleInUI = false, CategoryInUI = 'SPECIFIC' },
  }),
  UnitPromotions = rows({
    { Index = 0, Hash = 2200, UnitPromotionType = 'PROMOTION_DRILL_1', Name = 'LOC_DRILL_1' },
  }),
  Improvements = rows({
    { Index = 0, Hash = 2300, ImprovementType = 'IMPROVEMENT_FARM', Name = 'LOC_FARM' },
  }),
  Buildings = rows({
    { Index = 0, Hash = 2400, BuildingType = 'BUILDING_MONUMENT', Name = 'LOC_MONUMENT' },
  }),
  Districts = rows({
    { Index = 0, Hash = 2500, DistrictType = 'DISTRICT_CAMPUS', Name = 'LOC_CAMPUS', Kind = 'KIND_CAMPUS' },
  }),
  Projects = rows({
    { Index = 0, Hash = 2600, ProjectType = 'PROJECT_SPACE_RACE', Name = 'LOC_SPACE_RACE' },
  }),
  Technologies = rows({
    { Index = 0, Hash = 2700, TechnologyType = 'TECH_POTTERY', Name = 'LOC_POTTERY' },
  }),
  Civics = rows({
    { Index = 0, Hash = 2800, CivicType = 'CIVIC_CODE_OF_LAWS', Name = 'LOC_CODE_OF_LAWS' },
  }),
  Policies = rows({
    { Index = 0, Hash = 2900, PolicyType = 'POLICY_DISCIPLINE', Name = 'LOC_DISCIPLINE', GovernmentSlotType = 'SLOT_MILITARY' },
    { Index = 1, Hash = 2901, PolicyType = 'POLICY_SURVEY', Name = 'LOC_SURVEY', GovernmentSlotType = 'SLOT_MILITARY' },
    { Index = 2, Hash = 2902, PolicyType = 'POLICY_MANEUVER', Name = 'LOC_MANEUVER', GovernmentSlotType = 'SLOT_MILITARY' },
  }),
  Governments = rows({
    { Index = 0, Hash = 3000, GovernmentType = 'GOVERNMENT_CHIEFDOM', Name = 'LOC_CHIEFDOM' },
  }),
  GovernmentSlots = rows({
    { Index = 0, Hash = 3010, GovernmentSlotType = 'SLOT_MILITARY' },
    { Index = 1, Hash = 3011, GovernmentSlotType = 'SLOT_WILDCARD' },
  }),
  Yields = rows({
    { Index = 0, Hash = 3100, YieldType = 'YIELD_FOOD', Name = 'LOC_FOOD' },
    { Index = 1, Hash = 3101, YieldType = 'YIELD_GOLD', Name = 'LOC_GOLD' },
    { Index = 2, Hash = 3102, YieldType = 'YIELD_FAITH', Name = 'LOC_FAITH' },
  }),
  Terrains = rows({ { Index = 0, Hash = 3200, TerrainType = 'TERRAIN_GRASS', Name = 'LOC_GRASS' } }),
  Features = rows({}),
  Resources = rows({}),
  Religions = rows({ { Index = 0, Hash = 3300, ReligionType = 'RELIGION_PANTHEON', Name = 'LOC_PANTHEON' } }),
  Beliefs = rows({ { Index = 0, Hash = 3400, BeliefType = 'BELIEF_DIVINE_SPARK', Name = 'LOC_DIVINE_SPARK' } }),
  Governors = rows({
    { Index = 0, Hash = 3500, GovernorType = 'GOVERNOR_AMANI', Name = 'LOC_AMANI', Title = 'LOC_AMANI_TITLE', Description = 'LOC_AMANI_DESC' },
    { Index = 1, Hash = 3501, GovernorType = 'GOVERNOR_MAGNUS', Name = 'LOC_MAGNUS', Title = 'LOC_MAGNUS_TITLE', Description = 'LOC_MAGNUS_DESC' },
  }),
  GovernorPromotions = rows({
    { Index = 0, Hash = 3600, GovernorPromotionType = 'GOVERNOR_PROMOTION_TEST', Name = 'LOC_GOV_PROMO',
      Description = 'LOC_GOV_PROMO_DESC', Level = 1, Column = 0, BaseAbility = 0 },
  }),
  -- The promotion -> governor relationship is GovernorPromotionSets, and GovernorPromotions carries
  -- no GovernorType column at all (DLC/Expansion2/Data/Expansion2_Schema.sql:372-379 and :402-407).
  -- Shipped panels walk this table before looking the promotion row up by type
  -- (GovernorPanel.lua:203-208, GovernorDetailsPanel.lua:159-166).
  GovernorPromotionSets = rows({
    { GovernorType = 'GOVERNOR_AMANI', GovernorPromotion = 'GOVERNOR_PROMOTION_TEST' },
  }),
  GovernorPromotionPrereqs = rows({}),
  GameSpeeds = rows({ { Index = 0, GameSpeedType = 'GAMESPEED_STANDARD' } }),
  Difficulties = rows({ { Index = 0, DifficultyType = 'DIFFICULTY_PRINCE' } }),
  Maps = rows({ { Index = 0, MapSizeType = 'MAPSIZE_DUEL' } }),
}
GameInfo['Yields']['YIELD_GOLD'] = GameInfo.Yields[1]
GameInfo['Yields']['YIELD_FAITH'] = GameInfo.Yields[2]
GameInfo.Quests = { QUEST_SEND_TRADE_ROUTE = { Index = 9, QuestType = 'QUEST_SEND_TRADE_ROUTE' } }

function STUB_INSTALL(name)
  STUB_SCENARIO = name
  TRACE = {}
  STUB_TURN = 10
  STUB_SUBMITTED = false
  STUB_PROCESSING = false
  STUB_ACTIVE = true
  STUB_ALLOW_TACTICAL = true
  STUB_ALLOW_STRATEGIC = true
  STUB_CAN_END = true
  STUB_FIRST_BLOCKER = EndTurnBlockingTypes.NO_ENDTURN_BLOCKING
  STUB_BLOCKERS = {}
  STUB_BROKEN_PLOT = -1
  STUB_EDGE_ERROR = false
  STUB_FOREIGN_UNIT_VISIBLE = false
  STUB_FOREIGN_CITY_VISIBLE = false
  STUB_PANTHEON_AVAILABLE = true
  STUB_GOVERNOR_AVAILABLE = true
  STUB_GOVERNOR_APPOINTED = true
  STUB_GOVERNOR_PROMOTABLE = false
  STUB_GOVERNOR_ASSIGNABLE = true
  STUB_GOVERNOR_ASSIGN_RESULTS = {}
  STUB_MINOR_MET = true
  STUB_TOKENS_TO_GIVE = 0
  STUB_CAN_GIVE_INFLUENCE = true
  STUB_CAN_GIVE_TOKENS_TO = true
  STUB_TOKENS_RECEIVED = 0
  STUB_TOKENS_CONSIDERED = false
  STUB_POLICY_CHANGE_AVAILABLE = true
  STUB_OPERATION_LEGAL = true
  STUB_COMMAND_LEGAL = true
  STUB_CITY_OPERATION_LEGAL = true
  STUB_CITY_COMMAND_LEGAL = true
  STUB_OPERATION_RESULTS = {}
  STUB_COMMAND_RESULTS = {}
  STUB_CITY_OPERATION_RESULTS = {}
  STUB_CITY_COMMAND_RESULTS = {}
  STUB_OPERATION_TARGETS = { [UnitOperationResults.PLOTS] = { 2, 3, 4 }, [UnitOperationResults.MODIFIERS] = { 1, 0, 1 } }
  STUB_TRADE_LEGAL = {}
  STUB_TRADE_PATHS = { ['0:3'] = {4, 5}, ['1:12'] = {4, 8}, ['2:11'] = {4, 2} }
  STUB_TRADE_YIELDS = {
    Origin = {
      YieldsFromPotentialRoute = {2, 4, 0},
      YieldsFromPath = {1, 3, 0},
      YieldsFromModifiers = {2, 1, 0},
    },
    Destination = {
      YieldsFromPotentialRoute = {0, 2, 1},
      YieldsFromPath = {0, 1, 2},
      YieldsFromModifiers = {0, 1, 0},
    },
  }
  STUB_TRADE_MULTIPLIERS = {
    [0] = {[0] = 1.5, [1] = 2, [2] = 1},
    [1] = {[0] = 1, [1] = 3, [2] = 2},
    [2] = {[0] = 1, [1] = 1.25, [2] = 1},
  }
  STUB_TRADE_POSTS = {['1:12'] = true}
  STUB_TRADE_QUESTS = {[2] = true}
  STUB_CITY_OPERATION_TARGETS = { [CityOperationResults.PLOTS] = { 2, 4 } }
  STUB_CITY_COMMAND_TARGETS = { [CityCommandResults.PLOTS] = { 2 } }
  STUB_REQUEST_INDEX = 0
  STUB_REQUEST_MODES = {}
  STUB_COMMAND_REQUEST_MODES = {}
  STUB_CITY_REQUEST_MODES = {}
  STUB_PLAYER_REQUEST_MODES = {}
  STUB_REACHABLE = { 4, 1, 3, 5, 7 }
  STUB_REACHABLE_TARGETS = { 2 }
  STUB_REACHABLE_ZOC = { 5 }
  -- Own-unit order state, trade routes, production answers, optional district and queue
  -- observations: every scenario starts from "the engine records nothing and the city has no
  -- districts", so scenarios that predate these reads keep their exact meaning.
  STUB_UNIT_ACTIVITY = 0
  STUB_UNIT_OPERATION = nil
  STUB_UNIT_PENDING = nil
  STUB_UNIT_AUTOMATED = nil
  STUB_UNIT_QUEUED_DESTINATION = nil
  STUB_UNIT_TYPE = 0
  STUB_OUTGOING_ROUTES = nil
  STUB_ROUTES_BROKEN = false
  STUB_PRODUCTION_IN_PANEL = true
  STUB_PRODUCTION_AVAILABLE = true
  STUB_PRODUCTION_RESULTS = {}
  STUB_DISTRICT_TYPE = nil
  STUB_DISTRICT_PILLAGED = false
  STUB_DISTRICT_COMPLETE = true
  STUB_DISTRICT_INSTANCE_READ_FAILS = false
  STUB_RESEARCH_QUEUE = {}
  STUB_CIVIC_QUEUE = {}
  STUB_RESEARCHING_TECH = -1
  STUB_PROGRESSING_CIVIC = -1
  -- Plot 4 (1,1) -> 5 (2,1) -> 2 (2,0): two turns, one river obstacle at plot 5.
  STUB_PATH = { plots = { 4, 5, 2 }, turns = { 1, 1, 2 }, obstacles = { 5 } }
  -- Slot 0 (SLOT_MILITARY) holds POLICY_DISCIPLINE, slot 1 (SLOT_WILDCARD) holds POLICY_SURVEY.
  STUB_POLICY_SLOTS = { [0] = 0, [1] = 1 }
  -- STUB_EVENT_SUBSCRIPTIONS is deliberately NOT reset: subscriptions happen once at module
  -- load time, before any scenario is installed.
  STUB_VISIBLE = {}
  STUB_REVEALED = {}
  for y = 0, 2 do
    for x = 0, 2 do
      STUB_REVEALED[coordKey(x, y)] = true
    end
  end
  STUB_VISIBLE[coordKey(1, 1)] = true
  STUB_VISIBLE[coordKey(2, 1)] = true
  STUB_VISIBLE[coordKey(1, 2)] = true
  if name == 'fog' then
    STUB_FOREIGN_UNIT_VISIBLE = false
    STUB_VISIBLE[coordKey(2, 2)] = false
  elseif name == 'visible_foreign' then
    STUB_FOREIGN_UNIT_VISIBLE = true
    STUB_VISIBLE[coordKey(2, 2)] = true
  elseif name == 'unknown_edges' then
    STUB_VISIBLE = { [coordKey(1, 1)] = true }
  elseif name == 'partial_map' then
    STUB_BROKEN_PLOT = 4
  elseif name == 'blocked_end_turn' then
    STUB_CAN_END = false
    STUB_FIRST_BLOCKER = EndTurnBlockingTypes.ENDTURN_BLOCKING_UNITS
    STUB_BLOCKERS = { EndTurnBlockingTypes.ENDTURN_BLOCKING_UNITS }
  elseif name == 'processing' then
    STUB_PROCESSING = true
  elseif name == 'inactive' then
    STUB_ACTIVE = false
  end
end

function STUB_TRACE()
  return TRACE
end
