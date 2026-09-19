import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { Player } from "../player.ts";
import { createRuntime } from "./auth.ts";
import { serializedBytes } from "./limits.ts";
import { COMPACTION_INSTRUCTIONS, COMPACTION_REQUEST, NativeResponses } from "./native.ts";
import { ProviderCompletions } from "./provider.ts";
import { saveJson } from "./storage.ts";
import type { PlayerEvent, PlayerOptions } from "../contracts.ts";

interface WirePart { type?: string; text?: string; image_url?: { url: string } }
interface WireMessage { role: string; reasoning_content?: string; content: string | WirePart[]; tool_calls?: { id: string }[]; tool_call_id?: string }
interface WireRequest {
  model: string;
  reasoning_effort?: string;
  tools?: unknown[];
  messages: WireMessage[];
}
interface JournalEntry { kind: string; message?: { content: { type: string }[] }; original?: unknown; elided?: number; remaining?: number; originals?: unknown }
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSpkAAAAASUVORK5CYII=";
const MARKER = "[screenshot elided — image budget]";
/** What one request body actually carries: surviving screenshots, elision markers, result pairing. */
const imagesOf = (messages: WireMessage[]) => messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.image_url);
const elisionsIn = (value: unknown) => JSON.stringify(value).split(MARKER).length - 1;
const toolResultsIn = (messages: WireMessage[]) => messages.flatMap(message => message.tool_call_id ? [message.tool_call_id] : []);
const journalEntries = (options: PlayerOptions): JournalEntry[] => readFileSync(join(options.runDir, "player", "agents", "main", "provider.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as JournalEntry);
function response(toolId?: string, finish = true, withUsage: boolean | Record<string, unknown> = true): Response {
  const delta = toolId ? { reasoning: "Inspect the returned image", tool_calls: [{ index: 0, id: toolId, type: "function", function: { name: "exec_py", arguments: JSON.stringify({ code: "display(image)" }) } }] } : { content: "complete" };
  const chunks: unknown[] = [{ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }];
  if (finish) chunks.push({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: toolId ? "tool_calls" : "stop" }] });
  if (withUsage) chunks.push({ id: "fixture", choices: [], usage: withUsage === true ? { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 } : withUsage });
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function fixture(replies: (() => Response)[], overrides: Partial<PlayerOptions> = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "civ-provider-"));
  const bodies: WireRequest[] = [];
  const sizes: number[] = [];
  const events: PlayerEvent[] = [];
  const startsAtSend: boolean[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text();
    const body = JSON.parse(raw) as WireRequest;
    bodies.push(body);
    sizes.push(Buffer.byteLength(raw, "utf8"));
    const start = events.filter(event => event.type === "model_call").at(-1);
    const ledger = start && JSON.parse(readFileSync(join(runDir, "player", "agents", start.agentId, "provider.json"), "utf8"));
    const registry = JSON.parse(readFileSync(join(runDir, "player", "agents.json"), "utf8"));
    startsAtSend.push(!!start?.requestId && ledger?.inFlight?.id === start.requestId && registry.calls === bodies.length);
    return replies[bodies.length - 1]?.() ?? new Response("unexpected request", { status: 500 });
  } });
  const options: PlayerOptions = { runDir, projectRoot: process.cwd(), provider: "opencode-go", apiKey: "fixture-only", model: "glm-5.3-flash", effort: "high", baseUrl: `http://127.0.0.1:${server.port}/v1`, rpc: async () => ({ files: [] }), execute: async () => ({ content: [{ type: "image", data: image, mimeType: "image/png" }] }), ...overrides, onEvent: event => events.push(event) };
  const player = new Player(options);
  cleanups.push(async () => { await player.close(); server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  return { player, options, bodies, sizes, events, startsAtSend };
}

/** A ledger of already-sent screenshots, as an interrupted run might leave behind. */
function seededScreens(options: PlayerOptions, count: number) {
  const screen = (index: number): Message => ({ role: "user", content: [{ type: "text", text: `capture-${index}` }, ...Array.from({ length: 10 }, () => ({ type: "image" as const, data: image, mimeType: "image/png" }))], timestamp: index });
  saveJson(join(options.runDir, "player", "agents", "main", "provider.json"), { version: 1, messages: Array.from({ length: count }, (_, index) => screen(index + 1)), seenInputs: [], tools: {}, inputTokens: 900, sentMessages: count });
}

/** The completions ledger over an existing run directory, wired to the real SDK. */
async function openLedger(options: PlayerOptions) {
  const { runtime, model } = await createRuntime(options);
  return new ProviderCompletions("main", options, (model, context, options) => runtime.streamSimple(model, context, options), model, () => {}, () => {});
}

/** The exact serialized sizes of one image part as the SDK converts it and of its omission marker. */
function wireImageBytes() {
  return {
    image: serializedBytes({ type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }),
    marker: serializedBytes({ type: "text", text: "[screenshot elided — image budget]" }),
  };
}

test("SDK completions reserve durably before transport and preserve tool images and reasoning", async () => {
  const { player, bodies, events, startsAtSend } = fixture([() => response("vision"), () => response()], { effort: "max", maxModelCalls: 2 });
  await player.prompt("inspect a generated image");
  expect(startsAtSend).toEqual([true, true]);
  expect(bodies.map(body => body.reasoning_effort)).toEqual(["max", "max"]);
  expect(bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content).toBe("Inspect the returned image");
  expect(bodies[1]!.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.image_url?.url === `data:image/png;base64,${image}`))).toBe(true);
  for (const start of events.filter(event => event.type === "model_call")) {
    expect(events.filter(event => event.type === "usage" && event.requestId === start.requestId)).toHaveLength(1);
    expect(events.filter(event => event.type === "model_end" && event.requestId === start.requestId)).toHaveLength(1);
  }
});

