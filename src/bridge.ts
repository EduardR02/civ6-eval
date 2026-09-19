import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Arguments, BridgeOptions } from "./contracts";
import {
  closeSubmittedCongress,
  dismissPopup,
  observePopups,
  popupCatalog,
  sameContent,
  type CongressCloseResult,
  type PopupContent,
  type PopupInvoker,
  type PopupObservation,
} from "./bridge/popups";
import { TunerTransport } from "./bridge/transport";

export type { BridgeOptions } from "./contracts";

/**
 * Constructor options owned by this file: the host callback is part of the presentation boundary,
 * not of the transport contract. contracts.ts stays host-owned.
 */
export interface PopupBridgeOptions {
  /**
   * Awaited with the full captured observation before any automatic dismissal. The host archives
   * the observation durably here; throwing aborts the whole boundary before anything is closed.
   * It must not call back into this bridge: the boundary holds the bridge's serialization queue.
   * When it is absent, nothing informational is ever dismissed automatically.
   */
  onInformationalPopup?: (observation: PopupObservation) => Promise<void>;
}

/** What one presentation boundary did, and what it deliberately left alone. */
export interface PresentationReport {
  /** Every popup that was active or visible while the boundary ran, latest observation per id. */
  observed: PopupObservation[];
  /** Full observations handed to the host callback before their screen was closed. */
  presented: PopupObservation[];
  /** Popup ids closed through their exact native handler. */
  dismissed: string[];
  /** Popup ids whose native handler acknowledged one item and immediately raised the next from the same screen. */
  advanced: string[];
  /** Popup ids that left the screen by themselves (native auto-close) while the boundary ran. */
  resolved: string[];
  /** Popup ids still on screen, each with the reason it was not closed. */
  remaining: Array<{ id: string; reason: string }>;
  /** The host callback threw; the boundary stopped immediately and closed nothing further. */
  callbackFailures: Array<{ id: string; error: string }>;
  /** Contexts that could not be probed; an unavailable context is never an absent popup. */
  unavailable: Record<string, unknown>;
  /** The bounded drain ran out of rounds with an informational screen still presenting. */
  more: boolean;
}

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
  "civ.action", "civ.rules", "civ.civilopedia", "civ.keybinds", "civ.dismiss_notifications",
] as const;

/**
 * Host-owned admission check for one call: it runs after every awaited connection, context load
 * and probe, and immediately before each native exchange is admitted, so an abort that arrives
 * while the bridge is still setting up or observing prevents any native mutation. It must be
 * cheap and synchronous; throwing aborts the call.
 */
type RequestGuard = () => void;

/**
 * Wraps a guard failure so it can never be mistaken for a screen problem: the popup observers
 * rethrow this instead of reporting a degraded resource, because an aborted call must stop, not
 * continue with fewer popups.
 */
export class AuthorizationAborted extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AuthorizationAborted";
  }
}

/** Runs the host guard, keeping an abort distinguishable from a screen failure. */
function admit(authorize?: RequestGuard): void {
  if (authorize === undefined) return;
  try {
    authorize();
  } catch (error) {
    throw new AuthorizationAborted(error);
  }
}

/** Snapshot sections. The Lua owns what each contains; the host owns rejecting unknown names cheaply. */
const SECTIONS = ["core", "economy", "units", "cities", "map", "research", "culture", "resources",
  "diplomacy", "governors", "religion", "trade", "victory", "notifications", "configuration"] as const;
const DEFAULT_SECTIONS = ["core", "units", "cities", "notifications"];
const REGION_KEYWORDS = ["owned", "visible", "all"];
const MAX_BATCH = 64;
const COVERAGE_LEVELS = ["complete", "partial", "omitted"] as const;
/** InGame Lua modules, loaded in order: primitives, then observations, actions, options, diplomacy, decisions. */
const UI_MODULES = ["common", "state", "actions", "options", "diplomacy", "decisions"] as const;
/** Bounded rounds of the presentation drain; a native close can raise its next queued item instantly. */
const MAX_PRESENTATION_ROUNDS = 4;

/**
 * True when THIS call's own result reports the congress ballot submission: either directly, or as
 * an item of a batch (the submit may be anywhere in `results`, and the close is about the submit
 * that just happened, never about a later review surface).
 */
function congressSubmitted(result: Record<string, unknown>): boolean {
  if (result.sessionSubmitted === true) return true;
  for (const key of ["results", "items"]) {
    const list = result[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).sessionSubmitted === true) return true;
    }
  }
  return false;
}

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

