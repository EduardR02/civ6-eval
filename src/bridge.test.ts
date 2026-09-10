import { afterEach, expect, test } from "bun:test";
import { BRIDGE_METHODS, CivBridge } from "./bridge.ts";
import type { Arguments } from "./contracts.ts";

const bridges: CivBridge[] = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.close(); });

const GAME = "11111111-2222-3333-4444-555555555555";
interface Internals {
  ensureConnected: () => Promise<void>;
  refreshStates: () => Promise<void>;
  states: Map<number, string>;
  invoke: (method: string, args: Arguments) => Promise<{ ok: boolean; result?: unknown; unavailable?: Record<string, unknown> }>;
}

/** A bridge whose only fake is the Lua call itself: validation, merge and probe assembly stay real. */
function fakeBridge(reply: (method: string, args: Arguments) => unknown) {
  const bridge = new CivBridge();
  bridges.push(bridge);
  const calls: { method: string; args: Arguments }[] = [];
  const internals = bridge as unknown as Internals;
  internals.ensureConnected = async () => {};
  internals.refreshStates = async () => {};
  internals.states = new Map([[0, "InGame"], [1, "GameCore_Tuner"]]);
  internals.invoke = async (method, args) => { calls.push({ method, args }); return { ok: true, result: reply(method, args) }; };
  return { bridge, calls };
}

function record(id: string, own: boolean, extra: Record<string, unknown> = {}) {
  return { id, own, visibility: "visible", lastSeenTurn: 5, ...extra };
}
function snapshot(turn: number, sections: string[], units: unknown[] = [], cities: unknown[] = [], tiles: unknown[] = []) {
  return { gameId: GAME, playerId: 0, turn, sections, units, cities, map: { width: 4, height: 4, offset: 0, more: false, tiles } };
}
const ALL = ["core", "units", "cities", "map", "notifications"];

test("the method allowlist stays closed and names what is reachable", async () => {
  const { bridge, calls } = fakeBridge(() => ({ turn: 1 }));
  for (const method of ["lua.eval", "civ.lua", "sql", "civ.rules.raw", "civ.Snapshot", "civ.", "history.note"]) {
    await expect(bridge.request(method)).rejects.toThrow("no arbitrary Lua or SQL RPC exists");
  }
  expect(calls).toHaveLength(0);
  expect([...BRIDGE_METHODS]).toEqual(["civ.probe", "civ.snapshot", "civ.inspect", "civ.options", "civ.path",
    "civ.decisions", "civ.decide", "civ.action", "civ.rules", "civ.keybinds", "civ.dismiss_notifications"]);
});

test("arguments are bounded before anything is connected or submitted", async () => {
  let connected = false;
  const { bridge, calls } = fakeBridge(() => ({}));
  (bridge as unknown as Internals).ensureConnected = async () => { connected = true; };
  const rejections: [string, Arguments, string][] = [
    ["civ.snapshot", { include: ["core", "monuments"] }, 'Unknown snapshot section "monuments"'],
    ["civ.snapshot", { region: { x: 3, y: 3, radius: 900 } }, "region.radius"],
    ["civ.snapshot", { region: "elsewhere" }, "region must be one of"],
    ["civ.snapshot", { mapLimit: 0 }, "mapLimit"],
    ["civ.snapshot", { edges: "yes" }, "edges must be a boolean"],
    ["civ.action", { actions: Array.from({ length: 65 }, () => ({ type: "move" })) }, "at most 64 actions"],
    ["civ.action", { actions: [{ type: "end_turn" }, { type: "move" }] }, "end_turn may only appear as the last action"],
    ["civ.action", { type: "move", actions: [{ type: "move" }] }, "not both"],
    ["civ.action", { actions: [] }, "nonempty array"],
    ["civ.action", {}, "requires type="],
    ["civ.path", { x: 1, y: 2 }, "unitId"],
    ["civ.decide", {}, "id must be a nonempty identifier"],
    ["civ.options", { unitId: "a", cityId: "b" }, "unitId, cityId, or neither"],
    ["civ.inspect", {}, "requires a game-qualified id or integer x/y"],
    ["civ.rules", { where: { Cost: null } }, "scalar strings, numbers or booleans"],
  ];
  for (const [method, args, expected] of rejections) await expect(bridge.request(method, args)).rejects.toThrow(expected);
  expect(connected).toBe(false);
  expect(calls).toHaveLength(0);
});

