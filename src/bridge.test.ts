import { afterEach, expect, test } from "bun:test";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";
import { BRIDGE_METHODS, CivBridge } from "./bridge.ts";
import { dismissPopup, observePopups, popupCatalog, type PopupContent, type PopupObservation, type PopupInvoker } from "./bridge/popups.ts";
import type { Arguments } from "./contracts.ts";

const bridges: CivBridge[] = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.close(); });

const GAME = "11111111-2222-3333-4444-555555555555";
const IN_GAME = 146;
interface Internals {
  ensureConnected: () => Promise<void>;
  refreshStates: () => Promise<void>;
  states: Map<number, string>;
  transport: FakeTuner;
  invoke: (method: string, args: Arguments) => Promise<{ ok: boolean; result?: unknown; unavailable?: Record<string, unknown> }>;
  popupInvoker: () => PopupInvoker;
}

/** luaLiteral encodes strings as decimal escapes (`"\065\083..."`), so decode before matching. */
function markerOf(payload: string): string | undefined {
  for (const [, encoded] of payload.matchAll(/"((?:\\\d{3})+|ASTRA_[0-9a-f]*)"/g)) {
    const text = encoded!.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code)));
    if (text.startsWith("ASTRA_")) return text;
  }
  return undefined;
}

/** A transport with the real socket's one-outstanding-receive rule, so a parallel probe batch that
 *  shares a connection fails here exactly the way it did in the game (muse-run5: every popup probe
 *  came back "Concurrent FireTuner receive is not permitted." and then "Socket is closed"). */
class FakeTuner {
  connected = true;
  overlaps = 0;
  exchanges = 0;
  /** Every guarded close body the bridge sent, in order. The canned reply decides which branch it
   *  took, so a "changed" reply means the native handler was never reached; the real-Lua guard test
   *  below proves that property against an actual screen. */
  closeBodies: number[] = [];
  private receiving = false;
  private frames: { tag: number; payload: string }[] = [];
  private replies = new Map<number, unknown[]>();

  /** Queue the next probe result for one Lua-context index. */
  replyOnce(index: number, value: unknown): void {
    const queue = this.replies.get(index) ?? [];
    queue.push(value);
    this.replies.set(index, queue);
  }

  async connect(): Promise<void> { this.connected = true; }
  close(): void { this.connected = false; }

