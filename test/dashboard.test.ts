import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RunView, startDashboard, type TailEvent } from "../src/dashboard.ts";

type Cleanup = () => void | Promise<void>;
const cleanups: Cleanup[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "civ-dashboard-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function message(timestamp: string, role: string, content: unknown[], extra: Record<string, unknown> = {}): string {
  return line({
    type: "message",
    id: `${role}-${timestamp}`,
    parentId: null,
    timestamp,
    message: { role, content, ...extra },
  });
}

type CardEvent = Extract<TailEvent, { k: "card" }>;
type TurnEvent = Extract<TailEvent, { k: "turn" }>;

function cards(events: TailEvent[]): CardEvent[] {
  return events.filter((event): event is CardEvent => event.k === "card");
}

function turns(events: TailEvent[]): TurnEvent[] {
  return events.filter((event): event is TurnEvent => event.k === "turn");
}

function generation(events: TailEvent[]): number | undefined {
  return events.find((event): event is Extract<TailEvent, { k: "gen" }> => event.k === "gen")?.gen;
}
function hasFullState(events: TailEvent[]): boolean {
  return generation(events) !== undefined
    && events.some(event => event.k === "side")
    && events.some(event => event.k === "spark");
}

type StreamReadResult = { done: false; value: Uint8Array } | { done: true; value?: Uint8Array };

class SseClient {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private pendingRead: Promise<StreamReadResult> | undefined;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private frame(): { name: string; data: unknown } | undefined {
    const separator = /\r?\n\r?\n/.exec(this.buffer);
    if (!separator || separator.index === undefined) return undefined;
    const raw = this.buffer.slice(0, separator.index);
    this.buffer = this.buffer.slice(separator.index + separator[0].length);
    let name = "message";
    const data: string[] = [];
    for (const row of raw.split(/\r?\n/)) {
      if (row.startsWith("event:")) name = row.slice("event:".length).trim();
      else if (row.startsWith("data:")) data.push(row.slice("data:".length).trimStart());
    }
    return { name, data: data.length ? JSON.parse(data.join("\n")) : null };
  }

