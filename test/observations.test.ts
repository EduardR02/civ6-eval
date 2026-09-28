import { expect, test } from "bun:test";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";
import { parse } from "luaparse";

// state.lua owns player-observable records. These cases pin the facts a wrong implementation would
// get wrong silently: a stale id must never be read as the requested entity, native queued work must
// be annotated beside the blocker candidates instead of silently deciding they need no order,
// production availability must carry the engine's own reasons, district repair state must survive a
// failed per-instance read, and the research/civic queues must report native nodes or an explicit
// unknown rather than an invented list.
//
// Everything here runs the real modules through the Fengari VM with test/lua/fixture.lua's native
// objects; the fixture cannot model native access rules or engine rules, so a pass proves which
// calls were made and how the answer was shaped, not what a live engine would answer.
const paths = ["test/lua/shim.lua", "test/lua/fixture.lua", "lua/common.lua", "lua/state.lua"];
const sources = await Promise.all(paths.map(path => Bun.file(path).text()));

function run(code: string): string {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    for (const source of [...sources, `AstraCiv.session = 'test'; STUB_INSTALL('default'); AstraCiv.begin(); ${code}`]) {
      if (lauxlib.luaL_dostring(state, to_luastring(source)) !== lua.LUA_OK) {
        throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
      }
    }
    if (lauxlib.luaL_dostring(state, to_luastring("return STUB_DRAIN()")) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
    }
    return to_jsstring(lua.lua_tostring(state, -1));
  } finally {
    lua.lua_close(state);
  }
}

/** Reassemble one A.emit() envelope exactly the way src/bridge.ts collect() does. */
function envelope(marker: string, printed: string): { result: Record<string, unknown>; unavailable: Record<string, unknown> } {
  const parts: { index: number; text: string }[] = [];
  let count = 0;
  for (const line of printed.split("\n")) {
    const match = new RegExp(`^${marker}:(\\d+):(\\d+):([0-9a-f]*)$`).exec(line);
    if (!match) continue;
    count = Number(match[2]);
    parts.push({ index: Number(match[1]), text: Buffer.from(match[3]!, "hex").toString("utf8") });
  }
  expect(parts).toHaveLength(count);
  expect(new Set(parts.map(part => part.index)).size).toBe(count);
  parts.sort((left, right) => left.index - right.index);
  const frame = JSON.parse(parts.map(part => part.text).join("")) as
    { ok: boolean; result: Record<string, unknown>; unavailable: Record<string, unknown> };
  expect(frame.ok).toBe(true);
  return { result: frame.result, unavailable: frame.unavailable };
}

test("the observation module remains valid Civ Lua 5.1", () => {
  expect(parse(sources[3]!, { luaVersion: "5.1" }).type).toBe("Chunk");
});

test("a stale id that resolves to a different live entity is refused, not read as that entity", () => {
  run(`
    local A = AstraCiv
    local units = Players[0]:GetUnits()
    local unit = units:FindID(7)
    -- The engine answered a stale id with a different live entity whose id shares its low 16 bits.
    -- This collection reproduces that resolution without claiming the engine's mechanism: any id in
    -- unit 7's slot resolves to unit 7.
    local aliasing = { FindID = function(_, id)
      if type(id) == 'number' and id % 65536 == 7 then return unit end
      return nil
    end }
    Players[0].GetUnits = function() return aliasing end
    local stale = A.inspect({id='test:unit:0:65543'})
    assert(stale.status == 'not_observed' and stale.record == A.null, 'A stale id must not return a live record')
    assert(tostring(stale.reason):find('stale', 1, true), tostring(stale.reason))
    assert(stale.identity.id == 'test:unit:0:65543' and stale.identity.engineId == 65543)
    -- The real id still resolves.
    local live = A.inspect({id='test:unit:0:7'})
    assert(live.status == 'observed' and live.record.id == 'test:unit:0:7' and live.record.engineId == 7)
    -- Cities resolve through the same authority and get the same comparison.
    local city = Players[0]:GetCities():FindID(3)
    Players[0].GetCities = function() return { FindID = function() return city end } end
    local wrongCity = A.inspect({id='test:city:0:65539'})
    assert(wrongCity.status == 'not_observed' and wrongCity.record == A.null)
    assert(tostring(wrongCity.reason):find('stale', 1, true), tostring(wrongCity.reason))
  `);
});

