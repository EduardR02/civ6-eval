import { mkdir, readFile, writeFile, appendFile, readdir, lstat, realpath, rename, unlink, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { CivBridge } from "./bridge.ts";
import { DesktopService } from "./desktop.ts";
import { ExecutionService } from "./execution.ts";
import { Player } from "./player.ts";
import type { Arguments, PlayerEvent, ExecutionResult, ExecuteOptions } from "./contracts.ts";
import type { Config } from "./config.ts";
import { UsageLedger, readUsageReport } from "./usage.ts";

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
  private lastObserved: { turn: number | null; gameId: string | null } = { turn: null, gameId: null };
  private noteRate = new Map<string, number[]>();
  private nativeLock?: Promise<Server>;
  private closed = false;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly usage: UsageLedger;
  constructor(readonly projectRoot: string, readonly runDir: string, readonly config: Config, onEvent?: (event: PlayerEvent) => void) {
    this.usage = new UsageLedger(runDir, config.model, config.provider, config.apiRates);
    this.bridge = new CivBridge({ host: config.tunerHost, port: config.tunerPort });
    this.desktop = new DesktopService({ projectRoot, pythonPath: config.pythonPath });
    this.execution = new ExecutionService({ projectRoot, runDir, distro: config.distro, rpc: this.rpc.bind(this) });
    this.player = new Player({
      projectRoot, runDir, model: config.model, provider: config.provider, effort: config.effort,
      authPath: config.authPath, apiKey: config.provider === "openai" ? process.env.OPENAI_API_KEY : undefined, baseUrl: config.baseUrl,
      maxConcurrentAgents: config.maxConcurrentAgents, maxModelCalls: config.maxModelCalls === "unlimited" ? undefined : config.maxModelCalls,
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
    this.log({ kind: "host", event: "start", config: { ...this.config, authPath: "[private]" }, controller: this.controller });
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
  private async live<T>(id: string, operation: () => Promise<T>, requiresControl = true): Promise<T> {
    const epoch = this.controlEpoch;
    const next = this.liveQueue.catch(() => {}).then(async () => {
      if (this.closed) throw new Error("Player host is closed");
      if (requiresControl && id !== this.controller) throw new Error(`Live game control belongs to ${this.controller}; use a captured snapshot or ask main to grant control.`);
      if (requiresControl && epoch !== this.controlEpoch) throw new Error("Live request cancelled by a control handoff");
      await this.lockNativeAccess();
      return operation();
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
    return this.live(agentId, async () => {
      this.log({ kind: "request", agentId, method, args });
      try {
        let result: unknown = method.startsWith("desktop.")
          ? await this.desktop.request(method, args)
          : await this.bridge.request(method, args);
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