test("a sectioned snapshot never resurrects collections it did not include", async () => {
  const mine = record(`${GAME}:unit:0:1`, true);
  const enemy = record(`${GAME}:unit:3:196608`, false);
  const theirs = record(`${GAME}:city:3:7`, false);
  let stage = 0;
  const { bridge } = fakeBridge(method => {
    expect(method).toBe("snapshot");
    if (stage === 0) return snapshot(5, ALL, [{ ...mine }, { ...enemy }], [{ ...theirs }]);
    if (stage === 1) return snapshot(6, ["core"]);
    if (stage === 2) return snapshot(6, ["core", "units"], [{ ...mine }]);
    return snapshot(7, ALL, [{ ...mine }]);
  });
  const first = await bridge.request("civ.snapshot", { include: ["all"] }) as { units: unknown[]; cities: unknown[]; sections: string[] };
  expect(first.units).toHaveLength(2);
  expect(first.cities).toHaveLength(1);

  stage = 1;
  const core = await bridge.request("civ.snapshot", { include: ["core"] }) as { units: unknown[]; cities: unknown[]; knowledge: Record<string, string> };
  expect(core.units).toEqual([]);
  expect(core.cities).toEqual([]);
  expect(core.knowledge.sections).toContain("Included: core");

  stage = 2;
  const scoped = await bridge.request("civ.snapshot", { include: ["core", "units"], region: { x: 1, y: 1, radius: 2 } }) as { units: { id: string }[]; cities: unknown[]; knowledge: Record<string, string> };
  expect(scoped.units.map(unit => unit.id)).toEqual([mine.id]);
  expect(scoped.cities).toEqual([]);
  // Assert the invariant, not the prose: a partial response must never let absence read as removal.
  expect(scoped.knowledge.absence).toContain("not gone");

  // The knowledge itself was never lost: a complete snapshot still reports the unobserved records stale.
  stage = 3;
  const complete = await bridge.request("civ.snapshot", { include: ["all"] }) as { units: { id: string; visibility: string }[]; cities: { id: string; visibility: string }[] };
  expect(complete.units.map(unit => unit.id).sort()).toEqual([mine.id, enemy.id].sort());
  expect(complete.units.find(unit => unit.id === enemy.id)!.visibility).toBe("stale");
  expect(complete.cities.map(city => city.id)).toEqual([theirs.id]);
  expect(complete.cities[0]!.visibility).toBe("stale");
});

test("a snapshot response without a sections list keeps whole-collection behaviour", async () => {
  const enemy = record(`${GAME}:unit:3:196608`, false);
  let stage = 0;
  const { bridge } = fakeBridge(() => {
    const value = stage === 0 ? snapshot(5, [], [{ ...enemy }]) : snapshot(6, []);
    delete (value as { sections?: unknown }).sections;
    return value;
  });
  await bridge.request("civ.snapshot");
  stage = 1;
  const second = await bridge.request("civ.snapshot") as { sections: string[]; units: { id: string; visibility: string }[] };
  expect(second.sections).toContain("map");
  expect(second.units[0]!.visibility).toBe("stale");
});

test("inspect is a single-record lookup that keeps last-known semantics", async () => {
  const tileId = `${GAME}:tile:5`;
  const { bridge, calls } = fakeBridge((method, args) => {
    if (method === "snapshot") return snapshot(8, ALL, [], [], [{ id: tileId, own: false, visibility: "visible", lastSeenTurn: 8, x: 1, y: 1, terrain: "TERRAIN_GRASS" }]);
    if (method === "inspect") {
      if (args.id === "missing") return { gameId: GAME, turn: 9, kind: "unit", record: null };
      return { gameId: GAME, turn: 9, kind: "tile", record: { id: tileId, own: false, visibility: "revealed_not_visible", x: 1, y: 1 } };
    }
    throw new Error(`unexpected ${method}`);
  });
  await bridge.request("civ.snapshot", { include: ["all"] });
  const found = await bridge.request("civ.inspect", { x: 1, y: 1 }) as { kind: string; turn: number; record: Record<string, unknown> };
  expect(calls.map(call => call.method)).toEqual(["snapshot", "inspect"]);
  expect(found.kind).toBe("tile");
  expect(found.turn).toBe(9);
  expect(found.record.visibility).toBe("stale");
  expect(found.record.terrain).toBe("TERRAIN_GRASS");
  expect(found.record.staleReason).toContain("last-known");

  const missing = await bridge.request("civ.inspect", { id: "missing" }) as { record: unknown; unavailable: Record<string, string> };
  expect(missing.record).toBeNull();
  expect(missing.unavailable.record).toContain("Not observed by this player");
  expect(calls.filter(call => call.method === "snapshot")).toHaveLength(1);
});