  private async read(timeoutMs: number): Promise<StreamReadResult> {
    // This boundary test intentionally waits on the real SSE polling loop; fake timers cannot drive Bun.serve.
    const pending = this.pendingRead ??= this.reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("SSE read timed out")), timeoutMs);
    });
    try {
      const result = await Promise.race([pending, timeout]);
      this.pendingRead = undefined;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async next(name: string, timeoutMs = 2_000): Promise<unknown> {
    for (;;) {
      const frame = this.frame();
      if (frame) {
        if (frame.name === name) return frame.data;
        continue;
      }
      const chunk = await this.read(timeoutMs);
      if (chunk.done) throw new Error("SSE stream closed");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async close(): Promise<void> {
    try { await this.reader.cancel(); } catch { /* server may already be closed */ }
  }
}

async function connect(base: string): Promise<SseClient> {
  const response = await fetch(`${base}/events`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("SSE response has no body");
  const client = new SseClient(response.body.getReader());
  cleanups.push(() => client.close());
  return client;
}

async function nextTail(client: SseClient, predicate: (events: TailEvent[]) => boolean, timeoutMs = 3_000): Promise<TailEvent[]> {
  const deadline = Date.now() + timeoutMs;
  const events: TailEvent[] = [];
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const batch = await client.next("tail", remaining);
    if (!Array.isArray(batch)) throw new Error("SSE tail data is not an array");
    events.push(...batch as TailEvent[]);
    if (predicate(events)) return events;
  }
  throw new Error("Timed out waiting for the expected tail state");
}

async function noTail(client: SseClient, timeoutMs = 180): Promise<void> {
  await expect(client.next("tail", timeoutMs)).rejects.toThrow("timed out");
}

test("RunView attributes retries to observed turns rather than end_turn submissions", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  mkdirSync(main, { recursive: true });
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  writeFileSync(join(dir, "snapshots", "s-7.json"), line({
    turn: 7,
    capturedAt: "2026-09-08T10:59:59.000Z",
  }));
  writeFileSync(join(main, "2026-09-08T11-00-00-000Z_s1.jsonl"),
    message("2026-09-08T11:00:00.000Z", "user", [{ type: "text", text: "play turn" }])
    + message("2026-09-08T11:00:01.000Z", "assistant", [{ type: "text", text: "first attempt" }], { stopReason: "stop" })
    + message("2026-09-08T11:00:20.000Z", "assistant", [{ type: "text", text: "retry in the same turn" }], { stopReason: "stop" })
    + message("2026-09-08T11:00:30.000Z", "assistant", [{ type: "text", text: "after observed advance" }], { stopReason: "stop" }));
  writeFileSync(join(dir, "history.jsonl"),
    line({ at: "2026-09-08T11:00:05.000Z", kind: "request", method: "civ.action", args: { action: "end_turn" } })
    + line({ at: "2026-09-08T11:00:06.000Z", kind: "request", method: "civ.action", args: { action: "end_turn" } })
    + line({ at: "2026-09-08T11:00:10.000Z", kind: "request", method: "civ.action", args: { action: "end_turn" } })
    + line({ at: "2026-09-08T11:00:25.000Z", kind: "request", method: "civ.action", args: { action: "end_turn" } })
    + line({ at: "2026-09-08T11:00:26.000Z", kind: "result", result: { turnState: { turn: 8 } } }));

  const view = new RunView();
  await view.refresh(dir);
  expect(view.endTurns).toBe(4);
  expect(view.turns).toEqual([
    { time: "2026-09-08T10:59:59.000Z", turn: 7 },
    { time: "2026-09-08T11:00:26.000Z", turn: 8 },
  ]);

  const take = view.takeTail("retry-run");
  expect(turns(take.events).map(event => event.turn)).toEqual([7, 8]);
  const callCards = cards(take.events).filter(event => event.cls === "assistant");
  expect(callCards).toHaveLength(3);
  expect(callCards.map(event => event.b)).toEqual([
    expect.stringContaining("first attempt"),
    expect.stringContaining("retry in the same turn"),
    expect.stringContaining("after observed advance"),
  ]);
});

test("RunView leaves turn attribution unknown until a game observation exists", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, "2026-09-08T12-00-00-000Z_s1.jsonl"),
    message("2026-09-08T12:00:00.000Z", "user", [{ type: "text", text: "before observation" }])
    + message("2026-09-08T12:00:01.000Z", "assistant", [{ type: "text", text: "no invented turn" }], { stopReason: "stop" }));

  const view = new RunView();
  await view.refresh(dir);
  const take = view.takeTail("unknown-turn");
  expect(turns(take.events)).toEqual([{ k: "turn", turn: null }]);
  expect(cards(take.events).some(event => event.b.includes("no invented turn"))).toBe(true);
});

