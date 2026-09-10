import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PlayerEvent, PlayerOptions } from "../src/contracts.ts";
import { UsageLedger, readUsageReport, formatUsageReport } from "../src/usage.ts";
import { NativeResponses, emptyUsage } from "../src/player/native.ts";
import { saveJson } from "../src/player/storage.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "civ-usage-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const usage = { input: 100, cacheRead: 20, cacheWrite: 10, output: 50, reasoning: 40, totalTokens: 180 };
function event(type: string, requestId: string, data?: unknown, agentId = "main", at = "2026-09-08T00:00:00.000Z"): PlayerEvent {
  return { type, requestId, agentId, data, at };
}

test("request-start turn and older analyst snapshot references survive asynchronous completion and restart", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "gpt-6-astra", "codex");
  ledger.onEvent(event("model_call", "pregame"));
  ledger.onEvent(event("model_end", "pregame", { outcome: "cancelled" }));
  ledger.observe({ gameId: "game", playerId: 0, turn: 8, snapshotId: "s-current" });
  ledger.observe({ gameId: "game", playerId: 0, turn: 3, snapshotId: "s-old", secret: "not-public" }, "analyst");
  ledger.onEvent(event("model_call", "old-analysis", { kind: "responses" }, "analyst"));
  ledger.observe({ gameId: "game", playerId: 0, turn: 9 });
  ledger.onEvent(event("usage", "old-analysis", { usage }, "analyst"));
  ledger.onEvent(event("model_end", "old-analysis", { outcome: "completed" }, "analyst", "2026-09-08T00:00:02.000Z"));
  const resumed = new UsageLedger(dir, "gpt-6-astra", "codex");
  resumed.restoreObservation({ gameId: "game", playerId: 0, turn: 8 });
  resumed.onEvent(event("model_call", "next", { kind: "compact" }, "analyst"));
  const report = await readUsageReport(dir);
  expect(report.requests[0]).toMatchObject({ attribution: null, tokens: null, outcome: "cancelled", estimatedUsd: null });
  expect(report.requests[1]).toMatchObject({ attribution: { turn: 8 }, snapshotReference: { turn: 3, snapshotId: "s-old" }, durationMs: 2000 });
  expect(report.requests[2]).toMatchObject({ attribution: { turn: 9 }, snapshotReference: { turn: 3 }, kind: "compact" });
  expect(report.turns.map(row => row.turn)).toEqual([null, 8, 9]);
  expect(readFileSync(join(dir, "usage.jsonl"), "utf8")).not.toContain("not-public");
});

test("durable duplicate events do not double count and interrupted partial tails resume without free requests", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "gpt-6-astra", "codex");
  ledger.onEvent(event("model_call", "done"));
  ledger.onEvent(event("usage", "done", { usage }));
  ledger.onEvent(event("model_end", "done", { outcome: "completed" }));
  const path = join(dir, "usage.jsonl");
  appendFileSync(path, readFileSync(path, "utf8"));
  ledger.onEvent(event("model_call", "interrupted"));
  appendFileSync(path, '{"version":1,"type":"us');
  const resumed = new UsageLedger(dir, "unknown-model", "codex", { input: 999, cachedInput: 999, cacheWrite: 999, output: 999 });
  resumed.onEvent(event("usage", "done", { usage }));
  const report = await readUsageReport(dir);
  expect(report.summary).toMatchObject({ requests: 2, reportedRequests: 1, unreportedRequests: 1, tokens: usage, estimatedUsd: null });
  expect(report.requests[1]).toMatchObject({ outcome: "interrupted", durationMs: null, tokens: null });
  expect(report.requests[0]!.estimatedUsd).toBeCloseTo(0.003645, 10);
  expect(report.requests[0]!.pricing.rates!.input).toBe(10);
  expect(report.summary.knownEstimatedUsd).toBeCloseTo(0.003645, 10);
});

