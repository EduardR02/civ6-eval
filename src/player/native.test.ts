import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PlayerOptions } from "../contracts.ts";
import { ELIDED_IMAGE_TEXT } from "./limits.ts";
import { NativeResponses, emptyUsage } from "./native.ts";
import { saveJson } from "./storage.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(fetch: (request: Request) => Response | Promise<Response>, getAuth: () => Promise<unknown> = async () => ({ auth: { apiKey: "fixture-only" } }), modelOverrides: Partial<Model<Api>> = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "civ-native-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  cleanups.push(() => { server.stop(true); rmSync(runDir, { recursive: true, force: true }); });
  const model: Model<Api> = { id: "fixture", name: "Fixture", api: "openai-responses", provider: "openai", baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: true, input: ["text", "image"], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...modelOverrides };
  const path = join(runDir, "player", "agents", "main", "native.json");
  const create = (options: Partial<PlayerOptions> = {}) => new NativeResponses("main", { runDir, projectRoot: process.cwd(), provider: "openai", compactThreshold: 100, rpc: async () => ({}), execute: async () => ({ content: [] }), ...options }, { getAuth } as unknown as ModelRuntime, model, () => {}, () => {});
  return { create, path, runDir };
}

/** A ledger whose captures were all handed to the provider already, one item each. The boundary is
 * declared explicitly: an unset boundary means "no provable sent prefix" and protects everything. */
function ledgerOf(labels: string[]) {
  const parts = labels.map(label => ({ type: "input_image", image_url: `data:image/png;base64,${label}`, detail: "original" }));
  return {
    parts,
    state: { version: 1, items: labels.map((_, index) => ({ role: "user", content: [{ type: "input_text", text: `capture ${index}` }, parts[index]!] })), seenInputs: [], completedCalls: [], inputTokens: 0, compactions: 0, totalUsage: emptyUsage(), sentItems: labels.length },
  };
}

/** The same ledger with no recorded boundary: what a file written before the field existed, or one
 * whose last tool result never reached the provider, looks like when it is resumed. */
function ledgerWithoutBoundary(labels: string[]) {
  const { parts, state } = ledgerOf(labels);
  const { sentItems: _boundary, ...unbounded } = state;
  return { parts, state: unbounded };
}

/** Image data URLs the transport actually carried, in ledger order. */
function sentImages(items: unknown[]): string[] {
  const urls: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const parts = "content" in item && Array.isArray(item.content) ? item.content : "output" in item && Array.isArray(item.output) ? item.output : [];
    for (const part of parts) {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "input_image" || !("image_url" in part)) continue;
      urls.push(String(part.image_url));
    }
  }
  return urls;
}