test("an identity that cannot be read is refused rather than read as the requested entity", () => {
  run(`
    local A = AstraCiv
    local unit = Players[0]:GetUnits():FindID(7)
    Players[0].GetUnits = function() return { FindID = function() return unit end } end
    local realGetID = unit.GetID
    unit.GetID = function() error('fixture identity read failed') end
    local result = A.inspect({id='test:unit:0:7'})
    unit.GetID = realGetID
    assert(result.status == 'not_observed' and result.record == A.null, 'An unverified identity is never read')
    assert(tostring(result.reason):find('stale', 1, true), tostring(result.reason))
    assert(A.diagnostics.identity ~= nil, 'A failed identity read must stay visible in diagnostics')
  `);
});

test("queued native work is annotated on the blockers that already carry it", () => {
  run(`
    local A = AstraCiv
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_UNITS}
    STUB_FIRST_BLOCKER = EndTurnBlockingTypes.ENDTURN_BLOCKING_UNITS
    local idle = A.snapshot({include={'units'}})
    local blocker = idle.turnState.blockers[1]
    assert(#blocker.units == 1 and blocker.units[1] == idle.units[1].id)
    assert(blocker.unitsWithQueuedWork == nil)
    assert(idle.units[1].order.pending == false and idle.units[1].order.operation == nil)
    assert(idle.units[1].order.destination == nil and idle.units[1].trade == A.null)

    -- The same unit mid-order: the engine records a pending operation and a queued destination.
    STUB_UNIT_PENDING = true
    STUB_UNIT_OPERATION = UnitOperationTypes.MOVE_TO
    STUB_UNIT_QUEUED_DESTINATION = 2
    local queued = A.snapshot({include={'units'}})
    local unit = queued.units[1]
    assert(unit.order.pending == true and unit.order.operation == 'MOVE_TO')
    assert(unit.order.destination.plotId == 2 and unit.order.destination.x == 2 and unit.order.destination.y == 0)
    assert(unit.order.pathTurns == nil, 'A unit list does not compute paths')
    -- The candidate list is unchanged: a queued order can be interrupted or stuck.
    local blockered = queued.turnState.blockers[1]
    assert(#blockered.units == 1 and blockered.units[1] == unit.id)
    assert(#blockered.unitsWithQueuedWork == 1 and blockered.unitsWithQueuedWork[1].id == unit.id)
    assert(tostring(blockered.unitsWithQueuedWork[1].reason):find('queued destination', 1, true), blockered.unitsWithQueuedWork[1].reason)
    -- The native ready signal is not an exact end-turn blocker verdict.
    assert(unit.ready == true and unit.activity == 'ACTIVITY_AWAKE')
  `);
});

