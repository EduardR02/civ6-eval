import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NativeResponses, emptyUsage } from "./native.ts";
import { saveJson } from "./storage.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(fetch: (request: Request) => Response | Promise<Response>, getAuth: () => Promise<unknown> = async () => ({ auth: { apiKey: "fixture-only" } })) {
  const runDir = mkdtempSync(join(tmpdir(), "civ-native-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  cleanups.push(() => { server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  const model: Model<Api> = { id: "fixture", name: "Fixture", api: "openai-responses", provider: "openai", baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: true, input: ["text", "image"], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const path = join(runDir, "player", "agents", "main", "native.json");
  const create = () => new NativeResponses("main", { runDir, projectRoot: process.cwd(), provider: "openai", compactThreshold: 100, rpc: async () => ({}), execute: async () => ({ content: [] }) }, { getAuth } as unknown as ModelRuntime, model, () => {}, () => {});
  return { create, path, runDir };
}

function sse(events: unknown[]) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "exec_py", arguments: '{"code":"mutate()"}', status: "completed" };

test("auth refresh secrets never enter public errors or durable native state", async () => {
  const secret = "fresh-refresh-token-secret";
  let requests = 0;
  const { create, path } = fixture(() => { requests++; throw new Error("unexpected request"); }, async () => { throw new Error(JSON.stringify({ access_token: secret, refresh_token: secret })); });
  const result = await create().stream({ messages: [] }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("Authentication unavailable");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(readFileSync(path, "utf8")).not.toContain(secret);
  expect(requests).toBe(0);
});

test("unterminated streams cannot authorize projected tool calls", async () => {
  const { create } = fixture(() => sse([{ type: "response.output_item.added", output_index: 0, item: call }, { type: "response.output_item.done", output_index: 0, item: call }]));
  const native = create();
  const result = await native.stream({ messages: [] }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("terminal");
  expect(() => native.executionStarted("call_fixture|fc_fixture", {})).toThrow("no durable native call identity");
});

test("incomplete terminal output is retained without allowing execution on restart", async () => {
  const { create, path } = fixture(() => sse([{ type: "response.completed", response: { status: "incomplete", output: [call], incomplete_details: { reason: "max_output_tokens" } } }]));
  const result = await create().stream({ messages: [] }).result();
  expect(result.stopReason).toBe("error");
  const restarted = create();
  expect(() => restarted.executionStarted("call_fixture|fc_fixture", {})).toThrow("already completed");
  const state = JSON.parse(readFileSync(path, "utf8")) as { items: Record<string, unknown>[] };
  expect(state.items).toContainEqual(call);
  expect(JSON.stringify(state.items.find(item => item.type === "function_call_output"))).toContain("UNKNOWN");
});

test("native compaction preserves opaque output and completed identities without replaying old user inputs", async () => {
  const opaque = { type: "compaction", encrypted_content: "opaque-fixture", future_field: { retained: true } };
  let requestInput: unknown;
  const { create, path } = fixture(async request => {
    if (new URL(request.url).pathname.endsWith("/compact")) return Response.json({ output: [opaque] });
    requestInput = (await request.json() as { input: unknown }).input;
    return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
  });
  saveJson(path, { version: 1, items: [call, { type: "function_call_output", call_id: call.call_id, output: "done" }], seenInputs: [], completedCalls: [call.call_id], inputTokens: 101, compactions: 0, totalUsage: emptyUsage() });
  const native = create();
  const user = { role: "user" as const, content: "old input", timestamp: 123 };
  expect((await native.stream({ messages: [user] }).result()).stopReason).toBe("stop");
  expect(requestInput).toEqual([opaque]);
  const restarted = create();
  expect(() => restarted.executionStarted("call_fixture|fc_fixture", {})).toThrow("already completed");
  expect((await restarted.stream({ messages: [user] }).result()).stopReason).toBe("stop");
  expect(requestInput).toEqual([opaque]);
});

test("streamed native items survive a Codex terminal response with empty output", async () => {
  const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "opaque-roundtrip", future_field: 42 };
  const { create, path } = fixture(() => sse([
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: call },
    { type: "response.output_item.done", output_index: 1, item: call },
    { type: "response.completed", response: { status: "completed", output: [] } },
  ]));
  const native = create();
  const result = await native.stream({ messages: [] }).result();
  expect(result.stopReason).toBe("toolUse");
  native.executionStarted("call_fixture|fc_fixture", {});
  native.toolResult("call_fixture|fc_fixture", [{ type: "text", text: "actual action result" }]);
  const state = JSON.parse(readFileSync(path, "utf8"));
  expect(state.items.slice(0, 2)).toEqual([reasoning, call]);
  expect(state.completedCalls).toEqual(["call_fixture"]);
});
