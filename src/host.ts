import { mkdir, readFile, writeFile, appendFile, readdir, opendir, open, lstat, realpath, rename, unlink, stat } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createInterface } from "node:readline";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { CivBridge, type PresentationReport } from "./bridge.ts";
import { popupDigest, type PopupObservation } from "./bridge/popups.ts";
import { DesktopService } from "./desktop.ts";
import { ExecutionService } from "./execution.ts";
import { Player } from "./player.ts";
import type { Arguments, PlayerEvent, ExecutionResult, ExecuteOptions } from "./contracts.ts";
import type { Config } from "./config.ts";
import { UsageLedger, readUsageReport } from "./usage.ts";
import { saveJson } from "./player/storage.ts";

const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;
function textArg(args: Arguments, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function validAgent(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
}
const MAX_NOTE_BYTES = 8 * 1024;
const NOTE_WINDOW_MS = 60_000;
const MAX_NOTES_PER_WINDOW = 30;
const EVIDENCE_HISTORY_BYTES = 1024 * 1024;
const EVIDENCE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const EVIDENCE_TOTAL_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const EVIDENCE_CANDIDATES = 256;
const EVIDENCE_SNAPSHOTS = 16;
const EVIDENCE_TEXT_CHARS = 320;
const EVIDENCE_TIME_MS = 2000;

/** Read a fixed byte window from a real file, never following a provider-controlled link. */
async function evidenceFile(path: string, maxBytes: number, tail = false, offset?: number): Promise<{ data: Buffer; size: number } | null> {
  if (!(await lstat(path)).isFile()) return null;
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) return null;
    if (!tail && offset === undefined && info.size > maxBytes) return null;
    const start = offset ?? (tail ? Math.max(0, info.size - maxBytes) : 0);
    if (start > info.size) return null;
    const length = Math.min(info.size - start, maxBytes);
    const data = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const part = await file.read(data, read, length - read, start + read);
      if (!part.bytesRead) break;
      read += part.bytesRead;
    }
    return { data: data.subarray(0, read), size: info.size };
  } finally { await file.close(); }
}

function evidenceExcerpt(text: string, index: number) {
  const textOffset = Math.max(0, index - 80);
  return {
    text: text.slice(textOffset, textOffset + EVIDENCE_TEXT_CHARS),
    textOffset, totalChars: text.length,
    truncated: textOffset > 0 || textOffset + EVIDENCE_TEXT_CHARS < text.length,
  };
}

/**
 * Which snapshot sections a captured observation actually carries. The bridge normalises `sections`;
 * an archive without it predates sectioning and carried every collection.
 */
