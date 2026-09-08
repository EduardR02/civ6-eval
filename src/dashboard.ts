/** Live run dashboard: regenerate DIR/viewer.html from a run's ledgers as they grow.
 *
 * Sources (all optional; missing ones are skipped):
 *  - player/agents/main/*.jsonl  Pi session transcripts, merged chronologically by filename
 *                                (a resumed run starts a new file); base64 image data is dropped at parse
 *  - usage.jsonl                 token ledger: run totals, compaction times, per-call zip fallback
 *  - history.jsonl               host RPC log: end_turn turn boundaries, display artifacts, method counts
 *  - player/agents/main/provider.jsonl or native.jsonl
 *                                optional provider journals: compaction sizes, failed HTTP statuses
 *
 * Per-call tokens prefer the session message's own usage (aligned by construction for every provider);
 * when absent they fall back to zipping usage.jsonl events (main agent, non-compaction) by order.
 * Rebuilds are incremental: each source is re-read only from the byte offset already consumed, so a
 * steady-state refresh reads only appended data. Output is written atomically (tmp + rename).
 */
import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

interface CallTokens { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; cost: number | null }
type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; name: string; code: string }
  | { type: "image" };
interface Entry { ts: string; role: "user" | "assistant" | "toolResult"; blocks: Block[]; error: string | null; usage: CallTokens | null }
interface Compaction { time: string; originalLen: number | null; summaryLen: number | null }
interface Ledger { requests: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; usd: number; unpriced: number; present: boolean }
type SourceKind = "transcript" | "usage" | "history" | "journal";

const RESET = Symbol("source shrank; reparse everything");
const INTERESTING: Record<SourceKind, Record<string, boolean>> = {
  transcript: { message: true, model_change: true },
  usage: { start: true, usage: true, end: true },
  history: { request: true, execution_result: true },
  journal: { compaction: true, request_end: true, http_error: true },
};
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"]/g, character => ESCAPES[character]!);
const hhmmss = (iso: string | null): string => iso ? iso.slice(11, 19) : "?";
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const lengthJson = (value: unknown): number => typeof value === "string" ? value.length : JSON.stringify(value ?? "").length;