test("reasoning is an output subset and full-request long-context pricing includes cache rates", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "gpt-6-astra", "codex");
  ledger.onEvent(event("model_call", "boundary"));
  ledger.onEvent(event("usage", "boundary", { usage: { input: 200000, cacheRead: 72000, cacheWrite: 0, output: 100, reasoning: 100, totalTokens: 272100 } }));
  ledger.onEvent(event("model_call", "long"));
  ledger.onEvent(event("usage", "long", { usage: { input: 200000, cacheRead: 72000, cacheWrite: 1, output: 100, reasoning: 100, totalTokens: 272101 } }));
  const report = await readUsageReport(dir);
  expect(report.requests[0]).toMatchObject({ longContext: false, estimatedUsd: 2.077 });
  expect(report.requests[1]!.longContext).toBe(true);
  expect(report.requests[1]!.estimatedUsd).toBeCloseTo(4.151525, 10);
  expect(report.summary.tokens.totalTokens).toBe(544201);
  expect(report.summary.tokens.output).toBe(200);
  expect(report.summary.tokens.reasoning).toBe(200);
});

test("unknown prices, unreported terminal usage and missing ledgers are not zero-priced subscriptions", async () => {
  const dir = directory();
  expect((await readUsageReport(dir)).summary.estimatedUsd).toBeNull();
  const ledger = new UsageLedger(dir, "other-model", "subscription-provider");
  ledger.onEvent(event("model_call", "reported"));
  ledger.onEvent(event("usage", "reported", { usage: { ...usage, cost: { total: 0 }, privatePrompt: "never copied" } }));
  ledger.onEvent(event("model_end", "reported", { outcome: "failed" }));
  ledger.onEvent(event("model_call", "unreported"));
  ledger.onEvent(event("model_end", "unreported", { outcome: "completed" }));
  const report = await readUsageReport(dir);
  expect(report.summary).toMatchObject({ reportedRequests: 1, unreportedRequests: 1, unpricedRequests: 2, estimatedUsd: null });
  expect(report.requests[0]!.pricing).toMatchObject({ rates: null, source: null });
  expect(report.actualSubscriptionCharge).toBeNull();
  expect(formatUsageReport(report)).toContain("Actual subscription charge is unavailable");
  expect(readFileSync(join(dir, "usage.jsonl"), "utf8")).not.toContain("never copied");
});

test("native child compaction and failed responses share stable public lifecycle ids without opaque data", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "gpt-6-astra", "openai");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (new URL(request.url).pathname.endsWith("/compact")) return Response.json({ output: [{ type: "compaction", encrypted_content: "private-opaque" }], usage: { input_tokens: 100, output_tokens: 10 } });
    return new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"fixture","message":"fixture failure"},"usage":{"input_tokens":20,"output_tokens":3,"output_tokens_details":{"reasoning_tokens":2}}}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  } });
  cleanups.push(() => server.stop(true));
  const model: Model<Api> = { id: "gpt-6-astra", name: "fixture", provider: "openai", api: "openai-responses", baseUrl: `http://127.0.0.1:${server.port}`, reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 1000, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } };
  const runtime = { getAuth: async () => ({ auth: { apiKey: "fixture-not-a-key" } }) } as unknown as ModelRuntime;
  const agentId = "child";
  saveJson(join(dir, "player", "agents", agentId, "native.json"), { version: 1, items: [], seenInputs: [], completedCalls: [], inputTokens: 101, compactions: 0, totalUsage: emptyUsage() });
  const native = new NativeResponses(agentId, { projectRoot: process.cwd(), runDir: dir, compactThreshold: 100, rpc: async () => ({}), execute: async () => ({ content: [] }), onEvent: event => ledger.onEvent(event) }, runtime, model,
    (kind, requestId) => ledger.onEvent({ type: "model_call", agentId, requestId, data: { kind, model: model.id, provider: model.provider } }),
    (usage, kind, requestId) => ledger.onEvent({ type: "usage", agentId, requestId, data: { usage, kind } }));
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("error");
  const report = await readUsageReport(dir);
  expect(report.requests.map(row => [row.agentId, row.kind, row.outcome, row.tokens!.totalTokens])).toEqual([["child", "compact", "completed", 110], ["child", "responses", "failed", 23]]);
  expect(new Set(report.requests.map(row => row.requestId)).size).toBe(2);
  expect(report.agents[0]!.tokens.totalTokens).toBe(133);
  expect(readFileSync(join(dir, "usage.jsonl"), "utf8")).not.toContain("private-opaque");
});

