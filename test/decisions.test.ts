import { expect, test } from "bun:test";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";
import { parse } from "luaparse";

const paths = ["test/lua/shim.lua", "test/lua/fixture.lua", "lua/common.lua", "lua/state.lua", "lua/decisions.lua"];
const sources = await Promise.all(paths.map(path => Bun.file(path).text()));

// The existing fixture models Lua-visible objects only; it cannot simulate native access violations.
function scenario(code: string): void {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    for (const source of [...sources, `AstraCiv.session = 'test'; STUB_INSTALL('default'); AstraCiv.begin(); ${code}`]) {
      if (lauxlib.luaL_dostring(state, to_luastring(source)) !== lua.LUA_OK) {
        throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
      }
    }
  } finally {
    lua.lua_close(state);
  }
}

test("decision collectors remain valid Civ Lua 5.1", () => {
  expect(parse(sources[4]!, { luaVersion: "5.1" }).type).toBe("Chunk");
});

test("missing native managers report degradation without aborting other decision families", () => {
  scenario(`
    local A = AstraCiv
    local function absent() return nil end
    Game.GetEras, Game.GetGreatPeople, Game.GetWorldCongress, Game.GetReligion = absent, absent, absent, absent
    Players[0].GetReligion, Players[0].GetGovernors = absent, absent
    Players[0].GetCities, Players[0].GetUnits, Players[0].GetDiplomacy = absent, absent, absent
    DiplomacyManager = {HasQueuedSession=function() return false end}
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_PRODUCTION}
    local result = A.decisions({detail='full'})
    assert(result.total == 1 and result.decisions[1].kind == 'blocker')
    assert(result.decisions[1].id == 'test:decision:blocker:ENDTURN_BLOCKING_PRODUCTION')
    for group, key in pairs({commemoration='GetEras', greatPeople='GetGreatPeople', congress='GetWorldCongress',
      pantheon='GetReligion', religion='GetReligion', governors='GetGovernors', cityFate='GetCities',
      espionage='GetUnits', diplomacy='GetDiplomacy'}) do
      assert(A.diagnostics[group] and A.diagnostics[group][key], group..' lost its null-manager diagnostic')
    end
    assert(A.diagnostics.decisions == nil, 'A collector threw instead of degrading locally')
  `);
});

test("dedication choice reads wait for a positive allowance and preserve the available decision", () => {
  scenario(`
    local A, allowed, queried = AstraCiv, 0, 0
    GameConfiguration.GetStartTurn = function() return 0 end
    local eras = {
      GetPlayerNumAllowedCommemorations=function() return allowed end,
      GetPlayerCommemorateChoices=function() queried=queried+1; return {4} end,
      GetCurrentEra=function() return 2 end,
      GetPlayerActiveCommemorations=function() return {} end,
      HasGoldenAge=function() return false end, HasHeroicGoldenAge=function() return false end, HasDarkAge=function() return true end,
    }
    Game.GetEras = function() return eras end
    GameInfo.CommemorationTypes = {[4]={CommemorationType='COMMEMORATION_TEST', CategoryDescription='Dedication'}}
    assert(A.decisions({kind='commemoration'}).total == 0)
    assert(queried == 0, 'An inactive era queried the unsafe choices manager')
    allowed = 1
    local record = A.decisions({kind='commemoration', detail='full'}).decisions[1]
    assert(queried == 1 and record.id == 'test:decision:commemoration:era2')
    assert(record.operations[1] == 'choose')
    assert(record.options[1].choice == 'COMMEMORATION_TEST' and record.selectCount == 1)
  `);
});