function sectionsOf(value: unknown): string[] {
  const data = value as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.sections) && data.sections.every(section => typeof section === "string")) return data.sections as string[];
  const map = data.map as { tiles?: unknown } | undefined;
  const present = ["core"];
  if (Array.isArray(data.units)) present.push("units");
  if (Array.isArray(data.cities)) present.push("cities");
  if (Array.isArray(map?.tiles)) present.push("map");
  return present;
}
export class PlayerHost {
  readonly bridge: CivBridge;
  readonly desktop: DesktopService;
  readonly execution: ExecutionService;
  readonly player: Player;
  private controller = "main";
  private controlEpoch = 0;
  private liveQueue: Promise<unknown> = Promise.resolve();
  private latestSnapshot?: string;
  private readonly expertGuide?: string;
  private readonly expertGuideDigest?: string;
  private lastObserved: { turn: number | null; gameId: string | null } = { turn: null, gameId: null };
  private noteRate = new Map<string, number[]>();
  private nativeLock?: Promise<Server>;
  private closed = false;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly popupEvents = new Map<string, { eventId: string; popup: PopupObservation; lastObservedTurn: number | null }[]>();
  private readonly usage: UsageLedger;
  constructor(readonly projectRoot: string, readonly runDir: string, readonly config: Config, onEvent?: (event: PlayerEvent) => void) {
    this.usage = new UsageLedger(runDir, config.model, config.provider, config.apiRates);
    this.bridge = new CivBridge({
      host: config.tunerHost, port: config.tunerPort,
      onInformationalPopup: async popup => {
        const agentId = this.controller;
        const epoch = this.controlEpoch;
        const event = { eventId: randomUUID(), popup, lastObservedTurn: this.lastObserved.turn };
        this.log({ kind: "popup", agentId, ...event, gameId: this.lastObserved.gameId });
        await this.eventQueue;
        const pending = this.popupEvents.get(agentId) ?? [];
        pending.push(event);
        this.popupEvents.set(agentId, pending);
        if (this.closed || epoch !== this.controlEpoch) throw new Error("Popup dismissal cancelled by shutdown or control change");
      },
    });
    this.desktop = new DesktopService({ projectRoot, pythonPath: config.pythonPath });
    this.execution = new ExecutionService({ projectRoot, runDir, distro: config.distro, rpc: this.rpc.bind(this) });
    // A declared expert-informed run must actually carry its reference, so a missing or empty guide
    // is a startup failure rather than a run that silently degrades into the uncoached track.
    if (config.knowledge === "expert-informed") {
      let text: string;
      try { text = readFileSync(config.expertGuidePath, "utf8"); }
      catch { throw new Error(`knowledge is expert-informed but the guide at ${config.expertGuidePath} could not be read. Point expertGuidePath at the consolidated guide, or run with --knowledge uncoached.`); }
      if (!text.trim()) throw new Error(`The expert guide at ${config.expertGuidePath} is empty; refusing to declare an expert-informed run without supplied material.`);
      this.expertGuide = text;
      this.expertGuideDigest = createHash("sha256").update(text).digest("hex");
    }
    this.player = new Player({
      expertGuide: this.expertGuide,
      projectRoot, runDir, model: config.model, provider: config.provider, effort: config.effort,
      authPath: config.authPath, apiKey: config.provider === "openai" ? process.env.OPENAI_API_KEY : undefined, baseUrl: config.baseUrl,
      maxConcurrentAgents: config.maxConcurrentAgents, maxModelCalls: config.maxModelCalls === "unlimited" ? undefined : config.maxModelCalls,
      completionMode: config.completionMode,
      requestLimits: config.requestLimits,
      compactThreshold: config.compactThresholds?.[config.provider] ?? config.compactThreshold, rpc: this.rpc.bind(this),
      execute: (id, code, options) => this.execute(code, id, options),
      onEvent: event => { this.usage.onEvent(event); this.log({ kind: "player", ...event }); onEvent?.(event); },
    });
  }
  async initialize(): Promise<void> {
    await mkdir(join(this.runDir, "artifacts"), { recursive: true });
    await mkdir(join(this.runDir, "snapshots"), { recursive: true });
    // Recovery memory and the latest capture are separate concepts. Accumulated knowledge is the
    // union of everything ever observed; the latest snapshot may be a small regional page, and
    // restoring from that would silently discard remembered tiles.
    let recovered = false;
    try {
      const archive = JSON.parse(await readFile(join(this.runDir, "knowledge.json"), "utf8"));
      this.bridge.restoreKnowledge(archive);
      recovered = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const index = JSON.parse(await readFile(join(this.runDir, "observations.json"), "utf8"));
      if (typeof index.latest === "string" && /^s-[a-f0-9-]+$/.test(index.latest)) {
        const snapshot = JSON.parse(await readFile(join(this.runDir, "snapshots", `${index.latest}.json`), "utf8"));
        // Runs that predate knowledge.json still recover from their last capture.
        if (!recovered) this.bridge.restoreKnowledge(snapshot);
        this.latestSnapshot = index.latest;
        this.observedTurn(snapshot);
        this.usage.restoreObservation(snapshot);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const config = { ...this.config, authPath: "[private]" };
    const input = { config, expertGuide: this.expertGuide ?? null };
    const inputSha256 = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const inputFile = `inputs/${inputSha256}.json`;
    saveJson(join(this.runDir, inputFile), input);
    this.log({
      kind: "host", event: "start", config, controller: this.controller,
      input: { file: inputFile, sha256: inputSha256 },
      knowledge: { track: this.config.knowledge, guidePath: this.config.knowledge === "expert-informed" ? this.config.expertGuidePath : null, guideSha256: this.expertGuideDigest ?? null, guideChars: this.expertGuide?.length ?? 0 },
    });
  }
  private log(event: unknown): void {
    this.eventQueue = this.eventQueue.then(() => appendFile(join(this.runDir, "history.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event as object }) + "\n"));
    // Attach a rejection handler immediately; close/flush still observes the original failure.
    void this.eventQueue.catch(error => console.error("History persistence failed:", error.message));
  }
  /** Last turn this run actually observed, from any snapshot including a sectioned one. */
  private observedTurn(snapshot: unknown): void {
    const data = snapshot as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    if (Number.isSafeInteger(data.turn) && (data.turn as number) >= 0) this.lastObserved.turn = data.turn as number;
    if (typeof data.gameId === "string" && data.gameId) this.lastObserved.gameId = data.gameId;
  }
  private lockNativeAccess(): Promise<Server> {
    if (!this.nativeLock) {
      const identity = createHash("sha256").update(homedir()).digest("hex").slice(0, 20);
      this.nativeLock = new Promise<Server>((resolveLock, reject) => {
        const server = createServer(socket => socket.destroy());
        server.once("error", () => {
          this.nativeLock = undefined;
          reject(new Error("Another Civ player process owns live access. Close it before controlling this game."));
        });
        server.listen(`\\\\.\\pipe\\civ6-player-${identity}`, () => { server.unref(); resolveLock(server); });
      });
    }
    return this.nativeLock;
  }
  private async live<T>(id: string, operation: (authorize: () => void) => Promise<T>, requiresControl = true): Promise<T> {
    const epoch = this.controlEpoch;
    const authorize = () => {
      if (this.closed) throw new Error("Player host is closed");
      if (requiresControl && id !== this.controller) throw new Error(`Live game control belongs to ${this.controller}; use a captured snapshot or ask main to grant control.`);
      if (requiresControl && epoch !== this.controlEpoch) throw new Error("Live request cancelled by a control handoff or abort");
    };
    const next = this.liveQueue.catch(() => {}).then(async () => {
      authorize();
      await this.lockNativeAccess();
      authorize();
      return operation(authorize);
    });
    this.liveQueue = next;
    return next;
  }
  async setController(id: string): Promise<void> {
    validAgent(id);
    this.controlEpoch++;
    if (this.nativeLock) await this.desktop.request("desktop.cancel", {});
    const next = this.liveQueue.catch(() => {}).then(() => {
      if (this.closed) throw new Error("Player host is closed");
      this.controller = id;
      this.log({ kind: "control", controller: id });
    });
    this.liveQueue = next;
    await next;
  }
  async rpc(agentId: string, method: string, args: Arguments = {}): Promise<unknown> {
    validAgent(agentId);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("RPC arguments must be an object");
    if (this.closed) throw new Error("Player host is closed");
    if (method.startsWith("agent.")) return this.player.rpc(agentId, method, args);
    if (method === "control.status") return { controller: this.controller };
    if (method === "usage.summary") return readUsageReport(this.runDir);
    if (method === "control.grant") {
      if (agentId !== "main") throw new Error("Only main can grant live control");
      await this.setController(textArg(args, "agentId"));
      return { controller: this.controller };
    }
    if (method === "control.release") {
      if (agentId !== this.controller && agentId !== "main") throw new Error("Only controller or main can release control");
      await this.setController("main");
      return { controller: this.controller };
    }
    if (method.startsWith("artifact.")) return this.artifact(method, args);
    if (method.startsWith("history.")) return this.history(method, args, agentId);
    if (method === "civ.snapshot" && (args.snapshotId || agentId !== this.controller)) {
      const id = typeof args.snapshotId === "string" ? args.snapshotId : this.latestSnapshot;
      if (!id) throw new Error("No snapshot captured yet. Ask the controller to call civ.snapshot first.");
      if (!/^s-[a-f0-9-]+$/.test(id)) throw new Error("Invalid snapshot id");
      const snapshot = JSON.parse(await readFile(join(this.runDir, "snapshots", `${id}.json`), "utf8"));
      this.usage.observe(snapshot, agentId);
      return snapshot;
    }
    if (method === "harness.complain") {
      const note = textArg(args, "note");
      if (!note.trim() || note.length > 12000) throw new Error("note must contain 1–12000 characters of text");
      const complaintId = randomUUID();
      const complaint = {
        complaintId, at: new Date().toISOString(), agentId, controller: this.controller,
        lastObservedSnapshot: this.latestSnapshot ?? null, note,
        trace: await this.history("history.read", { limit: 20, textLimit: 2000 }, agentId),
      };
      const artifact = `complaints/${complaintId}.json`;
      await this.artifact("artifact.write", { name: artifact, content: JSON.stringify(complaint, null, 1) });
      this.log({ kind: "complaint", complaintId, agentId, note, lastObservedSnapshot: complaint.lastObservedSnapshot, artifact });
      await this.eventQueue;
      return { logged: true, complaintId, artifact };
    }
    if (!method.startsWith("civ.") && !method.startsWith("desktop.")) throw new Error(`Unknown RPC method: ${method}`);
    if (method.startsWith("civ.")) CivBridge.validateRequest(method, args);
    return this.live(agentId, async authorize => {
      this.log({ kind: "request", agentId, method, args });
      try {
        // Never clear a modal immediately before a coordinate click: its target was chosen from
        // an earlier image. Prepare only at fresh observation / explicit turn-advance boundaries.
        const endsTurn = method === "civ.action" && (args.type === "end_turn" ||
          (Array.isArray(args.actions) && args.actions.at(-1)?.type === "end_turn"));
        const prepares = method === "desktop.screenshot" || method === "civ.snapshot" || endsTurn ||
          (method === "civ.decisions" && args.popups !== "none" && !(typeof args.id === "string" && args.id.startsWith("popup:")));
        let presentation: PresentationReport | undefined;
        let presentationError: string | undefined;
        if (prepares) {
          try {
            presentation = await this.bridge.preparePresentation(authorize);
            if (presentation.callbackFailures.length) throw new Error(`Informational popup preservation failed: ${JSON.stringify(presentation.callbackFailures)}`);
          } catch (error) {
            // Native screenshots remain usable for diagnosis even when the structured bridge fails.
            if (method !== "desktop.screenshot") throw error;
            presentationError = String(error);
          }
        }
        authorize();
        let result: unknown = method.startsWith("desktop.")
          ? await this.desktop.request(method, args)
          : await this.bridge.request(method, args, authorize);
        if ((presentation || presentationError) && result && typeof result === "object") {
          result = { ...result, presentation, presentationError };
        }
        if (method === "civ.snapshot") {
          const snapshotId = `s-${randomUUID()}`;
          result = { ...(result as object), snapshotId, capturedAt: new Date().toISOString() };
          // Every capture is archived and addressable. `latest` is the analyst pointer and always
          // advances, partial or not, because its coverage travels with it. Recovery memory is the
          // bridge's accumulated knowledge, persisted separately so a regional page never replaces it.
          await writeFile(join(this.runDir, "snapshots", `${snapshotId}.json`), JSON.stringify(result));
          const sections = sectionsOf(result);
          const complete = ["map", "units", "cities"].every(section => sections.includes(section));
          await writeFile(join(this.runDir, "observations.json"), JSON.stringify({ latest: snapshotId }));
          this.latestSnapshot = snapshotId;
          const knowledge = this.bridge.exportKnowledge();
          if (knowledge) await writeFile(join(this.runDir, "knowledge.json"), JSON.stringify(knowledge));
          this.observedTurn(result);
          this.usage.observe(result);
          this.usage.observe(result, agentId);
          this.log({ kind: "result", agentId, method, snapshotId, sections, complete });
        } else if (method === "desktop.screenshot" && result && typeof result === "object" && "data" in result) {
          const screenshot = result as Record<string, unknown>;
          const name = `screens/${randomUUID()}.png`;
          await this.artifact("artifact.write", { name, content: screenshot.data, encoding: "base64" });
          this.log({ kind: "result", agentId, method, result: { ...screenshot, data: undefined, artifact: name } });
        } else this.log({ kind: "result", agentId, method, result });
        return result;
      } catch (error) {
        this.log({ kind: "error", agentId, method, error: String(error) });
        throw error;
      }
    }, method !== "civ.rules" && method !== "civ.probe" && method !== "civ.keybinds");
  }
  private async artifactPath(name: string, createParent = false): Promise<string> {
    if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid artifact name");
    const root = resolve(this.runDir, "artifacts");
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact path escapes storage");
    let cursor = root;
    for (const part of name.split("/").slice(0, -1)) {
      cursor = join(cursor, part);
      if (createParent) await mkdir(cursor, { recursive: false }).catch(error => { if (error.code !== "EEXIST") throw error; });
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Artifact parent must be a real directory");
    }
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Artifact symlinks are forbidden"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (relative(await realpath(root), await realpath(dirname(path))).startsWith("..")) throw new Error("Artifact path escapes storage");
    return path;
  }
  private async artifact(method: string, args: Arguments): Promise<unknown> {
    if (method === "artifact.list") {
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const files: string[] = [];
      const walk = async (dir: string, base = "") => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (files.length >= 1000) break;
          const name = base + entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), name + "/");
          else if (entry.isFile() && name.startsWith(prefix)) files.push(name);
        }
      };
      await walk(join(this.runDir, "artifacts"));
      return { files, limit: 1000 };
    }
    const name = textArg(args, "name");
    const path = await this.artifactPath(name, method === "artifact.write");
    if (method === "artifact.write") {
      const content = args.content;
      if (typeof content !== "string") throw new Error("content must be a string");
      if (content.length > MAX_ARTIFACT_BYTES * 2) throw new Error("Artifact too large");
      const data = Buffer.from(content, args.encoding === "base64" ? "base64" : "utf8");
      if (data.length > MAX_ARTIFACT_BYTES) throw new Error("Artifact too large");
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { flag: "wx" });
        // Windows readers holding the destination transiently deny the replace; retry briefly before failing.
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, path); break; }
          catch (error) {
            if (attempt >= 7 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            await new Promise<void>(resolve => setTimeout(resolve, 25));
          }
        }
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
      return { name, bytes: data.length };
    }
    if (method !== "artifact.read") throw new Error(`Unknown artifact method: ${method}`);
    const data = await readFile(path);
    if (data.length > MAX_ARTIFACT_BYTES) throw new Error("Artifact too large");
    if (args.encoding === "base64") return { name, content: data.toString("base64"), encoding: "base64" };
    const offset = Math.max(0, Number(args.offset ?? 0));
    const limit = Math.min(50000, Math.max(1, Number(args.limit ?? 12000)));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)) throw new Error("offset/limit must be integers");
    const text = data.toString("utf8");
    return { name, content: text.slice(offset, offset + limit), offset, total: text.length, truncated: offset + limit < text.length };
  }
  /**
   * Append a model-authored durable note to run history. This is the only writable channel that
   * survives compaction, so it is bounded and rate-limited rather than free-form logging.
   */
  private async note(agentId: string, args: Arguments): Promise<unknown> {
    const text = textArg(args, "text");
    if (!text.trim()) throw new Error("text must contain non-whitespace characters");
    if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) throw new Error(`text must be at most ${MAX_NOTE_BYTES} bytes of UTF-8; write long material to an artifact and note its name`);
    const now = Date.now();
    const recent = (this.noteRate.get(agentId) ?? []).filter(at => now - at < NOTE_WINDOW_MS);
    if (recent.length >= MAX_NOTES_PER_WINDOW) throw new Error(`history.note is limited to ${MAX_NOTES_PER_WINDOW} notes per agent per minute; the note was NOT recorded`);
    recent.push(now);
    this.noteRate.set(agentId, recent);
    const record = {
      at: new Date().toISOString(), kind: "note", agentId, text,
      lastObservedTurn: this.lastObserved.turn, gameId: this.lastObserved.gameId,
      lastObservedSnapshot: this.latestSnapshot ?? null,
    };
    this.log(record);
    await this.eventQueue;
    return { recorded: true, ...record, bytes: Buffer.byteLength(text, "utf8") };
  }
  private async history(method: string, args: Arguments, agentId = "main"): Promise<unknown> {
    if (method === "history.note") return this.note(agentId, args);
    if (method === "history.evidence") return this.evidence(args);
    if (method !== "history.search" && method !== "history.read") throw new Error(`Unknown history method: ${method}`);
    const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
    const offset = args.offset === undefined ? undefined : Number(args.offset);
    const textOffset = Number(args.textOffset ?? 0);
    const textLimit = Math.min(50000, Math.max(1, Number(args.textLimit ?? 2000)));
    if (!Number.isSafeInteger(limit) || (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) ||
      !Number.isSafeInteger(textOffset) || textOffset < 0 || !Number.isSafeInteger(textLimit)) throw new Error("History offsets and limits must be nonnegative integers");
    const query = method === "history.search" ? textArg(args, "query").toLowerCase() : undefined;
    await this.eventQueue;
    const path = join(this.runDir, "history.jsonl");
    const size = (await stat(path)).size;
    const selected: { line: number; text: string; textOffset: number; totalChars: number; truncated: boolean }[] = [];
    let total = 0;
    let matched = 0;
    if (size > 0) {
      const input = createReadStream(path, { start: 0, end: size - 1, encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const text of lines) {
          const index = total++;
          if (query !== undefined ? !text.toLowerCase().includes(query) : offset !== undefined && (index < offset || index >= offset + limit)) continue;
          matched++;
          selected.push({ line: index + 1, text: text.slice(textOffset, textOffset + textLimit), textOffset, totalChars: text.length, truncated: textOffset > 0 || textOffset + textLimit < text.length });
          if (selected.length > limit) selected.shift();
        }
      } finally { lines.close(); input.destroy(); }
    }
    return method === "history.search" ? { matches: selected, total: matched } : { rows: selected, total };
  }
  /** Search only immutable game observations and public run outputs, with finite IO and response size. */
  private async evidence(args: Arguments): Promise<unknown> {
    if (args.byteOffset !== undefined) return this.evidenceRecord(args);
    const rawQuery = textArg(args, "query");
    const query = rawQuery.trim().toLowerCase();
    if (query.length < 2 || Buffer.byteLength(rawQuery, "utf8") > 120) throw new Error("query must contain 2–120 characters (at most 120 UTF-8 bytes)");
    const limit = args.limit === undefined ? 6 : args.limit;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 8) throw new Error("limit must be an integer from 1 to 8");
    const snapshotId = args.snapshotId;
    if (snapshotId !== undefined && (typeof snapshotId !== "string" || snapshotId.length > 80 || !/^s-[a-f0-9-]+$/.test(snapshotId))) throw new Error("Invalid snapshot id");
    const maxMatches = limit as number;
    const scanned = { snapshots: 0, snapshotBytes: 0, historyBytes: 0 };
    let incomplete = false;
    const snapshots: Record<string, unknown>[] = [];
    const history: Record<string, unknown>[] = [];
    const latestObservedTurn = this.lastObserved.turn;
    const latestSnapshotId = this.latestSnapshot ?? null;
    await this.eventQueue;
    const deadline = Date.now() + EVIDENCE_TIME_MS;

    const directory = join(this.runDir, "snapshots");
    if (!(await lstat(directory)).isDirectory()) throw new Error("Snapshot archive must be a real directory");
    const candidates: { id: string; mtime: number }[] = [];
    if (!snapshotId && latestSnapshotId) candidates.push({ id: latestSnapshotId, mtime: Infinity });
    if (snapshotId) candidates.push({ id: snapshotId, mtime: 0 });
    else {
      const entries = await opendir(directory);
      let names = 0;
      for await (const entry of entries) {
        if (++names > EVIDENCE_CANDIDATES) { incomplete = true; break; }
        if (Date.now() >= deadline) { incomplete = true; break; }
        if (!entry.isFile() || !/^s-[a-f0-9-]+\.json$/.test(entry.name) || entry.name === `${latestSnapshotId}.json`) continue;
        const info = await lstat(join(directory, entry.name));
        if (info.isFile()) candidates.push({ id: entry.name.slice(0, -5), mtime: info.mtimeMs });
      }
      candidates.sort((a, b) => b.mtime - a.mtime || b.id.localeCompare(a.id));
      if (candidates.length > EVIDENCE_SNAPSHOTS) incomplete = true;
    }
    for (const { id } of candidates.slice(0, EVIDENCE_SNAPSHOTS)) {
      if (snapshots.length >= maxMatches) break;
      const priority = !snapshotId && id === latestSnapshotId;
      if ((Date.now() >= deadline && !priority) || scanned.snapshotBytes >= EVIDENCE_TOTAL_SNAPSHOT_BYTES) { incomplete = true; break; }
      let file: { data: Buffer; size: number } | null;
      try { file = await evidenceFile(join(directory, `${id}.json`), Math.min(EVIDENCE_SNAPSHOT_BYTES, EVIDENCE_TOTAL_SNAPSHOT_BYTES - scanned.snapshotBytes)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { incomplete = true; continue; }
        throw error;
      }
      if (!file) { incomplete = true; continue; }
      scanned.snapshots++;
      scanned.snapshotBytes += file.data.length;
      let snapshot: Record<string, unknown>;
      try {
        snapshot = JSON.parse(file.data.toString("utf8"));
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.snapshotId !== id) { incomplete = true; continue; }
      } catch { incomplete = true; continue; }
      const turn = Number.isSafeInteger(snapshot.turn) && (snapshot.turn as number) >= 0 ? snapshot.turn as number : null;
      const sameGame = typeof snapshot.gameId === "string" && snapshot.gameId === this.lastObserved.gameId;
      const ageTurns = sameGame && turn !== null && latestObservedTurn !== null && turn <= latestObservedTurn ? latestObservedTurn - turn : null;
      const rawCoverage = snapshot.coverage;
      const coverage = rawCoverage && typeof rawCoverage === "object" && !Array.isArray(rawCoverage) &&
        ["units", "cities", "map"].every(key => ["complete", "partial", "omitted"].includes((rawCoverage as Record<string, unknown>)[key] as string))
        ? { units: (rawCoverage as Record<string, unknown>).units, cities: (rawCoverage as Record<string, unknown>).cities, map: (rawCoverage as Record<string, unknown>).map } : null;
      const provenance = {
        source: "snapshot", snapshotId: id, turn,
        capturedAt: typeof snapshot.capturedAt === "string" && snapshot.capturedAt.length <= 40 ? snapshot.capturedAt : null,
        sections: Array.isArray(snapshot.sections) && snapshot.sections.length <= 16 &&
          snapshot.sections.every(value => typeof value === "string" && value.length <= 40) ? snapshot.sections : null,
        coverage, ageTurns,
      };
      const match = (value: unknown, pointer: string, section: string) => {
        if (snapshots.length >= maxMatches || (Date.now() >= deadline && !priority)) return;
        const text = JSON.stringify(value);
        if (!text) return;
        const index = text.toLowerCase().indexOf(query);
        if (index >= 0) snapshots.push({ ...provenance, pointer, section, ...evidenceExcerpt(text, index) });
      };
      for (const [section, value] of Object.entries(snapshot)) {
        if (snapshots.length >= maxMatches) break;
        if (Date.now() >= deadline && !priority) { incomplete = true; break; }
        if (section.length > 80) { incomplete = true; continue; }
        if (section === "snapshotId" || section === "capturedAt") continue;
        if (section === "map" && value && typeof value === "object" && !Array.isArray(value)) {
          for (const [key, part] of Object.entries(value)) {
            if (snapshots.length >= maxMatches) break;
            if (key === "tiles" && Array.isArray(part)) {
              for (let i = 0; i < part.length && snapshots.length < maxMatches; i++) {
                if (Date.now() >= deadline && !priority) { incomplete = true; break; }
                match(part[i], `/map/tiles/${i}`, "map");
              }
            } else if (key.length <= 80) match(part, `/map/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, "map");
            else incomplete = true;
          }
        } else if (Array.isArray(value)) {
          for (let i = 0; i < value.length && snapshots.length < maxMatches; i++) {
            if (Date.now() >= deadline && !priority) { incomplete = true; break; }
            match(value[i], `/${section.replaceAll("~", "~0").replaceAll("/", "~1")}/${i}`, section);
          }
        } else match(value, `/${section.replaceAll("~", "~0").replaceAll("/", "~1")}`, section);
      }
    }

    const historyPath = join(this.runDir, "history.jsonl");
    let file: { data: Buffer; size: number } | null;
    try { file = snapshotId ? null : await evidenceFile(historyPath, EVIDENCE_HISTORY_BYTES, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      file = null;
    }
    if (!file && !snapshotId) incomplete = true;
    if (file) {
      scanned.historyBytes = file.data.length;
      if (file.size > EVIDENCE_HISTORY_BYTES) incomplete = true;
      const start = file.size - file.data.length;
      const firstNewline = start ? file.data.indexOf(10) : -1;
      const first = start ? firstNewline + 1 : 0;
      if (start && firstNewline < 0) incomplete = true;
      const end = file.data.lastIndexOf(10);
      let line = 0;
      if (!start) for (let i = 0; i <= end; i++) if (file.data[i] === 10) line++;
      // Recent public evidence wins when a query has more matches than the response limit.
      // Count newlines once for absolute line numbers; parsing can then stop after enough hits.
      for (let recordEnd = end; recordEnd > first && history.length < maxMatches; ) {
        if (Date.now() >= deadline) { incomplete = true; break; }
        const previous = file.data.lastIndexOf(10, recordEnd - 1);
        const pos = Math.max(first, previous + 1);
        const recordOffset = start + pos;
        const record = file.data.toString("utf8", pos, recordEnd);
        recordEnd = previous;
        const recordLine = start === 0 ? line-- : null;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(record);
          if (!event || typeof event !== "object" || Array.isArray(event)) { incomplete = true; continue; }
        } catch { incomplete = true; continue; }
        let value: unknown;
        let source: string;
        if (event.kind === "execution_result") { source = "execution"; value = event.content; }
        else if (event.kind === "popup" && event.popup && typeof event.popup === "object") { source = "popup"; value = event.popup; }
        else if (event.kind === "note") { source = "note"; value = event.text; }
        else continue;
        const blocks = source === "execution" && Array.isArray(value) ? value : [value];
        for (let i = 0; i < blocks.length && history.length < maxMatches; i++) {
          const block = blocks[i];
          if (source === "execution" && (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string")) continue;
          const text = source === "execution" && block && typeof block === "object" && typeof block.text === "string"
            ? block.text : source === "note" && typeof block === "string" ? block : JSON.stringify(block);
          if (!text) continue;
          const index = text.toLowerCase().indexOf(query);
          if (index < 0) continue;
          history.push({
            source, at: typeof event.at === "string" && event.at.length <= 40 ? event.at : null, line: recordLine,
            byteOffset: recordOffset, executionId: source === "execution" && typeof event.executionId === "string" && event.executionId.length <= 80 ? event.executionId : null,
            blockIndex: source === "execution" ? i : undefined,
            lastObservedTurn: Number.isSafeInteger(event.lastObservedTurn) ? event.lastObservedTurn : null,
            ...evidenceExcerpt(text, index),
          });
        }
      }
    }
    const snapshotAllowance = Math.ceil(maxMatches / 2);
    const matches = [...snapshots.slice(0, snapshotAllowance), ...history.slice(0, maxMatches - Math.min(snapshotAllowance, snapshots.length))];
    if (matches.length < maxMatches) matches.push(...snapshots.slice(snapshotAllowance, maxMatches));
    return { matches, latestObservedTurn, latestSnapshotId, scanned, incomplete, resultLimitReached: snapshots.length + history.length > matches.length || snapshots.length >= maxMatches || history.length >= maxMatches };
  }
  /** Recover one selected public history block by its stable byte position, without reading a host path. */
  private async evidenceRecord(args: Arguments): Promise<unknown> {
    const byteOffset = args.byteOffset;
    const blockIndex = args.blockIndex ?? 0;
    const textOffset = args.textOffset ?? 0;
    const textLimit = args.textLimit ?? 2000;
    if (!Number.isSafeInteger(byteOffset) || (byteOffset as number) < 0 ||
        !Number.isSafeInteger(blockIndex) || (blockIndex as number) < 0 || (blockIndex as number) > 100 ||
        !Number.isSafeInteger(textOffset) || (textOffset as number) < 0 ||
        !Number.isSafeInteger(textLimit) || (textLimit as number) < 1 || (textLimit as number) > 2000)
      throw new Error("Invalid public evidence offset or limit");
    await this.eventQueue;
    const position = byteOffset as number;
    const file = await evidenceFile(join(this.runDir, "history.jsonl"), EVIDENCE_HISTORY_BYTES, false, Math.max(0, position - 1));
    if (!file || (position && file.data[0] !== 10)) throw new Error("Evidence offset is not a record boundary");
    const begin = position ? 1 : 0;
    const end = file.data.indexOf(10, begin);
    if (end < 0) throw new Error("Public evidence record exceeds the bounded read");
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(file.data.toString("utf8", begin, end));
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid public evidence record");
    } catch { throw new Error("Invalid public evidence record"); }
    let source: string;
    let text: string;
    if (event.kind === "execution_result" && Array.isArray(event.content)) {
      source = "execution";
      const block = event.content[blockIndex as number];
      if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string")
        throw new Error("No public text at this execution block");
      text = block.text;
    } else if (event.kind === "popup" && blockIndex === 0 && event.popup && typeof event.popup === "object") {
      source = "popup"; text = JSON.stringify(event.popup);
    } else if (event.kind === "note" && blockIndex === 0 && typeof event.text === "string") {
      source = "note"; text = event.text;
    } else throw new Error("Evidence offset does not identify a public record");
    const start = textOffset as number;
    const length = textLimit as number;
    return {
      source, byteOffset: position, blockIndex,
      executionId: source === "execution" && typeof event.executionId === "string" && event.executionId.length <= 80 ? event.executionId : null,
      at: typeof event.at === "string" && event.at.length <= 40 ? event.at : null,
      text: text.slice(start, start + length), textOffset: start, totalChars: text.length,
      truncated: start > 0 || start + length < text.length,
    };
  }
  async execute(code: string, agentId = "main", options?: ExecuteOptions): Promise<ExecutionResult> {
    validAgent(agentId);
    const executionId = randomUUID();
    this.log({ kind: "execution", agentId, executionId, code });
    const cancelDesktop = () => {
      if (agentId !== this.controller) return;
      this.controlEpoch++;
      if (this.nativeLock) void this.desktop.request("desktop.cancel", {}).catch(error => console.error("Desktop cancellation failed:", error));
    };
    options?.signal?.addEventListener("abort", cancelDesktop, { once: true });
    let result: ExecutionResult;
    try {
      result = await this.execution.execute(agentId, code, options);
      if (result.isError) cancelDesktop();
    } catch (error) {
      cancelDesktop();
      this.log({ kind: "execution_error", agentId, executionId, error: String(error) });
      throw error;
    } finally {
      options?.signal?.removeEventListener("abort", cancelDesktop);
    }
    const popups = this.popupEvents.get(agentId);
    if (popups?.length) {
      this.popupEvents.delete(agentId);
      // The screen text, the screen, the turn. The rest of the observation - adapter notes, control
      // paths, capture provenance, constant status flags - stays in public history rather than being
      // reprinted into the player's context on every popup the game happens to raise.
      const digests = popups.map(({ popup, lastObservedTurn }) => popupDigest(popup, lastObservedTurn)).filter(digest => digest !== null);
      if (digests.length) result.content.push({ type: "text", text: `popups: ${JSON.stringify(digests)}` });
    }
    // Workspace file paths stay in the execution log, never in the model-visible result: the block was
    // ~100 chars on every call and it baited re-reads of output the model already had.
    const workspaceFiles = result.artifacts ?? [];
    result.artifacts = [];
    const recorded = [];
    for (let i = 0; i < result.content.length; i++) {
      const block = result.content[i];
      if (block.type === "text") recorded.push(block);
      else {
        const name = `executions/${agentId}/${executionId}-${i}.${block.mimeType === "image/jpeg" ? "jpg" : "png"}`;
        await this.artifact("artifact.write", { name, content: block.data, encoding: "base64" });
        recorded.push({ type: "image", artifact: name, mimeType: block.mimeType });
        (result.artifacts ??= []).push(name);
      }
    }
    this.log({ kind: "execution_result", agentId, executionId, isError: result.isError, content: recorded, artifacts: result.artifacts, workspaceFiles });
    return result;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled([this.player.close(), this.execution.close(), this.desktop.close(), this.bridge.close()]);
    await this.eventQueue;
    if (this.nativeLock) {
      const server = await this.nativeLock.catch(() => undefined);
      if (server) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }
    for (const result of results) if (result.status === "rejected") console.error("Shutdown:", result.reason);
  }
}
