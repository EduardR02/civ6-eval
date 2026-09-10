/** Read-only LIVE run dashboard. Optional append-only journals feed an incremental
 * loopback HTTP/SSE viewer; no sidecars, private provider state, or model scripts
 * are served. Turns are attributed only to observations at or before a message.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

interface CallTokens { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; cost: number | null }
type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; name: string; code: string }
  | { type: "image" };
interface Entry { ts: string; role: "user" | "assistant" | "toolResult"; toolCallId: string | null; blocks: Block[]; error: string | null; usage: CallTokens | null }
interface Compaction { time: string; originalLen: number | null; summaryLen: number | null }
interface Ledger { requests: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; usd: number; unpriced: number; present: boolean }
interface TurnObservation { time: string; turn: number }
type SourceKind = "transcript" | "usage" | "history" | "journal";

const RESET = Symbol("source shrank; reparse everything");
const INTERESTING: Record<SourceKind, Record<string, boolean>> = {
  transcript: { message: true, model_change: true },
  usage: { start: true, usage: true, end: true },
  history: { request: true, execution_result: true, result: true, execution: true, player: true, tool_start: true },
  journal: { compaction: true, request_end: true, http_error: true },
};
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"]/g, character => ESCAPES[character]!);
const hhmmss = (iso: string | null): string => iso ? esc(iso.slice(11, 19)) : "?";
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const lengthJson = (value: unknown): number => typeof value === "string" ? value.length : JSON.stringify(value ?? "").length;
const byTime = (a: { time: string }, b: { time: string }): number => a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
const IMAGE_REFERENCE = /(?:workspaces\/main\/)?\.executions\/[\w-]+\/display-\d+\.(?:png|jpe?g)|(?:artifacts\/)?executions\/main\/[\w-]+\.(?:png|jpe?g)/gi;

/** Narrow an unknown JSON value to a plain object (null/arrays rejected). */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Skip large irrelevant journal rows only when a top-level tag is proven. */
function headTag(line: string): string {
  const match = /^\s*\{(?:\s*"[^"\\]+"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*,)*\s*"(?:kind|type)"\s*:\s*"([a-zA-Z_-]+)"/.exec(line.slice(0, 220));
  return match ? match[1]! : "";
}
function toolCode(block: Record<string, unknown>): string {
  const args = record(block.arguments);
  if (args) return typeof args.code === "string" ? args.code : JSON.stringify(args);
  try {
    const parsed = record(JSON.parse(str(block.arguments)));
    return typeof parsed?.code === "string" ? parsed.code : "";
  } catch { return str(block.arguments); }
}
/** Unknown until a game state has actually been observed. */
function turnOf(ts: string, observations: TurnObservation[]): number | null {
  let lo = 0, hi = observations.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (observations[mid]!.time <= ts) lo = mid + 1; else hi = mid;
  }
  return lo ? observations[lo - 1]!.turn : null;
}

interface Offset { offset: number; size: number; mtime: number; ino: number; pending: Buffer[] }
type StreamEvent = { kind: "turn" | "card"; key: string; turn: number | null; cls: string; html: string };
export type TailEvent =
  | { k: "gen"; gen: number }
  | { k: "turn"; turn: number | null }
  | { k: "card"; id: string; cls: string; b: string }
  | { k: "spark"; b: string }
  | { k: "side"; b: string };


/** Accumulated run state; `refresh()` applies only bytes appended since the previous call. */
export class RunView {
  /** Changes on every reparse or chronological replay. */
  generation: number;

  constructor(generation = 1) {
    this.generation = generation;
  }