  async send(tag: number, payload: string): Promise<void> {
    if (!this.connected) throw new Error("Socket is closed");
    const index = Number(/^CMD:(\d+):/.exec(payload)?.[1]);
    if (!Number.isInteger(index)) throw new Error("FakeTuner received a non-command frame");
    const marker = markerOf(payload);
    if (!marker) throw new Error("FakeTuner received a command without a response marker");
    this.exchanges++;
    // popups.ts builds every close body from luaClose(): a missing handler reports itself by name.
    if (payload.includes('closed = false, missing = ')) this.closeBodies.push(index);
    const called = /return AstraCiv\.(\w+)\(/.exec(payload)?.[1];
    // Context loads carry the trusted module source plus an AstraCiv.emit() envelope; the popup
    // evaluator never calls AstraCiv. Only a real probe consumes a queued screen state.
    const result = called === "decisions" ? { decisions: [], total: 0, offset: 0, more: false }
      : payload.includes("AstraCiv.emit") ? { version: 1, gameId: "gate" }
      : this.popupResult(index);
    const hex = Buffer.from(JSON.stringify({ ok: true, result }), "utf8").toString("hex");
    this.frames.push({ tag: 3, payload: `O\0${marker}:1:1:${hex}` }, { tag: 3, payload: `O\0${marker}:DONE` });
  }

  async receive(): Promise<{ tag: number; payload: string }> {
    if (this.receiving) {
      this.overlaps++;
      throw new Error("Concurrent FireTuner receive is not permitted.");
    }
    this.receiving = true;
    try {
      // A socket reply never arrives inside the caller's synchronous turn. Deferring to the next
      // macrotask models that delivery slot (no duration is being waited for), which is what makes
      // two parallel exchanges overlap here exactly as they would on the wire.
      const delivered = Promise.withResolvers<void>();
      setImmediate(delivered.resolve);
      await delivered.promise;
      const frame = this.frames.shift();
      if (!frame) throw new Error("FireTuner request timed out.");
      return frame;
    } finally { this.receiving = false; }
  }

  /** The queued screen state for one popup probe; unqueued probes read as a hidden screen. */
  private popupResult(index: number): unknown {
    const queued = this.replies.get(index);
    if (queued?.length) return queued.shift();
    return { visible: false, active: false };
  }
}

function transportBridge(options: ConstructorParameters<typeof CivBridge>[0] = {}) {
  const bridge = new CivBridge(options);
  bridges.push(bridge);
  const internals = bridge as unknown as Internals;
  const transport = new FakeTuner();
  internals.transport = transport;
  internals.ensureConnected = async () => {};
  internals.refreshStates = async () => {};
  internals.states = new Map<number, string>([
    [1, "GameCore_Tuner"],
    [IN_GAME, "InGame"],
    ...popupCatalog.map((entry, position) => [300 + position, entry.context] as [number, string]),
  ]);
  return { bridge, transport };
}

function popupIndex(context: string): number {
  const position = popupCatalog.findIndex(entry => entry.context === context);
  if (position < 0) throw new Error(`Unknown popup context ${context}`);
  return 300 + position;
}

/**
 * The screens the game would hand a popup context: ContextPtr, Controls, UIManager and the
 * screen's own globals. Every probe is run by a real Lua VM whose only fib is that these natives
 * come from this file instead of the engine.
 */
const LUA_PRELUDE = `PRINTED = {}
function print(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
  PRINTED[#PRINTED + 1] = table.concat(parts, "\\t")
end
local function control(props)
  props = props or {}
  return setmetatable(props, { __index = function(self, key)
    if key == "IsHidden" then return function() return self.hidden == true end end
    if key == "IsVisible" then return function() return self.hidden ~= true end end
    if key == "GetText" then return function() return self.text end end
    if key == "GetToolTipString" then return function() return self.tooltip end end
    if key == "GetChildren" then return function() return self.children or {} end end
    if key == "GetID" then return function() return self.id end end
    return nil
  end })
end`;

const LUA_SCENES: Record<string, string> = {
  // NaturalDisasterPopup.lua renders exactly these: HeaderTitle/DisasterName / DisasterDescription
  // and the casualty counters, inside the containers the XML nests them in.
  NaturalDisasterPopup: `
local name = control({ text = "A flood" })
local description = control({ text = "A flood damaged your lands." })
local damaged = control({ text = "2" })
local hiddenCounter = control({ hidden = true, text = "0" })
local stack = control({ children = { name, description, damaged, hiddenCounter } })
local header = control({ text = "NATURAL DISASTER" })
local body = control({ children = { header, stack } })
Controls = { HeaderTitle = header, DisasterName = name, DisasterDescription = description }
ContextPtr = control({ children = { body } })
UIManager = { IsInPopupQueue = function() return false end }
function Close() ContextPtr.hidden = true end`,
  WonderBuiltPopup: `
ContextPtr = setmetatable({}, { __index = function() return function() error("screen Lua is broken") end end })
Controls = {}
UIManager = { IsInPopupQueue = function() return false end }`,
};

const LUA_HIDDEN_SCREEN = `
ContextPtr = control({ hidden = true })
Controls = {}
UIManager = { IsInPopupQueue = function() return false end }`;

/** Runs one chunk in a fresh VM and returns everything it printed. */
function runLua(chunk: string): string[] {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    if (lauxlib.luaL_dostring(state, to_luastring(`${LUA_PRELUDE}\n${chunk}`)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
    }
    return printedLines(state);
  } finally {
    lua.lua_close(state);
  }
}

function printedLines(state: unknown): string[] {
  lua.lua_getglobal(state, to_luastring("PRINTED"));
  const count = lua.lua_rawlen(state, -1);
  const lines: string[] = [];
  for (let index = 1; index <= count; index++) {
    lua.lua_rawgeti(state, -1, index);
    lines.push(to_jsstring(lua.lua_tostring(state, -1)));
    lua.lua_pop(state, 1);
  }
  lua.lua_pop(state, 1);
  return lines;
}

/** Decodes the marker:part:count:hex frames a printed response is made of, exactly like the collector. */
function decodeFrames(lines: string[], marker: string): string {
  const frame = new RegExp(`^${marker}:(\\d+):(\\d+):([0-9a-f]*)$`);
  const parts = new Map<number, Buffer>();
  let total = 0;
  for (const line of lines) {
    if (line === `${marker}:DONE`) break;
    const match = frame.exec(line);
    if (!match) continue;
    total = Number(match[2]);
    parts.set(Number(match[1]), Buffer.from(match[3]!, "hex"));
  }
  const chunks: Buffer[] = [];
  for (let index = 1; index <= total; index++) chunks.push(parts.get(index)!);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A FireTuner whose Lua is real: the generated evaluator and the fixed probe bodies run in a Lua
 * VM per screen context, and only their printed output travels back through the real collector.
 */
class LuaTuner {
  connected = true;
  overlaps = 0;
  exchanges = 0;
  loads = new Map<number, string>();
  private receiving = false;
  private frames: { tag: number; payload: string }[] = [];
  private screens = new Map<number, unknown>();

  constructor(private readonly contexts: Map<number, string>) {}

  async connect(): Promise<void> { this.connected = true; }
  close(): void { this.connected = false; }

  async send(tag: number, payload: string): Promise<void> {
    if (!this.connected) throw new Error("Socket is closed");
    const prefix = /^CMD:(\d+):/.exec(payload);
    if (!prefix) throw new Error("LuaTuner received a non-command frame");
    const index = Number(prefix[1]);
    const marker = markerOf(payload);
    if (!marker) throw new Error("LuaTuner received a command without a response marker");
    this.exchanges++;
    const code = payload.slice(prefix[0].length);
    if (/return \{version=AstraCiv\.version,gameId=AstraCiv\.session\}/.test(code)) {
      this.loads.set(index, code);
      this.reply(marker, { version: 1, gameId: "gate" });
      return;
    }
    // Trusted module calls are answered structurally: this harness exercises the screen protocol.
    if (code.includes("AstraCiv.emit")) {
      this.reply(marker, { decisions: [], total: 0, offset: 0, more: false });
      return;
    }
    for (const line of this.runScreen(index, code)) this.frames.push({ tag: 3, payload: `O\0${line}` });
  }

  async receive(): Promise<{ tag: number; payload: string }> {
    if (this.receiving) {
      this.overlaps++;
      throw new Error("Concurrent FireTuner receive is not permitted.");
    }
    this.receiving = true;
    try {
      const delivered = Promise.withResolvers<void>();
      setImmediate(delivered.resolve);
      await delivered.promise;
      const frame = this.frames.shift();
      if (!frame) throw new Error("FireTuner request timed out.");
      return frame;
    } finally { this.receiving = false; }
  }

  /** One persistent Lua state per context: a native close must stay closed for the next probe. */
  private runScreen(index: number, code: string): string[] {
    let state = this.screens.get(index);
    if (state === undefined) {
      state = lauxlib.luaL_newstate();
      lualib.luaL_openlibs(state);
      const name = this.contexts.get(index) ?? `Unknown${index}`;
      const scene = LUA_SCENES[name] ?? LUA_HIDDEN_SCREEN;
      if (lauxlib.luaL_dostring(state, to_luastring(`${LUA_PRELUDE}\n${scene}`)) !== lua.LUA_OK) {
        throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
      }
      this.screens.set(index, state);
    }
    if (lauxlib.luaL_dostring(state, to_luastring(`PRINTED = {}\n${code}`)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
    }
    return printedLines(state);
  }

  private reply(marker: string, result: unknown): void {
    const hex = Buffer.from(JSON.stringify({ ok: true, result }), "utf8").toString("hex");
    this.frames.push({ tag: 3, payload: `O\0${marker}:1:1:${hex}` }, { tag: 3, payload: `O\0${marker}:DONE` });
  }
}

/** A bridge whose screen Lua is executed by a real VM and whose collector is untouched. */
function luaBridge(options: ConstructorParameters<typeof CivBridge>[0] = {}) {
  const bridge = new CivBridge(options);
  bridges.push(bridge);
  const internals = bridge as unknown as Internals;
  const contexts = new Map<number, string>([
    [1, "GameCore_Tuner"],
    [IN_GAME, "InGame"],
    ...popupCatalog.map((entry, position) => [300 + position, entry.context] as [number, string]),
  ]);
  const transport = new LuaTuner(contexts);
  internals.transport = transport as unknown as FakeTuner;
  internals.ensureConnected = async () => {};
  internals.refreshStates = async () => {};
  internals.states = contexts;
  return { bridge, transport };
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
    "civ.decisions", "civ.decide", "civ.action", "civ.rules", "civ.civilopedia", "civ.keybinds", "civ.dismiss_notifications"]);
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
    ["civ.civilopedia", { query: "Rome", id: "CIVILIZATION_ROME" }, "query or id"],
    ["civ.civilopedia", { query: "" }, "civilopedia.query"],
    ["civ.civilopedia", { limit: 101 }, "limit"],
    ["civ.civilopedia", { lua: "print('unsafe')" }, "Unknown civ.civilopedia argument"],
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
  const core = await bridge.request("civ.snapshot", { include: ["core"] }) as { units: unknown[]; cities: unknown[]; knowledge: { sections: string[]; coverage: Record<string, string> } };
  expect(core.units).toEqual([]);
  expect(core.cities).toEqual([]);
  expect(core.knowledge.sections).toEqual(["core"]);
  expect(core.knowledge.coverage.units).toBe("omitted");

  stage = 2;
  const scoped = await bridge.request("civ.snapshot", { include: ["core", "units"], region: { x: 1, y: 1, radius: 2 } }) as { units: { id: string }[]; cities: unknown[]; knowledge: { sections: string[]; coverage: Record<string, string> } };
  expect(scoped.units.map(unit => unit.id)).toEqual([mine.id]);
  expect(scoped.cities).toEqual([]);
  // The invariant carried structurally rather than in a sentence: this response does not claim to be
  // a complete list, so an absent record here is unqueried or unobservable, never removed.
  expect(scoped.knowledge.coverage.units).toBe("partial");
  expect(scoped.knowledge.coverage.cities).toBe("omitted");
  expect(JSON.stringify(scoped.knowledge)).not.toContain("never");

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
test("popup probes never overlap on the shared connection and report real screen state", async () => {
  const { bridge, transport } = transportBridge();
  const decisions = await bridge.request("civ.decisions") as { decisions: { id: string; kind: string }[]; unavailable?: Record<string, unknown> };
  // Every reviewed context is loaded and probed on first use; two exchanges at once would refuse
  // each other's receive and tear the transport down.
  expect(transport.overlaps).toBe(0);
  expect(transport.exchanges).toBeGreaterThan(popupCatalog.length);
  // Nothing was degraded, so the diagnostics key is absent rather than an empty object: its presence
  // is the signal, and an empty one on four results in five taught the model to skip the fifth.
  expect(decisions.unavailable).toBeUndefined();
  expect(decisions.decisions).toEqual([]);
  expect(transport.connected).toBe(true);

  transport.replyOnce(popupIndex("HistoricMoments"), { visible: true, active: true, closeable: true, title: "New moment" });
  const observed = await bridge.request("civ.decisions", { id: "popup:historic-moments" }) as { decisions: { active: boolean; visible: boolean; dismissable: boolean; title: string }[] };
  expect(observed.decisions[0]).toMatchObject({ active: true, visible: true, dismissable: true, title: "New moment" });
  expect(transport.overlaps).toBe(0);
});

test("a known informational popup is dismissed through its native handler only", async () => {
  const { bridge, transport } = transportBridge();
  transport.replyOnce(popupIndex("HistoricMoments"), { present: true, closed: true });
  transport.replyOnce(popupIndex("HistoricMoments"), { visible: false, active: false });
  const dismissed = await bridge.request("civ.decide", { id: "popup:historic-moments" }) as { dismissed: boolean; accepted: boolean };
  expect(dismissed.dismissed).toBe(true);
  expect(dismissed.accepted).toBe(true);

  // The same screen raised again: a second dismissal is a fresh presence check/close/verify, never a replay.
  transport.replyOnce(popupIndex("HistoricMoments"), { present: true, closed: true });
  transport.replyOnce(popupIndex("HistoricMoments"), { visible: true, active: true, closeable: true });
  const queued = await bridge.request("civ.decide", { id: "popup:historic-moments" }) as { dismissed: boolean; advanced?: boolean; note?: string };
  expect(queued.dismissed).toBe(false);
  expect(queued.advanced).toBe(true);
  expect(queued.note).toContain("next queued item");
});

test("a refusal raised before submission is returned as a refusal, not an unknown outcome", async () => {
  const { bridge } = fakeBridge(() => { throw new Error('ASTRA_REFUSED: [string "AstraCiv.emit(\\"ASTRA_x\\")"]:42: Action requires type'); });
  const refused = await bridge.request("civ.action", { type: "move" }) as { accepted: boolean; status: string; reasons: string[]; note: string };
  expect(refused.accepted).toBe(false);
  expect(refused.status).toBe("refused");
  expect(refused.reasons[0]).toBe("Action requires type");
  expect(refused.note).toContain("nothing reached the engine");

  const { bridge: unknown } = fakeBridge(() => { throw new Error('ASTRA_UNKNOWN: engine threw after the request'); });
  await expect(unknown.request("civ.action", { type: "move" })).rejects.toThrow("It was NOT replayed");
});

/* ---------------------------------------------------------------------------------------------
 * Executable offline smoke coverage for the popup protocol and the presentation boundary.
 *
 * The game prints whatever a Lua chunk prints, so running the real generated evaluator and the
 * real fixed probe bodies through a Lua VM and feeding the printed frames back through the real
 * collector is the exact protocol in both directions. muse-run5 (FINDINGS H02) lost every popup
 * probe to a "Malformed FireTuner response envelope" plus "Socket is closed" because the evaluator
 * serialized the bare probe value while the collector required {ok,result}; the first test below
 * fails on that drift instead of in the game.
 * ------------------------------------------------------------------------------------------- */

test("the generated screen evaluator emits exactly the envelope the collector parses", () => {
  const evaluator = (CivBridge as unknown as { POPUP_EVALUATOR: string }).POPUP_EVALUATOR;
  const marker = "ASTRA_regression";
  const frame = (body: string) => decodeFrames(
    runLua(evaluator.replaceAll("__MARKER__", () => `"${marker}"`).replace("%BODY%", () => body)),
    marker,
  );

  const ok = JSON.parse(frame("{ active = true, visible = true, closeable = true }")) as { ok: unknown; result?: unknown };
  expect(ok.ok).toBe(true);
  expect(ok.result).toEqual({ active: true, visible: true, closeable: true });

  const failed = JSON.parse(frame("(function() error('screen boom') end)()")) as { ok: unknown; error?: unknown; result?: unknown };
  expect(failed.ok).toBe(false);
  expect(String(failed.error)).toContain("screen boom");
  expect(failed.result).toBeUndefined();
});

test("a real screen probe captures its rendered text without tearing the transport down", async () => {
  const { bridge, transport } = luaBridge();
  const response = await bridge.request("civ.decisions", { id: "popup:natural-disaster" }) as { decisions: PopupObservation[] };
  const observation = response.decisions[0]!;
  expect(observation.status).toBe("ok");
  expect(observation.title).toBe("NATURAL DISASTER");
  expect(observation.contentStatus).toBe("captured");
  // Verified named controls come first and keep their semantic identity; the tree walk only adds
  // what no named control reported.
  expect(observation.content).toEqual({
    fields: [
      { control: "Controls.HeaderTitle", text: "NATURAL DISASTER", source: "text" },
      { control: "Controls.DisasterName", text: "A flood", source: "text" },
      { control: "Controls.DisasterDescription", text: "A flood damaged your lands.", source: "text" },
      { control: "root/1/2/3", text: "2", source: "text" },
    ],
    truncated: false,
    unreadable: [],
  });
  // The hidden casualty counter is not rendered, so it is not reported as content.
  expect(observation.content!.fields.map(field => field.control)).not.toContain("root/1/2/4");
  expect(observation.autoDismissible).toBe(true);
  expect(transport.connected).toBe(true);
  expect(transport.overlaps).toBe(0);
});

test("a screen whose own Lua raised degrades that one observation and leaves the rest working", async () => {
  const { bridge, transport } = luaBridge();
  const response = await bridge.request("civ.decisions", { id: "popup:wonder-built" }) as {
    decisions: PopupObservation[];
    unavailable: Record<string, unknown>;
  };
  expect(response.decisions[0]!.status).toBe("error");
  expect(response.decisions[0]!.error).toContain("screen Lua is broken");
  expect(response.decisions[0]!.contentStatus).toBe("unsupported");
  expect(response.decisions[0]!.autoDismissible).toBe(false);
  expect(response.unavailable.popup).toBeDefined();
  // The old evaluator raised instead, which tore down the shared connection for every later probe.
  expect(transport.connected).toBe(true);
  const recovered = await bridge.request("civ.decisions", { id: "popup:natural-disaster" }) as { decisions: PopupObservation[] };
  expect(recovered.decisions[0]!.status).toBe("ok");
});

test("the actual combined InGame load executes within Lua's module-local limits", async () => {
  const setup = await Promise.all(["test/lua/shim.lua", "test/lua/fixture.lua"].map(path => Bun.file(path).text()));
  const { bridge, transport } = luaBridge();
  await bridge.request("civ.decisions", { popups: "none" });
  const load = transport.loads.get(IN_GAME)!;
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    for (const source of [...setup, load, "STUB_INSTALL('default'); AstraCiv.begin(); return AstraCiv.snapshot({include={'core'}}).turn"]) {
      if (lauxlib.luaL_dostring(state, to_luastring(source)) !== lua.LUA_OK) {
        throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
      }
    }
    expect(lua.lua_tonumber(state, -1)).toBe(10);
  } finally {
    lua.lua_close(state);
  }
});

/** The captured text as the fixed probes report it. */
function capture(text: string, truncated = false) {
  return { fields: [{ control: "root/1", text, source: "text" }], truncated, unreadable: [] };
}

/**
 * One observe / guarded close / verify cycle for a screen. The guarded close runs presence, the
 * content comparison and the native handler in a single screen invocation, so it consumes exactly
 * one reply; a successor means the verification probe still finds the screen rendered.
 */
function queuePresentation(transport: FakeTuner, index: number, shown: string, successor?: string) {
  transport.replyOnce(index, { visible: true, active: true, closeable: true, title: "Moment", content: capture(shown) });
  transport.replyOnce(index, { present: true, closed: true });
  transport.replyOnce(index, successor === undefined
    ? { visible: false, active: false }
    : { visible: true, active: true, closeable: true, content: capture(successor) });
}

test("an information-only screen is archived by the callback before its native close runs", async () => {
  const archives: string[] = [];
  let closesDuringArchive = -1;
  const { bridge, transport } = transportBridge({
    onInformationalPopup: async observation => {
      closesDuringArchive = transport.closeBodies.length;
      archives.push(observation.content!.fields.map(field => field.text).join(" | "));
    },
  });
  const index = popupIndex("HistoricMoments");
  queuePresentation(transport, index, "New moment: your religion was founded");
  const report = await bridge.preparePresentation();

  expect(archives).toEqual(["New moment: your religion was founded"]);
  expect(closesDuringArchive).toBe(0);
  expect(transport.closeBodies).toEqual([index]);
  expect(report.presented.map(item => item.id)).toEqual(["popup:historic-moments"]);
  expect(report.dismissed).toEqual(["popup:historic-moments"]);
  expect(report.remaining).toEqual([]);
  expect(report.callbackFailures).toEqual([]);
  expect(report.more).toBe(false);
  expect(transport.connected).toBe(true);
});

test("without a callback nothing is dismissed, and choosers stay on screen", async () => {
  const { bridge, transport } = transportBridge();
  transport.replyOnce(popupIndex("HistoricMoments"), { visible: true, active: true, closeable: true, content: capture("A moment") });
  transport.replyOnce(popupIndex("EventPopup"), { visible: true, active: true, closeable: true, title: "A difficult choice" });
  const report = await bridge.preparePresentation();

  expect(report.dismissed).toEqual([]);
  expect(report.presented).toEqual([]);
  expect(transport.closeBodies).toEqual([]);
  expect(report.observed.map(item => item.id).sort()).toEqual(["popup:event", "popup:historic-moments"]);
  expect(report.remaining.map(entry => entry.id).sort()).toEqual(["popup:event", "popup:historic-moments"]);
  expect(report.remaining.every(entry => entry.reason.length > 0)).toBe(true);
  const event = report.observed.find(item => item.id === "popup:event")!;
  expect(event.contentStatus).toBe("unsupported");
  expect(event.autoDismissible).toBe(false);
});

test("a failed archive stops the boundary before any other screen is closed", async () => {
  const attempts: string[] = [];
  const { bridge, transport } = transportBridge({
    onInformationalPopup: async observation => {
      attempts.push(observation.id);
      throw new Error("history append failed");
    },
  });
  transport.replyOnce(popupIndex("TechCivicCompletedPopup"), { visible: true, active: true, closeable: true, content: capture("Pottery") });
  transport.replyOnce(popupIndex("HistoricMoments"), { visible: true, active: true, closeable: true, content: capture("A moment") });
  const report = await bridge.preparePresentation();

  expect(attempts).toEqual(["popup:tech-civic-completed"]);
  expect(transport.closeBodies).toEqual([]);
  expect(report.dismissed).toEqual([]);
  expect(report.presented).toEqual([]);
  expect(report.callbackFailures).toEqual([{ id: "popup:tech-civic-completed", error: "history append failed" }]);
  expect(report.remaining.map(entry => entry.id).sort()).toEqual(["popup:historic-moments", "popup:tech-civic-completed"]);
  expect(report.remaining.every(entry => entry.reason.length > 0)).toBe(true);
});

test("content that changed while it was archived is re-presented before any close", async () => {
  const archives: string[] = [];
  const { bridge, transport } = transportBridge({
    onInformationalPopup: async observation => {
      archives.push(observation.content!.fields.map(field => field.text).join(" | "));
    },
  });
  const index = popupIndex("BoostUnlockedPopup");
  transport.replyOnce(index, { visible: true, active: true, closeable: true, content: capture("Boost: Pottery") });
  transport.replyOnce(index, { present: true, matched: false, content: capture("Boost: Writing") });
  queuePresentation(transport, index, "Boost: Writing");
  const report = await bridge.preparePresentation();

  expect(archives).toEqual(["Boost: Pottery", "Boost: Writing"]);
  expect(report.dismissed).toEqual(["popup:boost-unlocked"]);
  expect(report.callbackFailures).toEqual([]);
  expect(report.remaining).toEqual([]);
});

test("a successor raised by the native close is archived before it is acknowledged in turn", async () => {
  const archives: string[] = [];
  const { bridge, transport } = transportBridge({
    onInformationalPopup: async observation => {
      archives.push(observation.content!.fields.map(field => field.text).join(" | "));
    },
  });
  const index = popupIndex("TechCivicCompletedPopup");
  queuePresentation(transport, index, "Tech complete: Pottery", "Civic complete: Foreign Trade");
  queuePresentation(transport, index, "Civic complete: Foreign Trade");
  const report = await bridge.preparePresentation();

  expect(archives).toEqual(["Tech complete: Pottery", "Civic complete: Foreign Trade"]);
  expect(transport.closeBodies).toEqual([index, index]);
  expect(report.advanced).toEqual(["popup:tech-civic-completed"]);
  expect(report.dismissed).toEqual(["popup:tech-civic-completed"]);
  expect(report.remaining).toEqual([]);
});

test("the drain is bounded and reports what it left presenting", async () => {
  const { bridge, transport } = transportBridge({ onInformationalPopup: async () => {} });
  const index = popupIndex("HistoricMoments");
  for (let round = 1; round <= 4; round++) queuePresentation(transport, index, `Moment ${round}`, `Moment ${round + 1}`);
  transport.replyOnce(index, { visible: true, active: true, closeable: true, content: capture("Moment 5") });
  const report = await bridge.preparePresentation();

  expect(report.more).toBe(true);
  expect(report.presented).toHaveLength(4);
  expect(report.advanced).toHaveLength(4);
  expect(report.dismissed).toEqual([]);
  expect(report.remaining.map(entry => entry.id)).toEqual(["popup:historic-moments"]);
  expect(report.remaining[0]!.reason.length).toBeGreaterThan(0);
});

/** A bridge whose trusted Lua call is stubbed but whose screen invoker still runs through the tuner. */
function submissionBridge(result: unknown) {
  const { bridge, transport } = transportBridge();
  const internals = bridge as unknown as Internals;
  internals.invoke = async () => ({ ok: true, result });
  return { bridge, transport };
}

test("an explicit congress submit tears down the in-session voting screen and reports it separately", async () => {
  const { bridge, transport } = submissionBridge({ accepted: true, status: "submitted", sessionSubmitted: true, turnEnding: true, ballot: [] });
  transport.replyOnce(popupIndex("WorldCongressPopup"), { present: true, inSessionSurface: true, closed: true });
  const result = await bridge.request("civ.action", { type: "congress", operation: "submit" }) as Record<string, unknown>;

  expect(result.sessionSubmitted).toBe(true);
  expect(result.accepted).toBe(true);
  expect(result.popupClose).toMatchObject({ id: "popup:world-congress", status: "closed" });
});

test("a congress context that already moved on to review data is left untouched", async () => {
  const { bridge, transport } = submissionBridge({ accepted: true, status: "submitted", sessionSubmitted: true });
  transport.replyOnce(popupIndex("WorldCongressPopup"), { present: true, inSessionSurface: false });
  const result = await bridge.request("civ.decide", { type: "congress", operation: "submit", id: "congress" }) as Record<string, unknown>;

  expect(result.popupClose).toMatchObject({ id: "popup:world-congress", status: "not-the-submitted-surface" });
});

test("a batch that submitted a ballot is torn down, and a batch without one is not", async () => {
  const submitted = submissionBridge({ accepted: true, results: [{ index: 1, type: "move", status: "submitted" }, { index: 2, type: "congress", status: "submitted", sessionSubmitted: true }] });
  submitted.transport.replyOnce(popupIndex("WorldCongressPopup"), { present: true, inSessionSurface: true, closed: true });
  const torn = await submitted.bridge.request("civ.action", { actions: [{ type: "move" }, { type: "congress" }] }) as Record<string, unknown>;
  expect(torn.popupClose).toMatchObject({ status: "closed" });

  const ordinary = submissionBridge({ accepted: true, results: [{ index: 1, type: "move", status: "submitted" }] });
  const plain = await ordinary.bridge.request("civ.action", { actions: [{ type: "move" }] }) as Record<string, unknown>;
  expect(plain.popupClose).toBeUndefined();
  expect(ordinary.transport.exchanges).toBe(0);
});

test("an unknown outcome is never followed by a congress teardown, and its error is not replaced", async () => {
  const { bridge, transport } = transportBridge();
  (bridge as unknown as Internals).invoke = async () => { throw new Error("acknowledgement lost"); };
  await expect(bridge.request("civ.action", { type: "congress", operation: "submit" })).rejects.toThrow("It was NOT replayed");
  expect(transport.exchanges).toBe(0);
});

test("a failed congress teardown keeps the submitted result instead of losing it", async () => {
  const { bridge, transport } = submissionBridge({ accepted: true, status: "submitted", sessionSubmitted: true });
  transport.replyOnce(popupIndex("WorldCongressPopup"), { present: true, inSessionSurface: true, closed: false, missing: "ClosePopup" });
  const result = await bridge.request("civ.action", { type: "congress", operation: "submit" }) as Record<string, unknown>;

  expect(result.accepted).toBe(true);
  expect(result.sessionSubmitted).toBe(true);
  expect(result.popupClose).toMatchObject({ status: "error" });
  expect(String((result.popupClose as Record<string, unknown>).error).length).toBeGreaterThan(0);
});

/** Runs one stub screen's own Lua for a body, so a test can see whether the native handler ran. */
function screenLua(scene: string) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  if (lauxlib.luaL_dostring(state, to_luastring(`${LUA_PRELUDE}\n${scene}`)) !== lua.LUA_OK) {
    throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
  }
  const decode = (index: number): unknown => {
    const type = lua.lua_type(state, index);
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(state, index);
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(state, index);
    if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(state, index));
    if (type !== lua.LUA_TTABLE) return null;
    const length = lua.lua_rawlen(state, index);
    if (length > 0) {
      const list: unknown[] = [];
      for (let item = 1; item <= length; item++) {
        lua.lua_rawgeti(state, index, item);
        list.push(decode(-1));
        lua.lua_pop(state, 1);
      }
      return list;
    }
    const record: Record<string, unknown> = {};
    lua.lua_pushnil(state);
    while (lua.lua_next(state, index - 1) !== 0) {
      record[to_jsstring(lua.lua_tostring(state, -2))] = decode(-1);
      lua.lua_pop(state, 1);
    }
    return record;
  };
  return async (_context: string, body: string): Promise<unknown> => {
    if (lauxlib.luaL_dostring(state, to_luastring(`RESULT = (${body})`)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
    }
    lua.lua_getglobal(state, to_luastring("RESULT"));
    const value = decode(-1);
    lua.lua_pop(state, 1);
    return value;
  };
}