/** Narrow an unknown JSON value to a plain object (null/arrays rejected). */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Cheap first-match kind/type tag from the line head; empty when absent (defensive full parse). */
function headTag(line: string): string {
  const match = /"(?:kind|type)":"([a-zA-Z_-]+)"/.exec(line.length > 220 ? line.slice(0, 220) : line);
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

interface Offset { offset: number }

/** Accumulated run state; `refresh()` applies only bytes appended since the previous call. */
export class RunView {
  entries: Entry[] = [];
  endTurns: string[] = [];
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

  resetState(): void {
    this.entries.length = 0;
    this.endTurns.length = 0;
    this.display.length = 0;
    this.methods.clear();
    this.model = "?";
    this.compactions.length = 0;
    this.failures.length = 0;
    this.ledger = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, usd: 0, unpriced: 0, present: false };
    this.offsets.clear();
    this.kinds.clear();
    this.usageEvents.length = 0;
  }

  async refresh(runDir: string): Promise<void> {
    this.runDir = runDir;
    this.read = 0;
    const mainDir = join(runDir, "player", "agents", "main");
    let transcripts: string[] = [];
    try {
      transcripts = readdirSync(mainDir)
        .filter(name => name.endsWith(".jsonl") && name !== "provider.jsonl" && name !== "native.jsonl")
        .sort().map(name => join(mainDir, name));
    } catch { /* run directory not created yet */ }
    const sources: { path: string; kind: SourceKind }[] = [
      ...transcripts.map(path => ({ path, kind: "transcript" as const })),
      { path: join(runDir, "usage.jsonl"), kind: "usage" },
      { path: join(runDir, "history.jsonl"), kind: "history" },
      { path: join(mainDir, "provider.jsonl"), kind: "journal" },
      { path: join(mainDir, "native.jsonl"), kind: "journal" },
    ];
    try {
      for (const source of sources) await this.pump(source);
    } catch (error) {
      if (error !== RESET) throw error;
      this.resetState();
      for (const source of sources) await this.pump(source);
    }
    this.endTurns.sort();
  }

  /** Read the byte range beyond the last consumed offset; an unterminated trailing line is re-read next time. */
  private async pump(source: { path: string; kind: SourceKind }): Promise<void> {
    let state = this.offsets.get(source.path);
    if (!state) this.offsets.set(source.path, state = { offset: 0 });
    let size = 0;
    try { size = statSync(source.path).size; } catch { return; } // absent yet: skip silently
    if (size < state.offset) throw RESET;
    if (size === state.offset) return;
    const handle = await open(source.path, "r");
    try {
      const bytes = Buffer.allocUnsafe(size - state.offset);
      const read = await handle.read(bytes, 0, bytes.length, state.offset);
      const data = read.bytesRead < bytes.length ? bytes.subarray(0, read.bytesRead) : bytes;
      this.read += data.length;
      // state.offset stops after the last complete line, so the next read naturally re-reads any
      // unterminated trailing line and parses it once it is complete.
      let at = 0;
      for (;;) {
        const newline = data.indexOf(10, at);
        if (newline === -1) break;
        this.apply(data.subarray(at, newline).toString("utf8"), source.kind);
        at = newline + 1;
      }
      state.offset += at;
    } finally { await handle.close(); }
  }

  private apply(line: string, kind: SourceKind): void {
    const tag = headTag(line);
    if (tag !== "" && !INTERESTING[kind][tag]) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; } // torn or malformed line: skipped
    const event = record(parsed);
    if (!event) return;
    const key = tag || str(event.type) || str(event.kind);
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
        if (method === "civ.action" && JSON.stringify(event.args ?? {}).includes("end_turn")) this.endTurns.push(str(event.at));
      } else if (key === "execution_result") this.applyDisplay(event);
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
      blocks,
      error: message.stopReason === "error" ? (str(message.errorMessage) || "error") : null,
      usage: tokens,
    });
  }

  /** Display images from one execution: workspace copies first; artifact copies when the workspace has none. */
  private applyDisplay(event: Record<string, unknown>): void {
    let found = 0;
    if (Array.isArray(event.workspaceFiles)) {
      for (const item of event.workspaceFiles) {
        const path = str(item).replaceAll("\\", "/");
        if (/^\.executions\/[^/]+\/display-\d+\.(png|jpg)$/i.test(path)) { this.display.push(`workspaces/main/${path}`); found++; }
      }
    }
    if (found || !Array.isArray(event.artifacts)) return;
    for (const item of event.artifacts) {
      const path = str(item).replaceAll("\\", "/");
      if (/\.(png|jpg)$/i.test(path)) this.display.push(path.startsWith("artifacts/") ? path : `artifacts/${path}`);
    }
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

  render(refreshSeconds: number, builtMs: number, runName = basename(this.runDir)): string {
    this.summarizeLedger();
    const entries = this.entries.slice().sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
    const isCall = (entry: Entry): boolean => entry.role === "assistant" && !(entry.error !== null && entry.blocks.length === 0);
    const calls: Entry[] = [];
    const slots = new Map<Entry, number>();
    for (const entry of entries) if (isCall(entry)) { slots.set(entry, calls.length); calls.push(entry); }
    // Fallback tokens: usage.jsonl events of the main agent except compaction requests, by call order.
    const zip = this.usageEvents
      .filter(event => {
        const meta = this.kinds.get(event.requestId);
        return meta?.kind !== "compact" && (meta === undefined || meta.agent === "main" || meta.agent === "?");
      })
      .map(event => event.tokens);
    const tokensOf = (entry: Entry): CallTokens | null => entry.usage ?? zip[slots.get(entry) ?? -1] ?? null;
    const ctxOf = (tokens: CallTokens | null): number => tokens ? tokens.input + tokens.cacheRead : 0;
    const ctx = calls.map(tokensOf).map(ctxOf);
    const peak = ctx.reduce((best, value, index) => value > best.v ? { v: value, i: index } : best, { v: 0, i: 0 });
    const attempts = entries.filter(entry => entry.role === "assistant");
    const stubs = attempts.filter(entry => entry.error !== null);
    const lastStub = stubs[stubs.length - 1];
    const finalFailure = this.failures.length
      ? this.failures.reduce((last, failure) => failure.time > last.time ? failure : last)
      : lastStub ? { time: lastStub.ts, status: /HTTP (\d+)/.exec(lastStub.error ?? "")?.[1] ?? "?" } : null;
    const compactionTimes = (this.compactions.length ? this.compactions : this.usageEvents
      .filter(event => this.kinds.get(event.requestId)?.kind === "compact")
      .map(event => ({ time: event.time, originalLen: null as number | null, summaryLen: null as number | null })))
      .slice().sort((a, b) => a.time < b.time ? -1 : 1);
    const window = entries.length ? `${hhmmss(entries[0]!.ts)}–${hhmmss(entries[entries.length - 1]!.ts)}Z` : "?";
    const activity = [...this.methods.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([method, count]) => `${esc(method)} ${count}`).join(" · ");

    const sparkCard = (() => {
      if (ctx.length < 2) return "";
      const W = 560, H = 48, max = Math.max(...ctx);
      const points = ctx.map((value, index) => `${(index / (ctx.length - 1) * W).toFixed(1)},${(H - 4 - value / max * (H - 8)).toFixed(1)}`).join(" ");
      const marks = compactionTimes.map(compaction => {
        const index = calls.findIndex(call => call.ts > compaction.time);
        if (index < 1) return "";
        const x = (index / (calls.length - 1) * W).toFixed(1);
        return `<line x1="${x}" y1="2" x2="${x}" y2="${H - 2}" stroke="#f96" stroke-dasharray="3 3"/>`;
      }).join("");
      const svg = `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline fill="none" stroke="#6cf" stroke-width="1.5" points="${points}"/>${marks}</svg>`;
      return `<div class="card answers"><div class="head">CONTEXT GROWTH · fresh+cached per model call${marks ? " · dashed = compaction" : ""}</div>${svg}</div>`;
    })();

    // The most recent thinking block renders expanded; every older one stays collapsed.
    let openEntry: Entry | undefined, openBlock = -1;
    for (let index = entries.length - 1; index >= 0 && !openEntry; index--) {
      const blocks = entries[index]!.blocks;
      for (let slot = blocks.length - 1; slot >= 0; slot--) {
        if (blocks[slot]!.type === "thinking") { openEntry = entries[index]; openBlock = slot; break; }
      }
    }
    let body = "", sidebar = "", lastTurn = 0, displayIndex = 0, mark = 0;
    for (const entry of entries) {
      const turn = turnOf(entry.ts, this.endTurns);
      if (turn !== lastTurn && entry.role !== "toolResult") {
        body += `<h3 id="turn${turn}">— turn ${turn} —</h3>`;
        sidebar += `<a class="toc" href="#turn${turn}">turn ${turn}</a>`;
        lastTurn = turn;
      }
      while (mark < compactionTimes.length && compactionTimes[mark]!.time < entry.ts) {
        body += `<div class="mark">⋯ context compacted ${hhmmss(compactionTimes[mark]!.time)}Z ⋯</div>`;
        mark++;
      }
      if (entry.role === "user") {
        const text = entry.blocks.map(block => block.type === "text" ? block.text : "").join("\n");
        body += `<div class="card user"><div class="head">USER PROMPT · ${hhmmss(entry.ts)}</div><div class="text">${esc(text.slice(0, 2500))}${text.length > 2500 ? " …[truncated]" : ""}</div></div>`;
      } else if (entry.role === "assistant") {
        const own = tokensOf(entry);
        const tok = own
          ? `fresh ${own.input.toLocaleString()} · cached ${own.cacheRead.toLocaleString()} · out ${own.output.toLocaleString()} · ctx≈${ctxOf(own).toLocaleString()}`
          : `no usage — ${esc(entry.error ?? "no tokens reported")}`;
        if (!isCall(entry)) {
          body += `<div class="card assistant"><div class="head">model call · ${hhmmss(entry.ts)} <span class="tok">${tok}</span></div><div class="text err">Request failed: ${esc(entry.error)}</div></div>`;
          continue;
        }
        let inner = "";
        for (let index = 0; index < entry.blocks.length; index++) {
          const block = entry.blocks[index]!;
          if (block.type === "thinking") inner += `<details class="think"${entry === openEntry && index === openBlock ? " open" : ""}><summary>thinking</summary><pre>${esc(block.thinking)}</pre></details>`;
          else if (block.type === "text") inner += `<div class="text">${linkify(block.text, this.runDir)}</div>`;
          else if (block.type === "toolCall") inner += `<details class="tool"><summary>${esc(block.name)}</summary><pre>${linkify(block.code.length > 16000 ? `${block.code.slice(0, 16000)}\n…[truncated]` : block.code, this.runDir)}</pre></details>`;
        }
        body += `<div class="card assistant"><div class="head">model call · ${hhmmss(entry.ts)} <span class="tok">${tok}</span></div>${inner}</div>`;
      } else {
        let html = "";
        for (const block of entry.blocks) {
          if (block.type === "image") {
            const src = this.display[displayIndex++] ?? null;
            html += src ? `<a href="${esc(src)}" target="_blank"><img class="shot" loading="lazy" src="${esc(src)}"></a>` : `<div class="text">🖼 (display artifact not recorded yet)</div>`;
          } else if (block.type === "text") {
            html += `<pre class="res">${esc(block.text.slice(0, 6000))}${block.text.length > 6000 ? "\n…[truncated]" : ""}</pre>`;
          }
        }
        body += `<div class="card toolresult"><div class="head">exec result · ${hhmmss(entry.ts)}</div>${html}</div>`;
      }
    }
    if (!entries.length) {
      body = `<div class="card answers"><div class="head">WAITING FOR RUN DATA</div><div class="text">No model transcript yet. Expected under ${esc(join(this.runDir, "player", "agents", "main"))}: *.jsonl session transcripts, plus usage.jsonl and history.jsonl. This page reloads itself while the dashboard runs.</div></div>`;
    }
    const surplus = this.display.length - displayIndex;
    if (entries.length && surplus > 0) console.log(`[dashboard] ${surplus} display artifact(s) not yet matched to a tool result (run still growing?)`);
    if (entries.length && surplus < 0) console.log(`[dashboard] ${-surplus} tool-result image(s) without a display artifact`);

    const lastCompaction = compactionTimes[compactionTimes.length - 1];
    const compactionNote = lastCompaction
      ? `compaction ${hhmmss(lastCompaction.time)}Z${lastCompaction.originalLen !== null ? ` · ${(lastCompaction.originalLen / 1e6).toFixed(1)} MB → ${lastCompaction.summaryLen?.toLocaleString()} chars` : ""}${compactionTimes.length > 1 ? ` (${compactionTimes.length} total)` : ""}<br>`
      : "";
    const sidebarHead = `<b>${esc(runName)} run viewer</b><br>${esc(this.model)}<br>
<b>${attempts.length}</b> model calls (${stubs.length} failed) · <b>${this.endTurns.length}</b> end_turns → ${this.endTurns.length + 1} turns<br>
${this.ledger.present ? `main fresh ${this.ledger.input.toLocaleString()} · cached ${this.ledger.cacheRead.toLocaleString()} · out ${this.ledger.output.toLocaleString()} · reasoning ${this.ledger.reasoning.toLocaleString()}<br>
${this.ledger.requests} requests · est $${this.ledger.usd.toFixed(2)} (${this.ledger.unpriced} unpriced)<br>` : "usage ledger absent<br>"}
ctx peak ${peak.v.toLocaleString()}${peak.v ? ` at call ${peak.i + 1}` : ""}<br>
${compactionNote}final HTTP ${esc(finalFailure?.status ?? "—")}<br>
${displayIndex} display images · rebuilt in ${builtMs}ms<br>${activity ? `activity: ${activity}<br>` : ""}<hr>`;
    sidebar = sidebarHead + sidebar;

    return `<!doctype html><html><head><meta charset="utf-8">${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}<title>${esc(runName)} run viewer</title><style>
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
</style></head><body><div id="side">${sidebar}</div><div id="main">${sparkCard}${body}<div id="tail"></div></div>
<script>(function(){
var KEY="civ-viewer-follow",tail=document.getElementById("tail"),last=scrollY;
var follow=function(){return sessionStorage.getItem(KEY)!=="0"};
addEventListener("scroll",function(){
  if(innerHeight+scrollY>=document.documentElement.scrollHeight-64)sessionStorage.setItem(KEY,"1");
  else if(scrollY<last)sessionStorage.setItem(KEY,"0");
  last=scrollY;
  btn.textContent=follow()?"follow":"pinned";
});
var btn=document.createElement("button");
btn.id="followbtn";
btn.textContent=follow()?"follow":"pinned";
btn.onclick=function(){
  var next=!follow();
  sessionStorage.setItem(KEY,next?"1":"0");
  btn.textContent=next?"follow":"pinned";
  if(next)tail.scrollIntoView({block:"end"});
};
document.body.appendChild(btn);
onbeforeunload=function(){sessionStorage.setItem("civ-viewer-scroll",String(scrollY))};
addEventListener("load",function(){
  if(follow())tail.scrollIntoView({block:"end"});
  else{var at=sessionStorage.getItem("civ-viewer-scroll");if(at!==null)scrollTo(0,+at)}
  setTimeout(function(){if(follow()&&innerHeight+scrollY<document.documentElement.scrollHeight-64)tail.scrollIntoView({block:"end"})},400);
});
})();</script></body></html>`;
  }
}