function nativeAccountingFixture(dir: string, providerUsage: unknown, onEvent: (event: PlayerEvent) => void, output: unknown[] = []) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: providerUsage } })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  ) });
  cleanups.push(() => server.stop(true));
  const model: Model<Api> = { id: "gpt-6-astra", name: "fixture", provider: "openai", api: "openai-responses", baseUrl: `http://127.0.0.1:${server.port}`, reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 1000, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } };
  const runtime = { getAuth: async () => ({ auth: { apiKey: "fixture-only" } }) } as unknown as ModelRuntime;
  return new NativeResponses("main", { projectRoot: process.cwd(), runDir: dir, rpc: async () => ({}), execute: async () => ({ content: [] }), onEvent }, runtime, model,
    (kind, requestId) => onEvent(event("model_call", requestId, { kind })),
    (usage, kind, requestId) => onEvent(event("usage", requestId, { usage, kind })));
}

test("native missing primary usage stays unreported while explicit zeros and cache subsets are accounted", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "gpt-6-astra", "openai");
  for (const missing of [undefined, {}, { input_tokens: 12 }, { output_tokens: 7 }]) {
    const native = nativeAccountingFixture(dir, missing, event => ledger.onEvent(event));
    expect((await native.stream({ messages: [] }).result()).stopReason).toBe("stop");
  }
  const zero = nativeAccountingFixture(dir, { input_tokens: 0, output_tokens: 0 }, event => ledger.onEvent(event));
  expect((await zero.stream({ messages: [] }).result()).stopReason).toBe("stop");
  const native = nativeAccountingFixture(dir, { input_tokens: 130, output_tokens: 50, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 40 } }, event => ledger.onEvent(event));
  expect((await native.stream({ messages: [] }).result()).usage).toMatchObject(usage);
  const report = await readUsageReport(dir);
  expect(report.summary).toMatchObject({ requests: 6, reportedRequests: 2, unreportedRequests: 4, unpricedRequests: 4, estimatedUsd: null, tokens: usage });
  expect(report.requests.slice(0, 4).map(request => [request.tokens, request.estimatedUsd, request.outcome])).toEqual(Array.from({ length: 4 }, () => [null, null, "completed"]));
  expect(report.requests[4]!.estimatedUsd).toBe(0);
  expect(report.summary.knownEstimatedUsd).toBeCloseTo(0.003645, 10);
});

test("native invalid counters and impossible subsets never become priced usage", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "gpt-6-astra", "openai");
  const invalid = [
    { input_tokens: -1, output_tokens: 0 },
    { input_tokens: 0.5, output_tokens: 0 },
    { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 } },
    { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 3 } },
    { input_tokens: 1, output_tokens: 2, total_tokens: 4 },
  ];
  for (const counters of invalid) {
    const native = nativeAccountingFixture(dir, counters, event => ledger.onEvent(event));
    expect((await native.stream({ messages: [] }).result()).stopReason).toBe("error");
  }
  const report = await readUsageReport(dir);
  expect(report.summary).toMatchObject({ requests: invalid.length, reportedRequests: 0, unreportedRequests: invalid.length, estimatedUsd: null });
  expect(report.requests.every(request => request.tokens === null && request.outcome === "failed")).toBe(true);
});