test("a guarded close compares inside the screen's own Lua and never runs the handler on a mismatch", async () => {
  const invoke = screenLua(`
local header = control({ text = "RESEARCH COMPLETE" })
local name = control({ text = "POTTERY" })
Controls = { HeaderLabel = header, ResearchName = name }
ContextPtr = control({ children = { header, name } })
UIManager = { IsInPopupQueue = function() return ContextPtr.hidden ~= true end }
function OnClose() ContextPtr.hidden = true end`);

  const stale: PopupContent = { fields: [{ control: "Controls.ResearchName", text: "WRITING", source: "text" }], truncated: false, unreadable: [] };
  const refused = await dismissPopup("popup:tech-civic-completed", invoke, stale);
  expect(refused.changed).toBe(true);
  expect(refused.dismissed).toBe(false);
  expect(refused.content!.fields.map(field => field.text)).toContain("POTTERY");
  // The handler was not reached: the screen is still rendered after the refused comparison.
  expect((await observePopups(invoke, { id: "popup:tech-civic-completed" }))[0]!.visible).toBe(true);

  const accepted = await dismissPopup("popup:tech-civic-completed", invoke, refused.content!);
  expect(accepted.dismissed).toBe(true);
  expect((await observePopups(invoke, { id: "popup:tech-civic-completed" }))[0]!.visible).toBe(false);
});