test("call ceiling prevents tool followup and child sends, including after restart", async () => {
  const { player, options, bodies } = fixture([() => response("single")], { maxModelCalls: 1 });
  await expect(player.prompt("do one tool")).rejects.toThrow("budget");
  const child = await player.rpc("main", "agent.spawn", { task: "must not send" }) as { id: string };
  await expect(player.rpc("main", "agent.wait", { id: child.id })).rejects.toThrow("budget");
  await player.close();
  const resumed = new Player(options);
  cleanups.push(() => resumed.close());
  await expect(resumed.prompt("must not send after restart")).rejects.toThrow("budget");
  expect(bodies).toHaveLength(1);
});

test("same-model child shares durable budget and low effort", async () => {
  const { player, bodies, startsAtSend } = fixture([() => response(), () => response()], { maxModelCalls: 2, effort: "low" });
  await player.prompt("main task");
  const child = await player.rpc("main", "agent.spawn", { task: "child task" }) as { id: string };
  await player.rpc("main", "agent.wait", { id: child.id });
  expect(startsAtSend).toEqual([true, true]);
  expect(bodies.map(body => [body.model, body.reasoning_effort])).toEqual([["glm-5.3-flash", "low"], ["glm-5.3-flash", "low"]]);
});

test("SDK compaction uses the same endpoint and ceiling while retaining original history", async () => {
  const { player, options, bodies, events, startsAtSend } = fixture([() => response(), () => response()], { maxModelCalls: 2, compactThreshold: 100 });
  await player.prompt("original-history-marker");
  await expect(player.prompt("new-task-marker")).rejects.toThrow("budget");
  expect(startsAtSend).toEqual([true, true]);
  expect(events.filter(event => event.type === "model_call").map(event => event.data && typeof event.data === "object" && "kind" in event.data ? event.data.kind : undefined)).toEqual(["completions", "compact"]);
  expect(bodies[1]!.tools).toBeUndefined();
  expect(JSON.stringify(bodies[1])).toContain("original-history-marker");
  const journal = readFileSync(join(options.runDir, "player", "agents", "main", "provider.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(JSON.stringify(journal.find(entry => entry.kind === "compaction").original)).toContain("original-history-marker");
  expect(bodies).toHaveLength(2);
});

test("successful summary is used for continuation and survives same-profile resume", async () => {
  const { player, options, bodies } = fixture([() => response(), () => response(), () => response(), () => response(), () => response()], { maxModelCalls: 5, compactThreshold: 100 });
  await player.prompt("old-marker");
  await player.prompt("new-marker");
  expect(JSON.stringify(bodies[2])).not.toContain("old-marker");
  expect(JSON.stringify(bodies[2])).toContain("Earlier conversation summary");
  expect(JSON.stringify(bodies[2])).toContain("new-marker");
  await player.close();
  const resumed = new Player(options);
  cleanups.push(() => resumed.close());
  await resumed.prompt("resume-marker");
  expect(JSON.stringify(bodies[4])).toContain("resume-marker");
});

test("failed partial stream cannot authorize tools or claim missing usage", async () => {
  let executions = 0;
  const { player, events, bodies } = fixture([() => response("partial", false, false)], { execute: async () => { executions++; return { content: [] }; } });
  await expect(player.prompt("partial response")).rejects.toThrow("UNKNOWN");
  expect(executions).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(events.filter(event => event.type === "usage")).toHaveLength(0);
  expect(events.filter(event => event.type === "model_end").map(event => event.data)).toEqual([{ kind: "completions", outcome: "failed", usage: "unknown" }]);
});

test("interrupted durable tool identity is recovered as unknown and never executable", async () => {
  const { options } = fixture([]);
  const { runtime, model } = await createRuntime(options);
  const make = () => new ProviderCompletions("recovery", options, (model, context, options) => runtime.streamSimple(model, context, options), model, () => {}, () => {});
  const ledger = make();
  ledger.importHistory([{ role: "assistant", api: model.api, model: model.id, provider: model.provider, content: [{ type: "toolCall", id: "old", name: "exec_py", arguments: { code: "side_effect()" } }], stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 }]);
  const resumed = make();
  expect(() => resumed.executionStarted("old", { code: "side_effect()" })).toThrow("no replay");
  const saved = JSON.parse(readFileSync(join(options.runDir, "player", "agents", "recovery", "provider.json"), "utf8"));
  expect(saved.messages.at(-1).content[0].text).toContain("UNKNOWN");
  expect(saved.messages.at(-1).isError).toBe(true);
});

test("profile changes and unsupported effort reject before transport", async () => {
  const { player, options, bodies } = fixture([() => response()]);
  await player.prompt("bind profile");
  await expect(createRuntime({ ...options, effort: "medium" })).rejects.toThrow("never remapped");
  await expect(createRuntime({ ...options, effort: "low" })).rejects.toThrow("new run");
  await expect(createRuntime({ ...options, model: "glm-5.1" })).rejects.toThrow();
  await expect(createRuntime({ ...options, baseUrl: "http://127.0.0.1:1/v1" })).rejects.toThrow("new run");
  expect(bodies).toHaveLength(1);
});

test("muse responses model binds catalog data and rejects unsupported max effort", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civ-muse-"));
  cleanups.push(async () => rmSync(runDir, { recursive: true, force: true }));
  const options: PlayerOptions = { runDir, projectRoot: process.cwd(), provider: "opencode-go", apiKey: "fixture-only", model: "muse-spark-1.3-contributor", effort: "high", rpc: async () => ({ files: [] }), execute: async () => ({ content: [] }) };
  const { runtime, model } = await createRuntime(options);
  expect(model.api).toBe("openai-responses");
  expect(model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
  expect(model.contextWindow).toBe(1048576);
  expect(model.maxTokens).toBe(131072);
  expect(model.cost).toEqual({ input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 });
  expect(model.thinkingLevelMap?.high).toBe("high");
  expect(model.thinkingLevelMap?.max).toBe(null);
  expect(runtime.getModel("opencode-go", "glm-5.3-flash")?.api).toBe("openai-completions");
  await expect(createRuntime({ ...options, effort: "max" })).rejects.toThrow("does not support reasoning effort max");
  await expect(createRuntime({ ...options, model: "muse-spark-1.2-contributor" })).rejects.toThrow("new run");
  expect(JSON.parse(readFileSync(join(runDir, "player", "profile.json"), "utf8"))).toMatchObject({ provider: "opencode-go", model: "muse-spark-1.3-contributor", baseUrl: "https://opencode.ai/zen/go/v1", effort: "high", pricingKnown: true });
});

test("opencode-go native requests carry stable session attribution", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanups.push(async () => server.stop(true));
  const runDir = mkdtempSync(join(tmpdir(), "civ-session-"));
  cleanups.push(async () => rmSync(runDir, { recursive: true, force: true }));
  const options: PlayerOptions = { runDir, projectRoot: process.cwd(), provider: "opencode-go", apiKey: "fixture-only", model: "muse-spark-1.3-contributor", effort: "high", baseUrl: `http://127.0.0.1:${server.port}/v1`, rpc: async () => ({ files: [] }), execute: async () => ({ content: [] }) };
  const { runtime, model } = await createRuntime(options);
  const native = new NativeResponses("main", options, runtime, model, () => {}, () => {});
  await native.stream({ messages: [{ role: "user", content: "reply ok", timestamp: 1 }] }).result();
  expect(seen[0]!.url.endsWith("/responses")).toBe(true);
  expect(seen[0]!.headers["x-opencode-session"]).toMatch(/^main-[0-9a-f]{24}$/);
  expect(seen[0]!.headers["x-opencode-client"]).toBe("pi");
  expect(seen[0]!.headers["user-agent"]).toBe("civ6-player/pi-0.84.4");
  expect(seen[0]!.headers.authorization).toBe("Bearer fixture-only");
});

test("absent primary counters remain unknown while explicit zeros are reported", async () => {
  const { player, events } = fixture([
    () => response(undefined, true, { completion_tokens: 9 }),
    () => response(undefined, true, { prompt_tokens: 0, completion_tokens: 0 }),
    () => response(undefined, true, { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 } }),
  ]);
  await player.prompt("missing input");
  expect(events.filter(event => event.type === "usage")).toHaveLength(0);
  await player.prompt("reported zero");
  const zero = events.find(event => event.type === "usage")?.data;
  expect(zero).toMatchObject({ usage: { input: 0, output: 0, totalTokens: 0 } });
  await player.prompt("cache without total");
  expect(events.filter(event => event.type === "usage").at(-1)?.data).toMatchObject({ usage: { input: 12, output: 5, cacheRead: 6, cacheWrite: 2, totalTokens: 25 } });
});

