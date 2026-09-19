import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Player } from "../player.ts";
import type { CompletionMode, PlayerEvent, PlayerOptions, TaskRecord } from "../contracts.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Responses-API fixtures: the native transport Muse and Codex use. */
function textItem(text: string) {
  return { type: "message", id: `msg_${text.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}
function callItem(name: string, args: unknown, callId: string) {
  return { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: "completed" };
}
function responses(...items: Record<string, unknown>[]): Response {
  const events: Record<string, unknown>[] = [];
  for (const [index, item] of items.entries()) {
    events.push({ type: "response.output_item.added", output_index: index, item }, { type: "response.output_item.done", output_index: index, item });
  }
  events.push({ type: "response.completed", response: { id: "resp", status: "completed", output: items } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
function failed(code: string, message: string): Response {
  return new Response(`data: ${JSON.stringify({ type: "response.failed", response: { id: "resp", status: "failed", error: { code, message } } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
/** Chat-completions fixtures: the transport the opencode-go GLM binding uses. */
function completionsTool(callId: string, name: string, args: unknown): Response {
  const chunks = [
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}
function completionsText(text: string): Response {
  const chunks = [
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

interface AgentView { id: string; status: string; error?: string; text: string; task?: TaskRecord; pendingMessages: string[] }
interface RegistryView { agents: AgentView[] }
interface Fixture {
  player: Player;
  bodies: string[];
  events: PlayerEvent[];
  registry: () => RegistryView;
  records: () => Record<string, unknown>[];
  dispatches: () => { dispatch: string; messages: string[] }[];
  task: (agentId?: string) => TaskRecord | undefined;
  restart: () => Player;
}
function fixture(mode: CompletionMode, replies: (() => Response | Promise<Response>)[], overrides: Partial<PlayerOptions> = {}): Fixture {
  const runDir = mkdtempSync(join(tmpdir(), "civ-task-"));
  const bodies: string[] = [];
  const events: PlayerEvent[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.text());
    const reply = replies[bodies.length - 1];
    if (!reply) throw new Error(`Unexpected model request ${bodies.length}`);
    return reply();
  } });
  const options: PlayerOptions = {
    runDir, projectRoot: process.cwd(), provider: "openai", apiKey: "fixture-only", model: "fixture",
    effort: "high", baseUrl: `http://127.0.0.1:${server.port}/v1`, completionMode: mode,
    rpc: async () => ({ files: [] }), execute: async () => { throw new Error("Unexpected execution"); },
    onEvent: event => events.push(event), ...overrides,
  };
  const player = new Player(options);
  cleanups.push(async () => { await player.close(); server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  const registry = (): RegistryView => JSON.parse(readFileSync(join(runDir, "player", "agents.json"), "utf8"));
  const records = (): Record<string, unknown>[] => readFileSync(join(runDir, "player", "tasks.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  return {
    player, bodies, events, registry, records,
    restart: () => {
      const restarted = new Player(options);
      cleanups.push(async () => { await restarted.close(); });
      return restarted;
    },
    dispatches: () => records().filter(line => line.kind === "dispatch").map(line => ({ dispatch: String(line.dispatch), messages: line.messages as string[] })),
    task: (agentId = "main") => registry().agents.find(agent => agent.id === agentId)?.task,
  };
}
const declaredCompletion = (status: "completed" | "blocked", reason: string, callId: string) => (() => responses(callItem("finish_task", { status, reason }, callId)));

test("explicit mode: a progress report is not a completion, and one reminder asks for a declaration", async () => {
  const { player, bodies, events, registry, task } = fixture("explicit", [
    () => responses(textItem("Turn 70 complete. Game active — NOT won/lost; no blocker.")),
    () => responses(textItem("Declaring completion."), callItem("finish_task", { status: "completed", reason: "Science victory on turn 214, confirmed by the victory screen" }, "call_finish")),
  ]);
  const result = await player.prompt("play to a confirmed victory or defeat");
  expect(result).toMatchObject({ outcome: "completed", reason: "Science victory on turn 214, confirmed by the victory screen", repair: true });
  // The progress report drew exactly one harness reminder, sent as the next user turn.
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain("[harness protocol]");
  expect(bodies[1]).toContain("Turn 70 complete");
  expect(registry().agents.find(agent => agent.id === "main")).toMatchObject({ status: "completed", text: "Declaring completion." });
  expect(events.filter(event => event.type === "protocol_repair")).toHaveLength(1);
  expect(events.filter(event => event.type === "task_outcome")).toHaveLength(1);
});

test("explicit mode: a second undeclared turn stops as an explicit protocol failure, never completed", async () => {
  const { player, bodies, registry, task, events } = fixture("explicit", [
    () => responses(textItem("Turn 70 done, continuing later.")),
    () => responses(textItem("Still nothing to declare.")),
  ]);
  await expect(player.prompt("play the game")).rejects.toThrow("Explicit task protocol failure");
  expect(bodies).toHaveLength(2);
  expect(events.filter(event => event.type === "task_outcome")).toHaveLength(0);
  expect(registry().agents.find(agent => agent.id === "main")?.status).toBe("failed");
  expect(task()).toMatchObject({ outcome: "protocol_failure", repair: true });
  expect(task()?.reason).toContain("ended two turns without a finish_task declaration");
});

test("explicit mode: a blocked declaration is durable, ends the turn, and is scoped to its dispatch", async () => {
  const { player, bodies, registry, dispatches, task } = fixture("explicit", [
    () => responses(callItem("finish_task", { status: "blocked", reason: "Civ shows an unresolvable modal at turn 12; the operator must dismiss it" }, "call_block")),
  ]);
  const result = await player.prompt("play the game");
  expect(result).toMatchObject({ outcome: "blocked", repair: false });
  // finish_task terminates the tool loop, so no later model request can mutate after the declaration.
  expect(bodies).toHaveLength(1);
  expect(task()).toMatchObject({ outcome: "blocked", repair: false, reason: "Civ shows an unresolvable modal at turn 12; the operator must dismiss it" });
  expect(task()?.dispatch).toBe(dispatches()[0]?.dispatch);
  expect(registry().agents.find(agent => agent.id === "main")?.status).toBe("completed");
});

test("explicit mode: tool calls after a declaration are acknowledged without execution", async () => {
  let executions = 0;
  const { player, bodies, task } = fixture("explicit", [
    () => responses(
      callItem("finish_task", { status: "completed", reason: "Everything verified" }, "call_finish"),
      callItem("exec_py", { code: "print('mutate')" }, "call_exec"),
    ),
  ], { execute: async () => { executions++; return { content: [{ type: "text", text: "mutate" }] }; } });
  const result = await player.prompt("play the game");
  expect(executions).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(result).toMatchObject({ outcome: "completed", repair: false, reason: "Everything verified" });
  expect(task()).toEqual(result);
});

test("explicit mode: a tool failure followed by silence stops the task instead of completing it", async () => {
  let executions = 0;
  const { player, bodies, task } = fixture("explicit", [
    () => responses(callItem("exec_py", { code: "raise RuntimeError()" }, "call_fail")),
    () => responses(textItem("The Python call failed; I will continue later.")),
  ], { execute: async () => { executions++; return { isError: true, content: [{ type: "text", text: "Python fixture failure" }] }; } });
  await expect(player.prompt("play the game")).rejects.toThrow("Task remains unfinished after an execution failure");
  expect(executions).toBe(1);
  expect(bodies).toHaveLength(2);
  expect(task()).toMatchObject({ outcome: "unfinished", repair: false });
});

test("explicit mode: a provider failure ends the dispatch without a reminder or a completion", async () => {
  const { player, bodies, registry, events, task } = fixture("explicit", [() => failed("server_error", "upstream exploded")]);
  await expect(player.prompt("play the game")).rejects.toThrow();
  expect(bodies).toHaveLength(1);
  expect(events.filter(event => event.type === "protocol_repair")).toHaveLength(0);
  expect(registry().agents.find(agent => agent.id === "main")?.status).toBe("failed");
  expect(task()).toMatchObject({ outcome: "unfinished", repair: false });
});

test("explicit mode: cancellation stops the dispatch without repair and records an unfinished task", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    requests.push("request");
    started.resolve();
    await release.promise;
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  cleanups.push(async () => { server.stop(true); });
  const { player, events, registry, task } = fixture("explicit", [], { baseUrl: `http://127.0.0.1:${server.port}/v1` });
  const run = player.prompt("play the game");
  void run.catch(() => {});
  await started.promise;
  await player.rpc("main", "agent.cancel", { id: "main" });
  release.resolve();
  await expect(run).rejects.toThrow();
  expect(requests).toHaveLength(1);
  expect(events.filter(event => event.type === "protocol_repair")).toHaveLength(0);
  expect(registry().agents.find(agent => agent.id === "main")?.status).toBe("interrupted");
  expect(task()?.outcome).toBe("unfinished");
});

test("explicit mode: a new dispatch never inherits the previous dispatch's completion", async () => {
  const { player, bodies, registry, dispatches, task } = fixture("explicit", [
    () => responses(callItem("finish_task", { status: "completed", reason: "First dispatch done" }, "call_one")),
    () => responses(textItem("Second dispatch progress, undeclared.")),
    () => responses(textItem("Still undeclared.")),
  ]);
  const first = await player.prompt("first task");
  expect(first?.outcome).toBe("completed");
  await expect(player.prompt("second task")).rejects.toThrow("Explicit task protocol failure");
  expect(bodies).toHaveLength(3);
  expect(dispatches()).toHaveLength(2);
  expect(task()?.dispatch).toBe(dispatches()[1]?.dispatch);
  expect(task()?.dispatch).not.toBe(first?.dispatch);
  expect(task()?.outcome).toBe("protocol_failure");
  expect(registry().agents.find(agent => agent.id === "main")?.text).toBe("Still undeclared.");
});

test("explicit mode: operator mail queued during a dispatch drains as its own declared task", async () => {
  const { player, bodies, dispatches, records, task, registry } = fixture("explicit", [
    async () => {
      await player.rpc("main", "agent.send", { id: "main", message: "second task queued mid-dispatch" });
      return responses(callItem("finish_task", { status: "completed", reason: "First task done" }, "call_one"));
    },
    () => responses(callItem("finish_task", { status: "blocked", reason: "Operator must choose a victory path" }, "call_two")),
  ]);
  const result = await player.prompt("first task");
  // Both dispatches declared independently; the run's caller sees the last one.
  expect(records().filter(record => record.kind === "declare").map(record => record.outcome)).toEqual(["completed", "blocked"]);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain("second task queued mid-dispatch");
  expect(dispatches()).toHaveLength(2);
  expect(result).toMatchObject({ outcome: "blocked", reason: "Operator must choose a victory path" });
  expect(task()?.dispatch).toBe(dispatches()[1]?.dispatch);
  expect(registry().agents.find(agent => agent.id === "main")?.pendingMessages).toEqual([]);
});

test("explicit mode: a declaration survives a restart without replaying the task", async () => {
  const { player, bodies, restart } = fixture("explicit", [declaredCompletion("blocked", "Waiting for the operator to load the game", "call_block")]);
  const original = await player.prompt("play the game");
  await player.close();
  const restarted = restart();
  const listed = await restarted.rpc("main", "agent.list", {}) as { agents: AgentView[] };
  expect(listed.agents.find(agent => agent.id === "main")?.task).toEqual(original);
  expect(bodies).toHaveLength(1);
});

test("explicit mode: a delegated child keeps response mode instead of the operator protocol", async () => {
  const { player, bodies, registry, task } = fixture("explicit", [
    () => responses(textItem("Three cities.")),
    () => responses(callItem("finish_task", { status: "completed", reason: "Played the turn" }, "call_finish")),
  ]);
  const child = await player.rpc("main", "agent.spawn", { task: "count cities", name: "Counter" }) as { id: string };
  await player.rpc("main", "agent.wait", { id: child.id });
  const childRecord = registry().agents.find(agent => agent.id === child.id);
  // A single child request was enough: its silence is the end of its task, with no declaration and no reminder.
  expect(bodies).toHaveLength(1);
  expect(childRecord?.task).toBeUndefined();
  expect(childRecord?.status).toBe("completed");
  expect((await player.prompt("play a turn"))?.outcome).toBe("completed");
  expect(bodies).toHaveLength(2);
  expect(task()?.reason).toBe("Played the turn");
});

test("explicit mode: an exhausted model-call budget stops the run without a completion or a replay", async () => {
  const { player, bodies, registry, events, task } = fixture("explicit", [
    () => responses(textItem("Turn 70 report only.")),
  ], { maxModelCalls: 1 });
  await expect(player.prompt("play the game")).rejects.toThrow("budget");
  // The reminder could not be sent: the ceiling rejects it before any request leaves the process.
  expect(bodies).toHaveLength(1);
  expect(events.filter(event => event.type === "task_outcome")).toHaveLength(0);
  expect(registry().agents.find(agent => agent.id === "main")?.status).toBe("failed");
  expect(task()).toMatchObject({ outcome: "unfinished", repair: true });
});

test("response mode remains the default contract: stopping is the end and no task is recorded", async () => {
  const { player, bodies, registry, events, task } = fixture("response", [() => responses(textItem("Analysis complete: six cities."))]);
  expect(await player.prompt("count cities")).toBeUndefined();
  expect(bodies).toHaveLength(1);
  expect(task()).toBeUndefined();
  expect(events.filter(event => event.type === "protocol_repair")).toHaveLength(0);
  expect(registry().agents.find(agent => agent.id === "main")?.status).toBe("completed");
});

test("opencode-go completions transports declare through finish_task like the native path", async () => {
  const { player, bodies, task } = fixture("explicit", [
    () => completionsText("Working on turn 70."),
    () => completionsTool("call_finish", "finish_task", { status: "completed", reason: "Turn 70 held; next turn queued" }),
  ], { provider: "opencode-go", model: "glm-5.3-flash" });
  const result = await player.prompt("one dispatch");
  expect(result).toMatchObject({ outcome: "completed", repair: true });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain("[harness protocol]");
  expect(task()?.reason).toContain("Turn 70 held");
});

test("an invalid declaration is rejected without ending the task", async () => {
  const { player, bodies, task } = fixture("explicit", [
    () => responses(callItem("finish_task", { status: "maybe", reason: "unsure" }, "call_bad")),
    () => responses(callItem("finish_task", { status: "blocked", reason: "Operator must choose the victory path" }, "call_ok")),
  ]);
  const result = await player.prompt("play the game");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain("Validation failed");
  expect(result?.outcome).toBe("blocked");
  expect(task()?.reason).toContain("Operator must choose the victory path");
});

test("a declaration reason longer than the durable bound is truncated, not dropped", async () => {
  const { player, task } = fixture("explicit", [declaredCompletion("completed", `Victory report: ${"x".repeat(20000)}`, "call_long")]);
  const result = await player.prompt("play the game");
  expect(result?.outcome).toBe("completed");
  expect(Buffer.byteLength(result!.reason, "utf8")).toBeLessThanOrEqual(8192);
  expect(result?.reason).toContain("declaration truncated");
  expect(result?.reason).toContain("Victory report");
  expect(task()?.reason).toBe(result?.reason);
});