test("an aborted boundary never mutates the UI, and the guard is not folded into a popup error", async () => {
  const { bridge, transport } = transportBridge({ onInformationalPopup: async () => {} });
  const index = popupIndex("HistoricMoments");
  transport.replyOnce(index, { visible: true, active: true, closeable: true, content: { fields: [{ control: "root/1", text: "A moment", source: "text" }], truncated: false, unreadable: [] } });
  let admissions = 0;
  await expect(bridge.preparePresentation(() => {
    admissions++;
    if (admissions > 1) throw new Error("aborted while probing");
  })).rejects.toThrow("aborted while probing");
  // The guard is re-checked after the awaited probes (not only at the start), and the abort it
  // raised stopped the boundary before any native close was admitted.
  expect(admissions).toBeGreaterThan(1);
  expect(transport.closeBodies).toEqual([]);
});

test("a guard that aborts at the start probes nothing at all", async () => {
  const { bridge, transport } = transportBridge({ onInformationalPopup: async () => {} });
  await expect(bridge.preparePresentation(() => { throw new Error("cancelled before the boundary"); }))
    .rejects.toThrow("cancelled before the boundary");
  expect(transport.exchanges).toBe(0);
});

test("a failed tree enumeration marks the capture incomplete and blocks the automatic close", async () => {
  // The named header is readable, but the root cannot be enumerated: the tree below it was never
  // read, so the capture must not certify itself as complete.
  const invoke = screenLua(`
local header = control({ text = "NATURAL DISASTER" })
Controls = { HeaderTitle = header, DisasterName = control({ text = "A flood" }) }
ContextPtr = setmetatable({}, { __index = function(_, key)
  if key == "IsHidden" then return function() return false end end
  if key == "GetChildren" then return function() error("GetChildren is unsupported here") end end
  return nil
end })
UIManager = { IsInPopupQueue = function() return false end }
function Close() end`);

  const [observation] = await observePopups(invoke, { id: "popup:natural-disaster" });
  expect(observation!.contentStatus).toBe("captured");
  expect(observation!.content!.fields.map(field => field.text)).toContain("NATURAL DISASTER");
  expect(observation!.content!.truncated).toBe(true);
  expect(observation!.content!.unreadable.length).toBeGreaterThan(0);
  expect(observation!.autoDismissible).toBe(false);
  expect(observation!.autoDismissReason!.length).toBeGreaterThan(0);
});

