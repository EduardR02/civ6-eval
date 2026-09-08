import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Arguments, BridgeOptions } from "./contracts";
import { TunerTransport } from "./bridge/transport";

export type { BridgeOptions } from "./contracts";
interface Envelope { ok: boolean; result?: unknown; error?: string; unavailable?: Record<string, unknown> }
interface Observation extends Record<string, unknown> { id: string; revision?: number; visibility?: string; own?: boolean; lastSeenTurn?: number | null }
interface Snapshot extends Record<string, unknown> {
  gameId: string; playerId: number; turn: number;
  cities: Observation[]; units: Observation[];
  map: { width: number; height: number; offset: number; more: boolean; tiles: Observation[] };
}
const MAX_RESPONSE = 16 * 1024 * 1024;
const ACTION_HELP = {
  move: { unitId: "game-qualified ID", x: "integer", y: "integer" },
  attack: { unitId: "ID", x: "integer", y: "integer", mode: "melee | ranged | air" },
  found: { unitId: "ID" },
  unit_operation: { unitId: "ID", operation: "MOVE_TO | RANGE_ATTACK | AIR_ATTACK | FOUND_CITY | FORTIFY | HEAL | SLEEP | SKIP_TURN | BUILD_IMPROVEMENT | REPAIR | REMOVE_FEATURE | HARVEST_RESOURCE | PILLAGE | COASTAL_RAID | SPREAD_RELIGION | REMOVE_HERESY | REBASE | SWAP_UNITS", x: "optional integer", y: "optional integer", improvement: "BUILD_IMPROVEMENT requires IMPROVEMENT_*" },
  unit_command: { unitId: "ID", command: "WAKE | CANCEL | UPGRADE | PROMOTE | DELETE | FORM_CORPS | FORM_ARMY | ENTER_FORMATION | EXIT_FORMATION", promotion: "PROMOTE requires PROMOTION_*", targetUnitId: "formation commands require ID" },
  production: { cityId: "ID", kind: "unit | building | district | project", item: "GameInfo type string", mode: "replace (default) | append", x: "placement x if needed", y: "placement y if needed" },
  purchase: { cityId: "ID", kind: "unit | building | district", item: "GameInfo type string", currency: "gold | faith", x: "placement x if needed", y: "placement y if needed" },
  research: { item: "TECH_*" }, civic: { item: "CIVIC_*" }, government: { item: "GOVERNMENT_*" },
  policies: { slots: "complete array of {slot: zero-based integer, policy: POLICY_*}" },
  unlock_policies: {}, city_attack: { cityId: "ID", x: "integer", y: "integer" }, end_turn: {},
};

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

/** Fixed read/action bridge. Transport source execution is deliberately private. */
export class CivBridge {
  private readonly options: Required<BridgeOptions>;
  private readonly transport = new TunerTransport();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private states = new Map<number, string>();
  private identity = "";
  private loaded = new Set<number>();
  private sources?: Promise<{ common: string; ui: string }>;
  private records = new Map<string, Observation>();
  private fingerprints = new Map<string, { hash: string; revision: number }>();
  private gameKey = "";
  private snapshotRevision = 0;

  constructor(options: BridgeOptions = {}) {
    this.options = { host: options.host ?? "127.0.0.1", port: options.port ?? 4318, timeoutMs: options.timeoutMs ?? 30_000 };
    if (!Number.isInteger(this.options.port) || this.options.port < 1 || this.options.port > 65535) throw new Error("Invalid FireTuner port.");
    if (!Number.isFinite(this.options.timeoutMs) || this.options.timeoutMs < 100 || this.options.timeoutMs > 300_000) throw new Error("FireTuner timeout must be 100..300000 ms.");
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
    return this.serialized(async () => { await this.ensureConnected(); return this.connectionInfo(); });
  }

  private async ensureConnected(): Promise<void> {
    if (this.transport.connected) return;
    this.loaded.clear();
    this.states.clear();
    await this.transport.connect(this.options.host, this.options.port, this.options.timeoutMs);
    try {
      await this.transport.send(4, "APP:");
      this.identity = await this.handshakeReply("APP");
      await this.refreshStates();
    } catch (error) { this.transport.close(); throw error; }
  }

