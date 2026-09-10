import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Arguments, BridgeOptions } from "./contracts";
import {
  dismissPopup,
  observePopups,
  popupCatalog,
  type PopupInvoker,
  type PopupObservation,
  type PopupSelector,
} from "./bridge/popups";
import { TunerTransport } from "./bridge/transport";

export type { BridgeOptions } from "./contracts";

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: string;
  unavailable?: Record<string, unknown>;
}

interface Observation extends Record<string, unknown> {
  id: string;
  revision?: number;
  visibility?: string;
  own?: boolean;
  lastSeenTurn?: number | null;
}

interface Snapshot extends Record<string, unknown> {
  gameId: string;
  playerId: number;
  turn: number;
  cities?: Observation[];
  units?: Observation[];
  map?: {
    width: number;
    height: number;
    offset: number;
    more: boolean;
    region?: unknown;
    tiles?: Observation[];
    [key: string]: unknown;
  };
  sections?: string[];
  coverage?: Coverage;
  unavailable?: Record<string, unknown>;
  revision?: number;
}

export type CoverageLevel = (typeof COVERAGE_LEVELS)[number];
export type Coverage = Record<"units" | "cities" | "map", CoverageLevel>;

interface KnowledgeArchive {
  version: 1;
  gameId: string;
  playerId: number;
  snapshotRevision: number;
  records: {
    units: Observation[];
    cities: Observation[];
    tiles: Observation[];
  };
}

const MAX_RESPONSE = 16 * 1024 * 1024;
const MAX_KNOWLEDGE_RECORDS = 100_000;
const MAX_RECORD_BYTES = 1024 * 1024;

/** The complete model-facing bridge surface. Nothing outside this list is reachable. */
export const BRIDGE_METHODS = [
  "civ.probe", "civ.snapshot", "civ.inspect", "civ.options", "civ.path", "civ.decisions", "civ.decide",
  "civ.action", "civ.rules", "civ.keybinds", "civ.dismiss_notifications",
] as const;

/** Snapshot sections. The Lua owns what each contains; the host owns rejecting unknown names cheaply. */
const SECTIONS = ["core", "economy", "units", "cities", "map", "research", "culture", "resources",
  "diplomacy", "governors", "religion", "trade", "victory", "notifications", "configuration"] as const;
const DEFAULT_SECTIONS = ["core", "units", "cities", "notifications"];
const REGION_KEYWORDS = ["owned", "visible", "all"];
const MAX_BATCH = 64;
const COVERAGE_LEVELS = ["complete", "partial", "omitted"] as const;