test("an unlock slot that exposes its tooltip is preserved and may be closed automatically", async () => {
  // TechCivicCompletedPopup's slots carry ToolTipHelper.GetToolTip(...) on the UnlockIcon button
  // (TechAndCivicSupport.lua:366-367), so the walk reads the unlocked item's own tooltip.
  const invoke = screenLua(`
local header = control({ text = "RESEARCH COMPLETE" })
local name = control({ text = "POTTERY" })
local iconButton = control({ id = "UnlockIcon", tooltip = "Warrior" })
local slot = control({ id = "Top", children = { control({ id = "Image", children = { iconButton } }) } })
local stack = control({ children = { slot } })
Controls = { HeaderLabel = header, ResearchName = name, UnlockStack = stack }
ContextPtr = control({ children = { header, name, stack } })
UIManager = { IsInPopupQueue = function() return ContextPtr.hidden ~= true end }
function OnClose() ContextPtr.hidden = true end`);

  const [observation] = await observePopups(invoke, { id: "popup:tech-civic-completed" });
  expect(observation!.content!.truncated).toBe(false);
  expect(observation!.content!.unreadable).toEqual([]);
  expect(observation!.content!.fields.some(field => field.text === "Warrior" && field.source === "tooltip")).toBe(true);
  expect(observation!.autoDismissible).toBe(true);

  const closed = await dismissPopup("popup:tech-civic-completed", invoke, observation!.content!);
  expect(closed.dismissed).toBe(true);
});