  entries: Entry[] = [];
  /** Observed game-turn timeline (snapshots + RPC results), sorted by capture time. */
  turns: TurnObservation[] = [];
  /** end_turn submissions, kept as context only — never used to number turns. */
  endTurns = 0;
  display: string[] = [];
  methods = new Map<string, number>();
  model = "?";
  compactions: Compaction[] = [];
  failures: { time: string; status: string }[] = [];
  ledger: Ledger = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, usd: 0, unpriced: 0, present: false };
  read = 0;
  runDir = "";
  private offsets = new Map<string, Offset>();
  private kinds = new Map<string, { agent: string; kind: string }>();
  private usageEvents: { requestId: string; time: string; tokens: CallTokens; usd: number | null }[] = [];
  private snapshotFiles = new Map<string, { size: number; mtime: number }>();
  private tail = new Map<string, string>();
  private singletons = new Map<string, string>();
  private restart = true;
  private dirty = true;
  private sortedEntries: Entry[] = [];
  private callList: Entry[] = [];
  private tokensOf: (entry: Entry) => CallTokens | null = () => null;
  private ctxPeak = { v: 0, i: 0 };
  private attemptCount = 0;
  private stubCount = 0;
  private finalFailure: { time: string; status: string } | null = null;
  private compactionTimes: Compaction[] = [];
  private displayIndex = 0;
  private imagePaths = new Set<string>();
  private displaysByText = new Map<string, string[]>();
  /** History links execution ids to the provider tool-call ids in the transcript. */
  private executionToolCalls = new Map<string, string>();
  private pendingToolCalls = new Map<string, string>();
  private displaysByToolCall = new Map<string, string[]>();
  private cardCache = new WeakMap<Entry, { signature: string; html: string }>();
  private entryMetadata = new WeakMap<Entry, { text: string; paths: string[]; images: number }>();

  resetState(): void {
    this.generation++;
    this.offsets.clear();
    this.entries.length = 0;
    this.turns.length = 0;
    this.endTurns = 0;
    this.display.length = 0;
    this.methods.clear();
    this.model = "?";
    this.compactions.length = 0;
    this.failures.length = 0;
    this.ledger = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, usd: 0, unpriced: 0, present: false };
    this.snapshotFiles.clear();
    this.imagePaths.clear();
    this.displaysByText.clear();
    this.executionToolCalls.clear();
    this.pendingToolCalls.clear();
    this.displaysByToolCall.clear();
    this.cardCache = new WeakMap();
    this.entryMetadata = new WeakMap();
    this.tail.clear();
    this.singletons.clear();
    this.restart = true;
    this.dirty = true;
  }

  async refresh(runDir: string): Promise<void> {
    if (this.runDir && this.runDir !== runDir) this.resetState();
    this.runDir = runDir;
    this.read = 0;
    const mainDir = join(runDir, "player", "agents", "main");
    let transcripts: string[] = [];
    try {
      transcripts = readdirSync(mainDir)
        .filter(name => name.endsWith(".jsonl") && name !== "provider.jsonl" && name !== "native.jsonl")
        .sort().map(name => join(mainDir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const sources: { path: string; kind: SourceKind }[] = [
      ...transcripts.map(path => ({ path, kind: "transcript" as const })),
      { path: join(runDir, "usage.jsonl"), kind: "usage" },
      { path: join(runDir, "history.jsonl"), kind: "history" },
      { path: join(mainDir, "provider.jsonl"), kind: "journal" },
      { path: join(mainDir, "native.jsonl"), kind: "journal" },
    ];
    try {
      const present = new Set(sources.map(source => source.path));
      for (const [path, state] of this.offsets) {
        if (state.size && !present.has(path)) throw RESET;
      }
      for (const source of sources) await this.pump(source);
      this.pumpSnapshots(join(runDir, "snapshots"));
    } catch (error) {
      if (error !== RESET) throw error;
      this.resetState();
      for (const source of sources) await this.pump(source);
      this.pumpSnapshots(join(runDir, "snapshots"));
    }
    if (this.dirty) this.turns.sort(byTime);
  }

  /** Consume new bytes once, retaining incomplete lines without repeatedly reading base64. */
  private async pump(source: { path: string; kind: SourceKind }): Promise<void> {
    let state = this.offsets.get(source.path);
    let info;
    try { info = statSync(source.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (state?.size) throw RESET;
      return;
    }
    if (state && (info.size < state.size || info.ino !== state.ino ||
      (info.size === state.size && info.mtimeMs !== state.mtime))) throw RESET;
    if (!state) this.offsets.set(source.path, state = { offset: 0, size: 0, mtime: 0, ino: info.ino, pending: [] });
    if (info.size === state.size) return;
    const handle = await open(source.path, "r");
    try {
      while (state.offset < info.size) {
        const bytes = Buffer.allocUnsafe(Math.min(1024 * 1024, info.size - state.offset));
        const result = await handle.read(bytes, 0, bytes.length, state.offset);
        if (!result.bytesRead) break;
        const data = bytes.subarray(0, result.bytesRead);
        this.read += data.length;
        state.offset += data.length;
        let at = 0;
        for (;;) {
          const newline = data.indexOf(10, at);
          if (newline === -1) break;
          let line = data.subarray(at, newline);
          if (state.pending.length) {
            state.pending.push(line);
            line = Buffer.concat(state.pending);
            state.pending = [];
          }
          this.apply(line.toString("utf8"), source.kind);
          at = newline + 1;
        }
        if (at < data.length) state.pending.push(Buffer.from(data.subarray(at)));
      }
      state.size = state.offset;
      state.mtime = info.mtimeMs;
    } finally { await handle.close(); }
  }

  /** Snapshot files are written once by the host; (re)read a file only when its stat changes. */
  private pumpSnapshots(dir: string): void {
    let names: string[];
    try { names = readdirSync(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (this.snapshotFiles.size) throw RESET;
      return;
    }
    const present = new Set(names);
    for (const name of this.snapshotFiles.keys()) if (!present.has(name)) throw RESET;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      let info: { size: number; mtime: number };
      try {
        const stat = statSync(path);
        info = { size: stat.size, mtime: stat.mtimeMs };
      } catch { continue; }
      const seen = this.snapshotFiles.get(name);
      if (seen && seen.size === info.size && seen.mtime === info.mtime) continue;
      if (seen) throw RESET;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { continue; } // mid-write: retried when the stat changes
      this.snapshotFiles.set(name, info);
      this.read += info.size;
      const snapshot = record(parsed);
      const turn = snapshot && typeof snapshot.turn === "number" && Number.isFinite(snapshot.turn) && snapshot.turn >= 0 ? snapshot.turn : -1;
      if (!snapshot || turn < 0) continue;
      const capturedAt = str(snapshot.capturedAt);
      this.turns.push({ time: capturedAt || new Date(info.mtime).toISOString(), turn });
      this.dirty = true;
    }
  }

  private apply(line: string, kind: SourceKind): void {
    const tag = headTag(line);
    if (tag !== "" && !INTERESTING[kind][tag]) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; } // torn or malformed line: skipped
    const event = record(parsed);
    if (!event) return;
    const key = tag || str(event.type) || str(event.kind);
    if (!INTERESTING[kind][key]) return;
    if (kind === "history" && key === "player" && event.type !== "tool_start") return;
    this.dirty = true;
    if (kind === "transcript") {
      if (key === "model_change") {
        const model = str(event.modelId);
        if (model) this.model = `${model}${str(event.provider) ? ` · ${str(event.provider)}` : ""}`;
      } else if (key === "message") this.applyMessage(event);
    } else if (kind === "usage") {
      if (key === "start") {
        const request = record(event.request);
        this.kinds.set(str(request?.requestId), { agent: str(request?.agentId) || "?", kind: str(request?.kind) || "?" });
      } else if (key === "usage") {
        const tokens = record(event.tokens) ?? {};
        this.usageEvents.push({
          requestId: str(event.requestId),
          time: str(event.time),
          tokens: { input: num(tokens.input), cacheRead: num(tokens.cacheRead), cacheWrite: num(tokens.cacheWrite), output: num(tokens.output), reasoning: num(tokens.reasoning), cost: null },
          usd: typeof event.estimatedUsd === "number" ? event.estimatedUsd : null,
        });
      }
    } else if (kind === "history") {
      if (key === "request") {
        const method = str(event.method);
        if (!method) return;
        this.methods.set(method, (this.methods.get(method) ?? 0) + 1);
        if (method === "civ.action" && JSON.stringify(event.args ?? {}).includes("end_turn")) this.endTurns++;
      } else if (key === "result") this.applyObservation(event);
      else if (key === "execution_result") this.applyDisplay(event);
      else if (key === "tool_start") this.applyToolStart(event);
      else if (key === "execution") this.applyExecution(event);
    } else {
      if (key === "compaction") {
        this.compactions.push({
          time: str(event.time),
          originalLen: "original" in event ? JSON.stringify(event.original).length : null,
          summaryLen: "summary" in event || "output" in event ? lengthJson(event.summary ?? event.output) : null,
        });
      } else if (key === "request_end") {
        const outcome = str(event.outcome);
        if (outcome && outcome !== "ok" && outcome !== "completed") this.failures.push({ time: str(event.time), status: String(event.httpStatus ?? "?") });
      } else if (key === "http_error") this.failures.push({ time: str(event.time), status: String(event.status ?? "?") });
    }
  }

  private applyToolStart(event: Record<string, unknown>): void {
    if (event.type !== "tool_start") return;
    const data = record(event.data);
    const toolCallId = str(data?.toolCallId);
    const agentId = str(event.agentId) || "?";
    if (toolCallId) this.pendingToolCalls.set(agentId, toolCallId);
    else this.pendingToolCalls.delete(agentId);
  }

  private applyExecution(event: Record<string, unknown>): void {
    const executionId = str(event.executionId);
    if (!executionId) return;
    const agentId = str(event.agentId) || "?";
    const toolCallId = str(event.toolCallId) || this.pendingToolCalls.get(agentId) || "";
    this.pendingToolCalls.delete(agentId);
    if (toolCallId) this.executionToolCalls.set(executionId, toolCallId);
  }

  /** Observed game turn from one RPC result: civ.action turnState, civ.inspect turn, snapshot game. */
  private applyObservation(event: Record<string, unknown>): void {
    const result = record(event.result);
    if (!result) return;
    const at = str(event.at);
    if (!at) return;
    const state = record(result.turnState);
    const game = record(result.game);
    const turn = [state?.turn, result.turn, game?.turn].find(value =>
      typeof value === "number" && Number.isFinite(value) && value >= 0) as number | undefined;
    if (turn === undefined) return;
    this.turns.push({ time: at, turn });
  }

  /** Only host-recorded main-agent display paths become browser-accessible images. */
  private applyDisplay(event: Record<string, unknown>): void {
    if (event.agentId !== undefined && event.agentId !== "main") return;
    const paths: string[] = [];
    if (Array.isArray(event.workspaceFiles)) {
      for (const item of event.workspaceFiles) {
        const path = str(item).replaceAll("\\", "/");
        if (/^\.executions\/[\w-]+\/display-\d+\.(png|jpe?g)$/i.test(path)) paths.push(`workspaces/main/${path}`);
      }
    }
    if (!paths.length && Array.isArray(event.artifacts)) {
      for (const item of event.artifacts) {
        const path = str(item).replaceAll("\\", "/").replace(/^artifacts\//, "");
        if (/^executions\/main\/[\w-]+\.(png|jpe?g)$/i.test(path)) paths.push(`artifacts/${path}`);
      }
    }
    for (const path of paths) { this.imagePaths.add(path); this.display.push(path); }
    const executionId = str(event.executionId);
    const toolCallId = this.executionToolCalls.get(executionId);
    if (toolCallId && paths.length) this.displaysByToolCall.set(toolCallId, paths);
    if (Array.isArray(event.content)) {
      const text = event.content.map(item => record(item)).filter(item => item?.type === "text").map(item => str(item!.text)).join("\n");
      // Ambiguous identical results must not silently borrow a different execution's image.
      if (this.displaysByText.has(text)) this.displaysByText.set(text, []);
      else this.displaysByText.set(text, paths);
    }
  }

  private applyMessage(event: Record<string, unknown>): void {
    const message = record(event.message);
    if (!message) return;
    const role = str(message.role);
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return;
    const blocks: Block[] = [];
    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const block = record(item);
        if (!block) continue;
        if (block.type === "text") blocks.push({ type: "text", text: str(block.text) });
        else if (block.type === "thinking") blocks.push({ type: "thinking", thinking: str(block.thinking) });
        else if (block.type === "toolCall") blocks.push({ type: "toolCall", name: str(block.name) || "exec_py", code: toolCode(block) });
        else if (block.type === "image") blocks.push({ type: "image" }); // base64 data dropped here
      }
    } else if (typeof content === "string") blocks.push({ type: "text", text: content });
    const usage = record(message.usage);
    const cost = record(usage?.cost);
    const tokens: CallTokens | null = usage && (num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite) + num(usage.output) + num(usage.reasoning)) > 0 ? {
      input: num(usage.input), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite),
      output: num(usage.output), reasoning: num(usage.reasoning),
      cost: typeof cost?.total === "number" ? cost.total : null,
    } : null;
    this.entries.push({
      ts: str(event.timestamp) || str(message.timestamp),
      role,
      toolCallId: role === "toolResult" ? str(message.toolCallId) || null : null,
      blocks,
      error: message.stopReason === "error" ? (str(message.errorMessage) || "error") : null,
      usage: tokens,
    });
  }

  imagePath(path: string): string | null {
    if (!this.imagePaths.has(path)) return null;
    try {
      const root = realpathSync(this.runDir);
      const requested = join(root, path), file = realpathSync(requested);
      // The run root itself may be a trusted junction; nothing below it may
      // redirect a recorded display path to another file, even inside the run.
      if (relative(requested, file) !== "") return null;
      const inside = relative(root, file);
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
      return statSync(file).isFile() ? file : null;
    } catch { return null; }
  }


  private metadata(entry: Entry): { text: string; paths: string[]; images: number } {
    let value = this.entryMetadata.get(entry);
    if (!value) {
      const text = entry.blocks.filter(block => block.type === "text").map(block => block.text).join("\n");
      const linked = entry.role === "assistant"
        ? entry.blocks.map(block => block.type === "text" ? block.text : block.type === "toolCall" ? block.code : "").join("\n")
        : text;
      const paths = (linked.match(IMAGE_REFERENCE) ?? []).map(path => path.startsWith(".executions/") ? `workspaces/main/${path}` : path.startsWith("executions/") ? `artifacts/${path}` : path);
      value = { text, paths, images: entry.blocks.reduce((count, block) => count + Number(block.type === "image"), 0) };
      this.entryMetadata.set(entry, value);
    }
    return value;
  }

  /** Summarize the usage ledger into sidebar totals (main agent, compaction included). */
  private summarizeLedger(): void {
    const ledger: Ledger = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, usd: 0, unpriced: 0, present: false };
    for (const event of this.usageEvents) {
      if (this.kinds.get(event.requestId)?.agent !== "main") continue;
      ledger.present = true;
      ledger.requests++;
      ledger.input += event.tokens.input;
      ledger.cacheRead += event.tokens.cacheRead;
      ledger.cacheWrite += event.tokens.cacheWrite;
      ledger.output += event.tokens.output;
      ledger.reasoning += event.tokens.reasoning;
      if (event.usd === null) ledger.unpriced++; else ledger.usd += event.usd;
    }
    this.ledger = ledger;
  }


  /** Full card sequence (turn headers, compaction marks, cards) in chronological order. */
  private computeCards(): StreamEvent[] {
    const entries = this.sortedEntries = this.entries.slice().sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
    const isCall = (entry: Entry): boolean => entry.role === "assistant" && !(entry.error !== null && entry.blocks.length === 0);
    const calls: Entry[] = this.callList = [];
    const slots = new Map<Entry, number>();
    for (const entry of entries) if (isCall(entry)) { slots.set(entry, calls.length); calls.push(entry); }
    // Fallback tokens: usage.jsonl events of the main agent except compaction requests, by call order.
    const zip = this.usageEvents
      .filter(event => {
        const meta = this.kinds.get(event.requestId);
        return meta?.kind !== "compact" && (meta === undefined || meta.agent === "main" || meta.agent === "?");
      })
      .map(event => event.tokens);
    const tokensOf = this.tokensOf = (entry: Entry): CallTokens | null => entry.usage ?? zip[slots.get(entry) ?? -1] ?? null;
    const ctxOf = (tokens: CallTokens | null): number => tokens ? tokens.input + tokens.cacheRead : 0;
    const ctx = calls.map(tokensOf).map(ctxOf);
    this.ctxPeak = ctx.reduce((best, value, index) => value > best.v ? { v: value, i: index } : best, { v: 0, i: 0 });
    const attempts = entries.filter(entry => entry.role === "assistant");
    this.attemptCount = attempts.length;
    const stubs = attempts.filter(entry => entry.error !== null);
    this.stubCount = stubs.length;
    const lastStub = stubs[stubs.length - 1];
    this.finalFailure = this.failures.length
      ? this.failures.reduce((last, failure) => failure.time > last.time ? failure : last)
      : lastStub ? { time: lastStub.ts, status: /HTTP (\d+)/.exec(lastStub.error ?? "")?.[1] ?? "?" } : null;
    this.compactionTimes = (this.compactions.length ? this.compactions : this.usageEvents
      .filter(event => this.kinds.get(event.requestId)?.kind === "compact")
      .map(event => ({ time: event.time, originalLen: null as number | null, summaryLen: null as number | null })))
      .slice().sort(byTime);
    // The most recent thinking block renders expanded; every older one stays collapsed.
    let openEntry: Entry | undefined, openBlock = -1;
    for (let index = entries.length - 1; index >= 0 && !openEntry; index--) {
      const blocks = entries[index]!.blocks;
      for (let slot = blocks.length - 1; slot >= 0; slot--) {
        if (blocks[slot]!.type === "thinking") { openEntry = entries[index]; openBlock = slot; break; }
      }
    }
    const cards: StreamEvent[] = [];
    let lastTurn: number | null | undefined;
    this.displayIndex = 0;
    let mark = 0;
    const slotSeen = new Map<string, number>();
    for (const entry of entries) {
      const turn = turnOf(entry.ts, this.turns);
      if (turn !== lastTurn) {
        cards.push({ kind: "turn", key: `turn:${turn}:${cards.length}`, turn, cls: "", html: "" });
        lastTurn = turn;
      }
      while (mark < this.compactionTimes.length && this.compactionTimes[mark]!.time < entry.ts) {
        const time = this.compactionTimes[mark]!.time;
        cards.push({ kind: "card", key: `mark:${time}`, turn: 0, cls: "mark", html: `⋯ context compacted ${hhmmss(time)}Z ⋯` });
        mark++;
      }
      const place = slotSeen.get(`${entry.ts}|${entry.role}`) ?? 0;
      slotSeen.set(`${entry.ts}|${entry.role}`, place + 1);
      const key = `card:${entry.ts}|${entry.role}|${place}`;
      const own = tokensOf(entry);
      const meta = this.metadata(entry);
      const recorded = entry.role === "toolResult" && entry.toolCallId ? this.displaysByToolCall.get(entry.toolCallId) : undefined;
      const paths = recorded ?? (meta.paths.length ? meta.paths : entry.role === "toolResult" ? this.displaysByText.get(meta.text) ?? [] : []);
      const signature = `${own?.input},${own?.cacheRead},${own?.output}|${entry === openEntry ? openBlock : -1}|${paths.map(path => this.imagePaths.has(path) ? path : "").join(",")}`;
      const cached = this.cardCache.get(entry);
      this.displayIndex += meta.images;
      if (cached?.signature === signature) {
        cards.push({ kind: "card", key, turn: 0, cls: entry.role === "toolResult" ? "toolresult" : entry.role, html: cached.html });
        continue;
      }
      if (entry.role === "user") {
        const text = meta.text;
        cards.push({ kind: "card", key, turn: 0, cls: "user", html: `<div class="head">USER PROMPT · ${hhmmss(entry.ts)}</div><div class="text">${esc(text.slice(0, 2500))}${text.length > 2500 ? " …[truncated]" : ""}</div>` });
      } else if (entry.role === "assistant") {
        const tok = own
          ? `fresh ${own.input.toLocaleString()} · cached ${own.cacheRead.toLocaleString()} · out ${own.output.toLocaleString()} · ctx≈${ctxOf(own).toLocaleString()}`
          : `no usage — ${esc(entry.error ?? "no tokens reported")}`;
        if (!isCall(entry)) {
          cards.push({ kind: "card", key, turn: 0, cls: "assistant", html: `<div class="head">model call · ${hhmmss(entry.ts)} <span class="tok">${tok}</span></div><div class="text err">Request failed: ${esc(entry.error)}</div>` });
          this.cardCache.set(entry, { signature, html: cards[cards.length - 1]!.html });
          continue;
        }
        let inner = "";
        for (let index = 0; index < entry.blocks.length; index++) {
          const block = entry.blocks[index]!;
          if (block.type === "thinking") inner += `<details class="think"${entry === openEntry && index === openBlock ? " open" : ""}><summary>thinking</summary><pre>${esc(block.thinking)}</pre></details>`;
          else if (block.type === "text") inner += `<div class="text">${linkify(block.text, this.imagePaths)}</div>`;
          else if (block.type === "toolCall") inner += `<details class="tool"><summary>${esc(block.name)}</summary><pre>${linkify(block.code.length > 16000 ? `${block.code.slice(0, 16000)}\n…[truncated]` : block.code, this.imagePaths)}</pre></details>`;
        }
        cards.push({ kind: "card", key, turn: 0, cls: "assistant", html: `<div class="head">model call · ${hhmmss(entry.ts)} <span class="tok">${tok}</span></div>${inner}` });
      } else {
        let html = "";
        let image = 0;
        for (const block of entry.blocks) {
          if (block.type === "image") {
            const path = paths[image++];
            const src = path && this.imagePaths.has(path) ? `/image?path=${encodeURIComponent(path)}` : null;
            html += src ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer"><img class="shot" loading="lazy" src="${esc(src)}"></a>` : `<div class="text">(display artifact not recorded or not uniquely matched yet)</div>`;
          } else if (block.type === "text") {
            html += `<pre class="res">${esc(block.text.slice(0, 6000))}${block.text.length > 6000 ? "\n…[truncated]" : ""}</pre>`;
          }
        }
        cards.push({ kind: "card", key, turn: 0, cls: "toolresult", html: `<div class="head">exec result · ${hhmmss(entry.ts)}</div>${html}` });
      }
      this.cardCache.set(entry, { signature, html: cards[cards.length - 1]!.html });
    }
    return cards;
  }

  /** Context-growth sparkline card, empty until at least two model calls exist. */
  private sparkHtml(): string {
    const tokensOf = this.tokensOf;
    const ctx = this.callList.map(tokensOf).map(tokens => tokens ? tokens.input + tokens.cacheRead : 0);
    if (ctx.length < 2) return "";
    const W = 560, H = 48, max = ctx.reduce((peak, value) => Math.max(peak, value), 1);
    const points = ctx.map((value, index) => `${(index / (ctx.length - 1) * W).toFixed(1)},${(H - 4 - value / max * (H - 8)).toFixed(1)}`).join(" ");
    const marks = this.compactionTimes.map(compaction => {
      const index = this.callList.findIndex(call => call.ts > compaction.time);
      if (index < 1) return "";
      const x = (index / (this.callList.length - 1) * W).toFixed(1);
      return `<line x1="${x}" y1="2" x2="${x}" y2="${H - 2}" stroke="#f96" stroke-dasharray="3 3"/>`;
    }).join("");
    const svg = `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline fill="none" stroke="#6cf" stroke-width="1.5" points="${points}"/>${marks}</svg>`;
    return `<div class="card answers"><div class="head">CONTEXT GROWTH · fresh+cached per model call${marks ? " · dashed = compaction" : ""}</div>${svg}</div>`;
  }

  /** Sidebar totals card; re-emitted only when its content changes so counters track the run live. */
  private sidebarHtml(runName: string): string {
    const entries = this.sortedEntries;
    const window = entries.length ? `${hhmmss(entries[0]!.ts)}–${hhmmss(entries[entries.length - 1]!.ts)}Z` : "?";
    const activity = [...this.methods.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([method, count]) => `${esc(method)} ${count}`).join(" · ");
    const lastCompaction = this.compactionTimes[this.compactionTimes.length - 1];
    const compactionNote = lastCompaction
      ? `compaction ${hhmmss(lastCompaction.time)}Z${lastCompaction.originalLen !== null ? ` · ${(lastCompaction.originalLen / 1e6).toFixed(1)} MB → ${lastCompaction.summaryLen?.toLocaleString()} chars` : ""}${this.compactionTimes.length > 1 ? ` (${this.compactionTimes.length} total)` : ""}<br>`
      : "";
    const lastTurn = this.turns.length ? this.turns[this.turns.length - 1]!.turn : "unknown";
    return `<b>${esc(runName)} run viewer</b><br>${esc(this.model)}<br>
<b>${this.attemptCount}</b> model calls (${this.stubCount} failed) · observed turn <b>${lastTurn}</b> · ${this.endTurns} end_turn submissions<br>
${this.ledger.present ? `main fresh ${this.ledger.input.toLocaleString()} · cached ${this.ledger.cacheRead.toLocaleString()} · out ${this.ledger.output.toLocaleString()} · reasoning ${this.ledger.reasoning.toLocaleString()}<br>
${this.ledger.requests} requests · API estimate $${this.ledger.usd.toFixed(2)} (${this.ledger.unpriced} unpriced); not subscription charges<br>` : "usage ledger absent<br>"}
ctx peak ${this.ctxPeak.v.toLocaleString()}${this.ctxPeak.v ? ` at call ${this.ctxPeak.i + 1}` : ""}<br>
${compactionNote}final HTTP ${esc(this.finalFailure?.status ?? "—")}<br>
${this.displayIndex} display images · window ${window}<br>${activity ? `activity: ${activity}<br>` : ""}<hr>`;
  }

  /** Drain tail events for this run state: appends in the steady state, a generation replay after a reparse. */
  takeTail(runName = basename(this.runDir)): { events: TailEvent[]; restart: boolean } {
    if (!this.dirty) return { events: [], restart: false };
    this.dirty = false;
    this.summarizeLedger();
    const cards = this.computeCards();
    const keys = [...this.tail.keys()];
    let restart = this.restart;
    if (!restart) {
      restart = cards.length < keys.length;
      for (let index = 0; !restart && index < keys.length; index++) {
        if (keys[index] !== cards[index]?.key) restart = true;
      }
    }
    const events: TailEvent[] = [];
    if (restart) {
      if (!this.restart) this.generation++;
      this.tail.clear(); this.singletons.clear();
      events.push({ k: "gen", gen: this.generation });
    }
    for (const card of cards) {
      if (!restart && this.tail.get(card.key) === card.html) continue;
      this.tail.set(card.key, card.html);
      if (card.kind === "turn") events.push({ k: "turn", turn: card.turn });
      else events.push({ k: "card", id: card.key, cls: card.cls, b: card.html });
    }
    const side = this.sidebarHtml(runName);
    if (restart || this.singletons.get("side") !== side) {
      events.push({ k: "side", b: side });
      this.singletons.set("side", side);
    }
    const spark = this.sparkHtml();
    if (restart || this.singletons.get("spark") !== spark) {
      events.push({ k: "spark", b: spark });
      this.singletons.set("spark", spark);
    }
    this.restart = false;
    return { events, restart };
  }

  /** Static, same-origin EventSource viewer. Model content is escaped before insertion. */
  shell(runName: string, nonce = ""): string {
    const waiting = `<div id="waiting" class="card answers"><div class="head">WAITING FOR RUN DATA</div><div class="text">No model transcript yet. New content appears automatically while the dashboard runs.</div></div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(runName)} run viewer</title><style>
body{font-family:ui-monospace,Consolas,monospace;background:#111;color:#ddd;margin:0;display:flex}
#side{width:250px;padding:10px;border-right:1px solid #333;height:100vh;overflow:auto;position:sticky;top:0;font-size:12px;line-height:1.5}
#side a.toc{display:block;color:#8cf;text-decoration:none;padding:1px 4px}
#side a.toc:hover{background:#223}
#main{padding:12px;max-width:1100px}
h3{color:#fa0;border-bottom:1px solid #444;padding-bottom:4px;scroll-margin-top:8px}
.card{border:1px solid #333;border-radius:6px;margin:10px 0;padding:8px;background:#181818}
.card .head{font-size:11px;color:#999;letter-spacing:1px;margin-bottom:6px}
.card .tok{float:right;color:#6cf;font-weight:normal;letter-spacing:0}
.card.user{border-color:#655;background:#1d1515}.card.user .head{color:#c98}
.card.assistant{border-color:#556}
.card.toolresult{border-color:#373;background:#141c14}.card.toolresult .head{color:#7b7}
.card.answers{border-color:#a63;background:#1d1712}.card.answers .head{color:#fa0}
.mark{color:#f96;font-size:12px;margin:12px 0;border-top:1px dashed #a63;border-bottom:1px dashed #a63;padding:2px 0}
.text{white-space:pre-wrap;font-size:13px;line-height:1.5}
.text.err{color:#f66}
details{margin:6px 0}summary{cursor:pointer;color:#89f;font-size:12px}
details pre,pre.res{white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.4;background:#101010;border:1px solid #2a2a2a;border-radius:4px;padding:6px;max-height:340px;overflow:auto;color:#bbb}
img.shot{max-width:100%;border:1px solid #333;border-radius:4px;margin:4px 0;cursor:zoom-in}
a.imglink{color:#6cf;text-decoration:none;border-bottom:1px dotted #468}
.spark{display:block;margin:10px 0 2px}
code{color:#9cd;background:#101010;padding:0 3px;border-radius:3px}
#followbtn{position:fixed;right:12px;bottom:12px;z-index:9;padding:4px 10px;font:12px ui-monospace,Consolas,monospace;background:#223;color:#8cf;border:1px solid #556;border-radius:12px;cursor:pointer;opacity:.85}
#followbtn:hover{opacity:1;background:#334}
</style></head><body><div id="side"><div id="status" role="status">connecting</div><div id="sidehead">loading…</div><div id="toc"></div></div><div id="main"><div id="sparkwrap"></div><div id="stream">${waiting}</div><div id="tail"></div></div>
<script nonce="${esc(nonce)}">
const stream=document.getElementById("stream"),sparkWrap=document.getElementById("sparkwrap"),sideHead=document.getElementById("sidehead"),toc=document.getElementById("toc"),tail=document.getElementById("tail"),status=document.getElementById("status");
const nodes=new Map(),opened=new Map();
let following=sessionStorage.getItem("civ-viewer-follow")!=="0",frame=0,lastY=scrollY,replay=false,pinnedY=0,turnIndex=0,applying=false;
function schedule(){if(frame)return;frame=requestAnimationFrame(()=>{frame=0;if(following)tail.scrollIntoView({block:"end"});else if(replay)scrollTo(0,pinnedY);});}
function remember(id,node){opened.set(id,Array.from(node.querySelectorAll("details"),d=>d.open));}
function apply(x){
  if(x.k==="gen"){
    nodes.forEach((node,id)=>remember(id,node));
    pinnedY=scrollY;replay=true;stream.innerHTML=${JSON.stringify(waiting)};nodes.clear();toc.replaceChildren();sparkWrap.replaceChildren();turnIndex=0;return;
  }
  if(x.k==="turn"){
    document.getElementById("waiting")?.remove();
    const h=document.createElement("h3");h.id="turn-"+turnIndex++;h.textContent=x.turn===null?"— turn not yet observed —":"— turn "+x.turn+" —";stream.append(h);
    const a=document.createElement("a");a.className="toc";a.href="#"+h.id;a.textContent=x.turn===null?"turn unknown":"turn "+x.turn;toc.append(a);
  }else if(x.k==="card"){
    document.getElementById("waiting")?.remove();
    const old=nodes.get(x.id);if(old)remember(x.id,old);
    const d=document.createElement("div");d.className="card "+x.cls;d.dataset.card=x.id;d.innerHTML=x.b;
    const state=opened.get(x.id);if(state)d.querySelectorAll("details").forEach((detail,i)=>{if(i<state.length)detail.open=state[i];});
    if(old)old.replaceWith(d);else stream.append(d);nodes.set(x.id,d);
  }else if(x.k==="spark")sparkWrap.innerHTML=x.b;
  else if(x.k==="side")sideHead.innerHTML=x.b;
}
const btn=document.createElement("button");btn.id="followbtn";
function setFollow(value){following=value;sessionStorage.setItem("civ-viewer-follow",value?"1":"0");btn.textContent=value?"follow":"pinned";}
setFollow(following);btn.onclick=()=>{setFollow(!following);if(following)schedule();};document.body.append(btn);
addEventListener("wheel",event=>{if(event.deltaY<0)setFollow(false);},{passive:true});
addEventListener("scroll",()=>{if(!applying&&!replay&&scrollY<lastY)setFollow(false);lastY=scrollY;},{passive:true});
toc.addEventListener("click",()=>setFollow(false));
stream.addEventListener("load",()=>{if(following)schedule();},true);
const events=new EventSource("/events");
events.addEventListener("tail",event=>{applying=true;JSON.parse(event.data).forEach(apply);applying=false;schedule();});
events.addEventListener("status",event=>{const state=JSON.parse(event.data).state;status.textContent=state==="running"?"LIVE · running":state==="waiting"?"LIVE · waiting for run data":"LIVE · read error (retrying)";schedule();requestAnimationFrame(()=>{replay=false;for(const id of opened.keys())if(!nodes.has(id))opened.delete(id);});});
events.onerror=()=>{status.textContent="disconnected · reconnecting";};
addEventListener("beforeunload",()=>events.close());
</script></body></html>`;
  }

}