function turnOf(ts: string, ends: string[]): number {
  let turn = 1;
  for (const at of ends) if (ts > at) turn++;
  return turn;
}

/** Single-pass image-path linkifier: emitted markup is never rescanned. */
function linkify(text: string, runDir: string): string {
  let out = "";
  const pattern = /(?:\.executions\/[^'"\\\s]+\/display-\d+\.(?:png|jpg))|(?:[\w-]+\.(?:png|jpg))/gi;
  let last = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    out += esc(text.slice(last, match.index));
    const path = match[0];
    if (/^\.executions\//i.test(path)) out += `<a class="imglink" href="workspaces/main/${esc(path.replaceAll("\\", "/"))}" target="_blank">🖼 display</a>`;
    else if (existsSync(join(runDir, "workspaces", "main", path))) out += `<a class="imglink" href="workspaces/main/${esc(path)}" target="_blank">🖼 ${esc(path)}</a>`;
    else out += esc(path);
    last = match.index + match[0].length;
  }
  return out + esc(text.slice(last));
}

function writeAtomic(target: string, html: string): void {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, html);
    renameSync(temporary, target);
  } catch (error) {
    try { renameSync(temporary, `${target}.${randomUUID()}.tmp`); } catch { /* nothing to clean */ }
    throw error;
  }
}