test("a rendered unlock slot with no readable content blocks the automatic close", async () => {
  const invoke = screenLua(`
local header = control({ text = "RESEARCH COMPLETE" })
local name = control({ text = "POTTERY" })
local blankSlot = control({ id = "Top", children = { control({ id = "Image", children = { control({ id = "UnlockIcon" }) } }) } })
local describedSlot = control({ id = "Top", children = { control({ id = "Image", children = { control({ id = "UnlockIcon", tooltip = "Warrior" }) } }) } })
local stack = control({ children = { blankSlot, describedSlot } })
Controls = { HeaderLabel = header, ResearchName = name, UnlockStack = stack }
ContextPtr = control({ children = { header, name, stack } })
UIManager = { IsInPopupQueue = function() return ContextPtr.hidden ~= true end }
function OnClose() ContextPtr.hidden = true end`);

  const [observation] = await observePopups(invoke, { id: "popup:tech-civic-completed" });
  expect(observation!.content!.unreadable.join(" ")).toContain("1 of 2 rendered slots");
  expect(observation!.autoDismissible).toBe(false);
  expect(observation!.autoDismissReason!.length).toBeGreaterThan(0);
});

test("a screen that renders content the capture cannot read is never closed automatically", async () => {
  const { bridge, transport } = transportBridge({ onInformationalPopup: async () => {} });
  const index = popupIndex("TechCivicCompletedPopup");
  transport.replyOnce(index, {
    visible: true, active: true, closeable: true, title: "RESEARCH COMPLETE",
    content: {
      fields: [{ control: "Controls.ResearchName", text: "POTTERY", source: "text" }],
      truncated: false,
      unreadable: ["Controls.UnlockStack renders icon-only instances"],
    },
  });
  const report = await bridge.preparePresentation();

  expect(report.dismissed).toEqual([]);
  expect(transport.closeBodies).toEqual([]);
  const remaining = report.remaining.find(entry => entry.id === "popup:tech-civic-completed");
  expect(remaining!.reason.length).toBeGreaterThan(0);
  expect(report.observed[0]!.autoDismissible).toBe(false);
});