test("a reused completed provider tool identity cannot execute after restart", async () => {
  let executions = 0;
  const { player, options } = fixture([() => response("once"), () => response(), () => response("once")], { execute: async () => { executions++; return { content: [{ type: "text", text: "executed" }] }; } });
  await player.prompt("first action");
  await player.close();
  const resumed = new Player(options);
  cleanups.push(() => resumed.close());
  await expect(resumed.prompt("continue")).rejects.toThrow("duplicate execution");
  expect(executions).toBe(1);
});

/** The completions ledger bounds already-sent screenshots with the same watermark policy as the
 * native path: one batched rewrite at the trigger, the newest low-watermark images preserved, and
 * nothing else about the replayed conversation changed. Results the provider has not seen yet are
 * never part of the rewrite: a fresh capture must arrive before any budget may take it away. */
test("deepseek completions bound already-sent screenshots at the shared watermark and keep fresh results", async () => {
  const shots = Array.from({ length: 6 }, (_, index) => `shot-${index + 1}`);
  const { player, options, bodies } = fixture(
    [...shots.map(id => () => response(id)), () => response(), () => response(), () => response()],
    {
      model: "deepseek-flash", effort: "max", maxModelCalls: 9, requestLimits: { maxImages: 45, retainedImages: 5 },
      // Ten screenshots per tool result, as one displayed analysis can produce.
      execute: async () => ({ content: Array.from({ length: 10 }, () => ({ type: "image" as const, data: image, mimeType: "image/png" })) }),
    },
  );
  await player.prompt("inspect the map repeatedly");
  // The fifth tool result crosses the 45-image trigger, so request six is the single rewrite: the
  // forty captures the provider has already seen age out, and that result's ten fresh screenshots
  // stay for request seven, which then extends the rewritten prefix with ten more.
  expect(bodies).toHaveLength(7);
  const bounded = bodies[5]!;
  expect(elisionsIn(bounded)).toBe(40);
  expect(imagesOf(bounded.messages)).toHaveLength(10);
  expect(imagesOf(bounded.messages.slice(0, -1))).toHaveLength(0);
  expect(imagesOf(bounded.messages.slice(-1))).toHaveLength(10);
  const elidedFrom = (id: string) => (JSON.stringify(bounded.messages.find(message => message.tool_call_id === id)).split(MARKER).length - 1);
  expect(shots.slice(0, 4).map(elidedFrom)).toEqual([10, 10, 10, 10]);
  expect(elidedFrom("shot-5")).toBe(0);
  // Elision replaces pixels and nothing else: results stay paired with their calls and every
  // assistant turn keeps the reasoning this route requires on replay.
  expect(toolResultsIn(bounded.messages)).toEqual(shots.slice(0, 5));
  expect(bounded.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? [])).toEqual(shots.slice(0, 5));
  expect(bounded.messages.filter(message => message.role === "assistant").map(message => message.reasoning_content)).toEqual(Array.from({ length: 5 }, () => "Inspect the returned image"));
  // Between purges the ledger only appends, so the next request extends the rewritten prefix
  // byte-for-byte, re-elides nothing, and never re-ingests the pruned results from Pi's transcript.
  expect(bodies[6]!.messages.slice(0, bounded.messages.length)).toEqual(bounded.messages);
  expect(imagesOf(bodies[6]!.messages)).toHaveLength(20);
  expect(toolResultsIn(bodies[6]!.messages)).toEqual(shots);
  expect(journalEntries(options).filter(entry => entry.kind === "image_budget").map(entry => ({ elided: entry.elided, remaining: entry.remaining }))).toEqual([{ elided: 40, remaining: 10 }]);
  // A restart resumes the bounded view instead of refilling it from the restored Pi transcript,
  // and the summary request is assembled from it with the run's own instructions and no tools.
  await player.close();
  const resumed = new Player({ ...options, compactThreshold: 100 });
  cleanups.push(() => resumed.close());
  await resumed.prompt("continue after restart");
  expect(bodies).toHaveLength(9);
  const summary = bodies[7]!;
  // The invariant is that a summary request cannot call anything. Pi emits an empty tools array on
  // the completions path and omits the key on the responses path; both satisfy it.
  expect(summary.tools ?? []).toEqual([]);
  expect(summary.messages[0]!.role).toBe("system");
  // The summary extends the same instructions the run was already sending, whichever they are.
  expect(summary.messages[0]).toEqual(bodies[6]!.messages[0]);
  // Compaction runs before the new turn's input is ingested, so it sees the previous request's
  // history plus the assistant reply that answered it, and extends that prefix rather than
  // replacing the head with summary instructions.
  const priorTail = bodies[6]!.messages.slice(1);
  const summarised = summary.messages.slice(1, -1);
  expect(summarised.slice(0, priorTail.length)).toEqual(priorTail);
  expect(summarised).toHaveLength(priorTail.length + 1);
  expect(summarised.at(-1)!.role).toBe("assistant");
  expect(elisionsIn(summary)).toBe(40);
  expect(imagesOf(summary.messages)).toHaveLength(20);
  expect(summary.messages.at(-1)!.content).toEqual([{ type: "text", text: COMPACTION_INSTRUCTIONS }, { type: "text", text: COMPACTION_REQUEST }]);
  const continuation = bodies[8]!;
  expect(JSON.stringify(continuation)).toContain("Earlier conversation summary");
  expect(JSON.stringify(continuation)).toContain("continue after restart");
  expect(JSON.stringify(continuation)).not.toContain("inspect the map repeatedly");
  expect(imagesOf(continuation.messages)).toHaveLength(0);
  expect(elisionsIn(continuation)).toBe(0);
  // The private journal stays append-only: it holds the explicit elision record, the pre-summary
  // view, every original capture exactly once, and no transient summary ask.
  const entries = journalEntries(options);
  expect(entries.filter(entry => entry.kind === "image_budget")).toHaveLength(1);
  expect(elisionsIn(entries.filter(entry => entry.kind === "compaction").at(-1)!.original)).toBe(40);
  expect(entries.filter(entry => entry.kind === "tool_result")).toHaveLength(6);
  expect(entries.filter(entry => entry.kind === "tool_result").flatMap(entry => entry.message?.content ?? []).filter(part => part.type === "image")).toHaveLength(60);
  expect(readFileSync(join(options.runDir, "player", "agents", "main", "provider.json"), "utf8")).not.toContain(COMPACTION_REQUEST);
});