  private async handshakeReply(kind: "APP" | "LSQ"): Promise<string> {
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      const frame = await this.transport.receive(deadline - Date.now());
      if (frame.payload.startsWith("ERR:")) throw new Error(frame.payload);
      if (frame.tag === 4 && frame.payload && !frame.payload.startsWith("O\0")) return frame.payload.replace(new RegExp(`^${kind}:`), "");
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
      if (/^\d+$/.test(token) && parts[index + 1]) { next.set(Number(token), parts[++index]!); continue; }
      const pair = /^(\d+)\s*[:=]\s*(.+)$/.exec(token);
      if (pair) next.set(Number(pair[1]), pair[2]!);
    }
    if (next.size === 0) throw new Error(`FireTuner returned an unrecognized Lua-state list: ${JSON.stringify(raw.slice(0, 400))}`);
    if (JSON.stringify([...next]) !== JSON.stringify([...this.states])) this.loaded.clear();
    this.states = next;
  }

  private connectionInfo() {
    return {
      connected: this.transport.connected, host: this.options.host, port: this.options.port, application: this.identity,
      contexts: [...this.states].map(([index, name]) => ({ index, name })),
      ready: [...this.states.values()].includes("InGame"),
      observationContext: "InGame (player visibility APIs)", rulesContext: "GameCore_Tuner", actionContext: "InGame (native requests)",
    };
  }

  private async context(core: boolean): Promise<number> {
    const name = core ? "GameCore_Tuner" : "InGame";
    let entry = [...this.states].find(([, state]) => state === name);
    if (!entry) { await this.refreshStates(); entry = [...this.states].find(([, state]) => state === name); }
    if (!entry) throw new Error(`FireTuner Lua context ${name} is not available. Load an active game, not the main menu, and retry.`);
    const index = entry[0];
    if (!this.loaded.has(index)) {
      this.sources ??= Promise.all(["common", "state", "actions"].map(module => readFile(new URL(`../lua/${module}.lua`, import.meta.url), "utf8")))
        .then(([common, state, actions]) => ({ common: common!, ui: state! + "\n" + actions! }));
      const source = await this.sources;
      const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
      const session = randomUUID();
      const code = `${source.common}\nAstraCiv.session=AstraCiv.session or ${luaLiteral(session)}\n${core ? "" : source.ui}\nAstraCiv.emit(${luaLiteral(marker)},function() return {version=AstraCiv.version,gameId=AstraCiv.session} end)`;
      await this.collect(index, code, marker);
      this.loaded.add(index);
    }
    return index;
  }

  private async collect(index: number, code: string, marker: string): Promise<Envelope> {
    const deadline = Date.now() + this.options.timeoutMs;
    const parts = new Map<number, Buffer>();
    let total = 0;
    let bytes = 0;
    await this.transport.send(3, `CMD:${index}:${code}`);
    try {
      while (Date.now() < deadline) {
        const frame = await this.transport.receive(deadline - Date.now());
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
        const part = Number(match[1]), count = Number(match[2]), hex = match[3]!;
        if (count < 1 || count > 6711 || part < 1 || part > count || hex.length % 2 || (total && count !== total)) throw new Error("Invalid FireTuner chunk sequence.");
        total = count;
        const chunk = Buffer.from(hex, "hex");
        const previous = parts.get(part);
        if (previous) { if (!previous.equals(chunk)) throw new Error("Conflicting duplicate response chunk."); continue; }
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE) throw new Error("FireTuner response exceeds 16 MiB bound.");
        parts.set(part, chunk);
      }
      throw new Error("FireTuner request timed out.");
    } catch (error) {
      this.transport.close();
      this.loaded.clear();
      throw error;
    }
  }

  private async invoke(method: string, args: Arguments): Promise<Envelope> {
    const index = await this.context(method === "rules");
    const marker = "ASTRA_" + randomUUID().replaceAll("-", "");
    return this.collect(index, `AstraCiv.emit(${luaLiteral(marker)},function() return AstraCiv.${method}(${luaLiteral(args)}) end)`, marker);
  }

  request(method: string, args: Arguments = {}): Promise<unknown> {
    if (!["civ.probe", "civ.snapshot", "civ.inspect", "civ.rules", "civ.action", "civ.dismiss_notifications", "civ.keybinds"].includes(method)) return Promise.reject(new Error(`Unsupported bridge method ${method}; no arbitrary Lua or SQL RPC exists.`));
    // Validate and bound data before connecting or submitting anything.
    const encoded = luaLiteral(args);
    if (encoded.length > 256 * 1024) return Promise.reject(new Error("Bridge arguments exceed 256 KiB encoded bound."));
    return this.serialized(async () => {
      await this.ensureConnected();
      if (method === "civ.probe") {
        await this.refreshStates();
        let game: unknown = null;
        let unavailable: unknown = {};
        if ([...this.states.values()].includes("InGame")) {
          try { const response = await this.invoke("turnState", {}); game = response.result; unavailable = response.unavailable; }
          catch (error) { unavailable = { game: error instanceof Error ? error.message : String(error) }; }
        }
        return { ...this.connectionInfo(), game, unavailable, methods: {
          "civ.snapshot": "{mapOffset?:integer,mapLimit?:1..100000}; full own state, currently visible tiles, cached last-known observations",
          "civ.inspect": "{id:string} or {x:integer,y:integer}; fresh fog-filtered snapshot lookup, never raw engine lookup",
          "civ.rules": "{table?:allowlisted GameInfo table,where?:exact scalar equality object,offset?:integer,limit?:1..500}; omit table to list",
          "civ.dismiss_notifications": "{None}; dismisses every dismissable notification in the on-screen rail (their content already arrives in snapshots; cosmetic only)",
          "civ.keybinds": "{category?:string,offset?:integer,limit?:integer}; the game's live keyboard bindings from the Input manager (name, category, key, alt)",
          "civ.action": { actions: ACTION_HELP, expectedTurn: "optional integer guard", outcome: "accepted is queued native request, completed remains false until observed; refresh returned separately", unsupported: "Use desktop GUI for specialized interactions; no cost bypass or strategic automation." },
        }, semantics: { gameId: "Loaded Lua-world instance UUID, stable over TCP reconnects; a reload gets a new instance", fog: "Only local player and visible entities are queried. Nonvisible tiles retain earlier observations, not live data. Enemy disappearance is not death.", unavailable: "null values plus grouped unavailable diagnostics; not fabricated zeroes" } };
      }
      if (method === "civ.rules") {
        if (args.where && (typeof args.where !== "object" || Array.isArray(args.where) || Object.values(args.where).some(value => value === null || !["string", "number", "boolean"].includes(typeof value)))) throw new Error("rules.where values must be scalar strings, numbers or booleans.");
        const response = await this.invoke("rules", args);
        return { ...(response.result as object), unavailable: response.unavailable };
      }
      if (method === "civ.action") {
        let response: Envelope;
        try { response = await this.invoke("action", args); }
        catch (error) { throw new Error(`Action failed or its acknowledgement was lost; outcome may be unknown. It was NOT replayed. Read a new snapshot before deciding whether to retry. ${error instanceof Error ? error.message : String(error)}`); }
        let observation: unknown;
        try { observation = await this.snapshot({}); }
        catch (error) { observation = { unavailable: error instanceof Error ? error.message : String(error), recovery: "Call civ.snapshot; do not replay the action." }; }
        return { ...(response.result as object), unavailable: response.unavailable, observation };
      }
      if (method === "civ.dismiss_notifications") {
        const response = await this.invoke("dismiss_notifications", args);
        return { ...(response.result as object), unavailable: response.unavailable };
      }
      if (method === "civ.keybinds") {
        const response = await this.invoke("keybinds", args);
        return { ...(response.result as object), unavailable: response.unavailable };
      }
      const snapshot = await this.snapshot(method === "civ.snapshot" ? args : {});
      if (method === "civ.snapshot") return snapshot;
      if (typeof args.id !== "string" && !(Number.isInteger(args.x) && Number.isInteger(args.y))) throw new Error("inspect requires a game-qualified id or integer x/y.");
      const records = [...snapshot.cities, ...snapshot.units, ...snapshot.map.tiles];
      const record = typeof args.id === "string" ? records.find(record => record.id === args.id) : snapshot.map.tiles.find(record => record.x === args.x && record.y === args.y);
      return { gameId: snapshot.gameId, turn: snapshot.turn, revision: snapshot.revision, record: record ?? null, unavailable: record ? snapshot.unavailable : { record: "Not observed by this player, no longer controlled, or ID belongs to another loaded game. Unseen live state is never queried." } };
    });
  }

  /** Restore only previously observed facts from a host-owned archived snapshot. */
  restoreKnowledge(value: unknown): void {
    if (this.gameKey || this.records.size) throw new Error("Restore knowledge before the first snapshot.");
    if (!value || typeof value !== "object") throw new Error("Invalid archived snapshot.");
    const snapshot = value as Snapshot;
    if (typeof snapshot.gameId !== "string" || !/^[0-9a-f-]{36}$/i.test(snapshot.gameId) ||
        !Number.isInteger(snapshot.playerId) || snapshot.playerId < 0 || snapshot.playerId > 63 ||
        !Number.isInteger(snapshot.turn) || snapshot.turn < 0 ||
        !Array.isArray(snapshot.cities) || !Array.isArray(snapshot.units) || !Array.isArray(snapshot.map?.tiles)) {
      throw new Error("Invalid archived snapshot identity or collections.");
    }
    const restored = new Map<string, Observation>();
    const fingerprints = new Map<string, { hash: string; revision: number }>();
    for (const [kind, collection] of [["city", snapshot.cities], ["unit", snapshot.units], ["tile", snapshot.map.tiles]] as const) {
      for (const record of collection) {
        if (!record || typeof record !== "object" || typeof record.id !== "string" ||
            !record.id.startsWith(`${snapshot.gameId}:${kind}:`) ||
            !/^\d+(?::\d+)?$/.test(record.id.slice(snapshot.gameId.length + kind.length + 2)) ||
            !["visible", "stale", "revealed_not_visible"].includes(record.visibility ?? "") ||
            (record.lastSeenTurn != null && (!Number.isInteger(record.lastSeenTurn) || record.lastSeenTurn < 0 || record.lastSeenTurn > snapshot.turn)) ||
            restored.has(record.id) || restored.size >= 100_000) throw new Error("Invalid archived observation.");
        const text = JSON.stringify(record);
        if (text.length > 1024 * 1024) throw new Error("Archived observation exceeds size bound.");
        const copy = JSON.parse(text) as Observation;
        const revision = Number.isInteger(copy.revision) && copy.revision! > 0 ? copy.revision! : 1;
        delete copy.revision;
        fingerprints.set(copy.id, { hash: createHash("sha256").update(JSON.stringify(copy)).digest("hex"), revision });
        copy.revision = revision;
        restored.set(copy.id, copy);
      }
    }
    this.gameKey = `${snapshot.gameId}:${snapshot.playerId}`;
    this.records = restored;
    this.fingerprints = fingerprints;
    this.snapshotRevision = Number.isInteger(snapshot.revision) && (snapshot.revision as number) > 0 ? snapshot.revision as number : 0;
  }

  private async snapshot(args: Arguments): Promise<Snapshot> {
    const response = await this.invoke("snapshot", args);
    const snapshot = response.result as Snapshot;
    if (!snapshot || typeof snapshot.gameId !== "string" || !Array.isArray(snapshot.cities) || !Array.isArray(snapshot.units) || !Array.isArray(snapshot.map?.tiles)) throw new Error("Malformed snapshot response.");
    const key = `${snapshot.gameId}:${snapshot.playerId}`;
    if (this.gameKey !== key) { this.records.clear(); this.fingerprints.clear(); this.gameKey = key; this.snapshotRevision = 0; }
    snapshot.revision = ++this.snapshotRevision;
    snapshot.unavailable = response.unavailable ?? {};
    const observed = new Set<string>();
    for (const collection of [snapshot.cities, snapshot.units, snapshot.map.tiles]) {
      for (let index = 0; index < collection.length; index++) {
        let record = collection[index]!;
        observed.add(record.id);
        const prior = this.records.get(record.id);
        if (record.visibility === "revealed_not_visible" && prior?.lastSeenTurn != null) {
          record = { ...prior, visibility: "stale", currentPresence: "unknown", staleReason: "Outside current sight; every retained field is last-known, not live." };
          collection[index] = record;
        }
        delete record.revision;
        const hash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
        const fingerprint = this.fingerprints.get(record.id);
        record.revision = fingerprint?.hash === hash ? fingerprint.revision : (fingerprint?.revision ?? 0) + 1;
        this.fingerprints.set(record.id, { hash, revision: record.revision });
        this.records.set(record.id, { ...record });
      }
    }
    for (const [id, prior] of this.records) {
      if (observed.has(id) || prior.own !== false) continue;
      if (id.includes(":unit:") || id.includes(":city:")) {
        const stale = { ...prior, visibility: "stale", currentPresence: "unknown", staleReason: "No longer observed. This does not establish movement, capture or death." };
        delete stale.revision;
        const hash = createHash("sha256").update(JSON.stringify(stale)).digest("hex");
        const fingerprint = this.fingerprints.get(id);
        stale.revision = fingerprint?.hash === hash ? fingerprint.revision : (fingerprint?.revision ?? 0) + 1;
        this.fingerprints.set(id, { hash, revision: stale.revision });
        this.records.set(id, stale);
        (id.includes(":unit:") ? snapshot.units : snapshot.cities).push(stale);
      }
    }
    snapshot.knowledge = { staleFacts: "Retained only from earlier observations in this bridge process; history/artifacts preserve snapshots durably. Freshly attached revealed-but-not-visible tiles have unknown details.", enemyAbsence: "Unknown, never inferred dead", records: "id stable within loaded game instance; revision increases when observed record changes" };
    return snapshot;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.transport.close();
    await this.queue;
    this.loaded.clear();
    this.records.clear();
    this.fingerprints.clear();
  }
}