const ERA_SCREEN = `
local header = control({ text = "MEDIEVAL" })
Controls = { EraCompletedHeader = header }
ContextPtr = control({ children = { header } })
ERA = { age = "normal", score = 42 }
local eras = {
  GetCurrentEra = function() return 2 end,
  HasHeroicGoldenAge = function(_, player) assert(player == 0); return ERA.age == "heroic" end,
  HasGoldenAge = function() return ERA.age == "golden" or ERA.age == "heroic" end,
  HasDarkAge = function() return ERA.age == "dark" end,
  GetPlayerCurrentScore = function() return ERA.score end,
  GetPlayerPreviousScore = function() return 42 end,
  GetPlayerDarkAgeThreshold = function() return 55 end,
  GetPlayerGoldenAgeThreshold = function() return 70 end,
  GetPlayerPreviousDarkAgeThreshold = function() return 20 end,
  GetPlayerPreviousGoldenAgeThreshold = function() return 40 end,
}
Game = { GetLocalPlayer = function() return 0 end, GetEras = function() return eras end }
GameInfo = { Eras = { [2] = { Name = "MEDIEVAL" } } }
Locale = { ToUpper = string.upper }
UIManager = { IsInPopupQueue = function() return not ContextPtr.hidden end }
function Close() ContextPtr.hidden = true end
`;

