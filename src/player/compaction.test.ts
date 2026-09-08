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