/** Validated Lua-declared coverage, or undefined when this response predates coverage declarations. */
function declaredCoverage(value: unknown): Coverage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const units = candidate.units;
  const cities = candidate.cities;
  const map = candidate.map;
  if (!COVERAGE_LEVELS.includes(units as CoverageLevel) ||
      !COVERAGE_LEVELS.includes(cities as CoverageLevel) ||
      !COVERAGE_LEVELS.includes(map as CoverageLevel)) return undefined;
  return { units: units as CoverageLevel, cities: cities as CoverageLevel, map: map as CoverageLevel };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer ${min}..${max}.`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new Error(`${label} must be a nonempty identifier string of at most 256 characters, taken from a recent observation.`);
  }
  return value;
}

function validateRegion(region: unknown): void {
  if (typeof region === "string") {
    if (!REGION_KEYWORDS.includes(region)) {
      throw new Error(`region must be one of ${REGION_KEYWORDS.join(", ")}, {x,y,radius} or {x0,y0,x1,y1}.`);
    }
    return;
  }
  if (!region || typeof region !== "object" || Array.isArray(region)) {
    throw new Error(`region must be one of ${REGION_KEYWORDS.join(", ")}, {x,y,radius} or {x0,y0,x1,y1}.`);
  }
  const bounds = region as Record<string, unknown>;
  if (bounds.radius !== undefined || bounds.x !== undefined || bounds.y !== undefined) {
    requireInteger(bounds.x, "region.x", 0, 10_000);
    requireInteger(bounds.y, "region.y", 0, 10_000);
    requireInteger(bounds.radius, "region.radius", 0, 128);
    return;
  }
  for (const key of ["x0", "y0", "x1", "y1"]) requireInteger(bounds[key], `region.${key}`, 0, 10_000);
}

function requestedSections(args: Arguments): string[] {
  if (args.include === undefined) return [...DEFAULT_SECTIONS];
  const include = (Array.isArray(args.include) ? args.include : [args.include]) as string[];
  if (include.includes("all")) return [...SECTIONS];
  return [...new Set(["core", ...include])];
}

function hasDiagnostic(value: unknown, group: string): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, group);
}

function scopedMap(args: Arguments): boolean {
  return (args.region !== undefined && args.region !== "all") ||
    args.mapOffset !== undefined || args.mapLimit !== undefined;
}

/** Encodes JSON data as Lua literals, not executable source. All strings are UTF-8 decimal escapes. */
function luaLiteral(value: unknown, depth = 0): string {
  if (depth > 20) throw new Error("Arguments exceed maximum nesting depth.");
  if (value === null) return "AstraCiv.null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Arguments must contain finite numbers.");
    return String(value);
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 32_768) throw new Error("Argument string exceeds 32 KiB.");
    return '"' + [...Buffer.from(value)].map(byte => "\\" + byte.toString().padStart(3, "0")).join("") + '"';
  }
  if (Array.isArray(value)) return "{" + value.map(item => luaLiteral(item, depth + 1)).join(",") + "}";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.entries(value).map(([key, item]) => `[${luaLiteral(key, depth + 1)}]=${luaLiteral(item, depth + 1)}`).join(",") + "}";
  }
  throw new Error("Arguments must be JSON values (no undefined, functions, prototypes or binary objects).");
}

/**
 * Host-enforced argument bounds, published by civ.probe. This describes what the bridge validates.
 * What actions and operations exist is never written here: civ.probe takes that from the Lua-side
 * runtime generator, so the probe cannot advertise something the ruleset will reject.
 */
const METHOD_SCHEMA: Record<string, string> = {
  "civ.probe": "{verbose?:boolean}; capabilities generated from the live ruleset, popup catalog from the fixed adapters, contexts only with verbose=true",
  "civ.snapshot": `{include?:string|string[] of ${SECTIONS.join("|")}|all (default ${DEFAULT_SECTIONS.join(",")}), region?:"owned"|"visible"|"all"|{x,y,radius<=128}|{x0,y0,x1,y1}, edges?:boolean, detail?:"summary"|"full", mapOffset?:integer>=0, mapLimit?:1..100000}; omitted sections are absent, not empty; coverage={units,cities,map} says complete|partial|omitted per queried collection; region and mapOffset/mapLimit make map partial`,
  "civ.inspect": "{id:string} or {x:integer,y:integer} (+kind?:string, edges?:boolean); single-record lookup, never a full-map read; a live miss returns the remembered record with lastSeenTurn and remembered=true instead of scanning the map",
  "civ.options": `{unitId?:string} | {cityId?:string} | {}; operation?:string (unit: short name from its list; city: item name, place_district, citizens or tile_purchase; player scope: research, civic, government or policies), targets?:boolean, detail?:"summary"|"full", offset?:integer>=0, limit?:1..500`,
  "civ.path": "{unitId:string,x:integer,y:integer}; engine-authorised per-plot path and turn data with busy=true and honest truncation when the engine or bounds cut it",
  "civ.decisions": `{kind?:string, id?:string, popups?:"all"|"none", detail?:"summary"|"full", offset?:integer>=0, limit?:1..500}; pending gameplay decisions with stable ids plus fixed-context popup observations; popups:"none" skips popup-context probing on list calls; popup ids resolve against the adapter registry only`,
  "civ.decide": `{id:string,choice?:scalar,choices?:array of <=${MAX_BATCH} selections}; answers one gameplay decision, or dismisses one informational popup by its popup: id (choice/choices rejected for popups); submission is not completion and a thrown-away acknowledgement is never replayed`,
  "civ.action": `{type:string,...} or {actions:[{type,...}] (<=${MAX_BATCH}, end_turn last only), expectedTurn?:integer, stopOnError?:boolean}; submission is not completion and a batch is never replayed`,
  "civ.rules": "{table?:allowlisted GameInfo table,where?:exact scalar equality object,offset?:integer>=0,limit?:1..500}; omit table to list",
  "civ.keybinds": "{category?:string,offset?:integer>=0,limit?:1..100000}; the game's live keyboard bindings from the Input manager",
  "civ.dismiss_notifications": "{}; dismisses every dismissable notification in the on-screen rail; cosmetic only, never a modal choice",
};

/** Fixed read/action bridge. Transport source execution is deliberately private. */
export class CivBridge {
  private readonly options: Required<BridgeOptions>;
  private readonly transport = new TunerTransport();
  private queue: Promise<unknown> = Promise.resolve();
  /** Popup adapters run Promise.all probes; this queue serializes their shared transport calls. */
  private popupQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private states = new Map<number, string>();
  private identity = "";
  private loaded = new Set<number>();
  private sources?: Promise<{ common: string; ui: string }>;
  private records = new Map<string, Observation>();
  private fingerprints = new Map<string, { hash: string; revision: number }>();
  private gameKey = "";
  private snapshotRevision = 0;
  private statesRefresh?: Promise<void>;
  /** Context names known not to exist after a shared refresh; avoids one LSQ round trip per popup. */
  private missingContexts = new Set<string>();

  constructor(options: BridgeOptions = {}) {
    this.options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4318,
      timeoutMs: options.timeoutMs ?? 30_000,
    };
    if (!Number.isInteger(this.options.port) || this.options.port < 1 || this.options.port > 65_535) {
      throw new Error("Invalid FireTuner port.");
    }
    if (!Number.isFinite(this.options.timeoutMs) || this.options.timeoutMs < 100 || this.options.timeoutMs > 300_000) {
      throw new Error("FireTuner timeout must be 100..300000 ms.");
    }
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error("CivBridge is closed.");
      return fn();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  connect(): Promise<unknown> {
    return this.serialized(async () => {
      await this.ensureConnected();
      return this.connectionInfo();
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.transport.connected) return;
    this.loaded.clear();
    this.states.clear();
    this.missingContexts.clear();
    this.statesRefresh = undefined;
    await this.transport.connect(this.options.host, this.options.port, this.options.timeoutMs);
    try {
      await this.transport.send(4, "APP:");
      this.identity = await this.handshakeReply("APP");
      await this.refreshStates();
    } catch (error) {
      this.transport.close();
      throw error;
    }
  }

  private async handshakeReply(kind: "APP" | "LSQ"): Promise<string> {
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      const frame = await this.transport.receive(Math.max(1, deadline - Date.now()));
      if (frame.payload.startsWith("ERR:")) throw new Error(frame.payload);
      if (frame.tag === 4 && frame.payload && !frame.payload.startsWith("O\0")) {
        return frame.payload.replace(new RegExp(`^${kind}:`), "");
      }
    }
    throw new Error(`FireTuner ${kind} handshake timed out.`);
  }

  private async refreshStates(): Promise<void> {
    await this.transport.send(4, "LSQ:");
    const raw = await this.handshakeReply("LSQ");
    const parts = raw.split(/[\0\r\n]+/).map(value => value.trim()).filter(Boolean);
    const next = new Map<number, string>();
    for (let index = 0; index < parts.length; index++) {
      const token = parts[index]!;
      if (/^\d+$/.test(token) && parts[index + 1]) {
        next.set(Number(token), parts[++index]!);
        continue;
      }
      const pair = /^(\d+)\s*[:=]\s*(.+)$/.exec(token);
      if (pair) next.set(Number(pair[1]), pair[2]!);
    }
    if (next.size === 0) {
      throw new Error(`FireTuner returned an unrecognized Lua-state list: ${JSON.stringify(raw.slice(0, 400))}`);
    }
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.states]);
    if (changed) {
      this.loaded.clear();
      this.missingContexts.clear();
    }
    this.states = next;
  }

  private connectionInfo(contexts = true) {
    return {
      connected: this.transport.connected,
      host: this.options.host,
      port: this.options.port,
      application: this.identity,
      ...(contexts
        ? { contexts: [...this.states].map(([index, name]) => ({ index, name })) }
        : { contextCount: this.states.size, contexts: "Omitted; call civ.probe(verbose=true) for the FireTuner Lua-state list." }),
      ready: [...this.states.values()].includes("InGame"),
      observationContext: "InGame (player visibility APIs)",
      rulesContext: "GameCore_Tuner",
      actionContext: "InGame (native requests)",
    };
  }

  /** Locate a FireTuner state by name; hierarchical names match their final path segment. */
  private contextEntry(name: string): [number, string] | undefined {
    for (const entry of this.states) if (entry[1] === name) return entry;
    const suffixed = [...this.states].filter(([, state]) => state.endsWith("/" + name));
    return suffixed.length === 1 ? suffixed[0] : undefined;
  }

  /**
   * Resolve a context with at most one shared state refresh when the name is missing from the
   * current list. A missing name is remembered until LSQ reports a changed list, which matters for
   * popup observation where most of the reviewed contexts are normally not loaded.
   */
  private async contextIndex(name: string, ui: boolean, unavailableHint?: string): Promise<number> {
    let entry = this.contextEntry(name);
    if (!entry) {
      if (this.missingContexts.has(name)) {
        throw new Error(unavailableHint ?? `FireTuner Lua context ${name} is not available in this application.`);
      }
      this.statesRefresh ??= this.refreshStates().finally(() => { this.statesRefresh = undefined; });
      await this.statesRefresh;
      entry = this.contextEntry(name);
      if (!entry) {
        this.missingContexts.add(name);
        throw new Error(unavailableHint ?? `FireTuner Lua context ${name} is not available in this application.`);
      }
      this.missingContexts.delete(name);
    }
    const index = entry[0];
    if (ui && !this.loaded.has(index)) {
      this.sources ??= Promise.all([
        "common", "state", "actions", "options", "decisions",
      ].map(module => readFile(new URL(`../lua/${module}.lua`, import.meta.url), "utf8")))
        .then(([common, state, actions, options, decisions]) => ({
          common: common!,
          ui: [state, actions, options, decisions].join("\n"),
        }));
      const source = await this.sources;
      const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
      const session = randomUUID();
      const code = `${source.common}\n${source.ui}\nAstraCiv.session=AstraCiv.session or ${luaLiteral(session)}\nAstraCiv.emit(${luaLiteral(marker)},function() return {version=AstraCiv.version,gameId=AstraCiv.session} end)`;
      await this.collect(index, code, marker);
      this.loaded.add(index);
    } else if (!ui && !this.loaded.has(index)) {
      const source = await (this.sources ??= readFile(new URL("../lua/common.lua", import.meta.url), "utf8")
        .then(common => ({ common, ui: "" })));
      const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
      const session = randomUUID();
      const code = `${source.common}\nAstraCiv.session=AstraCiv.session or ${luaLiteral(session)}\nAstraCiv.emit(${luaLiteral(marker)},function() return {version=AstraCiv.version,gameId=AstraCiv.session} end)`;
      await this.collect(index, code, marker);
      this.loaded.add(index);
    }
    return index;
  }

  /**
   * Self-contained evaluator for screen contexts where AstraCiv is deliberately absent. It mirrors
   * the trusted framing (marker:part:count:hex chunks) with a bounded JSON encoder.
   */
  private static readonly POPUP_EVALUATOR = String.raw`local ok, value = pcall(function() return (%BODY%) end)