test("congress defers meeting and favor reads until a ballot or emergency exists", () => {
  scenario(`
    local A, stage, costs, status, favor = AstraCiv, 0, 0, 0, 0
    local proposals = {empty={ProposalsOfType={}}}
    GameCapabilities = {HasCapability=function() return true end}
    GlobalParameters = {WORLD_CONGRESS_INITIAL_ERA=2}
    Game.GetEras = function() return {GetCurrentEra=function() return 2 end} end
    DB = {MakeHash=function(name) return name == 'TURNSEG_WORLDCONGRESS_1' and 1 or 2 end}
    Game.GetCurrentTurnSegment = function() return stage end
    local congress = {
      GetEmergencies=function() return {Proposals=proposals} end,
      GetProposals=function() return {Proposals=proposals} end,
      GetResolutions=function() return {} end,
      GetMeetingStatus=function() status=status+1; return {TurnsLeft=12} end,
      GetVotesandFavorCost=function() costs=costs+1; return {MaxVotes=5} end,
    }
    Game.GetWorldCongress=function() return congress end
    Players[0].GetFavor=function() favor=favor+1; return 25 end
    assert(A.decisions({kind='congress'}).total == 0)
    assert(costs == 0 and status == 0 and favor == 0)
    stage = 1
    assert(A.decisions({kind='congress'}).total == 0)
    assert(costs == 0 and status == 0 and favor == 0)
    proposals = {category={ProposalsOfType={
      b={TypeName='B', Type=2, Target=3, Sender=0, Name='Second'},
      a={TypeName='A', Type=1, Target=2, Sender=0, Name='First'},
    }}}
    stage = 0
    local emergency = A.decisions({kind='congress', detail='full'}).decisions[1]
    assert(emergency.id == 'test:decision:congress:proposals:turn10' and emergency.operation == 'proposal')
    assert(emergency.turnsToNextSession == 12 and emergency.favor == 25)
    assert(emergency.options[1].label == 'First' and emergency.options[2].choice.discussionType == 2)
    assert(costs == 0 and status == 1 and favor == 1)
    stage = 2
    local ballot = A.decisions({kind='congress', detail='full'}).decisions[1]
    assert(ballot.id == 'test:decision:congress:session:stage2:turn10' and ballot.operation == 'vote')
    assert(ballot.maxVotes == 5 and ballot.options[1].choice.target == 2)
    assert(costs == 1 and status == 1 and favor == 2)
    PlayerOperations.WORLD_CONGRESS_DISCUSSION_VOTE = 9001
    PlayerOperations.PARAM_PLAYER_ONE, PlayerOperations.PARAM_PLAYER_TWO = 'sender', 'target'
    PlayerOperations.PARAM_WORLD_CONGRESS_VOTES = 'votes'
    local result = A.decisionAction({type='congress', operation='vote', votes={{subject='discussion', sender=0, target=2, votes=1}}})
    assert(result.accepted and result.submittedCount == 1 and STUB_REQUEST_INDEX == 1)
    proposals.category.ProposalsOfType.a.Disabled = true
    local ok = pcall(A.decisionAction, {type='congress', operation='vote', votes={{subject='discussion', sender=0, target=2, votes=1}}})
    assert(not ok and STUB_REQUEST_INDEX == 1, 'Disabled ballot entry was submitted')
  `);
});

test("unappointed governors never enter promotion or assignment legality", () => {
  scenario(`
    STUB_GOVERNOR_APPOINTED = false
    local queries = 0
    local governors = Players[0]:GetGovernors()
    governors.GetGovernor = function() queries=queries+1; return nil end
    governors.CanPromoteGovernor = function() queries=queries+1; return true end
    governors.CanAssignGovernor = function() queries=queries+1; return true end
    local result = AstraCiv.decisions({kind='governor', detail='full'})
    assert(queries == 0)
    assert(result.total == 1 and result.decisions[1].operation == 'appoint')
    assert(result.decisions[1].options[1].choice == 'GOVERNOR_AMANI')
    assert(result.decisions[1].options[2].choice == 'GOVERNOR_MAGNUS')
  `);
});

test("governor assignments retain valid destinations while marking missing collections partial", () => {
  scenario(`
    local A = AstraCiv
    local complete = A.decisions({kind='governor', detail='full'}).decisions[2]
    assert(complete.id == 'test:decision:governor:assign:GOVERNOR_AMANI')
    assert(complete.candidatesPartial == false)
    assert(complete.options[1].choice == 'test:city:0:3' and complete.options[2].choice == 'test:city:2:11')
    Players[2].GetCities = function() return nil end
    A.begin()
    local partial = A.decisions({kind='governor', detail='full'}).decisions[2]
    assert(partial.candidatesPartial and #partial.options == 1 and partial.options[1].choice == 'test:city:0:3')
    assert(A.diagnostics.governors.minorCities)
    assert(A.diagnostics.decisions == nil)
    Players[0].GetCities = function() return nil end
    A.begin()
    local missing = A.decisions({kind='governor', detail='full'})
    assert(missing.total == 1 and missing.decisions[1].operation == 'appoint')
    assert(A.diagnostics.governors.GetCities)
  `);
});