test("resting units stay out of order candidates until native readiness wakes them", () => {
  run(`
    local A = AstraCiv
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_UNIT_NEEDS_ORDERS}
    STUB_FIRST_BLOCKER = EndTurnBlockingTypes.ENDTURN_BLOCKING_UNIT_NEEDS_ORDERS
    STUB_UNIT_ACTIVITY = ActivityTypes.ACTIVITY_AWAKE
    local nativeUnit = Players[0]:GetUnits():FindID(7)
    nativeUnit.GetMovesRemaining = function() return 2 end
    nativeUnit.GetMaxMoves = function() return 2 end
    nativeUnit.GetFortifyTurns = function() return 1 end
    local observation = A.snapshot({include={'units'}})
    local unit = observation.units[1]
    assert(unit.activity == 'ACTIVITY_AWAKE' and unit.moves == 2 and unit.maxMoves == 2)
    assert(unit.fortifyTurns == 1)
    assert(unit.ready == true, 'A woken native-ready unit can retain positive fortify turns')
    local blocker = observation.turnState.blockers[1]
    assert(#blocker.units == 1 and blocker.units[1] == unit.id,
      'The blocker candidate list must retain the native-ready unit')
    STUB_UNIT_ACTIVITY = ActivityTypes.ACTIVITY_SLEEP
    local sleeping = A.snapshot({include={'units'}})
    assert(sleeping.units[1].ready == false and #sleeping.turnState.blockers[1].units == 0,
      'Sleeping units must not recur in order candidates')
    STUB_UNIT_ACTIVITY = ActivityTypes.ACTIVITY_AWAKE
    nativeUnit.IsReadyToMove = function() return false end
    local resting = A.snapshot({include={'units'}})
    assert(resting.units[1].ready == false and #resting.turnState.blockers[1].units == 0,
      'An awake-looking fortified unit that native readiness excludes must not recur')
    nativeUnit.IsReadyToMove = function() return true end
    local woken = A.snapshot({include={'units'}})
    assert(woken.units[1].ready == true and woken.turnState.blockers[1].units[1] == unit.id)
  `);
});

test("unavailable native readiness stays unknown, not a false ready candidate", () => {
  run(`
    local A = AstraCiv
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_UNIT_NEEDS_ORDERS}
    UnitManager.GetActivityType = function() error('fixture activity read failed') end
    local observation = A.snapshot({include={'units'}})
    local unit = observation.units[1]
    assert(unit.ready == A.null, 'An unavailable activity read is unknown, not not-ready')
    assert(observation.turnState.blockers[1].units == A.null,
      'An unreadable readiness check must not fabricate a ready candidate or a definitive empty list')
    UnitManager.GetActivityType = function() return ActivityTypes.ACTIVITY_AWAKE end
    Players[0]:GetUnits():FindID(7).IsReadyToMove = function() error('fixture ready read failed') end
    local unknown = A.snapshot({include={'units'}})
    assert(unknown.units[1].ready == A.null and unknown.turnState.blockers[1].units == A.null,
      'An unreadable native IsReadyToMove result cannot create a ready candidate')
  `);
});

test("trader readiness distinguishes an active route from an unreadable route list", () => {
  run(`
    local A = AstraCiv
    STUB_UNIT_TYPE = 1
    STUB_OUTGOING_ROUTES = {{OriginCityPlayer=0,OriginCityID=3,DestinationCityPlayer=2,DestinationCityID=11,TraderUnitID=7}}
    local trader = A.snapshot({include={'units'}}).units[1]
    assert(trader.trade.trader == true)
    assert(trader.trade.activeRoute.originCityId == 'test:city:0:3')
    assert(trader.trade.activeRoute.destinationCityId == 'test:city:2:11')
    assert(trader.trade.readyForRoute == true)

    -- Busy: ACTIVITY_OPERATION with the queued move still recorded, so it is not an idle trader.
    STUB_UNIT_ACTIVITY = ActivityTypes.ACTIVITY_OPERATION
    STUB_UNIT_QUEUED_DESTINATION = 2
    local busy = A.snapshot({include={'units'}}).units[1]
    assert(busy.activity == 'ACTIVITY_OPERATION' and busy.trade.readyForRoute == false)
    assert(busy.order.destination.plotId == 2)

    -- An unreadable route list is unknown. It must not read as "this trader has no route".
    STUB_OUTGOING_ROUTES = nil
    STUB_ROUTES_BROKEN = true
    local unknown = A.snapshot({include={'units'}}).units[1]
    assert(unknown.trade.activeRoute == A.null)
    assert(type(unknown.trade.routeUnknown) == 'string', 'An unreadable route list is reported, not assumed empty')
  `);
});