test("an over-budget completions ledger is bounded before the summary request and keeps its ask transient", async () => {
  const { options, bodies } = fixture([() => response(), () => response()], { model: "deepseek-flash", effort: "max", compactThreshold: 100, requestLimits: { maxImages: 45, retainedImages: 5 } });
  const { runtime, model } = await createRuntime(options);
  const systemPrompt = "You are main, a Civilization VI: Gathering Storm player and analyst.";
  // An interrupted run can leave a ledger holding more screenshots than the watermark allows;
  // the summary request must never be assembled from that state before the rewrite has run.
  const screen = (index: number): Message => ({ role: "user", content: [{ type: "text", text: `capture-${index}` }, ...Array.from({ length: 10 }, () => ({ type: "image" as const, data: image, mimeType: "image/png" }))], timestamp: index });
  saveJson(join(options.runDir, "player", "agents", "main", "provider.json"), { version: 1, messages: [1, 2, 3, 4, 5].map(screen), seenInputs: [], tools: {}, inputTokens: 500, sentMessages: 5 });
  const ledger = new ProviderCompletions("main", options, (model, context, options) => runtime.streamSimple(model, context, options), model, () => {}, () => {});
  const warning = { role: "user" as const, content: "continue after restart", timestamp: 6 };
  expect((await ledger.stream({ systemPrompt, messages: [warning] }).result()).stopReason).toBe("stop");
  const summary = bodies[0]!;
  expect(elisionsIn(summary)).toBe(45);
  expect(imagesOf(summary.messages)).toHaveLength(5);
  expect(imagesOf(summary.messages.slice(0, 5))).toHaveLength(0);
  expect(imagesOf(summary.messages.slice(5))).toHaveLength(5);
  expect(summary.messages[0]).toEqual({ role: "system", content: systemPrompt });
  expect(summary.tools).toBeUndefined();
  expect(summary.messages.at(-1)!.content).toEqual([{ type: "text", text: COMPACTION_INSTRUCTIONS }, { type: "text", text: COMPACTION_REQUEST }]);
  const request = bodies[1]!;
  expect(JSON.stringify(request)).toContain("Earlier conversation summary");
  expect(JSON.stringify(request)).toContain(warning.content);
  expect(imagesOf(request.messages)).toHaveLength(0);
  expect(journalEntries(options).filter(entry => entry.kind === "image_budget").map(entry => ({ elided: entry.elided, remaining: entry.remaining }))).toEqual([{ elided: 45, remaining: 5 }]);
  expect(readFileSync(join(options.runDir, "player", "agents", "main", "provider.json"), "utf8")).not.toContain(COMPACTION_REQUEST);
});