test("spy escape preserves the city-centre route when districts are unavailable and missions reject missing plots", () => {
  scenario(`
    local A = AstraCiv
    local spy = Players[0]:GetUnits():FindID(7)
    local city = Players[0]:GetCities():FindID(3)
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE}
    Players[0]:GetDiplomacy().GetNextEscapingSpyID = function() return 7 end
    Cities.GetPlotPurchaseCity = function() return city end
    city.GetDistricts = function() return nil end
    GameInfo.Districts.DISTRICT_CITY_CENTER = {Index=0, Name='Centre'}
    GameInfo.Districts.DISTRICT_HARBOR = {Index=1, Name='Harbor'}
    local escape = A.decisions({kind='espionage', detail='full'}).decisions[1]
    assert(escape.id == 'test:decision:espionage:escape:7')
    assert(escape.options[1].choice == 'DISTRICT_HARBOR' and not escape.options[1].available)
    assert(escape.options[2].choice == 'DISTRICT_CITY_CENTER' and escape.options[2].available)
    assert(A.diagnostics.espionage.GetDistricts)
    STUB_BLOCKERS = {}
    GameInfo.Units[0].Spy = true
    spy.GetSpyOperation = function() return -1 end
    spy.IsReadyToMove = function() return true end
    Map.GetPlot = function() return nil end
    local queried = 0
    UnitManager.CanStartOperation = function() queried=queried+1; return true end
    A.begin()
    assert(A.decisions({kind='espionage'}).total == 0 and queried == 0)
    assert(A.diagnostics.espionage.GetPlot)
  `);
});

test("nullable city offers and absent diplomacy sessions never reach native entity methods", () => {
  scenario(`
    local cities = Players[0]:GetCities()
    cities.GetNextCapturedCity = function() return nil end
    cities.GetNextRebelledCity = function() return nil end
    local queried = 0
    CityManager.CanStartCommand = function() queried=queried+1; return true end
    DiplomacyManager = {
      HasQueuedSession=function() return false end,
      FindOpenSessionID=function() return nil end,
      GetSessionInfo=function() queried=queried+1; return {} end,
    }
    assert(AstraCiv.decisions({kind='city_fate'}).total == 0)
    assert(AstraCiv.decisions({kind='diplomacy'}).total == 0)
    assert(queried == 0)
  `);
});

test("turn transitions defer blocker bindings without suppressing between-turn congress ballots", () => {
  scenario(`
    local A, calls = AstraCiv, 0
    NotificationManager.GetAllEndTurnBlocking = function() calls=calls+1; return {} end
    NotificationManager.GetFirstEndTurnBlocking = function() calls=calls+1; return -1 end
    STUB_ACTIVE = false
    local result = A.decisions({kind='blocker'})
    assert(calls == 0 and not result.blockersKnown and result.turnState.blockers == A.null)
    STUB_ACTIVE, STUB_PROCESSING = true, true
    result = A.decisions({kind='blocker'})
    assert(calls == 0 and not result.blockersKnown)
    GameCapabilities = {HasCapability=function() return true end}
    DB = {MakeHash=function(name) return name == 'TURNSEG_WORLDCONGRESS_1' and 1 or 2 end}
    Game.GetCurrentTurnSegment = function() return 2 end
    Game.GetWorldCongress = function() return {
      GetProposals=function() return {Proposals={category={ProposalsOfType={
        {TypeName='A', Type=1, Sender=0, Target=2}
      }}}} end,
      GetVotesandFavorCost=function() return {} end,
    } end
    result = A.decisions({kind='congress', detail='full'})
    assert(calls == 0 and result.total == 1 and result.decisions[1].operation == 'vote')
    STUB_PROCESSING = false
    result = A.decisions({kind='blocker'})
    assert(calls == 2 and result.blockersKnown, 'Context and returned turn state must share one blocker observation')
  `);
});