test("probe publishes the runtime catalog and never a hand-written action table", async () => {
  let generator = true;
  const { bridge } = fakeBridge(method => {
    if (method === "turnState") return { turn: 3, active: true };
    if (method === "capabilities") {
      if (!generator) throw new Error("decisions module not loaded");
      return { actions: { move: { unitId: "id", x: "integer", y: "integer" } }, operations: ["MOVE_TO", "FORTIFY"] };
    }
    throw new Error(`unexpected ${method}`);
  });
  const probe = await bridge.request("civ.probe") as Record<string, unknown>;
  expect(probe.actions).toEqual({ move: { unitId: "id", x: "integer", y: "integer" } });
  expect(typeof probe.contexts).toBe("string");
  expect((probe.methods as Record<string, string>)["civ.decisions"]).toContain("pending");
  const verbose = await bridge.request("civ.probe", { verbose: true }) as Record<string, unknown>;
  expect(verbose.contexts).toEqual([{ index: 0, name: "InGame" }, { index: 1, name: "GameCore_Tuner" }]);

  generator = false;
  const degraded = await bridge.request("civ.probe") as Record<string, unknown>;
  expect(degraded.actions).toBeUndefined();
  expect(String((degraded.unavailable as Record<string, string>).capabilities)).toContain("Runtime action catalog unavailable");
  // The old probe advertised operations the Lua always rejected; nothing may substitute for the generator.
  for (const invented of ["HEAL", "SLEEP", "SKIP_TURN", "unit_operation"]) expect(JSON.stringify(degraded)).not.toContain(invented);
});

test("decisions and mutations keep their envelopes and are never replayed", async () => {
  const { bridge } = fakeBridge((method, args) => {
    if (method === "decisions") return [{ id: "popup:EraCompletePopup", kind: "popup", blocking: true }];
    if (method === "decide") return { accepted: true, completed: false, status: "submitted", id: args.id };
    throw new Error("acknowledgement lost");
  });
  const pending = await bridge.request("civ.decisions") as { decisions: { id: string }[] };
  expect(pending.decisions[0]!.id).toBe("popup:EraCompletePopup");
  const decided = await bridge.request("civ.decide", { id: "popup:EraCompletePopup" }) as { completed: boolean };
  expect(decided.completed).toBe(false);
  await expect(bridge.request("civ.action", { actions: [{ type: "move" }, { type: "end_turn" }] }))
    .rejects.toThrow("It was NOT replayed");
});

test("accumulated knowledge survives a restart that only ever saw regional pages", async () => {
  const distant = record(`${GAME}:tile:99`, false, { x: 3, y: 3, terrain: "TERRAIN_TUNDRA" });
  const near = record(`${GAME}:tile:5`, false, { x: 1, y: 1, terrain: "TERRAIN_GRASS" });
  let stage = 0;
  const { bridge } = fakeBridge(() => stage === 0
    ? snapshot(5, ALL, [], [], [distant, near])
    : snapshot(6, ["core", "map"], [], [], [near]));

  await bridge.request("civ.snapshot", { include: ["all"] });
  stage = 1;
  // A later regional page sees only the near tile; the distant one was simply not queried.
  const paged = await bridge.request("civ.snapshot", { include: ["core", "map"], region: { x: 1, y: 1, radius: 1 } }) as { map: { tiles: { id: string }[] } };
  expect(paged.map.tiles.map(tile => tile.id)).toEqual([near.id]);

  // Recovery memory is the union of everything observed, not the last capture.
  const archive = bridge.exportKnowledge();
  expect(archive).not.toBeNull();
  expect(archive!.records.tiles.map(tile => tile.id).sort()).toEqual([near.id, distant.id].sort());

  const restarted = new CivBridge();
  bridges.push(restarted);
  restarted.restoreKnowledge(archive);
  expect(restarted.exportKnowledge()!.records.tiles.map(tile => tile.id).sort()).toEqual([near.id, distant.id].sort());
});