test("a byte cap seen only at the transport boundary costs no call and marks nothing sent", async () => {
  // Learn the exact serialized size of this request from an uncapped run, then cap one byte below
  // it: no screenshot can be replaced for a single byte here, so the exact transport measurement is
  // what refuses it — and that refusal must cost nothing at all.
  const probe = fixture([() => response()]);
  await probe.player.prompt("admission probe");
  expect(probe.sizes).toHaveLength(1);
  const capped = fixture([() => response()], { maxModelCalls: 1, requestLimits: { maxBytes: probe.sizes[0]! - 1 } });
  await expect(capped.player.prompt("admission probe")).rejects.toThrow("requestLimits.maxBytes");
  expect(capped.bodies).toHaveLength(0);
  expect(capped.events.filter(event => event.type === "model_call")).toHaveLength(0);
  const refusals = journalEntries(capped.options).filter(entry => entry.kind === "request_refused");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toMatchObject({ operation: "completions" });
  const stored = JSON.parse(readFileSync(join(capped.options.runDir, "player", "agents", "main", "provider.json"), "utf8")) as { inFlight?: unknown; sentMessages?: number };
  expect(stored.inFlight).toBeUndefined();
  expect(stored.sentMessages).toBe(0);
  expect(journalEntries(capped.options).some(entry => entry.kind === "request")).toBe(false);
});