test("dedication initialization gates precede allowance and choice getters", () => {
  scenario(`
    local A, era, start, reads = AstraCiv, 0, 0, 0
    local eras = {
      GetCurrentEra=function() return era end,
      GetPlayerNumAllowedCommemorations=function() reads=reads+1; return 2 end,
      GetPlayerCommemorateChoices=function() reads=reads+1; return {4,5} end,
      GetPlayerActiveCommemorations=function() return {} end,
    }
    Game.GetEras = function() return eras end
    GameConfiguration.GetStartTurn = function() return start end
    GameInfo.CommemorationTypes = {
      [4]={CommemorationType='A'}, [5]={CommemorationType='B'},
    }
    assert(A.decisions({kind='commemoration'}).total == 0 and reads == 0)
    era, start = 2, STUB_TURN
    assert(A.decisions({kind='commemoration'}).total == 0 and reads == 0)
    start = 0
    local record = A.decisions({kind='commemoration', detail='full'}).decisions[1]
    assert(record.selectCount == 2 and #record.options == 2 and reads == 2)
    eras.GetPlayerNumAllowedCommemorations = function() return 0 end
    local ok = pcall(A.decisionAction, {type='commemoration', commemorations={'A'}})
    assert(not ok and STUB_REQUEST_INDEX == 0 and reads == 2)
  `);
});

test("pre-era congress needs a live emergency notification and stale proposals never submit", () => {
  scenario(`
    local A, reads, dismissed = AstraCiv, 0, false
    GameCapabilities = {HasCapability=function() return true end}
    GlobalParameters = {WORLD_CONGRESS_INITIAL_ERA=2}
    Game.GetEras = function() return {GetCurrentEra=function() return 0 end} end
    DB = {MakeHash=function(name) return name == 'TURNSEG_WORLDCONGRESS_1' and 1 or 2 end}
    Game.GetCurrentTurnSegment = function() return 0 end
    local proposal = {TypeName='A', Type=1, Target=2}
    Game.GetWorldCongress = function() return {
      GetEmergencies=function() reads=reads+1; return {Proposals={category={ProposalsOfType={proposal}}}} end,
      GetMeetingStatus=function() return {} end,
    } end
    assert(A.decisions({kind='congress'}).total == 0 and reads == 0)
    NotificationTypes = {NOTIFICATION_WORLD_CONGRESS_SPECIAL_SESSION_NON_BLOCKING=42}
    A.notificationIds[0] = {[7]=true}
    NotificationManager.Find = function() return {
      IsDismissed=function() return dismissed end, GetType=function() return 42 end,
    } end
    assert(A.decisions({kind='congress'}).total == 1 and reads == 1)
    local ok = pcall(A.decisionAction, {type='congress', operation='submit'})
    assert(not ok and STUB_REQUEST_INDEX == 0)
    proposal.Disabled = true
    ok = pcall(A.decisionAction, {type='congress', operation='proposal', proposals={{target=2, discussionType=1}}})
    assert(not ok and STUB_REQUEST_INDEX == 0)
    dismissed = true
    local before = reads
    assert(A.decisions({kind='congress'}).total == 0 and reads == before)
  `);
});

test("religion founding follows earned beliefs and unknown equipped lists do not invent slots", () => {
  scenario(`
    local A, created, earned, list = AstraCiv, -1, 0, nil
    local religion = Players[0]:GetReligion()
    religion.GetPantheon = function() return 1 end
    religion.GetReligionTypeCreated = function() return created end
    religion.GetNumBeliefsEarned = function() return earned end
    religion.HasReligiousFoundingUnit = function() return earned == 0 end
    local available = false
    local gameReligion = {
      HasBeenFounded=function() return available end,
      IsInSomePantheon=function() return false end,
      IsInSomeReligion=function() return false end,
      IsTooManyForReligion=function() return false end,
      GetReligions=function() return list end,
    }
    Game.GetReligion = function() return gameReligion end
    GameInfo.Religions = function() return coroutine.wrap(function()
      coroutine.yield({Index=1, ReligionType='RELIGION_TEST', Pantheon=false})
    end) end
    GameInfo.Beliefs = function() return coroutine.wrap(function()
      coroutine.yield({Index=2, BeliefType='BELIEF_TEST', BeliefClassType='BELIEF_CLASS_FOLLOWER'})
    end) end
    assert(A.decisions({kind='religion'}).total == 0)
    earned = 2
    local result = A.decisions({kind='religion'})
    assert(result.total == 1 and result.decisions[1].operation == 'found')
    available = nil
    A.begin()
    assert(A.decisions({kind='religion'}).total == 0 and A.diagnostics.religion.HasBeenFounded)
    created = 1
    A.begin()
    assert(A.decisions({kind='religion'}).total == 0 and A.diagnostics.religion.GetReligions)
    list = {{Founder=0}}
    A.begin()
    assert(A.decisions({kind='religion'}).total == 0 and A.diagnostics.religion.Beliefs)
    list[1].Beliefs = {2}
    result = A.decisions({kind='religion', detail='full'})
    assert(result.total == 1 and result.decisions[1].operation == 'belief' and result.decisions[1].selectCount == 1)
  `);
});