/** Single-pass image-path linkifier: emitted markup is never rescanned. */
function linkify(text: string, images: Set<string>): string {
  let out = "";
  const pattern = IMAGE_REFERENCE;
  pattern.lastIndex = 0;
  let last = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    out += esc(text.slice(last, match.index));
    const shown = match[0];
    const path = shown.startsWith(".executions/") ? `workspaces/main/${shown}` : shown.startsWith("executions/") ? `artifacts/${shown}` : shown;
    out += images.has(path)
      ? `<a class="imglink" href="/image?path=${encodeURIComponent(path)}" target="_blank" rel="noopener noreferrer">${esc(shown)}</a>`
      : esc(shown);
    last = match.index + shown.length;
  }
  return out + esc(text.slice(last));
}

interface DashboardClient {
  send(frame: Uint8Array): void;
  replay(frames: Uint8Array[]): void;
  close(): void;
}

/** Loopback-only, read-only viewer. interval is in seconds; close is idempotent. */
export async function startDashboard(runDir: string, interval: number): Promise<{ url: string; close(): Promise<void> }> {
  if (!Number.isFinite(interval) || interval <= 0 || interval * 1000 > 2_147_483_647) throw new Error("Dashboard interval must be positive seconds within the timer range");
  runDir = resolve(runDir);
  const view = new RunView();
  const encoder = new TextEncoder();
  const frames = new Map<string, Uint8Array>();
  const clients = new Set<DashboardClient>();
  let state = "waiting", stopped = false, turnKey = 0;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> = Promise.resolve();
  const statusFrame = (): Uint8Array => encoder.encode(`event: status\ndata: ${JSON.stringify({ state })}\n\n`);
  frames.set("gen", encoder.encode(`event: tail\ndata: [{"k":"gen","gen":${view.generation}}]\n\n`));
  const cycle = async (): Promise<void> => {
    let tail: { events: TailEvent[]; restart: boolean } = { events: [], restart: false };
    const previous = state;
    try {
      await view.refresh(runDir);
      tail = view.takeTail();
      state = view.entries.length ? "running" : "waiting";
    } catch {
      // Do not send raw filesystem/provider error text to the browser.
      state = "error";
    }
    if (stopped) return;
    if (tail.restart) { frames.clear(); turnKey = 0; }
    const changed: Uint8Array[] = [];
    for (const event of tail.events) {
      const frame = encoder.encode(`event: tail\ndata: ${JSON.stringify([event])}\n\n`);
      const key = event.k === "card" ? event.id : event.k === "turn" ? `turn:${turnKey++}` : event.k;
      frames.set(key, frame);
      changed.push(frame);
    }
    if (tail.restart) {
      const full = [...frames.values(), statusFrame()];
      for (const client of clients) client.replay(full);
    } else {
      for (const frame of changed) for (const client of clients) client.send(frame);
      if (changed.length || previous !== state) {
        const status = statusFrame();
        for (const client of clients) client.send(status);
      }
    }
  };
  await cycle();
  const nonce = randomUUID();
  const shell = view.shell(basename(runDir), nonce);
  const security = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (request.headers.get("host") !== server.url.host || (origin && origin !== server.url.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site") return new Response("Forbidden", { status: 403, headers: security });
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...security, Allow: "GET" } });
      if (url.pathname === "/") return new Response(shell, { headers: { ...security, "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname === "/image") {
        const path = url.searchParams.get("path") ?? "";
        const file = view.imagePath(path);
        if (!file) return new Response("Not found", { status: 404, headers: security });
        return new Response(Bun.file(file), { headers: { ...security, "Content-Type": /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png" } });
      }
      if (url.pathname !== "/events") return new Response("Not found", { status: 404, headers: security });
      if (clients.size >= 16) return new Response("Too many viewers", { status: 503, headers: security });
      let client: DashboardClient;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let initial = [...frames.values(), statusFrame()], index = 0, offset = 0;
      let pending: Uint8Array[] = [], pendingBytes = 0, ended = false;
      const flush = (): void => {
        if (ended || !controller || (controller.desiredSize ?? 0) <= 0) return;
        if (index >= initial.length) {
          initial = pending; pending = []; pendingBytes = 0; index = 0; offset = 0;
        }
        const frame = initial[index];
        if (!frame) return;
        const end = Math.min(offset + 64 * 1024, frame.length);
        const chunk = frame.subarray(offset, end);
        offset = end;
        if (offset === frame.length) { index++; offset = 0; }
        // Bun can pull synchronously from enqueue: publish the new cursor first.
        controller.enqueue(chunk);
      };
      const abort = (): void => client.close();
      client = {
        send(frame) {
          if (ended) return;
          // A slow viewer may reconnect, but may never accumulate unbounded updates.
          if (pendingBytes + frame.length > 4 * 1024 * 1024) { client.close(); return; }
          pending.push(frame); pendingBytes += frame.length; flush();
        },
        replay(next) {
          if (ended) return;
          // Never splice a generation into the middle of an in-flight SSE frame.
          if (offset !== 0) { client.close(); return; }
          initial = next; index = 0; pending = []; pendingBytes = 0; flush();
        },
        close() {
          if (ended) return;
          ended = true; clients.delete(client); initial = []; pending = [];
          request.signal.removeEventListener("abort", abort);
          try { controller.close(); } catch { /* consumer already cancelled */ }
        },
      };
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value; clients.add(client);
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) client.close(); else flush();
        },
        pull() { flush(); },
        cancel() { client.close(); },
      }, { highWaterMark: 1 });
      return new Response(stream, { headers: { ...security, "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
    },
  });
  const schedule = (): void => {
    timer = setTimeout(() => {
      active = cycle().finally(() => { if (!stopped) schedule(); });
    }, interval * 1000);
  };
  schedule();
  const heartbeat = setInterval(() => {
    const frame = encoder.encode(": keepalive\n\n");
    for (const client of clients) client.send(frame);
  }, 15_000);
  let closing: Promise<void> | undefined;
  return {
    url: server.url.href,
    close() {
      if (closing) return closing;
      stopped = true; clearTimeout(timer); clearInterval(heartbeat);
      for (const client of clients) client.close();
      closing = (async () => { await active; await server.stop(true); })();
      return closing;
    },
  };
}

/** Keep the read-only viewer alive until terminal shutdown. */
export async function runDashboard(runDir: string, interval: number): Promise<void> {
  const dashboard = await startDashboard(runDir, interval);
  console.log(`Dashboard: ${dashboard.url}\nWatching ${runDir} every ${interval}s; Ctrl+C to stop.`);
  const { promise, resolve: stop } = Promise.withResolvers<void>();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try { await promise; } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await dashboard.close();
  }
}
