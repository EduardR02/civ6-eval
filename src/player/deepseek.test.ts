import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { Api, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { PlayerOptions } from "../contracts.ts";
import { createRuntime } from "./auth.ts";
import { ProviderCompletions } from "./provider.ts";

/** Wire-level proof for the next-run model: overlay resolution, vision, effort max and the
 * reasoning-replay contract the DeepSeek thinking docs require once a request carries tools. */
interface WirePart { type?: string; text?: string; image_url?: { url: string } }
interface WireMessage { role: string; content?: string | WirePart[]; reasoning_content?: string }
interface WireRequest {
  model: string;
  reasoning_effort?: string;
  thinking?: { type?: string };
  max_tokens?: number;
  tools?: unknown[];
  messages: WireMessage[];
}
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSpkAAAAASUVORK5CYII=";
const tools: Context["tools"] = [{ name: "exec_py", description: "Execute Python in the persistent sandbox", parameters: Type.Object({ code: Type.String() }) }];
const frame = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const metered = (input = 40, output = 6) => `data: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } })}\n\n`;
const reply = (...parts: string[]) => new Response(`${parts.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const call = { index: 0, id: "call_tile", type: "function", function: { name: "exec_py", arguments: JSON.stringify({ code: "display(tile)" }) } };
const replies = [
  () => reply(frame({ reasoning_content: "Inspect the returned tile before answering" }), frame({ tool_calls: [call] }, "tool_calls"), metered()),
  () => reply(frame({ reasoning_content: "The observed tile has not changed" }), frame({ content: "The tile is teal." }, "stop"), metered()),
  () => reply(frame({ content: "Still teal." }, "stop"), metered()),
  () => reply(frame({ content: "Teal, unchanged." }, "stop"), metered()),
];
const asked = (timestamp: number, text: string): Message => ({ role: "user", content: text, timestamp });
// What the agent loop hands the transport for effort max: the session thinking level, not a model field.
const thinking: SimpleStreamOptions = { reasoning: "max" };
function fixture() {
  const runDir = mkdtempSync(join(tmpdir(), "civ-deepseek-"));
  const bodies: WireRequest[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.json() as WireRequest);
    return replies[bodies.length - 1]?.() ?? new Response("unexpected request", { status: 500 });
  } });
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  const options: PlayerOptions = { runDir, projectRoot: process.cwd(), provider: "opencode-go", apiKey: "fixture-only", model: "deepseek-flash", effort: "max", baseUrl, rpc: async () => ({ files: [] }), execute: async () => ({ content: [] }) };
  cleanups.push(async () => { server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  return { runDir, options, bodies, baseUrl };
}
const ledgerFor = async (options: PlayerOptions) => {
  const { runtime, model } = await createRuntime(options);
  const streamFunction = (m: Model<Api>, c: Context, o?: SimpleStreamOptions) => runtime.streamSimple(m, c, o);
  return { model, make: () => new ProviderCompletions("main", options, streamFunction, model, () => {}, () => {}) };
};


test("deepseek-flash replays every prior assistant reasoning, keeps tool images and survives restart", async () => {
  const { options, bodies } = fixture();
  const { make } = await ledgerFor(options);
  const ledger = make();
  const opened = await ledger.stream({ tools, messages: [asked(1, "which colour is the tile?")] }, thinking).result();
  const issued = opened.content.find(part => part.type === "toolCall");
  if (!issued || issued.type !== "toolCall") throw new Error("fixture did not return a tool call");
  ledger.toolResult(issued.id, [{ type: "image", data: image, mimeType: "image/png" }]);
  await ledger.stream({ tools, messages: [asked(1, "which colour is the tile?")] }, thinking).result();
  await ledger.stream({ tools, messages: [asked(3, "and now?")] }, thinking).result();
  await make().stream({ tools, messages: [asked(5, "after restart?")] }, thinking).result();

  const parts = (index: number) => bodies[index]!.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
  const attachments = (index: number) => parts(index).flatMap(part => part.image_url ? [part.image_url.url] : []);
  const assistants = (index: number) => bodies[index]!.messages.filter(message => message.role === "assistant").map(message => message.reasoning_content);
  expect(bodies.map(body => [body.model, body.reasoning_effort, body.thinking?.type])).toEqual(
    Array.from({ length: 4 }, () => ["deepseek-flash", "max", "enabled"]),
  );
  // Tool continuation: the image rides along and the tool turn keeps its reasoning.
  expect(assistants(1)).toEqual(["Inspect the returned tile before answering"]);
  expect(attachments(1)).toContain(`data:image/png;base64,${image}`);
  // A new user turn must retain the actual reasoning from the preceding no-tool answer.
  expect(assistants(2)).toEqual(["Inspect the returned tile before answering", "The observed tile has not changed"]);
  // A restart preserves that reasoning and supplies the required empty field for a turn without it.
  expect(assistants(3)).toEqual(["Inspect the returned tile before answering", "The observed tile has not changed", ""]);
  expect(attachments(3)).toContain(`data:image/png;base64,${image}`);
  expect(bodies).toHaveLength(4);
});