test("native streams settle when both usage and terminal ledger appends fail", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "gpt-6-astra", "openai");
  const path = join(dir, "usage.jsonl");
  const backup = join(dir, "usage.saved");
  let failedUsage = false;
  const native = nativeAccountingFixture(dir, { input_tokens: 1, output_tokens: 2 }, event => {
    if (event.type === "usage") {
      renameSync(path, backup);
      mkdirSync(path);
      failedUsage = true;
    }
    ledger.onEvent(event);
  });
  const result = await native.stream({ messages: [] }).result();
  expect(failedUsage).toBe(true);
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("accounting outcome is unknown");
  rmSync(path, { recursive: true });
  renameSync(backup, path);
  expect((await readUsageReport(dir)).requests[0]).toMatchObject({ outcome: "unknown", tokens: null, estimatedUsd: null });
  new UsageLedger(dir, "gpt-6-astra", "openai");
  expect((await readUsageReport(dir)).requests[0]).toMatchObject({ outcome: "interrupted", tokens: null, estimatedUsd: null });
}, 5000);

test("terminal and recovery persistence failures settle without authorizing durable calls", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "gpt-6-astra", "openai");
  const call = { type: "function_call", id: "fc_unexecuted", call_id: "call_unexecuted", name: "exec_py", arguments: "{}", status: "completed" };
  const log = join(dir, "player", "agents", "main", "native.jsonl");
  const native = nativeAccountingFixture(dir, { input_tokens: 1, output_tokens: 2 }, event => {
    if (event.type === "model_end") {
      rmSync(log);
      mkdirSync(log);
      throw new Error("private-storage-fixture");
    }
    ledger.onEvent(event);
  }, [call]);
  const result = await native.stream({ messages: [] }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("action outcomes remain unknown");
  expect(JSON.stringify(result)).not.toContain("private-storage-fixture");
  expect(() => native.executionStarted("call_unexecuted|fc_unexecuted", {})).toThrow();
  expect((await readUsageReport(dir)).requests[0]).toMatchObject({ outcome: "unknown", tokens: { totalTokens: 3 } });
  rmSync(log, { recursive: true });
  const restarted = nativeAccountingFixture(dir, undefined, event => ledger.onEvent(event));
  expect(() => restarted.executionStarted("call_unexecuted|fc_unexecuted", {})).toThrow("already completed");
  const state = JSON.parse(readFileSync(join(dir, "player", "agents", "main", "native.json"), "utf8"));
  expect(state.items.find((item: Record<string, unknown>) => item.type === "function_call_output").output[0].text).toContain("UNKNOWN");
}, 5000);

test("GLM Go catalog prices are persisted API equivalents, with unknown subscription charges and explicit overrides", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "glm-5.3-flash", "opencode-go");
  ledger.onEvent(event("model_call", "catalog"));
  ledger.onEvent(event("usage", "catalog", { usage }));
  ledger.onEvent(event("model_end", "catalog", { outcome: "completed" }));
  ledger.onEvent(event("model_call", "other-provider", { provider: "unknown" }));
  ledger.onEvent(event("usage", "other-provider", { usage }));
  ledger.onEvent(event("model_end", "other-provider", { outcome: "completed" }));
  const overridden = new UsageLedger(dir, "glm-5.3-flash", "opencode-go", { input: 1, cachedInput: 1, cacheWrite: 1, output: 1 });
  overridden.onEvent(event("model_call", "override"));
  overridden.onEvent(event("usage", "override", { usage }));
  const report = await readUsageReport(dir);
  expect(report.requests[0]!.estimatedUsd).toBeCloseTo(0.0000203, 10);
  expect(report.requests[0]!.pricing.source).toContain("opencode-go catalog");
  expect(report.requests[1]!.estimatedUsd).toBeNull();
  expect(report.requests[2]!.estimatedUsd).toBeCloseTo(0.00018, 10);
  expect(report.actualSubscriptionCharge).toBeNull();
  expect(report.summary.estimatedUsd).toBeNull();
  expect(report.summary.knownEstimatedUsd).toBeCloseTo(0.0002003, 10);
});

