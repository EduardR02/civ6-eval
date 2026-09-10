import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NativeResponses, emptyUsage } from "./native.ts";
import { saveJson } from "./storage.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(compactionEvents: unknown[]) {
  const runDir = mkdtempSync(join(tmpdir(), "civ-compaction-"));
  let input: unknown;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const body = await request.json() as { input: Record<string, unknown>[] };
    const compact = body.input.at(-1)?.type === "compaction_trigger";
    if (!compact) input = body.input;
    const events = compact ? compactionEvents : [{ type: "response.completed", response: { status: "completed", output: [] } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  } });
  cleanups.push(() => { server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
  const runtime = { getAuth: async () => ({ auth: { apiKey: token } }) } as unknown as ModelRuntime;
  const model: Model<Api> = { id: "fixture", name: "fixture", provider: "openai-codex", api: "openai-codex-responses", baseUrl: `http://127.0.0.1:${server.port}`, reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 1000, cost: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 } };
  const path = join(runDir, "player", "agents", "main", "native.json");
  const user = { role: "user", content: [{ type: "input_text", text: "Current request" }] };
  saveJson(path, { version: 1, items: [user], seenInputs: [], completedCalls: ["old_call"], inputTokens: 101, compactions: 0, totalUsage: emptyUsage() });
  const create = () => new NativeResponses("main", { runDir, projectRoot: process.cwd(), compactThreshold: 100, rpc: async () => ({}), execute: async () => ({ content: [] }) }, runtime, model, () => {}, () => {});
  return { create, path, user, input: () => input };
}

test("streamed compaction merges late identity metadata and preserves the request without subscription API charges", async () => {
  const opaque = { type: "compaction", encrypted_content: "fixture-opaque", future_field: { retained: true } };
  const { create, path, user, input } = fixture([
    { type: "response.output_item.done", output_index: 2, item: opaque },
    { type: "response.completed", response: { status: "completed", output: [{ type: "compaction", id: "cmp_fixture", terminal_metadata: 42 }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 5 } } } },
  ]);
  expect((await create().stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect(input()).toEqual([user, { ...opaque, id: "cmp_fixture", terminal_metadata: 42 }]);
  const state = JSON.parse(readFileSync(path, "utf8"));
  expect(state.totalUsage).toMatchObject({ input: 70, output: 20, cacheRead: 30, reasoning: 5, totalTokens: 120, cost: { total: 0 } });
  expect(state.inFlight).toBeUndefined();
  expect(() => create().executionStarted("old_call", {})).toThrow("already completed");
});

test("failed streamed compaction cannot replace context or authorize a tool", async () => {
  const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "exec_py", arguments: "{}" };
  const { create, path, user, input } = fixture([
    { type: "response.output_item.done", output_index: 0, item: { type: "compaction", encrypted_content: "fixture-opaque" } },
    { type: "response.output_item.done", output_index: 1, item: call },
    { type: "response.incomplete", response: { status: "incomplete", output: [] } },
  ]);
  const native = create();
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("error");
  expect(input()).toBeUndefined();
  expect(JSON.parse(readFileSync(path, "utf8")).items).toEqual([user]);
  expect(() => native.executionStarted("call_fixture|fc_fixture", {})).toThrow("no durable native call identity");
});

