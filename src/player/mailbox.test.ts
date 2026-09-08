import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Player } from "../player.ts";
import type { PlayerOptions } from "../contracts.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(rpc: PlayerOptions["rpc"], response?: (requestIndex: number) => Response) {
  const runDir = mkdtempSync(join(tmpdir(), "civ-mailbox-"));
  const inputs: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { input: unknown };
    inputs.push(JSON.stringify(body.input));
    if (response) return response(inputs.length);
    return new Response('data: {"type":"response.completed","response":{"id":"test","status":"completed","output":[]}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  } });
  const options: PlayerOptions = { runDir, projectRoot: process.cwd(), provider: "openai", apiKey: "fixture-only", model: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, maxConcurrentAgents: 1, rpc, execute: async () => { throw new Error("Unexpected execution"); } };
  const player = new Player(options);
  cleanups.push(async () => { await player.close(); server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  return { player, options, inputs, registry: () => JSON.parse(readFileSync(join(runDir, "player", "agents.json"), "utf8")) as { agents: { id: string; status: string; pendingMessages: string[]; activeMessages?: string[] }[] } };
}

test("main prompts with an existing queued session stay behind the scheduler lease", async () => {
  const childListing = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  const { player, inputs } = fixture(async id => {
    if (id !== "main") { childListing.resolve(); await releaseChild.promise; }
    return { files: [] };
  });
  await player.prompt("warm main session");
  await player.rpc("main", "agent.spawn", { task: "hold child lease" });
  await childListing.promise;
  const mainRun = player.prompt("queued main task");
  await player.rpc("main", "agent.status", {});
  await player.prompt("queued main followup");
  expect(inputs).toHaveLength(2);
  releaseChild.resolve();
  await mainRun;
  expect(inputs).toHaveLength(3);
  expect(inputs[2]).toContain("queued main task");
  expect(inputs[2]).toContain("queued main followup");
});

test("send accepted during finalization is durable and drains before wait completes", async () => {
  const listing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let listings = 0;
  const { player, inputs, registry } = fixture(async () => {
    if (++listings === 1) { listing.resolve(); await release.promise; }
    return { files: [] };
  });
  const run = player.prompt("initial task");
  await listing.promise;
  await player.rpc("main", "agent.send", { id: "main", message: "late durable message" });
  expect(registry().agents.find(agent => agent.id === "main")?.pendingMessages).toEqual(["late durable message"]);
  release.resolve();
  await run;
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toContain("late durable message");
  expect(registry().agents.find(agent => agent.id === "main")?.pendingMessages).toEqual([]);
});

test("cancelled unsent mail survives restart without automatic execution", async () => {
  const listing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { player, options, inputs, registry } = fixture(async () => { listing.resolve(); await release.promise; return { files: [] }; });
  const run = player.prompt("finished action");
  void run.catch(() => {});
  await listing.promise;
  await player.rpc("main", "agent.send", { id: "main", message: "not dispatched" });
  await player.rpc("main", "agent.cancel", { id: "main" });
  release.resolve();
  await expect(run).rejects.toThrow();
  await player.close();
  const restarted = new Player(options);
  cleanups.push(() => restarted.close());
  await restarted.rpc("main", "agent.status", {});
  expect(inputs).toHaveLength(1);
  expect(registry().agents.find(agent => agent.id === "main")?.pendingMessages).toEqual(["not dispatched"]);
  await restarted.prompt("explicit continuation");
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toContain("not dispatched");
  expect(inputs[1]).toContain("explicit continuation");
});

test("host Python failures produce Pi error events while retaining native error content", async () => {
  const call = { type: "function_call", id: "fc_error", call_id: "call_error", name: "exec_py", arguments: '{"code":"raise RuntimeError()"}', status: "completed" };
  const { player, options } = fixture(async () => ({ files: [] }), index => {
    const events = index === 1 ? [
      { type: "response.output_item.added", output_index: 0, item: call },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { status: "completed", output: [call] } },
    ] : [{ type: "response.completed", response: { status: "completed", output: [] } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  });
  const errors: boolean[] = [];
  options.execute = async () => ({ isError: true, content: [{ type: "text", text: "Python fixture failure" }] });
  options.onEvent = event => {
    if (event.type === "tool_end" && event.data && typeof event.data === "object" && "isError" in event.data && typeof event.data.isError === "boolean") errors.push(event.data.isError);
  };
  await player.prompt("exercise tool failure");
  expect(errors).toEqual([true]);
  const native = JSON.parse(readFileSync(join(options.runDir, "player", "agents", "main", "native.json"), "utf8")) as { items: Record<string, unknown>[] };
  expect(native.items.find(item => item.type === "function_call_output")?.output).toEqual([{ type: "input_text", text: "Python fixture failure" }]);
});
