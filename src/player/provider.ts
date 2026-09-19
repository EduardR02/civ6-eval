import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { calculateCost, createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type ImageContent, type Message, type Model, type SimpleStreamOptions, type TextContent, type Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Content, PlayerOptions } from "../contracts.ts";
import { COMPACTION_INSTRUCTIONS, COMPACTION_REQUEST, emptyUsage } from "./native.ts";
import { ELIDED_IMAGE_TEXT, elision, resolveRequestLimits, serializedBytes, type Elision, type ResolvedLimits } from "./limits.ts";
import { journal, loadJson, privateDirectory, saveJson } from "./storage.ts";

interface ProviderState {
  version: 1;
  messages: Message[];
  seenInputs: string[];
  tools: Record<string, { name: string; args: unknown; status: "authorized" | "started" | "completed" }>;
  inputTokens: number;
  /** Leading messages already handed to the transport. Anything above this index is fresh: it has
   * never been sent, so no budget may elide the screenshots it carries. */
  sentMessages?: number;
  inFlight?: { id: string; kind: string };
}
const unknownOutcome = "Execution outcome UNKNOWN after interruption. This call was not replayed. Inspect fresh observable state before deciding whether to perform any further action.";
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function reportedUsage(value: unknown, model: Model<Api>): Usage | undefined {
  if (!value || typeof value !== "object" || !("prompt_tokens" in value) || !("completion_tokens" in value)) return undefined;
  const raw = value as Record<string, unknown>;
  const input = raw.prompt_tokens;
  const output = raw.completion_tokens;
  const prompt = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object" ? raw.prompt_tokens_details as Record<string, unknown> : {};
  const completion = raw.completion_tokens_details && typeof raw.completion_tokens_details === "object" ? raw.completion_tokens_details as Record<string, unknown> : {};
  const cacheRead = prompt.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0;
  const cacheWrite = prompt.cache_write_tokens ?? 0;
  const reasoning = completion.reasoning_tokens ?? 0;
  if (typeof input !== "number" || typeof output !== "number" || typeof cacheRead !== "number" || typeof cacheWrite !== "number" || typeof reasoning !== "number") return undefined;
  if (![input, output, cacheRead, cacheWrite, reasoning].every(count => Number.isSafeInteger(count) && count >= 0) || cacheRead + cacheWrite > input || reasoning > output) return undefined;
  const totalTokens = input + output;
  if (!Number.isSafeInteger(totalTokens) || (raw.total_tokens !== undefined && raw.total_tokens !== totalTokens)) return undefined;
  const usage: Usage = { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite, reasoning, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  calculateCost(model, usage);
  return usage;
}

/** Observe only usage frames while passing original bytes to Pi unchanged. Pi's
 * zero-filled Usage cannot distinguish omitted counters from a reported zero.
 * `before` runs at the exact transport boundary — after the SDK built the complete body, before any
 * byte leaves — and receives that body's UTF-8 size when it is directly measurable. */
function usageTransport(transport: typeof fetch, observe: (value: unknown) => void, status: (value: number) => void, before?: (bytes: number | undefined) => void): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (before) {
      const payload = init?.body;
      before(typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload instanceof Uint8Array ? payload.byteLength : payload instanceof ArrayBuffer ? payload.byteLength : undefined);
    }
    const response = await transport(input, init);
    status(response.status);
    if (!response.ok || !response.body) return response;
    const decoder = new TextDecoder();
    let pending = "";
    const consume = (text: string) => {
      pending += text;
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(pending);
        if (!boundary) break;
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed && typeof parsed === "object" && "usage" in parsed && parsed.usage !== null) observe(parsed.usage);
      }
    };
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { consume(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
      flush() { consume(decoder.decode() + "\n\n"); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return Object.assign(wrapped, { preconnect: transport.preconnect });
}

/** Chat Completions carries image parts only inside user and tool-result content arrays. */
function imageContent(message: Message): (TextContent | ImageContent)[] | undefined {
  if (message.role === "toolResult") return message.content;
  if (message.role === "user" && Array.isArray(message.content)) return message.content;
  return undefined;
}

/** The exact image data URL of a converted part, or undefined when the part is not a recognized
 * image shape. Only recognized shapes are ever eligible for replacement, so an unrecognized
 * provider conversion keeps its images and is bounded by the exact byte refusal instead. */
function wireImagePayload(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const value = part as Record<string, unknown>;
  if (value.type === "image_url" && value.image_url && typeof value.image_url === "object") {
    const url = (value.image_url as Record<string, unknown>).url;
    if (typeof url === "string" && url.includes(";base64,")) return url;
  }
  if (value.type === "image" && value.source && typeof value.source === "object") {
    const source = value.source as Record<string, unknown>;
    if (typeof source.data === "string" && typeof source.media_type === "string") return `data:${source.media_type};base64,${source.data}`;
  }
  return undefined;
}

/** Pi's provider SDK owns wire/image/reasoning conversion. This ledger owns recovery,
 * tool authorization and compacted replay; the append-only journal retains original history. */
export class ProviderCompletions {
  private state: ProviderState;
  private readonly path: string;
  private readonly logPath: string;
  private readonly seen: Set<string>;
  private readonly fresh: boolean;
  private readonly limits: ResolvedLimits;
  private sentMessages: number;
  private blocked = false;

  constructor(private readonly id: string, private readonly options: PlayerOptions, private readonly streamFunction: AgentSession["agent"]["streamFunction"], private readonly model: Model<Api>, private readonly reserveCall: (kind: string, requestId: string) => void, private readonly accountUsage: (usage: Usage, kind: string, requestId: string) => void) {
    const directory = join(options.runDir, "player", "agents", id);
    privateDirectory(directory);
    this.path = join(directory, "provider.json");
    this.logPath = join(directory, "provider.jsonl");
    const saved = loadJson<ProviderState>(this.path);
    this.fresh = !saved;
    this.state = saved ?? { version: 1, messages: [], seenInputs: [], tools: {}, inputTokens: 0 };
    if (this.state.version !== 1) throw new Error("Unsupported provider ledger version");
    this.seen = new Set(this.state.seenInputs);
    this.limits = resolveRequestLimits(options, model);
    this.append({ kind: "request_limits", model: this.model.id, provider: this.model.provider, limits: this.limits, origin: options.requestLimits === undefined ? "measured route cap, if any" : "explicit run configuration" });
    // A ledger written before this boundary existed, or one whose last append was never dispatched,
    // has no provable sent prefix: a tool result is saved the moment it is produced, so it can be
    // durable here and still have never reached the provider. Unknown stays protected; the first
    // dispatch sets the boundary.
    this.sentMessages = Math.min(this.state.sentMessages ?? 0, this.state.messages.length);
    if (this.state.inFlight) {
      this.append({ kind: "interrupted_request", request: this.state.inFlight, outcome: "unknown; not replayed" });
      delete this.state.inFlight;
    }
    this.recoverUnanswered();
    this.save();
  }

  private append(value: unknown): void {
    try { journal(this.logPath, value); }
    catch (error) { this.blocked = true; throw error; }
  }
  private save(): void {
    this.state.seenInputs = [...this.seen];
    this.state.sentMessages = this.sentMessages;
    try { saveJson(this.path, this.state); }
    catch (error) { this.blocked = true; throw error; }
  }

  /** One-time migration of earlier Pi-only runs. Old calls are never newly authorized. */
  importHistory(messages: Message[]): void {
    if (!this.fresh || !messages.length) return;
    for (const message of messages) {
      if (message.role === "assistant") {
        if (message.stopReason === "error" || message.stopReason === "aborted") continue;
        this.acceptAssistant(message);
      } else if (message.role === "user") this.ingest({ messages: [message] });
      else if (Object.hasOwn(this.state.tools, message.toolCallId)) this.toolResult(message.toolCallId, message.content, message.isError);
    }
    // Pi's transcript is not proof of dispatch: its tail can hold results from a run that died
    // before its next request. The boundary stays where it was, so imported captures are protected
    // until this ledger actually sends them.
    this.recoverUnanswered();
    this.save();
  }

  recoverUnanswered(): void {
    for (const [toolId, tool] of Object.entries(this.state.tools)) {
      if (tool.status !== "completed") this.toolResult(toolId, [{ type: "text", text: unknownOutcome }], true);
    }
  }

  executionStarted(toolId: string, args: unknown): void {
    const tool = Object.hasOwn(this.state.tools, toolId) ? this.state.tools[toolId] : undefined;
    if (this.blocked || !tool || tool.status !== "authorized" || hash(args) !== hash(tool.args)) throw new Error("Tool execution lacks an unconsumed durable provider authorization; no replay is permitted");
    tool.status = "started";
    this.append({ kind: "execution_started", toolId, outcome: "unknown until durable tool_result" });
    this.save();
  }

  toolResult(toolId: string, content: Content[], isError = false): void {
    const tool = Object.hasOwn(this.state.tools, toolId) ? this.state.tools[toolId] : undefined;
    if (!tool) throw new Error("Tool result has no durable provider call identity");
    if (tool.status === "completed") return;
    const message: Message = { role: "toolResult", toolCallId: toolId, toolName: tool.name, content, isError, timestamp: Date.now() };
    this.state.messages.push(message);
    tool.status = "completed";
    this.append({ kind: "tool_result", message });
    this.save();
  }

  private acceptAssistant(message: AssistantMessage): void {
    const identities = new Set<string>();
    for (const part of message.content) if (part.type === "toolCall") {
      if (Object.hasOwn(this.state.tools, part.id) || identities.has(part.id)) throw new Error("Provider reused a durable tool identity; refusing duplicate execution");
      identities.add(part.id);
    }
    for (const part of message.content) if (part.type === "toolCall") {
      Object.defineProperty(this.state.tools, part.id, { value: { name: part.name, args: part.arguments, status: "authorized" }, enumerable: true, configurable: true, writable: true });
    }
    this.state.messages.push(message);
    this.append({ kind: "assistant", message });
    this.save();
  }

  private ingest(context: Context): void {
    for (const message of context.messages) {
      if (message.role === "assistant") continue;
      if (message.role === "toolResult") {
        this.toolResult(message.toolCallId, message.content, message.isError);
        continue;
      }
      const key = hash(message);
      if (this.seen.has(key)) continue;
      this.state.messages.push(message);
      this.seen.add(key);
      this.append({ kind: "input", message });
    }
    this.save();
  }

  /** Positions of the images this ledger has already handed to the transport, oldest first, with
   * `part` as the index inside the message's content array — the same meaning the native ledger and
   * the elision record use. A result appended after the last dispatched request is excluded: the
   * model must see it once before any budget may take its screenshots away. */
  private sentImages(): { message: number; part: number; material: string; bytes: number; mimeType: string }[] {
    const slots: { message: number; part: number; material: string; bytes: number; mimeType: string }[] = [];
    for (let message = 0; message < this.sentMessages; message++) {
      const content = imageContent(this.state.messages[message]!);
      if (!content) continue;
      for (let part = 0; part < content.length; part++) {
        const current = content[part]!;
        if (current.type !== "image") continue;
        slots.push({ message, part, material: JSON.stringify(current), bytes: serializedBytes(current), mimeType: current.mimeType });
      }
    }
    return slots;
  }

  /** Replaces the oldest `count` of `slots` with explicit omission markers. Image-bearing messages
   * are copied rather than mutated because Pi keeps its own transcript objects; this ledger's
   * append-only journal stays the record of the original captures, and the record names each
   * removed capture by position and digest. */
  private elideImages(slots: readonly { message: number; part: number; material: string; bytes: number; mimeType: string }[], count: number, record: { kind: string } & Record<string, unknown>): void {
    if (!count) return;
    const removed = new Set(slots.slice(0, count).map(slot => `${slot.message}:${slot.part}`));
    const originals: Elision[] = [];
    const replace = (message: number, content: (TextContent | ImageContent)[]) => {
      if (!content.some(part => part.type === "image")) return undefined;
      let changed = false;
      const replaced = content.map((current, position) => {
        if (current.type !== "image" || !removed.has(`${message}:${position}`)) return current;
        originals.push(elision(message, position, JSON.stringify(current), serializedBytes(current), current.mimeType));
        changed = true;
        return { type: "text" as const, text: ELIDED_IMAGE_TEXT };
      });
      return changed ? replaced : undefined;
    };
    this.state.messages = this.state.messages.map((message, index) => {
      if (message.role === "user" && Array.isArray(message.content)) {
        const content = replace(index, message.content);
        return content ? { ...message, content } : message;
      }
      if (message.role === "toolResult") {
        const content = replace(index, message.content);
        return content ? { ...message, content } : message;
      }
      return message;
    });
    journal(this.logPath, { ...record, elided: originals.length, originals });
    this.save();
  }

  /** Old screenshots age out under the same policy as the native ledger, from the same resolved
   * limits: crossing the trigger rewrites the replay view once, replacing every already-sent image
   * above the retained watermark, and the tail from the first marker stays byte-stable until the
   * next purge. Between purges the ledger only appends, so the provider can reuse its prefix cache
   * byte-for-byte. A route with no measured cap and no configured limit is left alone, and a cap
   * that freshness alone exceeds is refused rather than sent.
   */
  private enforceImageBudget(): void {
    const { maxImages, retainedImages } = this.limits;
    if (maxImages === undefined || retainedImages === undefined) return;
    let total = 0;
    for (const message of this.state.messages) for (const part of imageContent(message) ?? []) if (part.type === "image") total++;
    if (total <= maxImages) return;
    const slots = this.sentImages();
    const count = Math.min(total - retainedImages, slots.length);
    if (total - count > maxImages) {
      const unsent = total - slots.length;
      this.append({ kind: "request_refused", operation: "completions", reason: "request images exceed requestLimits.maxImages", images: total, maxImages, unsent });
      throw new Error(`Refusing to send this request: it carries ${total} images, above the ${maxImages}-image cap in force for this run (requestLimits.maxImages or a measured route cap), and the newest ${unsent} have not been sent yet so they cannot be elided. Nothing was sent and no capture was dropped; raise the limit or reduce the run's history.`);
    }
    this.elideImages(slots, count, { kind: "image_budget", remaining: total - count, retainedImages });
  }

  /** Occurrences of the captures the provider has already received, in ledger order and grouped by
   * their exact data URL. The same payload can appear many times — an unchanged view re-displayed is
   * common — so a wire part consumes the oldest matching occurrence, and when no occurrence is left
   * that part is a capture this run has never sent and must not be touched. */
  private eligibleImages(): Map<string, { message: number; part: number; image: ImageContent }[]> {
    const eligible = new Map<string, { message: number; part: number; image: ImageContent }[]>();
    for (let message = 0; message < this.sentMessages; message++) {
      const content = imageContent(this.state.messages[message]!);
      if (!content) continue;
      for (let part = 0; part < content.length; part++) {
        const current = content[part]!;
        if (current.type !== "image") continue;
        const occurrence = { message, part, image: current };
        const known = eligible.get(`data:${current.mimeType};base64,${current.data}`);
        if (known) known.push(occurrence);
        else eligible.set(`data:${current.mimeType};base64,${current.data}`, [occurrence]);
      }
    }
    return eligible;
  }

  /** Caps one request against the configured byte limit on the payload the SDK actually built, which
   * is the only place its true size exists. Already-received screenshots are replaced in that payload
   * — never in the ledger, which keeps every original and its pairing — and each replacement is
   * matched by its exact image payload, so a fresh result can never be touched. When even that leaves
   * the payload over the limit, the request is refused before transport: nothing is sent, no call is
   * reserved, and the ledger is untouched.
   */
  private capWirePayload(operation: "completions" | "compact", payload: unknown, limit: number): void {
    if (!payload || typeof payload !== "object") return;
    const carrier = payload as Record<string, unknown>;
    const messages = carrier.messages;
    if (!Array.isArray(messages)) return;
    const eligible = this.eligibleImages();
    if (!eligible.size) return;
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (bytes <= limit) return;
    const markerBytes = serializedBytes({ type: "text", text: ELIDED_IMAGE_TEXT });
    const originals: Elision[] = [];
    let freed = 0;
    for (let position = 0; position < messages.length && bytes - freed > limit; position++) {
      const message = messages[position];
      if (!message || typeof message !== "object") continue;
      const source = message as Record<string, unknown>;
      if (!Array.isArray(source.content)) continue;
      const content = source.content;
      let replaced: unknown[] | undefined;
      for (let index = 0; index < content.length; index++) {
        const part = content[index]!;
        const identity = wireImagePayload(part);
        if (identity === undefined) continue;
        const eligibleImage = eligible.get(identity)?.shift();
        if (!eligibleImage) continue;
        originals.push(elision(eligibleImage.message, eligibleImage.part, JSON.stringify(eligibleImage.image), serializedBytes(eligibleImage.image), eligibleImage.image.mimeType));
        freed += serializedBytes(part) - markerBytes;
        replaced ??= content.slice();
        replaced[index] = { type: "text", text: ELIDED_IMAGE_TEXT };
        if (bytes - freed <= limit) break;
      }
      // Copy on write: the converted message can share its array with the ledger, so only this
      // payload's own copy of it is ever changed.
      if (replaced) messages[position] = { ...source, content: replaced };
    }
    // The record's `bytes` is the payload size after these replacements, as both ledgers report it.
    if (originals.length) this.append({ kind: "byte_budget", operation, elided: originals.length, bytes: bytes - freed, limit, originals });
    if (bytes - freed > limit) this.refuseOversize(operation, bytes - freed);
  }

  /** Refuses an oversized request before transport. Nothing was sent and nothing was reserved, so
   * the outcome is known rather than unknown and no request is ever replayed. */
  private refuseOversize(operation: string, bytes: number, requestId?: string): never {
    const limit = this.limits.maxBytes!;
    this.append({ kind: "request_refused", requestId, operation, reason: "request exceeds requestLimits.maxBytes", bytes, limit });
    throw new Error(`Refusing to send this ${operation} request: its payload is ${bytes} UTF-8 bytes, above the configured requestLimits.maxBytes of ${limit}, after replacing every already-sent screenshot it could. Nothing was sent, no capture was dropped, and no tool call was replayed; raise the limit or reduce the run's history.`);
  }

  /** Durable admission for exactly one request, committed at the moment its complete body is about
   * to be handed to the transport: the run's call ceiling, the in-flight record and the sent
   * boundary. A request refused locally never reaches this point, so it costs no call and marks
   * nothing as sent. */
  private admit(kind: "completions" | "compact", requestId: string): void {
    this.reserveCall(kind, requestId);
    this.state.inFlight = { id: requestId, kind };
    this.append({ kind: "request", requestId, operation: kind, model: this.model.id, provider: this.model.provider });
    this.sentMessages = this.state.messages.length;
    this.save();
  }

  private async request(kind: "completions" | "compact", context: Context, options: SimpleStreamOptions, forward?: (event: AssistantMessageEvent) => void): Promise<AssistantMessage> {
    if (this.blocked) throw new Error("Provider persistence failed; refusing further requests or execution");
    options.signal?.throwIfAborted();
    const requestId = randomUUID();
    let outcome = "failed";
    let usageReported = false;
    let httpStatus: number | undefined;
    let refused: number | undefined;
    let refusal: unknown;
    let admission: unknown;
    let admitted = false;
    try {
      // Admission is deliberately not here: the SDK still has to build the body, so admission (call
      // ceiling, durable request identity, sent boundary) commits in the transport callback below,
      // once that body exists. A request refused or failed before that point costs no call and marks
      // nothing as sent, and its model_end is withheld because no model_call was ever emitted.
      let usage: Usage | undefined;
      const limit = this.limits.maxBytes;
      const transport = usageTransport(options.fetch ?? fetch, value => { usage = reportedUsage(value, this.model); }, status => { httpStatus = status; }, bytes => {
        if (admitted) return;
        if (limit !== undefined && bytes !== undefined && bytes > limit) {
          refused = bytes;
          throw new Error("serialized request exceeds requestLimits.maxBytes");
        }
        try { this.admit(kind, requestId); }
        catch (error) { admission = error; throw error; }
        admitted = true;
      });
      // The byte cap is applied to the payload the SDK actually built, and it runs *before* any
      // pre-existing payload hook: the replacement matches wire parts to already-received captures by
      // payload and occurrence order, which only the SDK's own conversion preserves. A later hook may
      // reorder or drop images freely — it can no longer make a never-sent capture look received —
      // and the transport guard still measures exactly what goes out.
      const priorPayload = options.onPayload;
      const onPayload = async (payload: unknown, model: Model<Api>) => {
        if (limit !== undefined) {
          try { this.capWirePayload(kind, payload, limit); }
          catch (error) { refusal = error; throw error; }
        }
        const replaced = await priorPayload?.(payload, model);
        return replaced === undefined ? payload : replaced;
      };
      const stream = await this.streamFunction(this.model, context, { ...options, fetch: transport, maxRetries: 0, onPayload });
      for await (const event of stream) {
        if (event.type !== "done" && event.type !== "error") { forward?.(event); continue; }
        const message = event.type === "done" ? event.message : event.error;
        if (usage) {
          message.usage = usage;
          this.accountUsage(usage, kind, requestId);
          usageReported = true;
          this.append({ kind: "usage", requestId, usage });
          this.state.inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        }
        if (event.type === "error") {
          outcome = event.reason === "aborted" ? "cancelled" : "failed";
          // Neither a payload nor a transport refusal reached the provider: nothing was sent, so
          // nothing was marked sent and nothing may be replayed.
          if (refusal !== undefined) throw refusal;
          if (refused !== undefined) this.refuseOversize(kind, refused, requestId);
          if (admission !== undefined) throw admission;
          // Provider diagnostics can echo request headers; retain no arbitrary error body.
          throw new Error(`${this.model.provider} ${kind} ${httpStatus === undefined ? "transport" : `HTTP ${httpStatus}`} ${outcome}; usage ${usageReported ? "reported" : "UNKNOWN"}. No automatic retry was performed.`);
        }
        outcome = message.stopReason === "length" ? "incomplete" : "completed";
        return message;
      }
      throw new Error("Provider stream ended without a terminal result; usage UNKNOWN");
    } finally {
      delete this.state.inFlight;
      try {
        this.append({ kind: "request_end", requestId, outcome, admitted, httpStatus, usage: usageReported ? "reported" : "unknown" });
        this.save();
      } finally {
        // Usage accounting pairs model_end with a reserved model_call; an unadmitted request never
        // had one and spent nothing, so it must not report an end.
        if (admitted) this.options.onEvent?.({ type: "model_end", agentId: this.id, requestId, at: new Date().toISOString(), data: { kind, outcome, usage: usageReported ? "reported" : "unknown" } });
      }
    }
  }

  private async compact(context: Context, options: SimpleStreamOptions): Promise<void> {
    const threshold = Math.min(this.options.compactThreshold ?? 180000, this.model.contextWindow - this.model.maxTokens);
    if (this.state.inputTokens < threshold || !this.state.messages.length) return;
    // The run's own instructions lead this request, so a summary extends the prompt prefix the
    // agent was already sending instead of replacing its head with the summary instructions. The
    // ask rides at the tail, where it cannot shift anything already sent, and there are no tools:
    // a summary request must not be able to call anything. The ask stays transient; only the
    // ledger's durable messages persist. The byte cap is applied to the payload the SDK builds for
    // this request too, exactly as for an ordinary one.
    const summary = await this.request("compact", {
      systemPrompt: context.systemPrompt,
      messages: [...this.state.messages, { role: "user", content: [{ type: "text", text: COMPACTION_INSTRUCTIONS }, { type: "text", text: COMPACTION_REQUEST }], timestamp: Date.now() }],
    }, options);
    const text = summary.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
    if (summary.stopReason !== "stop" || !text || summary.content.some(part => part.type === "toolCall")) throw new Error("Compaction did not produce a complete text summary; original history retained");
    this.append({ kind: "compaction", original: this.state.messages, summary });
    this.state.messages = [{ role: "user", content: `Earlier conversation summary (original history retained in the private provider journal):\n${text}`, timestamp: Date.now() }];
    this.state.inputTokens = 0;
    // The replacement was never sent: it is fresh until a later request dispatches it.
    this.sentMessages = 0;
    this.save();
    this.options.onEvent?.({ type: "compaction", agentId: this.id, at: new Date().toISOString(), data: { provider: this.model.provider } });
  }

  stream(context: Context, options: SimpleStreamOptions = {}) {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        // Bound images and summarize the completed old conversation before this request's new
        // inputs are added: neither rewrite may be driven by, or explode with, old screenshots.
        this.enforceImageBudget();
        await this.compact(context, options);
        this.ingest(context);
        this.enforceImageBudget();
        const message = await this.request("completions", { ...context, messages: this.state.messages }, options, event => output.push(event));
        // A length-truncated reply cannot authorize even apparently complete tool calls.
        if (message.stopReason !== "stop" && message.stopReason !== "toolUse") throw new Error("Provider reply incomplete; tool execution was not authorized");
        this.acceptAssistant(message);
        output.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        const aborted = options.signal?.aborted;
        const message: AssistantMessage = { role: "assistant", api: this.model.api, provider: this.model.provider, model: this.model.id, content: [], usage: emptyUsage(), stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
        output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      } finally { output.end(); }
    })();
    return output;
  }
}