type NativeItem = Record<string, unknown>;
const summaryItem = { type: "message", id: "summary", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Keep artifact main/plan.py. Last action outcome UNKNOWN; observe before repeating." }] };
const summaryUsage = { input_tokens: 101, output_tokens: 20, total_tokens: 121 };
function eventsResponse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
function completeSummary(): Response {
  return eventsResponse([
    { type: "response.output_item.done", output_index: 0, item: summaryItem },
    { type: "response.completed", response: { status: "completed", output: [], usage: summaryUsage } },
  ]);
}

function goFixture(replies: (() => Response)[], ceiling = Infinity) {
  const runDir = mkdtempSync(join(tmpdir(), "civ-go-compaction-"));
  const requests: { path: string; body: NativeItem; session: string | null }[] = [];
  const reserved: { kind: string; id: string }[] = [];
  const accounted: { kind: string; id: string; totalTokens: number }[] = [];
  const events: unknown[] = [];
  const limit = { calls: ceiling };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    const body = await request.json() as NativeItem;
    requests.push({ path, body, session: request.headers.get("x-opencode-session") });
    // Reproduces the actual capability boundary: Responses exists; /compact does not.
    if (path !== "/zen/go/v1/responses") return new Response("<html>unsupported endpoint</html>", { status: 404 });
    return replies.shift()?.() ?? eventsResponse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
  } });
  cleanups.push(() => { server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  const model: Model<Api> = { id: "muse-spark-1.3-contributor", name: "Muse", provider: "opencode-go", api: "openai-responses", baseUrl: `http://127.0.0.1:${server.port}/zen/go/v1`, reasoning: true, input: ["text", "image"], contextWindow: 10000, maxTokens: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 } };
  const oldUser = { role: "user" as const, content: "old-history-marker", timestamp: 1 };
  const original: NativeItem[] = [
    { role: "user", content: [{ type: "input_text", text: oldUser.content }] },
    { type: "reasoning", id: "reason", encrypted_content: "opaque-history", summary: [] },
    { type: "function_call", id: "fc_old", call_id: "old", name: "exec_py", arguments: '{"code":"mutate()"}', status: "completed" },
    { type: "function_call_output", call_id: "old", output: [{ type: "input_text", text: "Last action outcome UNKNOWN" }] },
  ];
  const path = join(runDir, "player", "agents", "main", "native.json");
  const logPath = join(runDir, "player", "agents", "main", "native.jsonl");
  saveJson(path, { version: 1, items: original, seenInputs: [createHash("sha256").update(JSON.stringify(oldUser)).digest("hex")], completedCalls: ["old"], inputTokens: 101, compactions: 0, totalUsage: emptyUsage(), inFlight: { id: "previous-failed-compact", kind: "compact" } });
  const create = () => new NativeResponses("main", {
    runDir, projectRoot: process.cwd(), provider: "opencode-go", effort: "xhigh", compactThreshold: 100,
    rpc: async () => ({}), execute: async () => ({ content: [] }), onEvent: event => { events.push(event); },
  }, { getAuth: async () => ({ auth: { apiKey: "fixture-only" } }) } as unknown as ModelRuntime, model, (kind, id) => {
    if (reserved.length >= limit.calls) throw new Error("Run model-call budget exhausted");
    reserved.push({ kind, id });
  }, (usage, kind, id) => { accounted.push({ kind, id, totalTokens: usage.totalTokens }); });
  const saved = () => JSON.parse(readFileSync(path, "utf8"));
  const journalEntries = () => readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { create, saved, journalEntries, requests, reserved, accounted, events, original, oldUser, limit, path, logPath };
}

test("Go summarizes through Responses and resumes the failed boundary without replay or losing new instructions", async () => {
  const f = goFixture([completeSummary]);
  const warning = { role: "user" as const, content: "Restart: Python bindings are gone. Do not replay actions.", timestamp: 2 };
  const native = f.create();
  expect((await native.stream({ systemPrompt: "original-system", messages: [f.oldUser, warning] }).result()).stopReason).toBe("stop");
  expect(f.requests.map(request => request.path)).toEqual(["/zen/go/v1/responses", "/zen/go/v1/responses"]);
  expect(f.requests[0]!.body.input).toEqual([...f.original, expect.objectContaining({ role: "user" })]);
  expect(JSON.stringify(f.requests[0]!.body)).not.toContain(warning.content);
  expect(f.requests[0]!.body.tools).toBeUndefined();
  expect(f.requests[0]!.body).toMatchObject({ model: "muse-spark-1.3-contributor", reasoning: { effort: "xhigh" }, stream: true, store: false });
  const continuation = f.requests[1]!.body.input as NativeItem[];
  expect(JSON.stringify(continuation)).toContain(summaryItem.content[0]!.text);
  expect(continuation.at(-1)).toEqual({ role: "user", content: [{ type: "input_text", text: warning.content }] });
  expect(JSON.stringify(continuation)).not.toContain("old-history-marker");
  expect(continuation.some(item => item.type === "function_call" || item.type === "compaction")).toBe(false);
  expect(f.requests[1]!.body.instructions).toBe("original-system");
  expect(f.requests[0]!.session).toBe(f.requests[1]!.session);
  expect(f.reserved.map(request => request.kind)).toEqual(["compact", "responses"]);
  expect(f.accounted).toEqual([{ ...f.reserved[0]!, totalTokens: 121 }]);
  expect(f.saved()).toMatchObject({ compactions: 1, inputTokens: 0, completedCalls: ["old"], totalUsage: { totalTokens: 121 } });
  expect(f.saved().inFlight).toBeUndefined();
  expect(f.journalEntries().find(entry => entry.kind === "compaction")).toMatchObject({ mechanism: "summary", original: f.original });
  expect(f.journalEntries().find(entry => entry.kind === "interrupted_request").request.id).toBe("previous-failed-compact");
  const restarted = f.create();
  expect(() => restarted.executionStarted("old|fc_old", { code: "mutate()" })).toThrow();
  expect((await restarted.stream({ messages: [f.oldUser, warning] }).result()).stopReason).toBe("stop");
  expect(f.requests[2]!.body.input).toEqual(continuation);
  expect(f.accounted).toHaveLength(1);
});