for (const age of ["normal", "dark", "golden", "heroic"]) {
  test(`era rollover preserves ${age} age and score without a screenshot`, async () => {
    const invoke = screenLua(`${ERA_SCREEN}\nERA.age = "${age}"`);
    const [popup] = await observePopups(invoke, { id: "popup:era-complete" });
    expect(popup!.autoDismissible).toBe(true);
    const state = Object.fromEntries(popup!.content!.fields
      .filter(field => field.source === "game-state")
      .map(field => [field.control, field.text]));
    expect(state).toMatchObject({
      "Game.GetEras.age": age,
      "Game.GetEras.currentScore": "42",
      "Game.GetEras.previousGoldenAgeThreshold": "40",
      "Game.GetEras.goldenAgeThreshold": "70",
    });
    const result = await dismissPopup("popup:era-complete", invoke, popup!.content!);
    expect(result.dismissed).toBe(true);
  });
}

test("an era score change after preservation prevents acknowledging unseen state", async () => {
  const invoke = screenLua(ERA_SCREEN);
  const [popup] = await observePopups(invoke, { id: "popup:era-complete" });
  await invoke("EraCompletePopup", "(function() ERA.score = 43; return true end)()");
  const result = await dismissPopup("popup:era-complete", invoke, popup!.content!);
  expect(result.changed).toBe(true);
  expect(result.dismissed).toBe(false);
  expect((await observePopups(invoke, { id: "popup:era-complete" }))[0]!.visible).toBe(true);
});

test("unavailable age state cannot be treated as normal or automatically dismissed", async () => {
  const invoke = screenLua(`${ERA_SCREEN}\nGame.GetEras().HasDarkAge = function() return nil end`);
  const [popup] = await observePopups(invoke, { id: "popup:era-complete" });
  expect(popup!.autoDismissible).toBe(false);
  expect(popup!.content!.fields.some(field => field.control === "Game.GetEras.age")).toBe(false);
  expect(popup!.content!.unreadable.length).toBeGreaterThan(0);
});

test("one presentation boundary preserves the era result before releasing the screen", async () => {
  const invoke = screenLua(`${ERA_SCREEN}
function Close()
  assert(PRESERVED == true, "Era result was not preserved")
  ContextPtr.hidden = true
end`);
  const preserved: PopupContent[] = [];
  const { bridge } = transportBridge({
    onInformationalPopup: async popup => {
      preserved.push(popup.content!);
      await invoke("EraCompletePopup", "(function() PRESERVED = true; return true end)()");
    },
  });
  // Replace only the native context transport; exercise the actual presentation drain.
  const internals = bridge as unknown as Internals;
  internals.popupInvoker = () =>
    async (context, body) => context === "EraCompletePopup" ? invoke(context, body) : { visible: false, active: false };

  const report = await bridge.preparePresentation();
  expect(report.dismissed).toEqual(["popup:era-complete"]);
  expect(preserved).toHaveLength(1);
  expect(preserved[0]!.fields).toContainEqual({ control: "Game.GetEras.age", text: "normal", source: "game-state" });
  expect((await observePopups(invoke, { id: "popup:era-complete" }))[0]!.visible).toBe(false);
});

test("a large preserved popup can pass the guarded close without another observation round trip", async () => {
  const { bridge, transport } = transportBridge({ onInformationalPopup: async () => {} });
  const index = popupIndex("HistoricMoments");
  const content: PopupContent = {
    fields: Array.from({ length: 12 }, (_, index) => ({ control: `root/${index + 1}`, text: "歴史".repeat(650), source: "text" as const })),
    truncated: false, unreadable: [],
  };
  transport.replyOnce(index, { visible: true, active: true, closeable: true, content });
  transport.replyOnce(index, { present: true, matched: true, closed: true });
  transport.replyOnce(index, { visible: false, active: false });
  const report = await bridge.preparePresentation();
  expect(report.dismissed).toEqual(["popup:historic-moments"]);
  expect(report.presented[0]!.content).toEqual(content);
});

// This regressed once already: withDiagnostics was added with a comment explaining that an
// always-present empty `unavailable` teaches the model to skip the key, and then three of the five
// result paths kept emitting one anyway. Assert the property across the paths rather than trusting
// the helper to be reached.
test("no result carries an empty unavailable, so its presence always means something is degraded", async () => {
  const { bridge } = transportBridge();
  const calls: [string, Arguments][] = [
    ["civ.probe", {}],
    ["civ.decisions", {}],
    ["civ.action", { type: "end_turn" }],
    ["civ.decide", { id: "g:decision:pantheon:player0", choice: "BELIEF_X" }],
    // A popup: id takes the dismissal branch instead of the mutation one; both used to emit {}.
    ["civ.decide", { id: "popup:historic-moments" }],
    ["civ.inspect", { x: 1, y: 1 }],
  ];
  for (const [method, args] of calls) {
    const result = await bridge.request(method, args) as Record<string, unknown>;
    if (!("unavailable" in result)) continue;
    expect({ method, unavailable: result.unavailable }).toEqual({
      method,
      unavailable: expect.objectContaining({}),
    });
    expect(Object.keys(result.unavailable as object).length,
      `${method} returned an empty unavailable; presence must mean something was degraded`).toBeGreaterThan(0);
  }
});