test("production options carry native availability, reasons and the repair flag", () => {
  run(`
    local A = AstraCiv
    local kinds = {}
    for _, option in ipairs(A.snapshot({include={'cities'}}).cities[1].production.options) do
      kinds[option.kind] = true
      assert(option.available == true, option.type)
      assert(option.details == nil, 'A startable item needs no failure detail')
    end
    assert(kinds.unit and kinds.building and kinds.district and kinds.project, 'Every production kind is listed')

    -- Displayed but not startable: the engine's own reasons travel with it instead of vanishing.
    STUB_PRODUCTION_AVAILABLE = false
    STUB_PRODUCTION_RESULTS = {[CityCommandResults.FAILURE_REASONS] = {'LOC_TEST_NEEDS_POPULATION'}}
    for _, option in ipairs(A.snapshot({include={'cities'}}).cities[1].production.options) do
      assert(option.available == false, option.type)
      assert(option.details.reasons[1] == 'LOC_TEST_NEEDS_POPULATION', option.type)
    end

    -- The panel-visibility filter still hides what the native panel hides.
    STUB_PRODUCTION_IN_PANEL = false
    assert(#A.snapshot({include={'cities'}}).cities[1].production.options == 0)
  `);
});

test("district repair state survives a failed per-instance read and is never faked", () => {
  run(`
    local A = AstraCiv
    STUB_DISTRICT_TYPE = 0
    STUB_DISTRICT_PILLAGED = true
    local city = A.snapshot({include={'cities'}}).cities[1]
    local district = city.districts[1]
    assert(district.type == 'DISTRICT_CAMPUS' and district.pillaged == true and district.complete == true)
    local districtOption
    for _, option in ipairs(city.production.options) do
      if option.kind == 'district' then districtOption = option end
      if option.kind == 'building' then assert(option.repair == false, 'Only the pillaged item is a repair') end
    end
    assert(districtOption ~= nil and districtOption.repair == true and districtOption.type == 'DISTRICT_CAMPUS')

    -- district:IsPillaged() unavailable: the city collection answers (CitySupport.lua:665).
    STUB_DISTRICT_INSTANCE_READ_FAILS = true
    local fallback = A.snapshot({include={'cities'}}).cities[1].districts[1]
    assert(fallback.pillaged == true, 'The collection read covers the failed instance read')

    -- Both reads unavailable: unknown, never reported as "not pillaged".
    Players[0]:GetCities():FindID(3):GetDistricts().IsPillaged = function() error('native pillage read unavailable') end
    local unknown = A.snapshot({include={'cities'}}).cities[1].districts[1]
    assert(unknown.pillaged == A.null, 'An unreadable repair state is unknown, not false')
    assert(A.diagnostics.cityDistricts ~= nil)
  `);
});

test("the research and civic queues report native nodes or stay explicitly unknown", () => {
  run(`
    local A = AstraCiv
    STUB_RESEARCH_QUEUE = {[1] = 0}
    STUB_RESEARCHING_TECH = 0
    STUB_PROGRESSING_CIVIC = 0
    local observed = A.snapshot({include={'research','culture'}})
    assert(observed.research.queue.known == true and observed.research.queue.current == 'TECH_POTTERY')
    assert(observed.research.queue.items[1].type == 'TECH_POTTERY' and observed.research.queue.items[1].index == 1)
    assert(observed.culture.queue.known == true and observed.culture.queue.current == 'CIVIC_CODE_OF_LAWS')

    -- A failed native queue read is unknown with a reason and no invented nodes, never empty.
    Players[0]:GetTechs().GetResearchQueue = function() error('native queue read unavailable') end
    local failed = A.snapshot({include={'research'}}).research.queue
    assert(failed.known == false and #failed.items == 0 and type(failed.reason) == 'string', tostring(failed.reason))
  `);
});