test("successful Go summary consumes its own call allowance before continuation and remains resumable", async () => {
  const f = goFixture([completeSummary], 1);
  const warning = { role: "user" as const, content: "Fresh restart warning", timestamp: 2 };
  expect((await f.create().stream({ messages: [warning] }).result()).stopReason).toBe("error");
  expect(f.requests).toHaveLength(1);
  expect(f.reserved.map(request => request.kind)).toEqual(["compact"]);
  expect(f.saved()).toMatchObject({ compactions: 1, inputTokens: 0 });
  expect(JSON.stringify(f.saved().items)).toContain(warning.content);
  f.limit.calls = 2;
  expect((await f.create().stream({ messages: [warning] }).result()).stopReason).toBe("stop");
  expect(f.reserved.map(request => request.kind)).toEqual(["compact", "responses"]);
  expect(f.accounted).toHaveLength(1);
});

for (const [name, events] of [
  ["unterminated", [{ type: "response.output_item.done", output_index: 0, item: summaryItem }]],
  ["incomplete", [{ type: "response.incomplete", response: { status: "incomplete", output: [summaryItem], usage: summaryUsage } }]],
  ["tool-producing", [{ type: "response.completed", response: { status: "completed", output: [summaryItem, { type: "function_call", call_id: "forbidden", name: "exec_py", arguments: "{}" }], usage: summaryUsage } }]],
  ["refusal", [{ type: "response.completed", response: { status: "completed", output: [{ ...summaryItem, content: [{ type: "refusal", refusal: "No summary" }] }], usage: summaryUsage } }]],
  ["empty", [{ type: "response.completed", response: { status: "completed", output: [], usage: summaryUsage } }]],
] as const) {
  test(`Go ${name} compaction preserves context and threshold without authorizing partial output`, async () => {
    const f = goFixture([() => eventsResponse([...events])]);
    const native = f.create();
    expect((await native.stream({ messages: [{ role: "user", content: "new-warning", timestamp: 2 }] }).result()).stopReason).toBe("error");
    expect(f.requests).toHaveLength(1);
    expect(f.saved()).toMatchObject({ items: f.original, inputTokens: 101, compactions: 0, completedCalls: ["old"] });
    expect(() => native.executionStarted("forbidden", {})).toThrow();
    expect(f.journalEntries().some(entry => entry.kind === "compaction")).toBe(false);
    expect(f.accounted).toHaveLength(name === "unterminated" ? 0 : 1);
    expect(f.saved().totalUsage.totalTokens).toBe(name === "unterminated" ? 0 : 121);
  });
}

test("Go HTTP errors preserve status, exclude arbitrary secret-bearing HTML, and allow explicit summary recovery", async () => {
  const secret = "token-bearing-provider-error";
  const f = goFixture([() => new Response(`<html>${secret.repeat(10000)}</html>`, { status: 503 }), completeSummary]);
  const native = f.create();
  const failed = await native.stream({ messages: [] }).result();
  expect(failed.stopReason).toBe("error");
  expect(failed.errorMessage).toContain("HTTP 503");
  expect(failed.errorMessage).not.toContain(secret);
  expect(readFileSync(f.logPath, "utf8")).not.toContain(secret);
  expect(f.saved()).toMatchObject({ items: f.original, inputTokens: 101, compactions: 0 });
  expect(f.requests).toHaveLength(1);
  expect(f.accounted).toHaveLength(0);
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect(f.reserved.map(request => request.kind)).toEqual(["compact", "compact", "responses"]);
  const records = f.journalEntries().filter(entry => entry.kind === "request");
  expect(records[1].appendedFrom).toBe(f.original.length);
  expect(records[1].appended).toEqual([]);
  expect(f.saved().compactions).toBe(1);
});

test("Go recovery summarizes an interrupted tool only with its durable UNKNOWN result and never reauthorizes it", async () => {
  const f = goFixture([completeSummary]);
  const pending = { type: "function_call", id: "fc_pending", call_id: "pending", name: "exec_py", arguments: '{"code":"uncertain_action()"}', status: "completed" };
  saveJson(f.path, { ...f.saved(), items: [...f.original, pending] });
  const native = f.create();
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("stop");
  const input = f.requests[0]!.body.input as NativeItem[];
  expect(input).toContainEqual(pending);
  const result = input.find(item => item.type === "function_call_output" && item.call_id === "pending");
  expect(JSON.stringify(result)).toContain("UNKNOWN");
  expect(() => native.executionStarted("pending|fc_pending", {})).toThrow();
  expect(f.saved().completedCalls).toEqual(["old", "pending"]);
  expect(f.journalEntries().filter(entry => entry.kind === "execution_started")).toEqual([]);
});

test("Go exhausted allowance cannot send or replace the failed-boundary context", async () => {
  const f = goFixture([completeSummary], 0);
  expect((await f.create().stream({ messages: [] }).result()).stopReason).toBe("error");
  expect(f.requests).toEqual([]);
  expect(f.reserved).toEqual([]);
  expect(f.accounted).toEqual([]);
  expect(f.saved()).toMatchObject({ items: f.original, compactions: 0, inputTokens: 101 });
});