test("a byte cap replaces already-sent screenshots in the wire payload and keeps the ledger whole", async () => {
  const systemPrompt = "You are main, a Civilization VI: Gathering Storm player and analyst.";
  const warning = { role: "user" as const, content: "continue after restart", timestamp: 6 };
  // Fifty already-sent screenshots, the same ledger in both runs: only the cap differs.
  const probe = fixture([() => response()], { maxModelCalls: 1 });
  seededScreens(probe.options, 5);
  expect((await (await openLedger(probe.options)).stream({ systemPrompt, messages: [warning] }).result()).stopReason).toBe("stop");
  expect(probe.sizes).toHaveLength(1);
  const limit = probe.sizes[0]! - 3000;
  const capped = fixture([() => response()], { maxModelCalls: 1, requestLimits: { maxBytes: limit } });
  seededScreens(capped.options, 5);
  expect((await (await openLedger(capped.options)).stream({ systemPrompt, messages: [warning] }).result()).stopReason).toBe("stop");
  // The request that went out fits the cap and carries fewer screenshots than the ledger holds...
  expect(capped.sizes).toHaveLength(1);
  expect(capped.sizes[0]!).toBeLessThanOrEqual(limit);
  expect(imagesOf(capped.bodies[0]!.messages).length).toBeLessThan(50);
  expect(elisionsIn(capped.bodies[0])).toBeGreaterThan(0);
  // ...while the durable ledger keeps every original capture and its pairing.
  const stored = JSON.parse(readFileSync(join(capped.options.runDir, "player", "agents", "main", "provider.json"), "utf8")) as { messages: unknown[] };
  expect(JSON.stringify(stored.messages).split('"type":"image"').length - 1).toBe(50);
  const budgets = journalEntries(capped.options).filter(entry => entry.kind === "byte_budget");
  expect(budgets).toHaveLength(1);
  const originals = budgets[0]!.originals as { message: number; part: number; bytes: number; sha256: string }[]; // written by this ledger
  expect(originals.length).toBeGreaterThan(0);
  // `part` is the index inside the message's content array, so [text, image, ...] reports 1 first.
  expect(originals[0]!.part).toBe(1);
  const messages = stored.messages as { content: { type: string; data?: string; mimeType?: string }[] }[]; // durable provider ledger
  const firstScreen = messages[0]!.content[1]!;
  expect(originals[0]!.sha256).toBe(createHash("sha256").update(JSON.stringify({ type: "image", data: firstScreen.data, mimeType: firstScreen.mimeType })).digest("hex"));
});