/** Lua tags a mutation error with what is known about submission (lua/common.lua A.entry). */
const REFUSED_MARKER = "ASTRA_REFUSED: ";
const UNKNOWN_MARKER = "ASTRA_UNKNOWN: ";

/** Lua errors carry a `[string "..."]:line:` chunk reference; it is not part of the reason. The
 *  chunk name can itself contain escaped quotes, so escaping is part of the match. */
function luaReason(text: string): string {
  return text.replaceAll(REFUSED_MARKER, "").replaceAll(UNKNOWN_MARKER, "")
    .replace(/\[string "(?:[^"\\]|\\.)*"\]:\d+:\s*/g, "").trim();
}

/**
 * A refusal is an error the trusted Lua tagged as raised before any native request was sent, so the
 * outcome is known: nothing happened. Anything else (transport failure, a request that already
 * reached the engine, a Lua error after one did) stays an unknown outcome and is never replayed.
 */
function refusalReason(error: unknown): string | undefined {
  const text = message(error);
  const at = text.indexOf(REFUSED_MARKER);
  if (at < 0) return undefined;
  return luaReason(text.slice(at + REFUSED_MARKER.length)) || "The request was refused before submission.";
}

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
 * Host-enforced argument bounds, published by civ.probe. This describes only what the bridge
 * validates and what a method returns; presence, codec support and current legality are three
 * different things and are never collapsed here. Action and operation catalogues come from the
 * Lua-side runtime generator, so the probe reports what that call advertised - an advertised
 * action can still be refused by the ruleset, and an action missing from one call is missing from
 * that call, not proven absent from the ruleset.
 */
const METHOD_SCHEMA: Record<string, string> = {
  "civ.probe": "{verbose?:boolean}; capabilities as advertised by the runtime generator on this call (not a ruleset claim), popup catalog from the fixed reviewed screen adapters, contexts only with verbose=true",
  "civ.snapshot": `{include?:string|string[] of ${SECTIONS.join("|")}|all (default ${DEFAULT_SECTIONS.join(",")}), region?:"owned"|"visible"|"all"|{x,y,radius<=128}|{x0,y0,x1,y1}, edges?:boolean, detail?:"summary"|"full", mapOffset?:integer>=0, mapLimit?:1..100000}; omitted sections are absent, not empty; coverage={units,cities,map} says complete|partial|omitted per queried collection; region and mapOffset/mapLimit make map partial`,
  "civ.inspect": "{id:string} or {x:integer,y:integer} (+kind?:string, edges?:boolean); single-record lookup, never a full-map read; a live miss returns the remembered record with lastSeenTurn and remembered=true instead of scanning the map",
  "civ.options": `{unitId?:string} | {cityId?:string} | {}; operation?:string (unit: short name from its list; city: item name, place_district, citizens or tile_purchase; player scope: research, civic, government or policies), targets?:boolean, detail?:"summary"|"full", offset?:integer>=0, limit?:1..500`,
  "civ.path": "{unitId:string,x:integer,y:integer}; engine-authorised per-plot path and turn data with busy=true and honest truncation when the engine or bounds cut it",
  "civ.decisions": `{kind?:string, id?:string, popups?:"all"|"none", detail?:"summary"|"full", offset?:integer>=0, limit?:1..500}; pending gameplay decisions with stable ids plus fixed-context popup observations; popups:"none" skips popup-context probing on list calls; popup ids resolve against the adapter registry only; every rendered popup reports its captured text (content/contentStatus) and whether a lossless automatic close is possible (autoDismissible, autoDismissReason)`,
  "civ.decide": `{id:string,choice?:scalar,choices?:array of <=${MAX_BATCH} selections}; answers one gameplay decision, or closes one reviewed popup by its popup: id (choice/choices rejected for popups). A popup close runs only that screen's own native close handler: it chooses nothing, and gameplay choosers (event, promotion, raze, espionage, map pin, deals) are never closed. Presence and, for an automatic close, byte-identical captured content are re-checked inside the same screen invocation; then it reports advanced=true when the screen immediately shows its next queued item. Submission is not completion, and a thrown-away acknowledgement is never replayed. A request refused before it reached the engine returns status="refused" with reasons; only an already-sent request reports an unknown outcome`,
  "civ.action": `{type:string,...} or {actions:[{type,...}] (<=${MAX_BATCH}, end_turn last only), expectedTurn?:integer, stopOnError?:boolean}; submission is not completion and a batch is never replayed. A request refused before it reached the engine returns status="refused" (batch items: status="refused", never "unknown"); only an already-sent request reports an unknown outcome. A congress submit that reports sessionSubmitted=true also runs the native ClosePopup teardown of the session screen and reports it separately as popupClose (closed / already-closed / not-the-submitted-surface); an unknown outcome is never followed by that teardown, and a failed teardown never replaces the submitted result`,
  "civ.rules": "{table?:allowlisted GameInfo table,where?:exact scalar equality object,offset?:integer>=0,limit?:1..500}; omit table to list",
  "civ.civilopedia": "{query?:string,section?:string,id?:string,offset?:integer>=0,limit?:1..100}; no arguments lists sections; query searches the active Civilopedia's titles/ids/search terms; id reads one page (section disambiguates a repeated id). A page is produced by the game's own page code, so its chapters and stat boxes are what the screen shows, with narrative history/flavor omitted; when a page's layout cannot run in this state the same page is answered from the ruleset's own rows and chapters instead, and provenance.source says which happened (layout|data). Costs are the page's reference values; civ.options reports live prices and legality. No screen is opened, focused or navigated.",
  "civ.keybinds": "{category?:string,offset?:integer>=0,limit?:1..100000}; the game's live keyboard bindings from the Input manager",
  "civ.dismiss_notifications": "{}; dismisses every dismissable notification in the on-screen rail; cosmetic only, never a modal choice",
};