function nativeJournal(runDir: string): Record<string, unknown>[] {
  return readFileSync(join(runDir, "player", "agents", "main", "native.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
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

test("request journal records only newly appended items, not the whole input each call", async () => {
  const { create, runDir } = fixture(() => sse([{ type: "response.completed", response: { status: "completed", output: [] } }]));
  const native = create();
  const first = { role: "user" as const, content: "first observation", timestamp: 1 };
  const second = { role: "user" as const, content: "second observation", timestamp: 2 };
  expect((await native.stream({ messages: [first] }).result()).stopReason).toBe("stop");
  expect((await native.stream({ messages: [first, second] }).result()).stopReason).toBe("stop");
  const requests = readFileSync(join(runDir, "player", "agents", "main", "native.jsonl"), "utf8")
    .trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(entry => entry.kind === "request");
  expect(requests).toHaveLength(2);
  // The second call must not re-journal the first turn: that squared the log with run length.
  expect(requests[1]!.appendedFrom).toBe(requests[0]!.items);
  expect(JSON.stringify(requests[1]!.appended)).not.toContain("first observation");
  expect(JSON.stringify(requests[1]!.appended)).toContain("second observation");
  // The envelope still reports the true request size so accounting stays auditable.
  expect(requests[1]!.items).toBeGreaterThan(requests[0]!.items as number);
  expect(requests[1]!.bytes).toBeGreaterThan(0);
});

test("request journal reports true UTF-8 sizes, not UTF-16 code-unit counts", async () => {
  const received: Buffer[] = [];
  const { create, runDir } = fixture(async request => {
    received.push(Buffer.from(await request.arrayBuffer()));
    return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
  });
  const native = create();
  const systemPrompt = "Rôle — 東 · café ☕";
  const unicode = "Florence → (30, 28) · café — 東京都";
  expect((await native.stream({ systemPrompt, messages: [{ role: "user", content: unicode, timestamp: 1 }] }).result()).stopReason).toBe("stop");
  const requests = readFileSync(join(runDir, "player", "agents", "main", "native.jsonl"), "utf8")
    .trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(entry => entry.kind === "request");
  expect(requests).toHaveLength(1);
  // The recorded size must equal the bytes actually uploaded, so transport accounting and any
  // later prefix audit are not skewed by multi-byte content (UTF-16 length used to undercount).
  expect(requests[0]!.bytes).toBe(received[0]!.byteLength);
  expect(requests[0]!.bytes).toBeGreaterThan(received[0]!.toString("utf8").length);
  expect(requests[0]!.instructionsBytes).toBe(Buffer.byteLength(systemPrompt, "utf8"));
  expect(requests[0]!.instructionsBytes).toBeGreaterThan(systemPrompt.length);
});

/** Image retention is a per-route policy: the measured cap belongs to Muse's Responses route, and
 * an unmeasured route (Astra or DeepSeek today) keeps its history unless the operator sets one. */
test("the measured Muse route bounds its own screenshots without configuration", async () => {
  const bodies: { input: unknown[] }[] = [];
  const { create, path, runDir } = fixture(async request => {
    bodies.push(await request.json() as { input: unknown[] });
    return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
  }, undefined, { id: "muse-spark-1.3-contributor", provider: "opencode-go" });
  const { state } = ledgerOf(Array.from({ length: 50 }, (_, index) => `shot-${index}`));
  saveJson(path, state);
  expect((await create().stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect(sentImages(bodies[0]!.input)).toHaveLength(5);
  expect(nativeJournal(runDir).filter(entry => entry.kind === "image_budget")).toMatchObject([{ elided: 45, remaining: 5, retainedImages: 5 }]);
});

test("a route with no measured cap keeps every capture when no limit is configured", async () => {
  const bodies: { input: unknown[] }[] = [];
  const { create, path, runDir } = fixture(async request => {
    bodies.push(await request.json() as { input: unknown[] });
    return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
  });
  const { state } = ledgerOf(Array.from({ length: 50 }, (_, index) => `shot-${index}`));
  saveJson(path, state);
  expect((await create().stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect(sentImages(bodies[0]!.input)).toHaveLength(50);
  expect(nativeJournal(runDir).filter(entry => entry.kind === "image_budget" || entry.kind === "byte_budget")).toHaveLength(0);
});

test("a purge keeps fresh tool screenshots and only replaces captures the provider already saw", async () => {
  const bodies: { input: unknown[] }[] = [];
  const { create, path, runDir } = fixture(async request => {
    bodies.push(await request.json() as { input: unknown[] });
    return bodies.length === 1
      ? sse([{ type: "response.output_item.added", output_index: 0, item: call }, { type: "response.output_item.done", output_index: 0, item: call }, { type: "response.completed", response: { status: "completed", output: [] } }])
      : sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
  });
  const { parts, state } = ledgerOf(Array.from({ length: 15 }, (_, index) => `old-${index}`));
  saveJson(path, state);
  const native = create({ requestLimits: { maxImages: 20, retainedImages: 5 } });
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("toolUse");
  native.toolResult("call_fixture|fc_fixture", Array.from({ length: 6 }, (_, index) => ({ type: "image", data: `fresh-${index}`, mimeType: "image/png" })));
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("stop");
  // Fifteen captures had already been sent, so the watermark may age them out; the six the model
  // has never seen are exactly what the next request carries, with their tool identity intact.
  expect(sentImages(bodies[0]!.input)).toEqual(parts.map(part => part.image_url));
  expect(sentImages(bodies[1]!.input)).toEqual(Array.from({ length: 6 }, (_, index) => `data:image/png;base64,fresh-${index}`));
  const identities = bodies[1]!.input as { type?: string; call_id?: string }[]; // fixture server parsed this body
  expect(identities.filter(item => item.call_id === "call_fixture").map(item => item.type)).toEqual(["function_call", "function_call_output"]);
  const budget = nativeJournal(runDir).find(entry => entry.kind === "image_budget")!;
  expect(budget).toMatchObject({ elided: 15, remaining: 6, retainedImages: 5 });
  // Every replaced capture is named by position and digest, so the original stays locatable in the
  // append-only journal even though the replayed view no longer carries its bytes.
  const originals = budget.originals as { position: number; part: number; sha256: string }[]; // written by this ledger
  expect(originals).toHaveLength(15);
  expect(originals[0]).toMatchObject({ position: 0, part: 1 });
  expect(originals[0]!.sha256).toBe(createHash("sha256").update(JSON.stringify(parts[0])).digest("hex"));
  const rewritten = JSON.parse(readFileSync(path, "utf8")) as { items: unknown[] }; // durable native ledger
  expect(sentImages(rewritten.items)).toHaveLength(6);
});

test("a configured byte cap replaces the oldest already-sent captures instead of failing", async () => {
  const sent: { bytes: number; input: unknown[] }[] = [];
  const { create, path, runDir } = fixture(async request => {
    const raw = Buffer.from(await request.arrayBuffer());
    const body = JSON.parse(raw.toString("utf8")) as { input: unknown[] }; // fixture server parsed this body
    sent.push({ bytes: raw.byteLength, input: body.input });
    return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
  });
  const { parts, state } = ledgerOf(Array.from({ length: 6 }, (_, index) => `${"A".repeat(3000)}${index}`));
  saveJson(path, state);
  expect((await create({ requestLimits: { maxBytes: 9000 } }).stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect(sent[0]!.bytes).toBeLessThanOrEqual(9000);
  // Oldest first, and only whole image parts: the surviving captures are the newest ones, still in
  // their original order, and the bytes the provider receives stay under the configured cap.
  const carried = sentImages(sent[0]!.input);
  expect(carried.length).toBeGreaterThan(0);
  expect(carried).toEqual(parts.slice(-carried.length).map(part => part.image_url));
  expect(JSON.stringify(sent[0]!.input)).toContain(ELIDED_IMAGE_TEXT);
  const budget = nativeJournal(runDir).find(entry => entry.kind === "byte_budget")!;
  expect(budget.elided).toBe(6 - carried.length);
  const originals = budget.originals as { position: number; sha256: string }[]; // written by this ledger
  expect(originals.map(original => original.position)).toEqual(parts.slice(0, originals.length).map((_, index) => index));
  expect(originals[0]!.sha256).toBe(createHash("sha256").update(JSON.stringify(parts[0])).digest("hex"));
});

test("an unsatisfiable byte cap refuses before transport and never reports an unknown outcome", async () => {
  let requests = 0;
  const { create, path, runDir } = fixture(() => { requests++; return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]); });
  const { parts, state } = ledgerOf([`${"A".repeat(200)}0`]);
  saveJson(path, state);
  const result = await create({ requestLimits: { maxBytes: 300 } }).stream({ systemPrompt: "S".repeat(1000), messages: [] }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("requestLimits.maxBytes");
  expect(requests).toBe(0);
  const stored = JSON.parse(readFileSync(path, "utf8")) as { inFlight?: unknown; sentItems?: number; items: unknown[] }; // durable native ledger
  expect(stored.inFlight).toBeUndefined();
  // A refusal dispatches nothing, so it must not advance the sent boundary either.
  expect(stored.sentItems).toBe(1);
  // An unsatisfiable limit costs nothing: the capture is still in the ledger, not replaced by a
  // marker, because no rewrite can bring this request under the cap.
  expect(sentImages(stored.items)).toEqual(parts.map(part => part.image_url));
  expect(nativeJournal(runDir).filter(entry => entry.kind === "request_refused")).toHaveLength(1);
  const rewrites = nativeJournal(runDir).filter(entry => entry.kind === "byte_budget" || entry.kind === "image_budget");
  expect(rewrites).toHaveLength(0);
  expect(nativeJournal(runDir).filter(entry => entry.kind === "request")).toHaveLength(0);
  // A restart must not read the refusal as an interrupted request whose outcome is unknown.
  create();
  expect(nativeJournal(runDir).filter(entry => entry.kind === "interrupted_request")).toHaveLength(0);
});

test("a ledger with no recorded sent boundary refuses rather than evicting or exceeding the cap", async () => {
  let requests = 0;
  const { create, path, runDir } = fixture(() => { requests++; return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]); }, undefined, { id: "muse-spark-1.3-contributor", provider: "opencode-go" });
  // A tool result is durable the moment it is produced, so a ledger can hold captures the provider
  // has never seen. Without a persisted boundary there is no provable sent prefix, so nothing here
  // may be elided — and because that evidence alone exceeds the cap, the request is refused instead
  // of sent: the provider never sees an over-cap request and no capture is dropped.
  const { state } = ledgerWithoutBoundary(Array.from({ length: 50 }, (_, index) => `shot-${index}`));
  saveJson(path, state);
  const result = await create().stream({ messages: [] }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("requestLimits.maxImages");
  expect(requests).toBe(0);
  const stored = JSON.parse(readFileSync(path, "utf8")) as { sentItems?: number; items: unknown[] };
  expect(stored.sentItems).toBe(0);
  expect(sentImages(stored.items)).toHaveLength(50);
  const refusals = nativeJournal(runDir).filter(entry => entry.kind === "request_refused");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toMatchObject({ images: 50, maxImages: 45, unsent: 50 });
  expect(nativeJournal(runDir).filter(entry => entry.kind === "image_budget")).toHaveLength(0);
});

test("a dispatch establishes the boundary so later captures age out and fresh ones survive", async () => {
  const bodies: { input: unknown[] }[] = [];
  const { create, path, runDir } = fixture(async request => {
    bodies.push(await request.json() as { input: unknown[] });
    return bodies.length === 1
      ? sse([{ type: "response.output_item.added", output_index: 0, item: call }, { type: "response.output_item.done", output_index: 0, item: call }, { type: "response.completed", response: { status: "completed", output: [] } }])
      : sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
  });
  // Fifteen captures without a recorded boundary, under a cap they fit: the first request carries
  // them all, and that dispatch is what makes them eligible on the next one.
  const { state } = ledgerWithoutBoundary(Array.from({ length: 15 }, (_, index) => `old-${index}`));
  saveJson(path, state);
  const native = create({ requestLimits: { maxImages: 20, retainedImages: 5 } });
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("toolUse");
  expect(sentImages(bodies[0]!.input)).toHaveLength(15);
  expect(nativeJournal(runDir).filter(entry => entry.kind === "image_budget")).toHaveLength(0);
  native.toolResult("call_fixture|fc_fixture", Array.from({ length: 6 }, (_, index) => ({ type: "image", data: `fresh-${index}`, mimeType: "image/png" })));
  expect((await native.stream({ messages: [] }).result()).stopReason).toBe("stop");
  expect(sentImages(bodies[1]!.input)).toEqual(Array.from({ length: 6 }, (_, index) => `data:image/png;base64,fresh-${index}`));
  expect(nativeJournal(runDir).filter(entry => entry.kind === "image_budget")).toMatchObject([{ elided: 15, remaining: 6 }]);
});