test("a payload cap never replaces a screenshot whose identical bytes were never sent", async () => {
  const systemPrompt = "You are main, a Civilization VI: Gathering Storm player and analyst.";
  // The same bytes appear again in a result this run has never dispatched — an unchanged view
  // re-displayed — so identity cannot be pixel equality alone: it has to consume one already-sent
  // occurrence per replaced wire part and stop when none is left.
  const repeated = (): Message => ({ role: "user", content: [{ type: "text", text: "same view again" }, ...Array.from({ length: 10 }, () => ({ type: "image" as const, data: image, mimeType: "image/png" }))], timestamp: 4 });
  const probe = fixture([() => response()], { maxModelCalls: 1 });
  seededScreens(probe.options, 3);
  expect((await (await openLedger(probe.options)).stream({ systemPrompt, messages: [repeated()] }).result()).stopReason).toBe("stop");
  expect(probe.sizes).toHaveLength(1);
  // Cap a little below what the thirty already-sent copies alone can free: a correct cap elides
  // those thirty and refuses; membership matching would reach into the ten unsent duplicates.
  const { image: imageBytes, marker: markerBytes } = wireImageBytes();
  const limit = probe.sizes[0]! - 35 * (imageBytes - markerBytes);
  const capped = fixture([() => response()], { maxModelCalls: 1, requestLimits: { maxBytes: limit } });
  seededScreens(capped.options, 3);
  const result = await (await openLedger(capped.options)).stream({ systemPrompt, messages: [repeated()] }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("requestLimits.maxBytes");
  expect(capped.bodies).toHaveLength(0);
  const budgets = journalEntries(capped.options).filter(entry => entry.kind === "byte_budget");
  expect(budgets).toHaveLength(1);
  expect(budgets[0]!.elided).toBe(30);
  const originals = budgets[0]!.originals as { position: number }[]; // written by this ledger
  expect(originals).toHaveLength(30);
  // Position is the ledger message index: every replacement came from one of the three sent screens.
  expect(originals.every(original => original.position < 3)).toBe(true);
  const stored = JSON.parse(readFileSync(join(capped.options.runDir, "player", "agents", "main", "provider.json"), "utf8")) as { messages: unknown[]; sentMessages?: number };
  expect(JSON.stringify(stored.messages).split('"type":"image"').length - 1).toBe(40);
  expect(stored.sentMessages).toBe(3);
});

test("a supplied expert guide rides the system prompt and survives compaction", async () => {
  // A guide that vanished at the compaction boundary would be worse than no guide: the run would
  // silently continue as an uncoached one while still declaring the expert-informed track.
  const GUIDE = "GUIDE-SENTINEL: district production cost scales with completed technologies and civics.";
  const { player, bodies } = fixture(
    [() => response(), () => response(), () => response()],
    { maxModelCalls: 3, compactThreshold: 100, expertGuide: GUIDE },
  );
  await player.prompt("first turn");
  await player.prompt("second turn");

  expect(bodies.length).toBeGreaterThanOrEqual(2);
  // The guide lives in the system prompt, which is rebuilt per request from the context rather
  // than drawn from the compacted message ledger, so every body carries it verbatim.
  for (const body of bodies) {
    expect(body.messages[0]!.role).toBe("system");
    expect(String(body.messages[0]!.content)).toContain(GUIDE);
  }
  // Prove compaction actually happened, and that the request after it still carries the guide.
  const compacted = bodies.filter(body => JSON.stringify(body).includes("Earlier conversation summary"));
  expect(compacted.length).toBeGreaterThanOrEqual(1);
  expect(String(compacted.at(-1)!.messages[0]!.content)).toContain(GUIDE);
});

test("an uncoached run carries no supplied reference block", async () => {
  const { player, bodies } = fixture([() => response()], { maxModelCalls: 1 });
  await player.prompt("first turn");
  expect(String(bodies[0]!.messages[0]!.content)).not.toContain("SUPPLIED EXPERT REFERENCE");
});

test("an unmeasured completions route keeps every screenshot when no limit is configured", async () => {
  const shots = Array.from({ length: 3 }, (_, index) => `shot-${index + 1}`);
  const { player, options, bodies } = fixture(
    [...shots.map(id => () => response(id)), () => response()],
    {
      model: "deepseek-flash", effort: "max", maxModelCalls: 4,
      // Twenty screenshots per tool result: past the Muse watermark, which does not apply here.
      execute: async () => ({ content: Array.from({ length: 20 }, () => ({ type: "image" as const, data: image, mimeType: "image/png" })) }),
    },
  );
  await player.prompt("inspect the map repeatedly");
  expect(bodies).toHaveLength(4);
  expect(imagesOf(bodies[3]!.messages)).toHaveLength(60);
  expect(elisionsIn(bodies[3])).toBe(0);
  expect(journalEntries(options).filter(entry => entry.kind === "image_budget" || entry.kind === "byte_budget")).toHaveLength(0);
});

test("a configured byte cap refuses an oversized completions request before transport", async () => {
  const { player, options, bodies, events } = fixture([() => response()], { maxModelCalls: 1, requestLimits: { maxBytes: 3000 } });
  await expect(player.prompt("oversized")).rejects.toThrow("requestLimits.maxBytes");
  // Nothing reached the provider, the refusal was journaled as a known outcome, and no model call
  // was reserved: raising the limit resumes the run instead of charging it for a request it never made.
  expect(bodies).toHaveLength(0);
  expect(events.filter(event => event.type === "model_call")).toHaveLength(0);
  const refusals = journalEntries(options).filter(entry => entry.kind === "request_refused");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toMatchObject({ operation: "completions", limit: 3000 });
  expect(journalEntries(options).some(entry => entry.kind === "request")).toBe(false);
  const stored = JSON.parse(readFileSync(join(options.runDir, "player", "agents", "main", "provider.json"), "utf8")) as { inFlight?: unknown; sentMessages?: number };
  expect(stored.inFlight).toBeUndefined();
  // Nothing was dispatched, so nothing in the ledger may have been marked as sent.
  expect(stored.sentMessages).toBe(0);
  // Resuming must still hit the refusal, not a budget error and not an interrupted request: the
  // refusal never became an in-flight request, so there is no unknown outcome to recover.
  await player.close();
  const resumed = new Player(options);
  cleanups.push(() => resumed.close());
  await expect(resumed.prompt("oversized again")).rejects.toThrow("requestLimits.maxBytes");
  expect(journalEntries(options).filter(entry => entry.kind === "interrupted_request")).toHaveLength(0);
  expect(bodies).toHaveLength(0);
});