test("inspect keeps the fog boundaries that the identity gate sits in front of", () => {
  run(`
    local A = AstraCiv
    local hidden = A.inspect({id='test:unit:1:9'})
    assert(hidden.status == 'not_observed' and hidden.record == A.null)
    assert(tostring(hidden.reason):find('not currently visible', 1, true), tostring(hidden.reason))
    -- Tile 8 is (2,2): never revealed, then revealed but out of sight.
    STUB_REVEALED['2,2'] = nil
    STUB_VISIBLE['2,2'] = nil
    local unrevealed = A.inspect({id='test:tile:8'})
    assert(unrevealed.status == 'not_observed' and unrevealed.record == A.null)
    assert(tostring(unrevealed.reason):find('never been revealed', 1, true), tostring(unrevealed.reason))
    STUB_REVEALED['2,2'] = true
    local remembered = A.inspect({id='test:tile:8'})
    assert(remembered.status == 'observed' and remembered.record.visibility == 'revealed_not_visible')
    assert(remembered.record.lastSeenTurn == A.null)
  `);
});

test("smoke: a busy trader, a pillaged district and a locked item survive the emitted JSON envelope", () => {
  const printed = run(`
    local A = AstraCiv
    STUB_UNIT_TYPE = 1
    -- Awake with a queued destination and a pending operation: queued work that must stay visible on
    -- the unit without pretending the unit needs no orders.
    STUB_UNIT_ACTIVITY = ActivityTypes.ACTIVITY_AWAKE
    STUB_UNIT_PENDING = true
    STUB_UNIT_OPERATION = UnitOperationTypes.MOVE_TO
    STUB_UNIT_QUEUED_DESTINATION = 2
    STUB_OUTGOING_ROUTES = {{OriginCityPlayer=0,OriginCityID=3,DestinationCityPlayer=2,DestinationCityID=11,TraderUnitID=7}}
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_UNITS}
    STUB_FIRST_BLOCKER = EndTurnBlockingTypes.ENDTURN_BLOCKING_UNITS
    STUB_DISTRICT_TYPE = 0
    STUB_DISTRICT_PILLAGED = true
    STUB_PRODUCTION_AVAILABLE = false
    STUB_PRODUCTION_RESULTS = {[CityCommandResults.FAILURE_REASONS] = {'LOC_TEST_NEEDS_POPULATION'}}
    Players[0]:GetTechs().GetResearchQueue = function() error('native queue read unavailable') end
    A.emit('SMOKE', function() return A.snapshot({include={'units','cities','research'}}) end)
  `);
  const snapshot = envelope("SMOKE", printed).result;
  const unit = (snapshot.units as Record<string, unknown>[])[0]!;
  const order = unit.order as Record<string, unknown>;
  expect(order.pending).toBe(true);
  expect(order.operation).toBe("MOVE_TO");
  expect(order.destination).toEqual({ plotId: 2, x: 2, y: 0 });
  expect(order).not.toHaveProperty("pathTurns");
  const trade = unit.trade as Record<string, unknown>;
  expect(trade.trader).toBe(true);
  expect((trade.activeRoute as Record<string, unknown>).originCityId).toBe("test:city:0:3");

  const blocker = ((snapshot.turnState as Record<string, unknown>).blockers as Record<string, unknown>[])[0]!;
  expect(blocker.units).toEqual([unit.id]);
  const withWork = blocker.unitsWithQueuedWork as { id: string; reason: string }[];
  expect(unit.id).toBe(withWork[0]!.id);
  expect(withWork[0]!.reason).toContain("queued destination");

  const city = (snapshot.cities as Record<string, unknown>[])[0]!;
  expect(((city.districts as Record<string, unknown>[])[0]!).pillaged).toBe(true);
  const options = (city.production as Record<string, unknown>).options as Record<string, unknown>[];
  expect(options.length).toBeGreaterThan(0);
  for (const option of options) {
    expect(option.available).toBe(false);
    expect((option.details as Record<string, unknown>).reasons).toEqual(["LOC_TEST_NEEDS_POPULATION"]);
  }
  expect(options.find(option => option.kind === "district")!.repair).toBe(true);
  expect(options.find(option => option.kind === "building")!.repair).toBe(false);

  const queue = (snapshot.research as Record<string, unknown>).queue as Record<string, unknown>;
  expect(queue.known).toBe(false);
  expect(queue.items).toEqual([]);
  expect(queue.reason).toBeString();
});