test("RunView resumes torn lines, applies late usage, and emits changed cards once", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  mkdirSync(main, { recursive: true });
  const session = join(main, "2026-09-08T13-00-00-000Z_s1.jsonl");
  writeFileSync(session,
    message("2026-09-08T13:00:00.000Z", "user", [{ type: "text", text: "start" }])
    + message("2026-09-08T13:00:01.000Z", "assistant", [{ type: "text", text: "waiting for usage" }], { stopReason: "stop" }));
  writeFileSync(join(dir, "usage.jsonl"), line({
    time: "2026-09-08T13:00:00.500Z",
    version: 1,
    type: "start",
    request: { requestId: "r1", agentId: "main", kind: "completions" },
  }));

  const view = new RunView();
  await view.refresh(dir);
  const first = view.takeTail("late-data");
  const firstAssistant = cards(first.events).find(event => event.b.includes("waiting for usage"));
  expect(firstAssistant).toBeDefined();
  expect(firstAssistant!.b).toContain("no usage");

  appendFileSync(join(dir, "usage.jsonl"), line({
    time: "2026-09-08T13:00:01.500Z",
    version: 1,
    type: "usage",
    requestId: "r1",
    tokens: { input: 5, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 0 },
    estimatedUsd: 0.01,
  }));
  await view.refresh(dir);
  const late = view.takeTail("late-data");
  const lateCards = cards(late.events);
  expect(lateCards).toHaveLength(1);
  expect(lateCards[0]!.id).toBe(firstAssistant!.id);
  expect(lateCards[0]!.b).toContain("fresh 5");
  const side = late.events.find((event): event is Extract<TailEvent, { k: "side" }> => event.k === "side");
  expect(side?.b).toContain("API estimate $0.01");
  expect(side?.b).toContain("not subscription charges");
  expect(view.takeTail("late-data")).toEqual({ events: [], restart: false });

  appendFileSync(session, '{"type":"message","timestamp":"2026-09-08T13:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"partial');
  await view.refresh(dir);
  expect(view.entries).toHaveLength(2);
  expect(view.takeTail("late-data")).toEqual({ events: [], restart: false });

  appendFileSync(session, ' line"}],"stopReason":"stop"}}\n');
  await view.refresh(dir);
  expect(view.entries).toHaveLength(3);
  const resumed = cards(view.takeTail("late-data").events);
  expect(resumed).toHaveLength(1);
  expect(resumed[0]!.b).toContain("partial line");
});

test("RunView links image-only execution results by tool identity", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  const fileA = join(dir, "workspaces", "main", ".executions", "exec-a", "display-1.jpg");
  const fileB = join(dir, "workspaces", "main", ".executions", "exec-b", "display-1.jpg");
  mkdirSync(main, { recursive: true });
  mkdirSync(join(fileA, ".."), { recursive: true });
  mkdirSync(join(fileB, ".."), { recursive: true });
  writeFileSync(fileA, Uint8Array.of(1, 2, 3));
  writeFileSync(fileB, Uint8Array.of(4, 5, 6));
  const session = join(main, "2026-09-08T13-30-00-000Z_s1.jsonl");
  const history = join(dir, "history.jsonl");
  const callA = "call-image-a";
  const callB = "call-image-b";
  const executionA = "execution-image-a";
  const executionB = "execution-image-b";
  const pathA = "workspaces/main/.executions/exec-a/display-1.jpg";
  const pathB = "workspaces/main/.executions/exec-b/display-1.jpg";
  writeFileSync(session,
    message("2026-09-08T13:30:00.000Z", "user", [{ type: "text", text: "inspect images" }])
    + message("2026-09-08T13:30:01.000Z", "toolResult", [{ type: "image" }], { toolCallId: callA })
    + message("2026-09-08T13:30:02.000Z", "toolResult", [{ type: "image" }], { toolCallId: callB }));
  writeFileSync(history, "");

  const view = new RunView();
  await view.refresh(dir);
  const unresolved = cards(view.takeTail("image-identity").events).filter(event => event.cls === "toolresult");
  expect(unresolved).toHaveLength(2);
  expect(unresolved.every(event => !event.b.includes("<img"))).toBe(true);

  appendFileSync(history,
    line({ at: "2026-09-08T13:30:01.010Z", kind: "player", type: "tool_start", agentId: "main", data: { toolCallId: callA } })
    + line({ at: "2026-09-08T13:30:01.011Z", kind: "execution", agentId: "main", executionId: executionA, code: "display(image)" })
    + line({
      at: "2026-09-08T13:30:01.012Z",
      kind: "execution_result",
      agentId: "main",
      executionId: executionA,
      content: [{ type: "image", artifact: `executions/main/${executionA}-0.jpg`, mimeType: "image/jpeg" }],
      artifacts: [`executions/main/${executionA}-0.jpg`],
      workspaceFiles: [".executions/exec-a/display-1.jpg"],
    })
    + line({ at: "2026-09-08T13:30:01.013Z", kind: "player", type: "tool_end", agentId: "main", data: { toolCallId: callA } })
    + line({ at: "2026-09-08T13:30:02.010Z", kind: "player", type: "tool_start", agentId: "main", data: { toolCallId: callB } })
    + line({ at: "2026-09-08T13:30:02.011Z", kind: "execution", agentId: "main", executionId: executionB, code: "display(image)" })
    + line({
      at: "2026-09-08T13:30:02.012Z",
      kind: "execution_result",
      agentId: "main",
      executionId: executionB,
      content: [{ type: "image", artifact: `executions/main/${executionB}-0.jpg`, mimeType: "image/jpeg" }],
      artifacts: [`executions/main/${executionB}-0.jpg`],
      workspaceFiles: [".executions/exec-b/display-1.jpg"],
    })
    + line({ at: "2026-09-08T13:30:02.013Z", kind: "player", type: "tool_end", agentId: "main", data: { toolCallId: callB } }));
  await view.refresh(dir);
  const linked = cards(view.takeTail("image-identity").events).filter(event => event.cls === "toolresult");
  expect(linked).toHaveLength(2);
  expect(linked[0]!.b).toContain(encodeURIComponent(pathA));
  expect(linked[1]!.b).toContain(encodeURIComponent(pathB));
  expect(view.imagePath(pathA)).toBe(fileA);
  expect(view.imagePath(pathB)).toBe(fileB);
});