/** Poll the run's ledgers and regenerate viewer.html whenever they change. Returns on SIGINT. */
export async function runDashboard(runDir: string, interval: number): Promise<void> {
  const view = new RunView();
  const target = join(runDir, "viewer.html");
  console.log(`Dashboard watching ${runDir} (poll every ${interval}s); Ctrl+C to stop.`);
  let signature = "", stopped = false, lastWaiting: boolean | null = null;
  let wake: (() => void) | undefined;
  const namedInterrupt = (): void => { stopped = true; wake?.(); };
  process.on("SIGINT", namedInterrupt);
  const sleep = (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => { if (wake === stop) wake = undefined; resolve(); }, ms);
    const stop = (): void => { clearTimeout(timer); if (wake === stop) wake = undefined; resolve(); };
    wake = stop;
    return promise;
  };
  const inputs = (): { sig: string; transcripts: number; dir: boolean } => {
    const mainDir = join(runDir, "player", "agents", "main");
    const stat = (path: string): string => {
      try { const info = statSync(path); return `${info.size}:${info.mtimeMs}`; } catch { return "-"; }
    };
    const parts: string[] = [];
    let transcripts = 0;
    try {
      for (const name of readdirSync(mainDir).sort()) {
        if (!name.endsWith(".jsonl") || name === "provider.jsonl" || name === "native.jsonl") continue;
        parts.push(name, stat(join(mainDir, name)));
        transcripts++;
      }
    } catch { /* missing directory */ }
    parts.push(stat(join(runDir, "usage.jsonl")), stat(join(runDir, "history.jsonl")));
    for (const journal of ["provider.jsonl", "native.jsonl"]) parts.push(stat(join(mainDir, journal)));
    return { sig: parts.join("|"), transcripts, dir: existsSync(runDir) };
  };
  while (!stopped) {
    const state = inputs();
    const waiting = !state.dir || state.transcripts === 0;
    const changed = state.sig !== signature;
    signature = state.sig;
    if (waiting !== lastWaiting) {
      lastWaiting = waiting;
      console.log(waiting ? `[dashboard] waiting for run data in ${runDir}` : `[dashboard] run data found`);
    }
    if (state.dir && changed) {
      const started = performance.now();
      try {
        await view.refresh(runDir);
        writeAtomic(target, view.render(interval, Math.round(performance.now() - started)));
        console.log(`[dashboard] viewer.html ${waiting ? "waiting page" : "rebuilt"} in ${Math.round(performance.now() - started)}ms · ${view.read.toLocaleString()} bytes read`);
      } catch (error) { console.error(`[dashboard] rebuild failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await sleep(interval * 1000);
  }
  process.off("SIGINT", namedInterrupt);
}