/** Fixed read/action bridge. Transport source execution is deliberately private. */
export class CivBridge {
  private readonly options: Required<BridgeOptions>;
  private readonly transport = new TunerTransport();
  private queue: Promise<unknown> = Promise.resolve();
  /** Single-flight gate for every FireTuner exchange; see gated(). */
  private gate: Promise<unknown> = Promise.resolve();
  private closed = false;
  private states = new Map<number, string>();
  private identity = "";
  private loaded = new Set<number>();
  /** Loaded UI module sources, cached across context reloads; cleared never (source text is immutable). */
  private uiSources?: Promise<string>;
  private ruleSource?: Promise<string>;
  private civilopediaSource?: Promise<string>;
  private records = new Map<string, Observation>();
  private fingerprints = new Map<string, { hash: string; revision: number }>();
  private gameKey = "";
  private snapshotRevision = 0;
  private statesRefresh?: Promise<void>;
  /** Context names known not to exist after a shared refresh; avoids one LSQ round trip per popup. */
  private missingContexts = new Set<string>();
  private readonly onInformationalPopup?: (observation: PopupObservation) => Promise<void>;

  constructor(options: BridgeOptions & PopupBridgeOptions = {}) {
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
    if (options.onInformationalPopup !== undefined && typeof options.onInformationalPopup !== "function") {
      throw new Error("onInformationalPopup must be a function that archives one popup observation.");
    }
    this.onInformationalPopup = options.onInformationalPopup;
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

  private async ensureConnected(authorize?: RequestGuard): Promise<void> {
    admit(authorize);
    if (this.transport.connected) return;
    // Connect, handshake and the state list are one exclusive transport exchange: nothing else may
    // send or receive while a half-open connection is being brought up.
    await this.gated(async () => {
      admit(authorize);
      this.loaded.clear();
      this.states.clear();
      this.missingContexts.clear();
      this.statesRefresh = undefined;
      await this.transport.connect(this.options.host, this.options.port, this.options.timeoutMs);
      try {
        await this.transport.send(4, "APP:");
        this.identity = await this.handshakeReply("APP");
        await this.listStates();
      } catch (error) {
        this.transport.close();
        throw error;
      }
    });
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

  private refreshStates(authorize?: RequestGuard): Promise<void> {
    return this.gated(() => {
      admit(authorize);
      return this.listStates();
    });
  }

  private async listStates(): Promise<void> {
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
  private async contextIndex(name: string, ui: boolean, authorize?: RequestGuard, unavailableHint?: string): Promise<number> {
    let entry = this.contextEntry(name);
    if (!entry) {
      if (this.missingContexts.has(name)) {
        throw new Error(unavailableHint ?? `FireTuner Lua context ${name} is not available in this application.`);
      }
      this.statesRefresh ??= this.refreshStates(authorize).finally(() => { this.statesRefresh = undefined; });
      await this.statesRefresh;
      entry = this.contextEntry(name);
      if (!entry) {
        this.missingContexts.add(name);
        throw new Error(unavailableHint ?? `FireTuner Lua context ${name} is not available in this application.`);
      }
      this.missingContexts.delete(name);
    }
    const index = entry[0];
    if (!this.loaded.has(index)) {
      const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
      const session = randomUUID();
      const tail = `\nAstraCiv.session=AstraCiv.session or ${luaLiteral(session)}\nAstraCiv.emit(${luaLiteral(marker)},function() return {version=AstraCiv.version,gameId=AstraCiv.session} end)`;
      if (ui) {
        const source = await (this.uiSources ??= Promise.all(UI_MODULES.map(module =>
          readFile(new URL(`../lua/${module}.lua`, import.meta.url), "utf8")))
          // Each file has module-private locals; sharing one lexical scope exceeds Civ's
          // Lua register/local limit and can also accidentally bind another module's helpers.
          .then(sources => sources.map(source => `do\n${source}\nend`).join("\n")));
        await this.collect(index, `${source}${tail}`, marker, false, authorize);
      } else if (name === "CivilopediaScreen") {
        const source = await (this.civilopediaSource ??= Promise.all(["common", "civilopedia"].map(module =>
          readFile(new URL(`../lua/${module}.lua`, import.meta.url), "utf8")))
          .then(sources => sources.map(source => `do\n${source}\nend`).join("\n")));
        await this.collect(index, `${source}${tail}`, marker, false, authorize);
      } else {
        // The rules context gets the shared primitives only, and it has its own cache: a
        // common-only load must never satisfy a later InGame load that needs every module.
        const source = await (this.ruleSource ??= readFile(new URL("../lua/common.lua", import.meta.url), "utf8"));
        await this.collect(index, `${source}${tail}`, marker, false, authorize);
      }
      this.loaded.add(index);
    }
    return index;
  }

  /**
   * Self-contained evaluator for screen contexts where AstraCiv is deliberately absent. It mirrors
   * the trusted framing exactly: the same marker:part:count:hex chunk lines and the same
   * {ok,result|error} envelope AstraCiv.emit produces (lua/common.lua:123-139), with a bounded
   * JSON encoder. A screen-side Lua error becomes a received ok=false envelope, so one broken
   * screen probe reports its own error instead of tearing down the shared transport.
   */
  private static readonly POPUP_EVALUATOR = String.raw`local ok, value = pcall(function() return (%BODY%) end)
local response
if ok then response = { ok = true, result = value } else response = { ok = false, error = tostring(value) } end
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
local text = encode(response, 0)
local chunks = math.max(1, math.ceil(#text / 2500))
for i = 1, chunks do
  local part = text:sub((i - 1) * 2500 + 1, i * 2500)
  local hex = part:gsub('.', function(c) return string.format('%02x', string.byte(c)) end)
  print(__MARKER__ .. ':' .. i .. ':' .. chunks .. ':' .. hex)
end
print(__MARKER__ .. ':DONE')`;

  /**
   * Popup contexts are evaluated only through fixed bodies supplied by popups.ts. The evaluator is
   * not exposed by RPC. observePopups starts its probes in parallel, and popupInvoker may load a
   * context first; both kinds of exchange take the single-flight transport gate below, so parallel
   * probes can never collide with each other or with a request that is already in flight.
   */
  private popupInvoker(authorize?: RequestGuard): PopupInvoker {
    return async (contextName: string, body: string) => {
      if (typeof contextName !== "string" || !contextName || contextName.length > 256) {
        throw new Error("Popup invoker received an invalid context name.");
      }
      // A guarded close embeds up to 48 KiB of captured text plus field paths, expanded into
      // Lua byte escapes. This trusted generated code is not a player RPC argument: keep
      // a separate byte bound, comfortably below the transport's 8 MiB frame limit.
      if (typeof body !== "string" || !body || Buffer.byteLength(body, "utf8") > 1024 * 1024 || body.includes("\0")) {
        throw new Error("Popup invoker body is empty, contains NUL, or exceeds 1 MiB.");
      }
      const index = await this.contextIndex(contextName, false, authorize);
      const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
      // Every marker occurrence is substituted. A leftover literal marker would be a nil global in the
      // game, so the DONE line raised a Lua error instead of closing the response ("Socket is closed"
      // plus "FireTuner Lua error" on every popup probe).
      const code = CivBridge.POPUP_EVALUATOR
        .replaceAll("__MARKER__", () => luaLiteral(marker))
        .replace("%BODY%", () => body);
      // A screen whose own Lua raised degrades that one observation; the shared transport and the
      // other screens' probes keep running.
      const response = await this.collect(index, code, marker, true, authorize);
      if (!response.ok) throw new Error(luaReason(`Popup probe failed in ${contextName}: ${response.error ?? "the screen's Lua raised."}`));
      return response.result ?? null;
    };
  }

  /**
   * FireTuner allows exactly one outstanding command/receive per connection: a second concurrent
   * receive is refused outright (TunerTransport.receive), and the refused request tears the shared
   * transport down. Every exchange therefore takes this single gate — one Lua request, one LSQ
   * refresh, one popup probe, one context load — so callers may run in parallel without interleaving
   * frames or stealing each other's reply.
   */
  private gated<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(() => fn());
    this.gate = run.catch(() => undefined);
    return run;
  }

  private collect(index: number, code: string, marker: string, degrade = false, authorize?: RequestGuard): Promise<Envelope> {
    // The guard runs inside the gate, immediately before the exchange is admitted: an abort during
    // any earlier await (connect, LSQ, context load, probe) stops the mutation here.
    return this.gated(() => {
      admit(authorize);
      return this.exchange(index, code, marker, degrade);
    });
  }

  private async exchange(index: number, code: string, marker: string, degrade = false): Promise<Envelope> {
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
          // A received ok=false envelope is a known outcome: the request reached the screen's Lua
          // and raised there. Screen probes hand it back as that screen's own degraded status, while
          // every trusted request keeps failing loudly.
          if (!envelope.ok && !degrade) throw new Error(envelope.error ?? "Trusted Lua request failed.");
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

  private async invoke(method: string, args: Arguments, authorize?: RequestGuard): Promise<Envelope> {
    const core = method === "rules";
    admit(authorize);
    const pedia = method === "civilopedia";
    const index = await this.contextIndex(pedia ? "CivilopediaScreen" : core ? "GameCore_Tuner" : "InGame", !core && !pedia, authorize);
    const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
    return this.collect(index, `AstraCiv.emit(${luaLiteral(marker)},function() return AstraCiv.${method}(${luaLiteral(args)}) end)`, marker, false, authorize);
  }

  /**
   * The complete no-connection preflight request() performs: argument checks plus the exact Lua
   * literal encoding (nesting depth, 32 KiB per string, JSON-value shape) and the 256 KiB encoded
   * bound. Public so the host can reject invalid civ arguments before any automatic UI change;
   * request() runs this same path once and never encodes twice.
   */
  static validateRequest(method: string, args: Arguments): void {
    CivBridge.encodeArguments(method, args);
  }

  private static encodeArguments(method: string, args: Arguments): string {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Bridge arguments must be an object.");
    CivBridge.validateArguments(method, args);
    const encoded = luaLiteral(args);
    if (encoded.length > 256 * 1024) throw new Error("Bridge arguments exceed 256 KiB encoded bound.");
    return encoded;
  }

  /** Argument bounds per method; the encoding preflight lives in encodeArguments. */
  private static validateArguments(method: string, args: Arguments): void {
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
      case "civ.civilopedia":
        for (const key of Object.keys(args)) {
          if (!["query", "section", "id", "offset", "limit"].includes(key)) throw new Error(`Unknown civ.civilopedia argument: ${key}`);
        }
        for (const key of ["query", "section", "id"]) {
          const value = args[key];
          if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 256)) {
            throw new Error(`civilopedia.${key} must be a nonempty string of at most 256 characters.`);
          }
        }
        if (args.query !== undefined && args.id !== undefined) throw new Error("Civilopedia takes query or id, not both.");
        if (args.offset !== undefined) requireInteger(args.offset, "offset", 0, 1_000_000);
        if (args.limit !== undefined) requireInteger(args.limit, "limit", 1, 100);
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

  request(method: string, args: Arguments = {}, authorize?: RequestGuard): Promise<unknown> {
    admit(authorize);
    if (!(BRIDGE_METHODS as readonly string[]).includes(method)) {
      return Promise.reject(new Error(`Unsupported bridge method ${method}; no arbitrary Lua or SQL RPC exists. Available: ${BRIDGE_METHODS.join(", ")}.`));
    }
    let encoded: string;
    try {
      encoded = CivBridge.encodeArguments(method, args);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (encoded.length > 256 * 1024) return Promise.reject(new Error("Bridge arguments exceed 256 KiB encoded bound."));
    return this.serialized(async () => {
      admit(authorize);
      await this.ensureConnected(authorize);
      // The connect handshake and the state list are awaits the host may have passed during; the
      // call only proceeds if it is still authorized at this point.
      admit(authorize);
      switch (method) {
        case "civ.probe": return this.probe(args, authorize);
        case "civ.snapshot": return this.snapshot(args, authorize);
        case "civ.inspect": return this.inspect(args, authorize);
        case "civ.options": return this.read("options", args, authorize);
        case "civ.path": return this.read("path", args, authorize);
        case "civ.decisions": return this.decisions(args, authorize);
        case "civ.rules": return this.read("rules", args, authorize);
        case "civ.civilopedia": return this.read("civilopedia", args, authorize);
        case "civ.keybinds": return this.read("keybinds", args, authorize);
        case "civ.dismiss_notifications": return this.read("dismiss_notifications", args, authorize);
        case "civ.decide": return this.decide(args, authorize);
        case "civ.action": return this.mutation("action", args, authorize);
      }
      throw new Error(`Unsupported bridge method ${method}; no arbitrary Lua or SQL RPC exists.`);
    });
  }

  /** Capabilities come from A.capabilities at call time; the bridge never publishes a static action table. */
  private async probe(args: Arguments, authorize?: RequestGuard): Promise<unknown> {
    const verbose = args.verbose === true;
    await this.refreshStates(authorize);
    const info = this.connectionInfo(verbose);
    const unavailable: Record<string, unknown> = {};
    let game: unknown = null;
    let capabilities: Record<string, unknown> = {};
    if ([...this.states.values()].includes("InGame")) {
      try {
        const response = await this.invoke("turnState", {}, authorize);
        game = response.result;
        Object.assign(unavailable, response.unavailable ?? {});
      } catch (error) {
        unavailable.game = message(error);
      }
      try {
        const response = await this.invoke("capabilities", {}, authorize);
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
        capabilities: "What the runtime generator advertised on this call: action types and operations it can currently describe, not a claim about the ruleset. Missing means not advertised now (unknown, not absent); advertised means dispatchable through a codec, not currently legal. civ.options reports current legality and refusals.",
        popupCatalog: "Fixed reviewed screen adapters. dismissable there means an explicit civ.decide close runs that screen's own native handler (information-only screens plus the dismiss-only congress, governor and great-people screens); autoDismissible on an observation additionally requires captured, untruncated content and is never offered for a gameplay choice.",
        submission: "civ.action and civ.decide return accepted/submitted, never completed. A partially executed batch names stoppedAt and is never replayed.",
      },
    };
  }

  /** `unavailable: {}` was riding on four results in five, which taught the model to skip the key on
   *  the fifth - the one carrying a real degraded-observation report. Present means something is
   *  actually unavailable. */
  private static withDiagnostics<T extends object>(body: T, unavailable: Record<string, unknown>): T {
    return Object.keys(unavailable).length ? { ...body, unavailable } : body;
  }

  private async read(name: string, args: Arguments, authorize?: RequestGuard, arrayKey?: string): Promise<unknown> {
    const response = await this.invoke(name, args, authorize);
    const result = response.result;
    const unavailable = response.unavailable ?? {};
    if (Array.isArray(result)) return CivBridge.withDiagnostics({ [arrayKey ?? "result"]: result }, unavailable);
    if (!result || typeof result !== "object") return CivBridge.withDiagnostics({ result: result ?? null }, unavailable);
    return CivBridge.withDiagnostics({ ...(result as object) }, unavailable);
  }

  private async decisions(args: Arguments, authorize?: RequestGuard): Promise<unknown> {
    const id = typeof args.id === "string" && args.id.startsWith("popup:") ? args.id : undefined;
    if (id !== undefined) {
      const observations = await observePopups(this.popupInvoker(authorize), { id });
      const popup = observations[0]!;
      return CivBridge.withDiagnostics(
        { decisions: [popup], total: 1, offset: 0, more: false },
        popup.status === "ok" ? {} : { popup: { [popup.id]: popup.error ?? popup.status } });
    }

    const response = await this.invoke("decisions", args, authorize);
    const observations = await observePopups(this.popupInvoker(authorize), args.popups === "none" ? { kinds: [] } : undefined);
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
      return CivBridge.withDiagnostics({ decisions, total: decisions.length, offset: 0, more: false }, unavailable);
    }
    if (!result || typeof result !== "object") {
      const decisions = [...active];
      return CivBridge.withDiagnostics({ decisions, total: decisions.length, offset: 0, more: false }, unavailable);
    }
    const output = CivBridge.withDiagnostics({ ...(result as Record<string, unknown>) }, unavailable) as Record<string, unknown>;
    const native = Array.isArray(output.decisions) ? output.decisions : [];
    output.decisions = [...native, ...active];
    if (typeof output.total === "number" && output.more !== true) output.total += active.length;
    else if (output.total === undefined) output.total = (output.decisions as unknown[]).length;
    if (output.offset === undefined) output.offset = 0;
    if (output.more === undefined) output.more = false;
    return output;
  }

  /**
   * One presentation boundary. Every information-only screen that is currently rendered is
   * captured, handed to the host callback (which archives it durably and may abort by throwing),
   * revalidated immediately before the close, and only then closed through its exact native
   * handler. A native close can raise the next queued item from the same screen: those are
   * re-observed and re-presented in bounded rounds, so a successor is never acknowledged before
   * its content is preserved. Choosers, diplomacy/congress, the generic modal, the advisor and the
   * game-over screen are only reported. Without a callback nothing is dismissed automatically, and
   * the first callback failure stops the boundary instead of closing anything else.
   *
   * `authorize` is the final admission check the host owns: it runs at the start of the boundary
   * and again immediately before every native close, inside the serialized section, so an abort
   * that arrives while the screen is still being probed or archived prevents any UI mutation.
   * Throwing from it aborts the boundary; nothing is closed afterwards and the guard failure is
   * never folded into a popup error result.
   */
  preparePresentation(authorize?: RequestGuard): Promise<PresentationReport> {
    return this.serialized(async () => {
      admit(authorize);
      await this.ensureConnected();
      return this.present(authorize);
    });
  }

  private async present(authorize?: RequestGuard): Promise<PresentationReport> {
    const invoke = this.popupInvoker(authorize);
    const seen = new Map<string, PopupObservation>();
    const presented: PopupObservation[] = [];
    const dismissed: string[] = [];
    const advanced: string[] = [];
    const resolved: string[] = [];
    const callbackFailures: Array<{ id: string; error: string }> = [];
    const remaining = new Map<string, string>();
    const lastPresented = new Map<string, PopupContent>();
    let pending: string[] = [];
    let more = false;

    for (let round = 1; ; round++) {
      const observations = round === 1
        ? await observePopups(invoke)
        : await Promise.all(pending.map(async id => (await observePopups(invoke, { id }))[0]!));
      pending = [];

      const work: PopupObservation[] = [];
      for (const observation of observations) {
        seen.set(observation.id, observation);
        if (observation.status !== "ok") {
          if (round > 1) remaining.set(observation.id, `The screen could not be probed while draining it: ${observation.error ?? observation.status}.`);
          continue;
        }
        if (!observation.active && !observation.visible) {
          if (round > 1) resolved.push(observation.id);
          continue;
        }
        if (observation.autoDismissible) {
          const prior = round > 1 ? lastPresented.get(observation.id) : undefined;
          if (prior !== undefined && observation.content !== null && sameContent(prior, observation.content)) {
            // A native acknowledgement that raises the same text again is not a new item; the
            // bridge archives it once and never repeats the close on its own.
            remaining.set(observation.id, "The screen shows the same text again after its native handler acknowledged one item, so nothing further was closed automatically.");
            continue;
          }
          work.push(observation);
        } else remaining.set(observation.id, observation.autoDismissReason ?? `${observation.context} is never closed automatically.`);
      }
      if (work.length === 0) break;
      if (round > MAX_PRESENTATION_ROUNDS) {
        more = true;
        for (const observation of work) remaining.set(observation.id, `The bounded presentation drain stopped at ${MAX_PRESENTATION_ROUNDS} rounds with ${observation.context} still presenting; nothing was closed on this pass.`);
        break;
      }
      if (this.onInformationalPopup === undefined) {
        for (const observation of work) {
          remaining.set(observation.id, "No onInformationalPopup callback is configured, so nothing is dismissed automatically.");
        }
        break;
      }

      let progressed = false;
      for (const observation of work) {
        // The host callback may have run long enough for the bridge to be closed (shutdown or
        // control change); nothing further is closed then, and the rest is reported untouched.
        if (this.closed) {
          for (const item of work) {
            remaining.set(item.id, "The bridge was closed while the boundary was presenting; nothing was closed and the screen was not touched.");
          }
          break;
        }
        const content = observation.content!;
        try {
          await this.onInformationalPopup(observation);
        } catch (error) {
          callbackFailures.push({ id: observation.id, error: message(error) });
          remaining.set(observation.id, `The host callback failed, so nothing was closed: ${message(error)}`);
          for (const other of work) {
            if (other.id !== observation.id) {
              remaining.set(other.id, "The presentation boundary stopped after the host callback failed; this screen was not touched.");
            }
          }
          return this.report(seen, presented, dismissed, advanced, resolved, remaining, callbackFailures, more);
        }
        presented.push(observation);
        lastPresented.set(observation.id, content);
        // Final admission check: the host may have been cancelled while this screen was probed and
        // archived, and that must prevent the native close. A throw here aborts the boundary.
        admit(authorize);
        const result = await dismissPopup(observation.id, invoke, content);
        if (result.dismissed) {
          dismissed.push(observation.id);
          remaining.delete(observation.id);
          progressed = true;
        } else if (result.advanced) {
          advanced.push(observation.id);
          pending.push(observation.id);
          remaining.set(observation.id, "Its native handler acknowledged one item and raised the next from the same screen; the next item is presented before it is acknowledged in turn.");
          progressed = true;
        } else if (result.changed) {
          pending.push(observation.id);
          remaining.set(observation.id, "Its content changed after it was presented, so the native close ran nothing; the new content is captured before it is closed.");
          progressed = true;
        } else if (result.gone) {
          resolved.push(observation.id);
          remaining.delete(observation.id);
          progressed = true;
        } else {
          remaining.set(observation.id, result.note ?? result.error ?? `The native close did not complete (status ${result.status}).`);
        }
      }
      if (!progressed) break;
    }
    return this.report(seen, presented, dismissed, advanced, resolved, remaining, callbackFailures, more);
  }

  private report(
    seen: Map<string, PopupObservation>,
    presented: PopupObservation[],
    dismissed: string[],
    advanced: string[],
    resolved: string[],
    remaining: Map<string, string>,
    callbackFailures: Array<{ id: string; error: string }>,
    more: boolean,
  ): PresentationReport {
    const unavailable: Record<string, unknown> = {};
    const contextMissing = [...seen.values()].filter(item => item.status === "context-missing").map(item => item.id);
    const errors = [...seen.values()].filter(item => item.status === "error").map(item => ({ id: item.id, error: item.error }));
    if (contextMissing.length) unavailable.contextMissing = contextMissing;
    if (errors.length) unavailable.errors = errors;
    const observed = [...seen.values()].filter(item => item.status === "ok" && (item.active || item.visible));
    return {
      observed,
      presented,
      dismissed,
      advanced,
      resolved,
      remaining: [...remaining].map(([id, reason]) => ({ id, reason })),
      callbackFailures,
      unavailable,
      more,
    };
  }

  private async decide(args: Arguments, authorize?: RequestGuard): Promise<unknown> {
    if (typeof args.id === "string" && args.id.startsWith("popup:")) {
      const result = await dismissPopup(args.id, this.popupInvoker(authorize));
      return { ...result, accepted: result.dismissed, completed: result.dismissed, unavailable: {} };
    }
    return this.mutation("decide", args, authorize);
  }

  private async mutation(name: string, args: Arguments, authorize?: RequestGuard): Promise<unknown> {
    const label = name === "decide" ? "Decision" : "Action";
    let response: Envelope;
    try {
      response = await this.invoke(name, args, authorize);
    } catch (error) {
      const refused = refusalReason(error);
      if (refused === undefined) {
        const text = message(error);
        throw new Error(`${label} failed or its acknowledgement was lost; outcome may be unknown. It was NOT replayed. Read a new snapshot before deciding whether to retry. ${luaReason(text) || text}`);
      }
      return {
        accepted: false, completed: false, status: "refused", reasons: [refused], unavailable: {},
        note: "Refused before submission: nothing reached the engine, so there is no unknown outcome here. Fix the stated reason and submit again.",
      };
    }
    const result = response.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return { result: result ?? null, unavailable: response.unavailable ?? {} };
    }
    const output: Record<string, unknown> = { ...(result as Record<string, unknown>), unavailable: response.unavailable ?? {} };
    // The model's own explicit congress submit authorizes the screen teardown the native Accept
    // performs (WorldCongressPopup.lua OnAccept -> ClosePopup). Only a known submitted outcome
    // reaches this point: an unknown outcome throws above and is never followed by a close, and a
    // refused request has nothing to tear down. The close is reported separately and its failure
    // never replaces the submitted result.
    if (congressSubmitted(output)) {
      let popupClose: CongressCloseResult;
      try {
        popupClose = await closeSubmittedCongress(this.popupInvoker(authorize));
      } catch (error) {
        popupClose = {
          id: "popup:world-congress", status: "error", error: message(error),
          note: "The submitted result stands unchanged; the congress screen could not be re-probed, so close it explicitly with civ.decide if it is still up.",
        };
      }
      output.popupClose = popupClose;
    }
    return output;
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

  private async snapshot(args: Arguments, authorize?: RequestGuard): Promise<Snapshot> {
    const response = await this.invoke("snapshot", args, authorize);
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

    // What this response covers is data and stays. What "partial" and "last-known" mean is contract:
    // the system prompt and civ.probe state it once, and it was being restated on every snapshot.
    // `complete` is the flag that carries the invariant; the paragraph did not add to it.
    snapshot.knowledge = {
      sections: declaredSections,
      coverage,
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
  private async inspect(args: Arguments, authorize?: RequestGuard): Promise<unknown> {
    const response = await this.invoke("inspect", args, authorize);
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
    await Promise.allSettled([this.queue, this.gate]);
    this.loaded.clear();
    this.missingContexts.clear();
    this.records.clear();
    this.fingerprints.clear();
  }
}