test("RunView preserves resumed sessions and resets generation after a source shrink", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  mkdirSync(main, { recursive: true });
  const firstSession = join(main, "2026-09-08T14-00-00-000Z_s1.jsonl");
  writeFileSync(firstSession, message("2026-09-08T14:00:00.000Z", "user", [{ type: "text", text: "original prompt that will be replaced" }]));

  const view = new RunView();
  await view.refresh(dir);
  view.takeTail("resume-run");
  const oldGeneration = view.generation;

  writeFileSync(join(main, "2026-09-08T14-05-00-000Z_s2.jsonl"),
    message("2026-09-08T14:05:00.000Z", "assistant", [{ type: "text", text: "resumed session" }], { stopReason: "stop" }));
  await view.refresh(dir);
  const resumed = view.takeTail("resume-run");
  expect(resumed.restart).toBe(false);
  expect(cards(resumed.events)).toHaveLength(1);
  expect(cards(resumed.events)[0]!.b).toContain("resumed session");

  writeFileSync(firstSession, message("2026-09-08T14:00:00.000Z", "user", [{ type: "text", text: "rewritten" }]));
  await view.refresh(dir);
  expect(view.entries).toHaveLength(2);
  const rebuilt = view.takeTail("resume-run");
  expect(rebuilt.restart).toBe(true);
  expect(view.generation).toBeGreaterThan(oldGeneration);
  expect(rebuilt.events[0]).toEqual({ k: "gen", gen: view.generation });
  const rebuiltCards = cards(rebuilt.events);
  expect(rebuiltCards).toHaveLength(2);
  expect(rebuiltCards.map(event => event.b).join("\n")).toContain("rewritten");
  expect(rebuiltCards.map(event => event.b).join("\n")).toContain("resumed session");
  expect(rebuiltCards.map(event => event.b).join("\n")).not.toContain("original prompt");
});