test("unknown spy readiness and failed city legality are reported rather than offered", () => {
  scenario(`
    local A, reads = AstraCiv, 0
    local spy = Players[0]:GetUnits():FindID(7)
    GameInfo.Units[0].Spy = true
    spy.GetSpyOperation = function() return -1 end
    spy.IsReadyToMove = function() return nil end
    Cities.GetPlotPurchaseCity = function() reads=reads+1; return nil end
    assert(A.decisions({kind='espionage'}).total == 0 and reads == 0)
    assert(A.diagnostics.espionage.IsReadyToMove)
    local cities = Players[0]:GetCities()
    cities.GetNextCapturedCity = function() return cities:FindID(3) end
    CityDestroyDirectives = {KEEP=1}
    UnitOperationTypes.PARAM_FLAGS = 'flags'
    CityCommandTypes.DESTROY = 9002
    CityManager.CanStartCommand = function() error('native legality unavailable') end
    A.begin()
    assert(A.decisions({kind='city_fate'}).total == 0 and A.diagnostics.cityFate.CanStartCommand)
  `);
});

test("escape getter waits for the native escape blocker and stale choices never reach it", () => {
  scenario(`
    local A, reads = AstraCiv, 0
    local city = Players[0]:GetCities():FindID(3)
    Players[0]:GetDiplomacy().GetNextEscapingSpyID = function() reads=reads+1; return 7 end
    Cities.GetPlotPurchaseCity = function() return city end
    GameInfo.Districts.DISTRICT_CITY_CENTER = {Index=0, Name='Centre'}
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_PRODUCTION}
    local result = A.decisions({})
    assert(reads == 0, 'Default observation queried the native escaping-spy getter without an escape choice')
    local production = false
    for _, record in ipairs(result.decisions) do
      if record.kind == 'blocker' and record.blockerType == 'ENDTURN_BLOCKING_PRODUCTION' then production = true end
    end
    assert(production, 'Guard suppressed unrelated decisions')
    STUB_ACTIVE = false
    A.begin()
    A.decisions({kind='espionage'})
    assert(reads == 0 and A.diagnostics.espionage.escapeReadiness)
    STUB_ACTIVE = true
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE}
    local record = A.decisions({kind='espionage', detail='full'}).decisions[1]
    assert(reads == 1 and record.operation == 'escape' and record.options[1].available)
    STUB_BLOCKERS = {}
    local answer = A.decide({id=record.id, choice='DISTRICT_CITY_CENTER'})
    assert(answer.status == 'stale' and not answer.accepted and reads == 1 and STUB_REQUEST_INDEX == 0)
    PlayerOperations.SET_ESCAPE_ROUTE, PlayerOperations.PARAM_DISTRICT_TYPE = 9003, 'district'
    local ok = pcall(A.decisionAction, {type='espionage', operation='escape', unitId=record.unitId, district='DISTRICT_CITY_CENTER'})
    assert(not ok and STUB_REQUEST_INDEX == 0, 'Direct escape action bypassed the pending-choice gate')
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE}
    answer = A.decisionAction({type='espionage', operation='escape', unitId=record.unitId, district='DISTRICT_CITY_CENTER'})
    assert(answer.accepted and answer.submittedCount == 1 and STUB_REQUEST_INDEX == 1)
  `);
});
