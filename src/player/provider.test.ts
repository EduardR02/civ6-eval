import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Player } from "../player.ts";
import { createRuntime } from "./auth.ts";
import { ProviderCompletions } from "./provider.ts";
import type { PlayerEvent, PlayerOptions } from "../contracts.ts";

interface WireRequest {
  model: string;
  reasoning_effort?: string;
  tools?: unknown[];
  messages: { role: string; reasoning_content?: string; content: string | { image_url?: { url: string } }[] }[];
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSpkAAAAASUVORK5CYII=";
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
  const events: PlayerEvent[] = [];
  const startsAtSend: boolean[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as WireRequest;
    bodies.push(body);
    const start = events.filter(event => event.type === "model_call").at(-1);
    const ledger = start && JSON.parse(readFileSync(join(runDir, "player", "agents", start.agentId, "provider.json"), "utf8"));
    const registry = JSON.parse(readFileSync(join(runDir, "player", "agents.json"), "utf8"));
    startsAtSend.push(!!start?.requestId && ledger?.inFlight?.id === start.requestId && registry.calls === bodies.length);
    return replies[bodies.length - 1]?.() ?? new Response("unexpected request", { status: 500 });
  } });
  const options: PlayerOptions = { runDir, projectRoot: process.cwd(), provider: "opencode-go", apiKey: "fixture-only", model: "glm-5.3-flash", effort: "high", baseUrl: `http://127.0.0.1:${server.port}/v1`, rpc: async () => ({ files: [] }), execute: async () => ({ content: [{ type: "image", data: image, mimeType: "image/png" }] }), ...overrides, onEvent: event => events.push(event) };
  const player = new Player(options);
  cleanups.push(async () => { await player.close(); server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  return { player, options, bodies, events, startsAtSend };
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