test("startDashboard serves a shell and streams only incremental changes", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  mkdirSync(main, { recursive: true });
  const session = join(main, "2026-09-08T15-00-00-000Z_s1.jsonl");
  writeFileSync(session, message("2026-09-08T15:00:00.000Z", "user", [{ type: "text", text: "hello live" }]));

  const dashboard = await startDashboard(dir, 0.05);
  cleanups.push(() => dashboard.close());
  const shellResponse = await fetch(dashboard.url);
  expect(shellResponse.status).toBe(200);
  expect(shellResponse.headers.get("content-type")).toContain("text/html");
  expect(await shellResponse.text()).toContain("<!doctype html>");
  expect((await fetch(`${dashboard.url}history.jsonl`)).status).toBe(404);
  expect((await fetch(`${dashboard.url}usage.jsonl`)).status).toBe(404);

  const client = await connect(dashboard.url);
  const initial = await nextTail(client, events =>
    hasFullState(events) && cards(events).some(event => event.b.includes("hello live")));
  expect(generation(initial)).toBeDefined();
  const initialCard = cards(initial).find(event => event.b.includes("hello live"));
  expect(initialCard).toBeDefined();

  await noTail(client);
  appendFileSync(session, message("2026-09-08T15:00:01.000Z", "assistant", [{ type: "text", text: "answer streamed" }], { stopReason: "stop" }));
  const appended = await nextTail(client, events =>
    events.some(event => event.k === "side") && cards(events).some(event => event.b.includes("answer streamed")));
  const appendedCards = cards(appended).filter(event => event.b.includes("answer streamed"));
  expect(appendedCards).toHaveLength(1);
  expect(generation(appended)).toBeUndefined();
  await noTail(client);
});

test("startDashboard replays reconnects, resets on shrink, and protects image paths", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  const imageDir = join(dir, "workspaces", "main", ".executions", "e1");
  mkdirSync(main, { recursive: true });
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(join(dir, "workspaces", "main", "private.png"), Uint8Array.of(9, 8, 7));
  const imagePath = join(imageDir, "display-1.png");
  writeFileSync(imagePath, Uint8Array.of(1, 2, 3, 4));
  const session = join(main, "2026-09-08T16-00-00-000Z_s1.jsonl");
  writeFileSync(session,
    message("2026-09-08T16:00:00.000Z", "user", [{ type: "text", text: "inspect" }])
    + message("2026-09-08T16:00:01.000Z", "toolResult", [{ type: "image" }]));
  writeFileSync(join(dir, "history.jsonl"), line({
    at: "2026-09-08T16:00:01.100Z",
    kind: "execution_result",
    workspaceFiles: [".executions/e1/display-1.png"],
  }));

  const dashboard = await startDashboard(dir, 0.05);
  cleanups.push(() => dashboard.close());
  const firstClient = await connect(dashboard.url);
  const initial = await nextTail(firstClient, events =>
    hasFullState(events) && cards(events).some(event => event.cls === "toolresult"));
  const firstGeneration = generation(initial);
  expect(firstGeneration).toBeDefined();

  const allowed = await fetch(`${dashboard.url}image?path=${encodeURIComponent("workspaces/main/.executions/e1/display-1.png")}`);
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("content-type")).toContain("image/png");
  expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4));
  expect((await fetch(`${dashboard.url}image?path=${encodeURIComponent("workspaces/main/private.png")}`)).status).toBe(404);
  expect((await fetch(`${dashboard.url}image?path=${encodeURIComponent("history.jsonl")}`)).status).toBe(404);
  expect((await fetch(`${dashboard.url}image?path=${encodeURIComponent("../history.jsonl")}`)).status).toBe(404);
  expect((await fetch(`${dashboard.url}player/agents/main/${basename(session)}`)).status).toBe(404);

  writeFileSync(session, message("2026-09-08T16:00:00.000Z", "user", [{ type: "text", text: "rewritten live" }]));
  const reset = await nextTail(firstClient, events =>
    hasFullState(events)
    && generation(events) !== firstGeneration
    && cards(events).some(event => event.b.includes("rewritten live")));
  expect(generation(reset)).not.toBe(firstGeneration);
  expect(cards(reset).map(event => event.b).join("\n")).not.toContain("inspect");

  const reconnect = await connect(dashboard.url);
  const replay = await nextTail(reconnect, events =>
    hasFullState(events)
    && generation(events) === generation(reset)
    && cards(events).some(event => event.b.includes("rewritten live")));
  expect(generation(replay)).toBe(generation(reset));
  expect(cards(replay).some(event => event.b.includes("rewritten live"))).toBe(true);
});