if not ok then error(tostring(value)) end
local function quote(value)
  return '"' .. value:gsub('[%z\1-\31\\"]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    return string.format('\\u%04x', string.byte(c))
  end) .. '"'
end
local function encode(value, depth)
  if depth > 32 then error('Popup response nesting exceeds 32') end
  if value == nil then return 'null' end
  local kind = type(value)
  if kind == 'boolean' then return value and 'true' or 'false' end
  if kind == 'number' then
    if value ~= value or value == math.huge or value == -math.huge then return 'null' end
    return tostring(value)
  end
  if kind == 'string' then return quote(value) end
  if kind ~= 'table' then error('Non-serializable popup response value: ' .. kind) end
  local out = {}
  if #value > 0 then
    for i = 1, #value do out[#out + 1] = encode(value[i], depth + 1) end
    return '[' .. table.concat(out, ',') .. ']'
  end
  for key, item in pairs(value) do out[#out + 1] = quote(tostring(key)) .. ':' .. encode(item, depth + 1) end
  table.sort(out)
  return '{' .. table.concat(out, ',') .. '}'
end
local text = encode(value, 0)
local chunks = math.max(1, math.ceil(#text / 2500))
for i = 1, chunks do
  local part = text:sub((i - 1) * 2500 + 1, i * 2500)
  local hex = part:gsub('.', function(c) return string.format('%02x', string.byte(c)) end)
  print(MARKER .. ':' .. i .. ':' .. chunks .. ':' .. hex)
end
print(MARKER .. ':DONE')`;

  /** The trusted popup invoker handed to the reviewed adapters; model code cannot supply either string. */
  private popupCollect(index: number, code: string, marker: string): Promise<Envelope> {
    const next = this.popupQueue.then(() => this.collect(index, code, marker));
    this.popupQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Popup contexts are evaluated only through fixed bodies supplied by popups.ts. The evaluator is
   * not exposed by RPC and its calls are serialized separately because observePopups probes in
   * parallel for latency while FireTuner permits one receive at a time.
   */
  private popupInvoker(): PopupInvoker {
    return async (contextName: string, body: string) => {
      if (typeof contextName !== "string" || !contextName || contextName.length > 256) {
        throw new Error("Popup invoker received an invalid context name.");
      }
      if (typeof body !== "string" || !body || body.length > 32_768 || body.includes("\0")) {
        throw new Error("Popup invoker received an invalid body.");
      }
      const index = await this.contextIndex(contextName, false);
      const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
      const code = CivBridge.POPUP_EVALUATOR
        .replace("MARKER", () => luaLiteral(marker))
        .replace("%BODY%", () => body);
      const response = await this.popupCollect(index, code, marker);
      return response.result ?? null;
    };
  }

  private async collect(index: number, code: string, marker: string): Promise<Envelope> {
    const deadline = Date.now() + this.options.timeoutMs;
    const parts = new Map<number, Buffer>();
    let total = 0;
    let bytes = 0;
    try {
      await this.transport.send(3, `CMD:${index}:${code}`);
      while (Date.now() < deadline) {
        const frame = await this.transport.receive(Math.max(1, deadline - Date.now()));
        if (frame.payload.startsWith("ERR:")) throw new Error(`FireTuner Lua error: ${frame.payload}`);
        // Ignore command acknowledgements, echoed source and unrelated game print output.
        if (!frame.payload.startsWith("O\0")) continue;
        const separator = frame.payload.indexOf(": ", 2);
        const text = (separator >= 0 ? frame.payload.slice(separator + 2) : frame.payload.slice(2)).trim();
        if (text === `${marker}:DONE`) {
          if (!total || parts.size !== total) throw new Error("Incomplete FireTuner response chunks.");
          const chunks: Buffer[] = [];
          for (let part = 1; part <= total; part++) {
            const chunk = parts.get(part);
            if (!chunk) throw new Error(`Missing FireTuner response chunk ${part}.`);
            chunks.push(chunk);
          }
          const envelope = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as Envelope;
          if (typeof envelope.ok !== "boolean") throw new Error("Malformed FireTuner response envelope.");
          if (!envelope.ok) throw new Error(envelope.error ?? "Trusted Lua request failed.");
          return envelope;
        }
        if (!text.startsWith(marker + ":")) continue;
        const match = /^(\d+):(\d+):([0-9a-f]*)$/.exec(text.slice(marker.length + 1));
        if (!match) throw new Error("Malformed FireTuner response chunk.");
        const part = Number(match[1]);
        const count = Number(match[2]);
        const hex = match[3]!;
        if (count < 1 || count > 6711 || part < 1 || part > count || hex.length % 2 || (total && count !== total)) {
          throw new Error("Invalid FireTuner chunk sequence.");
        }
        total = count;
        const chunk = Buffer.from(hex, "hex");
        const previous = parts.get(part);
        if (previous) {
          if (!previous.equals(chunk)) throw new Error("Conflicting duplicate response chunk.");
          continue;
        }
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE) throw new Error("FireTuner response exceeds 16 MiB bound.");
        parts.set(part, chunk);
      }
      throw new Error("FireTuner request timed out.");
    } catch (error) {
      // A sent command with no trustworthy response has unknown outcome. Closing the stream is
      // deliberate; reconnecting never replays the command.
      this.transport.close();
      this.loaded.clear();
      throw error;
    }
  }

  private async invoke(method: string, args: Arguments): Promise<Envelope> {
    const core = method === "rules";
    const index = await this.contextIndex(core ? "GameCore_Tuner" : "InGame", !core);
    const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
    return this.collect(index, `AstraCiv.emit(${luaLiteral(marker)},function() return AstraCiv.${method}(${luaLiteral(args)}) end)`, marker);
  }

  /** Validate and bound every argument before a connection is opened or anything is submitted. */
  private static validate(method: string, args: Arguments): void {
    switch (method) {
      case "civ.probe":
        if (args.verbose !== undefined && typeof args.verbose !== "boolean") throw new Error("verbose must be a boolean.");
        return;
      case "civ.snapshot": {
        if (args.include !== undefined) {
          const include = Array.isArray(args.include) ? args.include : [args.include];
          if (!include.length || include.length > SECTIONS.length + 1) throw new Error(`include must name 1..${SECTIONS.length + 1} sections.`);
          for (const section of include) {
            if (typeof section !== "string" || (section !== "all" && !(SECTIONS as readonly string[]).includes(section))) {
              throw new Error(`Unknown snapshot section ${JSON.stringify(section)}. Valid sections: ${SECTIONS.join(", ")}, or "all".`);
            }
          }
        }
        if (args.region !== undefined) validateRegion(args.region);
        if (args.edges !== undefined && typeof args.edges !== "boolean") throw new Error("edges must be a boolean.");
        if (args.detail !== undefined && args.detail !== "summary" && args.detail !== "full") throw new Error('detail must be "summary" or "full".');
        if (args.mapOffset !== undefined) requireInteger(args.mapOffset, "mapOffset", 0, 4_000_000);
        if (args.mapLimit !== undefined) requireInteger(args.mapLimit, "mapLimit", 1, 100_000);
        return;
      }
      case "civ.inspect":
        if (typeof args.id !== "string" && !(Number.isInteger(args.x) && Number.isInteger(args.y))) {
          throw new Error("inspect requires a game-qualified id or integer x/y.");
        }
        if (args.id !== undefined) requireId(args.id, "id");
        if (args.id === undefined) {
          requireInteger(args.x, "x", 0, 10_000);
          requireInteger(args.y, "y", 0, 10_000);
        }
        if (args.kind !== undefined && (typeof args.kind !== "string" || args.kind.length > 64)) throw new Error("kind must be a short string when provided.");
        if (args.edges !== undefined && typeof args.edges !== "boolean") throw new Error("edges must be a boolean.");
        return;
      case "civ.options":
        if (args.unitId !== undefined && args.cityId !== undefined) throw new Error("civ.options takes unitId, cityId, or neither for player scope.");
        if (args.unitId !== undefined) requireId(args.unitId, "unitId");
        if (args.cityId !== undefined) requireId(args.cityId, "cityId");
        if (args.operation !== undefined && (typeof args.operation !== "string" || !args.operation || args.operation.length > 128)) throw new Error("operation must be a short name taken from civ.options output or the documented player-scope operations.");
        if (args.targets !== undefined && typeof args.targets !== "boolean") throw new Error("targets must be a boolean.");
        if (args.detail !== undefined && args.detail !== "summary" && args.detail !== "full") throw new Error('detail must be "summary" or "full".');
        if (args.offset !== undefined) requireInteger(args.offset, "offset", 0, 1_000_000);
        if (args.limit !== undefined) requireInteger(args.limit, "limit", 1, 500);
        return;
      case "civ.path":
        requireId(args.unitId, "unitId");
        requireInteger(args.x, "x", 0, 10_000);
        requireInteger(args.y, "y", 0, 10_000);
        return;
      case "civ.decisions":
        if (args.kind !== undefined && (typeof args.kind !== "string" || !args.kind || args.kind.length > 64)) throw new Error("kind must be a short decision kind from civ.decisions output.");
        if (args.id !== undefined) requireId(args.id, "id");
        if (args.detail !== undefined && args.detail !== "summary" && args.detail !== "full") throw new Error('detail must be "summary" or "full".');
        if (args.offset !== undefined) requireInteger(args.offset, "offset", 0, 1_000_000);
        if (args.limit !== undefined) requireInteger(args.limit, "limit", 1, 500);
        if (args.popups !== undefined) {
          if (typeof args.id === "string" && args.id.startsWith("popup:")) throw new Error('popups applies when listing decisions; a popup: id observes exactly that context.');
          if (args.popups !== "all" && args.popups !== "none") throw new Error('popups must be "all" or "none".');
        }
        return;
      case "civ.decide":
        requireId(args.id, "id");
        if (typeof args.id === "string" && args.id.startsWith("popup:")) {
          if (args.choice !== undefined || args.choices !== undefined) {
            throw new Error("Popup dismissal takes no choice; popups are dismissed as they are, and gameplay choosers are never closed by the bridge.");
          }
          return;
        }
        if (args.choice !== undefined && !["string", "number", "boolean"].includes(typeof args.choice)) throw new Error("choice must be a scalar option value from civ.decisions.");
        if (args.choices !== undefined) {
          if (!Array.isArray(args.choices) || !args.choices.length || args.choices.length > MAX_BATCH) throw new Error(`choices must be an array of 1..${MAX_BATCH} selections from civ.decisions.`);
        }
        return;
      case "civ.action":
        if (args.expectedTurn !== undefined) requireInteger(args.expectedTurn, "expectedTurn", 0, 100_000);
        if (args.stopOnError !== undefined && typeof args.stopOnError !== "boolean") throw new Error("stopOnError must be a boolean.");
        if (args.actions === undefined) {
          if (typeof args.type !== "string" || !args.type) throw new Error("civ.action requires type=... for a single action or actions=[...] for a batch.");
          return;
        }
        if (args.type !== undefined) throw new Error("Pass a single action (type=...) or a batch (actions=[...]), not both.");
        if (!Array.isArray(args.actions) || !args.actions.length) throw new Error("actions must be a nonempty array of action objects.");
        if (args.actions.length > MAX_BATCH) throw new Error(`A batch may contain at most ${MAX_BATCH} actions; a partially executed batch is never replayed.`);
        for (let index = 0; index < args.actions.length; index++) {
          const action = args.actions[index];
          if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error(`actions[${index}] must be an object.`);
          const type = (action as Arguments).type;
          if (typeof type !== "string" || !type) throw new Error(`actions[${index}].type must be a nonempty string.`);
          if (type === "end_turn" && index !== args.actions.length - 1) throw new Error("end_turn may only appear as the last action in a batch.");
        }
        return;
      case "civ.rules":
        if (args.where !== undefined && (typeof args.where !== "object" || args.where === null || Array.isArray(args.where) ||
          Object.values(args.where).some(value => value === null || !["string", "number", "boolean"].includes(typeof value)))) {
          throw new Error("rules.where values must be scalar strings, numbers or booleans.");
        }
        if (args.offset !== undefined) requireInteger(args.offset, "offset", 0, 1_000_000);
        if (args.limit !== undefined) requireInteger(args.limit, "limit", 1, 500);
        return;
      case "civ.keybinds":
        if (args.category !== undefined && (typeof args.category !== "string" || args.category.length > 128)) throw new Error("category must be a short string.");
        if (args.offset !== undefined) requireInteger(args.offset, "offset", 0, 100_000);
        if (args.limit !== undefined) requireInteger(args.limit, "limit", 1, 100_000);
        return;
      case "civ.dismiss_notifications":
        return;
    }
  }

  request(method: string, args: Arguments = {}): Promise<unknown> {
    if (!(BRIDGE_METHODS as readonly string[]).includes(method)) {
      return Promise.reject(new Error(`Unsupported bridge method ${method}; no arbitrary Lua or SQL RPC exists. Available: ${BRIDGE_METHODS.join(", ")}.`));
    }
    let encoded: string;
    try {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Bridge arguments must be an object.");
      CivBridge.validate(method, args);
      encoded = luaLiteral(args);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (encoded.length > 256 * 1024) return Promise.reject(new Error("Bridge arguments exceed 256 KiB encoded bound."));
    return this.serialized(async () => {
      await this.ensureConnected();
      switch (method) {
        case "civ.probe": return this.probe(args);
        case "civ.snapshot": return this.snapshot(args);
        case "civ.inspect": return this.inspect(args);
        case "civ.options": return this.read("options", args);
        case "civ.path": return this.read("path", args);
        case "civ.decisions": return this.decisions(args);
        case "civ.rules": return this.read("rules", args);
        case "civ.keybinds": return this.read("keybinds", args);
        case "civ.dismiss_notifications": return this.read("dismiss_notifications", args);
        case "civ.decide": return this.decide(args);
        case "civ.action": return this.mutation("action", args);
      }
      throw new Error(`Unsupported bridge method ${method}; no arbitrary Lua or SQL RPC exists.`);
    });
  }

  /** Capabilities come from A.capabilities at call time; the bridge never publishes a static action table. */
  private async probe(args: Arguments): Promise<unknown> {
    const verbose = args.verbose === true;
    await this.refreshStates();
    const info = this.connectionInfo(verbose);
    const unavailable: Record<string, unknown> = {};
    let game: unknown = null;
    let capabilities: Record<string, unknown> = {};
    if ([...this.states.values()].includes("InGame")) {
      try {
        const response = await this.invoke("turnState", {});
        game = response.result;
        Object.assign(unavailable, response.unavailable ?? {});
      } catch (error) {
        unavailable.game = message(error);
      }
      try {
        const response = await this.invoke("capabilities", {});
        if (response.result && typeof response.result === "object" && !Array.isArray(response.result)) {
          capabilities = response.result as Record<string, unknown>;
        } else {
          unavailable.capabilities = "The runtime capability generator returned a non-object; no hand-written substitute is published.";
        }
        Object.assign(unavailable, response.unavailable ?? {});
      } catch (error) {
        unavailable.capabilities = `Runtime action catalog unavailable: ${message(error)}. Nothing here claims an action exists; use civ.options for what is currently legal.`;
      }
    } else {
      unavailable.capabilities = "Load an active game. The action catalog is generated from the live ruleset, never from a static table.";
    }
    return {
      ...info,
      ...capabilities,
      game,
      popupCatalog,
      unavailable,
      methods: METHOD_SCHEMA,
      semantics: {
        gameId: "Loaded Lua-world instance UUID, stable over TCP reconnects; a reload gets a new instance",
        fog: "Only local player and visible entities are queried. Nonvisible tiles retain earlier observations, not live data. Enemy disappearance is not death.",
        unavailable: "null values plus grouped unavailable diagnostics; not fabricated zeroes",
        capabilities: "Generated from the live ruleset each call. If an action type or operation is absent here, it does not resolve in this ruleset.",
        submission: "civ.action and civ.decide return accepted/submitted, never completed. A partially executed batch names stoppedAt and is never replayed.",
      },
    };
  }

  private async read(name: string, args: Arguments, arrayKey?: string): Promise<unknown> {
    const response = await this.invoke(name, args);
    const result = response.result;
    const unavailable = response.unavailable ?? {};
    if (Array.isArray(result)) return { [arrayKey ?? "result"]: result, unavailable };
    if (!result || typeof result !== "object") return { result: result ?? null, unavailable };
    return { ...(result as object), unavailable };
  }

  private async decisions(args: Arguments): Promise<unknown> {
    const id = typeof args.id === "string" && args.id.startsWith("popup:") ? args.id : undefined;
    if (id !== undefined) {
      const observations = await observePopups(this.popupInvoker(), { id });
      const popup = observations[0]!;
      return {
        decisions: [popup],
        total: 1,
        offset: 0,
        more: false,
        unavailable: popup.status === "ok" ? {} : { popup: { [popup.id]: popup.error ?? popup.status } },
      };
    }

    const response = await this.invoke("decisions", args);
    const observations = await observePopups(this.popupInvoker(), args.popups === "none" ? { kinds: [] } : undefined);
    const active: PopupObservation[] = observations.filter(observation =>
      observation.status === "ok" && (observation.active || observation.visible));
    const diagnostics = observations.filter(observation => observation.status !== "ok");
    const unavailable: Record<string, unknown> = { ...(response.unavailable ?? {}) };
    // Do not print twenty-six inactive/default rows. Preserve only a compact diagnostic summary;
    // an explicitly targeted popup returns its full context error above.
    if (diagnostics.length) {
      unavailable.popup = {
        contextMissing: diagnostics.filter(item => item.status === "context-missing").map(item => item.id),
        errors: diagnostics.filter(item => item.status === "error").map(item => ({ id: item.id, error: item.error })),
      };
    }
    const result = response.result;
    if (Array.isArray(result)) {
      const decisions = [...result, ...active];
      return { decisions, total: decisions.length, offset: 0, more: false, unavailable };
    }
    if (!result || typeof result !== "object") {
      const decisions = [...active];
      return { decisions, total: decisions.length, offset: 0, more: false, unavailable };
    }
    const output = { ...(result as Record<string, unknown>), unavailable } as Record<string, unknown>;
    const native = Array.isArray(output.decisions) ? output.decisions : [];
    output.decisions = [...native, ...active];
    if (typeof output.total === "number" && output.more !== true) output.total += active.length;
    else if (output.total === undefined) output.total = (output.decisions as unknown[]).length;
    if (output.offset === undefined) output.offset = 0;
    if (output.more === undefined) output.more = false;
    return output;
  }

  private async decide(args: Arguments): Promise<unknown> {
    if (typeof args.id === "string" && args.id.startsWith("popup:")) {
      const result = await dismissPopup(args.id, this.popupInvoker());
      return { ...result, accepted: result.dismissed, completed: result.dismissed, unavailable: {} };
    }
    return this.mutation("decide", args);
  }

  private async mutation(name: string, args: Arguments): Promise<unknown> {
    const label = name === "decide" ? "Decision" : "Action";
    const response = await this.invoke(name, args).catch((error: unknown) => {
      throw new Error(`${label} failed or its acknowledgement was lost; outcome may be unknown. It was NOT replayed. Read a new snapshot before deciding whether to retry. ${message(error)}`);
    });
    const result = response.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return { result: result ?? null, unavailable: response.unavailable ?? {} };
    }
    return { ...(result as object), unavailable: response.unavailable ?? {} };
  }

  private clearKnowledge(): void {
    this.records.clear();
    this.fingerprints.clear();
    this.gameKey = "";
    this.snapshotRevision = 0;
  }

  private gameOfKey(): string | undefined {
    const separator = this.gameKey.indexOf(":");
    return separator > 0 ? this.gameKey.slice(0, separator) : undefined;
  }

  private playerOfKey(): number | undefined {
    const separator = this.gameKey.indexOf(":");
    if (separator < 0) return undefined;
    const player = this.gameKey.slice(separator + 1);
    return /^\d+$/.test(player) ? Number(player) : undefined;
  }

  private observationKind(id: string, gameId = this.gameOfKey()): "unit" | "city" | "tile" | undefined {
    if (!gameId || !id.startsWith(`${gameId}:`)) return undefined;
    const rest = id.slice(gameId.length + 1);
    if (rest.startsWith("unit:")) return "unit";
    if (rest.startsWith("city:")) return "city";
    if (rest.startsWith("tile:")) return "tile";
    return undefined;
  }

  private validateArchivedRecord(value: unknown, kind: "unit" | "city" | "tile", gameId: string, turn?: number): Observation {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid archived observation.");
    const record = value as Observation;
    if (typeof record.id !== "string" || this.observationKind(record.id, gameId) !== kind) throw new Error("Invalid archived observation id.");
    const suffix = record.id.slice(gameId.length + kind.length + 2);
    if (kind === "tile" ? !/^\d+$/.test(suffix) : !/^\d+:\d+$/.test(suffix)) throw new Error("Invalid archived observation id.");
    if (record.visibility !== undefined && !["visible", "stale", "revealed_not_visible"].includes(record.visibility)) throw new Error("Invalid archived observation visibility.");
    if (record.lastSeenTurn != null && (!Number.isInteger(record.lastSeenTurn) || record.lastSeenTurn < 0 || (turn !== undefined && record.lastSeenTurn > turn))) {
      throw new Error("Invalid archived observation turn.");
    }
    const text = JSON.stringify(record);
    if (text.length > MAX_RECORD_BYTES) throw new Error("Archived observation exceeds size bound.");
    const copy = JSON.parse(text) as Observation;
    const revision = Number.isInteger(copy.revision) && copy.revision! > 0 ? copy.revision! : 1;
    delete copy.revision;
    copy.revision = revision;
    return copy;
  }

  /**
   * Restore accumulated facts independently of any one immutable snapshot. Legacy snapshots are
   * accepted as input, but partial collections are valid and absent groups remain absent.
   */
  restoreKnowledge(value: unknown): void {
    if (this.gameKey || this.records.size) throw new Error("Restore knowledge before the first snapshot.");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid archived knowledge.");
    const source = value as Record<string, unknown>;
    const gameId = source.gameId;
    const playerId = source.playerId;
    if (typeof gameId !== "string" || !gameId || gameId.length > 256 || typeof playerId !== "number" || !Number.isInteger(playerId) || playerId < 0 || playerId > 63) {
      throw new Error("Invalid archived knowledge identity.");
    }
    const turn = Number.isInteger(source.turn) && (source.turn as number) >= 0 ? source.turn as number : undefined;
    const rawRecords = source.records && typeof source.records === "object" && !Array.isArray(source.records)
      ? source.records as Record<string, unknown>
      : source;
    const units = rawRecords.units === undefined ? [] : rawRecords.units;
    const cities = rawRecords.cities === undefined ? [] : rawRecords.cities;
    const tiles = rawRecords.tiles ?? rawRecords.map;
    const tileRecords = tiles === undefined ? [] : (Array.isArray(tiles) ? tiles : (tiles && typeof tiles === "object" && Array.isArray((tiles as Record<string, unknown>).tiles) ? (tiles as Record<string, unknown>).tiles : tiles));
    if (!Array.isArray(units) || !Array.isArray(cities) || !Array.isArray(tileRecords)) throw new Error("Invalid archived knowledge collections.");
    if (units.length + cities.length + tileRecords.length > MAX_KNOWLEDGE_RECORDS) throw new Error("Archived knowledge exceeds record bound.");
    const records = new Map<string, Observation>();
    const fingerprints = new Map<string, { hash: string; revision: number }>();
    for (const [kind, collection] of [["unit", units], ["city", cities], ["tile", tileRecords]] as const) {
      for (const item of collection) {
        const copy = this.validateArchivedRecord(item, kind, gameId, turn);
        if (records.has(copy.id)) throw new Error("Duplicate archived observation id.");
        const withoutRevision = { ...copy };
        delete withoutRevision.revision;
        fingerprints.set(copy.id, { hash: createHash("sha256").update(JSON.stringify(withoutRevision)).digest("hex"), revision: copy.revision ?? 1 });
        records.set(copy.id, copy);
      }
    }
    this.gameKey = `${gameId}:${playerId}`;
    this.records = records;
    this.fingerprints = fingerprints;
    this.snapshotRevision = Number.isInteger(source.snapshotRevision) && (source.snapshotRevision as number) >= 0 ? source.snapshotRevision as number : 0;
  }

  /** Export all accumulated records; immutable snapshots and the latest analyst pointer are separate. */
  exportKnowledge(): KnowledgeArchive | null {
    const playerId = this.playerOfKey();
    const gameId = this.gameOfKey();
    if (gameId === undefined || playerId === undefined) return null;
    const units: Observation[] = [];
    const cities: Observation[] = [];
    const tiles: Observation[] = [];
    for (const record of this.records.values()) {
      const kind = this.observationKind(record.id, gameId);
      if (kind === "unit") units.push({ ...record });
      else if (kind === "city") cities.push({ ...record });
      else if (kind === "tile") tiles.push({ ...record });
    }
    const byId = (left: Observation, right: Observation) => left.id.localeCompare(right.id);
    units.sort(byId);
    cities.sort(byId);
    tiles.sort(byId);
    return { version: 1, gameId, playerId, snapshotRevision: this.snapshotRevision, records: { units, cities, tiles } };
  }

  /** Attach a revision to an observed record, merging a prior revealed-but-not-visible tile. */
  private track(record: Observation, collection?: Observation[], index?: number): Observation {
    const prior = this.records.get(record.id);
    let current: Observation = { ...record };
    if (current.visibility === "revealed_not_visible" && prior?.lastSeenTurn != null) {
      current = {
        ...prior,
        visibility: "stale",
        currentPresence: "unknown",
        staleReason: "Outside current sight; every retained field is last-known, not live.",
      };
    }
    delete current.revision;
    const hash = createHash("sha256").update(JSON.stringify(current)).digest("hex");
    const fingerprint = this.fingerprints.get(current.id);
    current.revision = fingerprint?.hash === hash ? fingerprint.revision : (fingerprint?.revision ?? 0) + 1;
    this.fingerprints.set(current.id, { hash, revision: current.revision });
    this.records.set(current.id, { ...current });
    if (collection && index !== undefined) collection[index] = { ...current };
    return current;
  }

  private normalizeSections(snapshot: Snapshot, args: Arguments): string[] {
    if (Array.isArray(snapshot.sections)) {
      if (!snapshot.sections.every(section => typeof section === "string" && (SECTIONS as readonly string[]).includes(section))) {
        throw new Error("Malformed snapshot sections.");
      }
      return [...new Set(snapshot.sections)];
    }
    // Older modules emitted all collection keys without a sections declaration. Keep that legacy
    // behaviour rather than interpreting absent modern keys as empty arrays.
    const sections = ["core"];
    if (snapshot.units !== undefined) sections.push("units");
    if (snapshot.cities !== undefined) sections.push("cities");
    if (snapshot.map !== undefined) sections.push("map");
    // Retain the caller's selected non-collection sections only when the old response cannot say
    // what it carried; this is a conservative compatibility hint, not a fabricated collection.
    if (snapshot.sections === undefined && snapshot.units === undefined && snapshot.cities === undefined && snapshot.map === undefined) {
      for (const section of requestedSections(args)) if (!sections.includes(section)) sections.push(section);
    }
    return sections;
  }

  private normalizeCoverage(snapshot: Snapshot, sections: Set<string>, args: Arguments, unavailable: Record<string, unknown>): Coverage {
    const declared = declaredCoverage(snapshot.coverage);
    const included = {
      units: sections.has("units") && Array.isArray(snapshot.units),
      cities: sections.has("cities") && Array.isArray(snapshot.cities),
      map: sections.has("map") && !!snapshot.map && Array.isArray(snapshot.map.tiles),
    };
    const fallback = (kind: keyof Coverage): CoverageLevel => {
      if (!included[kind]) return "omitted";
      if (hasDiagnostic(unavailable, kind)) return "partial";
      if (kind === "map" && scopedMap(args)) return "partial";
      if ((kind === "units" || kind === "cities") && declared === undefined && args.region !== undefined && args.region !== "all") return "partial";
      return "complete";
    };
    return {
      units: included.units ? (declared?.units ?? fallback("units")) : "omitted",
      cities: included.cities ? (declared?.cities ?? fallback("cities")) : "omitted",
      map: included.map ? (declared?.map ?? fallback("map")) : "omitted",
    };
  }

  private async snapshot(args: Arguments): Promise<Snapshot> {
    const response = await this.invoke("snapshot", args);
    if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) throw new Error("Malformed snapshot response.");
    const snapshot = response.result as Snapshot;
    if (typeof snapshot.gameId !== "string" || !snapshot.gameId || snapshot.gameId.length > 256 ||
        !Number.isInteger(snapshot.playerId) || snapshot.playerId < 0 || snapshot.playerId > 63 ||
        !Number.isInteger(snapshot.turn) || snapshot.turn < 0) throw new Error("Malformed snapshot identity.");
    if (snapshot.units !== undefined && !Array.isArray(snapshot.units)) throw new Error("Malformed snapshot units collection.");
    if (snapshot.cities !== undefined && !Array.isArray(snapshot.cities)) throw new Error("Malformed snapshot cities collection.");
    if (snapshot.map !== undefined && (!snapshot.map || typeof snapshot.map !== "object" || Array.isArray(snapshot.map) || !Array.isArray(snapshot.map.tiles))) {
      throw new Error("Malformed snapshot map collection.");
    }
    const key = `${snapshot.gameId}:${snapshot.playerId}`;
    const priorGame = this.gameOfKey();
    const priorPlayer = this.playerOfKey();
    if (this.gameKey && (priorGame !== snapshot.gameId || (priorPlayer !== undefined && priorPlayer !== snapshot.playerId))) this.clearKnowledge();
    this.gameKey = key;
    snapshot.revision = ++this.snapshotRevision;
    const unavailable = response.unavailable ?? {};
    snapshot.unavailable = unavailable;
    const declaredSections = this.normalizeSections(snapshot, args);
    const sections = new Set(declaredSections);
    snapshot.sections = declaredSections;
    const coverage = this.normalizeCoverage(snapshot, sections, args, unavailable);
    snapshot.coverage = coverage;
    const observed = new Set<string>();
    const collections: Array<["unit" | "city" | "tile", Observation[] | undefined]> = [
      ["unit", snapshot.units],
      ["city", snapshot.cities],
      ["tile", snapshot.map?.tiles],
    ];
    for (const [kind, collection] of collections) {
      if (!collection) continue;
      for (let index = 0; index < collection.length; index++) {
        const record = collection[index];
        if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string" || this.observationKind(record.id, snapshot.gameId) !== kind) {
          throw new Error(`Malformed ${kind} observation record.`);
        }
        observed.add(record.id);
        this.track(record, collection, index);
      }
    }

    const entityCollections: Array<["unit" | "city", CoverageLevel, Observation[] | undefined]> = [
      ["unit", coverage.units, snapshot.units],
      ["city", coverage.cities, snapshot.cities],
    ];
    for (const [kind, level, collection] of entityCollections) {
      if (level !== "complete" || !collection) continue;
      for (const [id, prior] of [...this.records]) {
        if (observed.has(id) || this.observationKind(id, snapshot.gameId) !== kind) continue;
        if (prior.own === true) {
          // Own removal is meaningful only after the native collection was complete.
          this.records.delete(id);
          this.fingerprints.delete(id);
          continue;
        }
        if (prior.own === false) {
          const stale: Observation = {
            ...prior,
            visibility: "stale",
            currentPresence: "unknown",
            staleReason: "No longer observed. This does not establish movement, capture or death.",
          };
          this.track(stale);
          collection.push({ ...this.records.get(id)! });
        }
      }
    }

    const narrowed = coverage.units !== "complete" || coverage.cities !== "complete" || coverage.map !== "complete";
    snapshot.knowledge = {
      staleFacts: "Accumulated from earlier player-observable captures and restored independently of this snapshot; retained facts are last-known, never hidden live state.",
      enemyAbsence: "Unknown, never inferred dead",
      records: "id stable within the loaded game/player instance; revision increases when an observed record changes",
      sections: `Included: ${declaredSections.join(", ")}. Anything outside these sections is omitted from this response, not empty in the game; accumulated records remain available through later matching queries and host recovery memory.`,
      coverage: `units=${coverage.units}, cities=${coverage.cities}, map=${coverage.map}`,
      ...(narrowed ? { absence: "This response is partial or sectioned, so missing records were not treated as absent. Their absence here means unqueried or not currently observable, not gone." } : {}),
    };
    return snapshot;
  }

  private rememberedForInspect(args: Arguments, payload: Record<string, unknown>): Observation | undefined {
    const gameId = typeof payload.gameId === "string" ? payload.gameId : this.gameOfKey();
    if (!gameId) return undefined;
    if (typeof args.id === "string") return this.records.get(args.id);
    if (typeof args.x !== "number" || typeof args.y !== "number") return undefined;
    for (const record of this.records.values()) {
      if (this.observationKind(record.id, gameId) === "tile" && record.x === args.x && record.y === args.y) return record;
    }
    return undefined;
  }

  /** Single-record lookup with the same last-known/stale discipline as a snapshot, without reading the map. */
  private async inspect(args: Arguments): Promise<unknown> {
    const response = await this.invoke("inspect", args);
    if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) throw new Error("Malformed inspect response.");
    const payload = response.result as Record<string, unknown>;
    const gameId = typeof payload.gameId === "string" ? payload.gameId : null;
    const payloadPlayer = Number.isInteger(payload.playerId) ? payload.playerId as number : undefined;
    if (gameId && this.gameKey && this.gameOfKey() !== gameId) this.clearKnowledge();
    let record = (payload.record ?? null) as Observation | null;
    if (record && (typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string")) throw new Error("Malformed inspect record.");
    if (record && gameId && this.observationKind(record.id, gameId)) {
      if (!this.gameKey) {
        const owner = record.id.split(":")[2];
        if (payloadPlayer !== undefined) this.gameKey = `${gameId}:${payloadPlayer}`;
        else if (record.own === true && /^\d+$/.test(owner ?? "")) this.gameKey = `${gameId}:${owner}`;
      }
      if (this.gameOfKey() === gameId) record = this.track(record);
    }
    let remembered = false;
    if (!record) {
      const prior = this.rememberedForInspect(args, payload);
      if (prior) {
        remembered = true;
        record = {
          ...prior,
          visibility: prior.visibility === "visible" ? "stale" : prior.visibility,
          currentPresence: "unknown",
          remembered: true,
          staleReason: "Live inspect did not observe this record; returned accumulated last-known data only.",
        };
      }
    }
    const unavailable = record
      ? (remembered
        ? { record: "Live state unavailable; returning accumulated last-known data with explicit staleness." }
        : (response.unavailable ?? {}))
      : { record: "Not observed by this player, no longer controlled, or ID belongs to another loaded game. Unseen live state is never queried." };
    return {
      gameId,
      turn: payload.turn ?? null,
      kind: payload.kind ?? null,
      status: payload.status ?? (remembered ? "remembered" : record ? "observed" : "not_observed"),
      record,
      unavailable,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
    await Promise.allSettled([this.queue, this.popupQueue]);
    this.loaded.clear();
    this.missingContexts.clear();
    this.records.clear();
    this.fingerprints.clear();
  }
}