test("Muse Spark contributor prices persist the effectively-free catalog rates", async () => {
  const dir = directory();
  const ledger = new UsageLedger(dir, "muse-spark-1.3-contributor", "opencode-go");
  ledger.onEvent(event("model_call", "muse"));
  ledger.onEvent(event("usage", "muse", { usage }));
  ledger.onEvent(event("model_end", "muse", { outcome: "completed" }));
  const report = await readUsageReport(dir);
  expect(report.requests[0]!.estimatedUsd).toBeCloseTo(0.00002004, 10);
  expect(report.requests[0]!.pricing.source).toContain("muse-spark-1.3-contributor");
  expect(report.requests[0]!.pricing.rates).toEqual({ input: 0.1, cachedInput: 0.002, cacheWrite: 0, output: 0.2 });
});

test("native image budget purges to the watermark in one batch and stays append-only between purges", async () => {
  const dir = directory();
  const bodies: { input: Record<string, unknown>[] }[] = [];
  const { model, runtime, options } = imageBudgetFixture(dir, bodies);
  const agentDir = join(dir, "player", "agents", "main");
  // 47 tool screenshots plus 3 inline user screenshots: 50 images, 5 over the 45 trigger.
  const items: Record<string, unknown>[] = [];
  const completedCalls: string[] = [];
  for (let index = 0; index < 47; index++) {
    items.push({ type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "civ.snapshot", arguments: "{}", status: "completed" });
    items.push({ type: "function_call_output", call_id: `call_${index}`, output: [{ type: "input_image", image_url: `data:image/png;base64,tool-${index}`, detail: "original" }] });
    if (index === 0 || index === 23 || index === 46) items.push({ role: "user", content: [{ type: "input_text", text: `turn ${index}` }, { type: "input_image", image_url: `data:image/png;base64,user-${index}`, detail: "original" }] });
    completedCalls.push(`call_${index}`);
  }
  saveJson(join(agentDir, "native.json"), { version: 1, items, seenInputs: [], completedCalls, inputTokens: 0, compactions: 0, totalUsage: emptyUsage() });
  const native = new NativeResponses("main", options, runtime, model, () => {}, () => {});
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("stop");
  const [first, second] = bodies;
  expect(first!.input).toHaveLength(items.length);
  // One batched purge: the oldest 45 images become placeholders, exactly 5 survive.
  expect(countParts(first!.input, "input_image")).toBe(5);
  expect(countParts(second!.input, "input_image")).toBe(5);
  const placeholder = "[screenshot elided — image budget]";
  expect(countParts(first!.input, "input_text", placeholder)).toBe(45);
  expect(countParts(second!.input, "input_text", placeholder)).toBe(45);
  const outputFor = (callId: string) => first!.input.find(item => item.call_id === callId && item.type === "function_call_output") as { output: Record<string, unknown>[] };
  expect(outputFor("call_0").output).toEqual([{ type: "input_text", text: placeholder }]);
  expect(outputFor("call_42").output).toEqual([{ type: "input_text", text: placeholder }]);
  expect(outputFor("call_43").output).toEqual([{ type: "input_image", image_url: "data:image/png;base64,tool-43", detail: "original" }]);
  expect(outputFor("call_46").output).toEqual([{ type: "input_image", image_url: "data:image/png;base64,tool-46", detail: "original" }]);
  const turn = (index: number) => first!.input.find(item => Array.isArray(item.content) && (item.content as Record<string, unknown>[])[0]!.text === `turn ${index}`) as { content: Record<string, unknown>[] };
  expect(turn(0).content[1]).toEqual({ type: "input_text", text: placeholder });
  expect(turn(23).content[1]).toEqual({ type: "input_text", text: placeholder });
  expect(turn(46).content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,user-46", detail: "original" });
  // Between purges the outbound prefix is byte-identical: no churn, only appends.
  expect(JSON.stringify(second!.input)).toBe(JSON.stringify(first!.input));
  // A new screenshot lands below the trigger: nothing is rewritten or journaled.
  expect((await native.stream({ messages: [{ role: "user", content: [{ type: "image", data: "bmV3", mimeType: "image/png" }], timestamp: 3 }] }).result()).stopReason).toBe("stop");
  expect(bodies[2]).toBeDefined();
  expect(bodies[2]!.input).toHaveLength(items.length + 1);
  expect(countParts(bodies[2]!.input, "input_image")).toBe(6);
  expect(countParts(bodies[2]!.input, "input_text", placeholder)).toBe(45);
  expect(JSON.stringify(bodies[2]!.input.slice(0, second!.input.length))).toBe(JSON.stringify(second!.input));
  // The purge rewrote the durable ledger exactly once; resume replays the placeholders unchanged.
  const resumed = new NativeResponses("main", options, runtime, model, () => {}, () => {});
  expect((await resumed.stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect(countParts(bodies[3]!.input, "input_image")).toBe(6);
  expect(countParts(bodies[3]!.input, "input_text", placeholder)).toBe(45);
  const state = JSON.parse(readFileSync(join(agentDir, "native.json"), "utf8"));
  expect(countParts(state.items, "input_image")).toBe(6);
  expect(countParts(state.items, "input_text", placeholder)).toBe(45);
  const rewrites = readFileSync(join(agentDir, "native.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as { kind: string }).filter(entry => entry.kind === "image_budget");
  expect(rewrites).toHaveLength(1);
  expect(rewrites[0]).toMatchObject({ elided: 45, remaining: 5 });
});

test("native image budget leaves a ledger at the trigger threshold untouched", async () => {
  const dir = directory();
  const bodies: { input: Record<string, unknown>[] }[] = [];
  const { model, runtime, options } = imageBudgetFixture(dir, bodies);
  const agentDir = join(dir, "player", "agents", "main");
  const items: Record<string, unknown>[] = [];
  const completedCalls: string[] = [];
  for (let index = 0; index < 45; index++) {
    items.push({ type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "civ.snapshot", arguments: "{}", status: "completed" });
    items.push({ type: "function_call_output", call_id: `call_${index}`, output: [{ type: "input_image", image_url: `data:image/png;base64,tool-${index}`, detail: "original" }] });
    completedCalls.push(`call_${index}`);
  }
  saveJson(join(agentDir, "native.json"), { version: 1, items, seenInputs: [], completedCalls, inputTokens: 0, compactions: 0, totalUsage: emptyUsage() });
  const native = new NativeResponses("main", options, runtime, model, () => {}, () => {});
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect(countParts(bodies[0]!.input, "input_image")).toBe(45);
  expect(readFileSync(join(agentDir, "native.jsonl"), "utf8")).not.toContain("image_budget");
  const state = JSON.parse(readFileSync(join(agentDir, "native.json"), "utf8"));
  expect(countParts(state.items, "input_image")).toBe(45);
  expect(countParts(state.items, "input_text", "[screenshot elided — image budget]")).toBe(0);
});

function imageBudgetFixture(dir: string, bodies: { input: Record<string, unknown>[] }[]) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.json());
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanups.push(() => server.stop(true));
  const model: Model<Api> = { id: "muse-spark-1.3-contributor", name: "fixture", provider: "opencode-go", api: "openai-responses", baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: true, input: ["text", "image"], contextWindow: 10000, maxTokens: 1000, cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 } };
  const runtime = { getAuth: async () => ({ auth: { apiKey: "fixture-only" } }) } as unknown as ModelRuntime;
  const options: PlayerOptions = { projectRoot: process.cwd(), runDir: dir, rpc: async () => ({}), execute: async () => ({ content: [] }) };
  return { model, runtime, options };
}

function countParts(input: readonly unknown[], type: string, text?: string): number {
  let total = 0;
  for (const item of input) {
    const parts = [...Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as Record<string, unknown>[] : [], ...Array.isArray((item as Record<string, unknown>).output) ? (item as Record<string, unknown>).output as Record<string, unknown>[] : []];
    for (const part of parts) if (part.type === type && (text === undefined || part.text === text)) total++;
  }
  return total;
}
