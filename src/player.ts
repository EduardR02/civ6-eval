import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { Arguments, PlayerOptions } from "./contracts.ts";
import { playerPrompt } from "./prompts.ts";
import { createRuntime } from "./player/auth.ts";
import { emptyUsage, NativeResponses } from "./player/native.ts";
import { ProviderCompletions } from "./player/provider.ts";
import { journal, loadJson, privateDirectory, saveJson } from "./player/storage.ts";

type Status = "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";
interface SavedAgent {
  id: string;
  parentId?: string;
  name: string;
  status: Status;
  sessionFile?: string;
  text: string;
  artifacts: string[];
  error?: string;
  calls: number;
  compactionCalls: number;
  usage: Usage;
  pendingMessages: string[];
  activeMessages?: string[];
}
interface AgentRecord extends SavedAgent {
  session?: AgentSession;
  native?: NativeResponses;
  provider?: ProviderCompletions;
  run?: Promise<void>;
  controller?: AbortController;
  lease?: boolean;
  waitingFor: Set<string>;
}
interface Registry { version: 1; calls: number; agents: SavedAgent[] }
interface SlotWaiter { record: AgentRecord; signal: AbortSignal; resolve: () => void; reject: (reason: Error) => void; abort: () => void }

function requiredText(args: Arguments, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a nonempty string`);
  return value;
}
function validId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Agent ids must be 1–80 letters, numbers, underscores or hyphens");
  return id;
}
function abortError(): Error { return new Error("Agent operation cancelled; interrupted actions have unknown outcome"); }

/** Pi owns the prompt/tool loop. The native adapter owns lossless provider context; the
 * registry owns scheduling and recovery. Restart never queues any old task automatically.
 */
export class Player {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly directory: string;
  private readonly registryPath: string;
  private readonly limit: number;
  private readonly ready: Promise<void>;
  private runtime!: ModelRuntime;
  private model!: Model<Api>;
  private calls = 0;
  private active = 0;
  private readonly slotWaiters: SlotWaiter[] = [];
  private closed = false;
  private aborting = false;

  constructor(private readonly options: PlayerOptions) {
    this.limit = options.maxConcurrentAgents ?? 4;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error("maxConcurrentAgents must be a positive integer");
    if (options.maxModelCalls !== undefined && (!Number.isSafeInteger(options.maxModelCalls) || options.maxModelCalls < 1)) throw new Error("maxModelCalls must be a positive integer");
    if (options.compactThreshold !== undefined && (!Number.isFinite(options.compactThreshold) || options.compactThreshold <= 0)) throw new Error("compactThreshold must be a positive token count");
    this.directory = join(options.runDir, "player");
    this.registryPath = join(this.directory, "agents.json");
    privateDirectory(this.directory);
    const saved = loadJson<Registry>(this.registryPath);
    if (saved && saved.version !== 1) throw new Error("Unsupported player registry version");
    this.calls = saved?.calls ?? 0;
    for (const agent of saved?.agents ?? []) {
      validId(agent.id);
      const native = loadJson<{ totalUsage?: Usage }>(join(this.directory, "agents", agent.id, "native.json"));
      const interrupted = ["running", "waiting", "queued"].includes(agent.status);
      this.agents.set(agent.id, { ...agent, usage: native?.totalUsage ?? agent.usage, status: interrupted ? "interrupted" : agent.status, error: interrupted ? "Process stopped during execution; outcome unknown. No actions were replayed." : agent.error, waitingFor: new Set(), pendingMessages: agent.pendingMessages ?? [] });
    }
    if (!this.agents.has("main")) this.agents.set("main", this.newRecord("main", "Main"));
    this.persist();
    this.ready = this.initialize();
    // Construction is synchronous; prompt/rpc expose initialization errors without an unhandled rejection.
    void this.ready.catch(() => {});
  }

  private async initialize(): Promise<void> {
    const { runtime, model } = await createRuntime(this.options);
    this.runtime = runtime;
    this.model = model;
  }

  private newRecord(id: string, name: string, parentId?: string): AgentRecord {
    return { id, name, parentId, status: "idle", text: "", artifacts: [], calls: 0, compactionCalls: 0, usage: emptyUsage(), waitingFor: new Set(), pendingMessages: [] };
  }

  private saved(record: AgentRecord): SavedAgent {
    const { id, parentId, name, status, sessionFile, text, artifacts, error, calls, compactionCalls, usage, pendingMessages, activeMessages } = record;
    return { id, parentId, name, status, sessionFile, text, artifacts, error, calls, compactionCalls, usage, pendingMessages, activeMessages };
  }

  private result(record: AgentRecord): Omit<SavedAgent, "sessionFile"> {
    const { sessionFile: _privatePath, ...result } = this.saved(record);
    return result;
  }

  private persist(): void {
    saveJson(this.registryPath, { version: 1, calls: this.calls, agents: [...this.agents.values()].map(agent => this.saved(agent)) } satisfies Registry);
  }

  private emit(type: string, record: AgentRecord, text?: string, data?: unknown, requestId?: string): void {
    this.options.onEvent?.({ type, agentId: record.id, text, data, requestId, at: new Date().toISOString() });
  }

  private record(id: string): AgentRecord {
    const agent = this.agents.get(validId(id));
    if (!agent) throw new Error(`Unknown agent ${id}`);
    return agent;
  }

  private acquire(record: AgentRecord, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (record.lease) return Promise.resolve();
    if (this.active < this.limit) {
      this.active++;
      record.lease = true;
      return Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter: SlotWaiter = { record, signal, resolve, reject, abort: () => {
      const index = this.slotWaiters.indexOf(waiter);
      if (index >= 0) this.slotWaiters.splice(index, 1);
      reject(abortError());
    } };
    this.slotWaiters.push(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
    return promise;
  }

  private release(record: AgentRecord): void {
    if (!record.lease) return;
    record.lease = false;
    this.active--;
    while (this.active < this.limit && this.slotWaiters.length) {
      const waiter = this.slotWaiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(abortError()); continue; }
      waiter.record.lease = true;
      this.active++;
      waiter.resolve();
    }
  }

  private async session(record: AgentRecord): Promise<AgentSession> {
    if (record.session) return record.session;
    const directory = join(this.directory, "agents", record.id);
    const workspace = join(this.options.runDir, "workspaces", record.id);
    privateDirectory(directory);
    privateDirectory(workspace);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, images: { autoResize: false, blockImages: false }, packages: [], extensions: [], skills: [], prompts: [], enableSkillCommands: false, enableAnalytics: false, enableInstallTelemetry: false });
    const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: playerPrompt(record.id, record.parentId) });
    await resourceLoader.reload();
    const sessionManager = record.sessionFile ? SessionManager.open(record.sessionFile, directory, workspace) : SessionManager.create(workspace, directory);
    const nativeLedger = this.model.api === "openai-responses" || this.model.api === "openai-codex-responses";
    const reserveCall = (kind: string, requestId?: string): void => {
      if (this.options.maxModelCalls !== undefined && this.calls >= this.options.maxModelCalls) throw new Error(`Run model-call budget (${this.options.maxModelCalls}) exhausted; no request was sent.`);
      this.calls++;
      record.calls++;
      if (kind === "compact") record.compactionCalls++;
      this.persist();
      this.emit("model_call", record, undefined, { calls: record.calls, totalCalls: this.calls, kind, model: this.model.id, provider: this.model.provider }, requestId);
    };
    const accountUsage = (usage: Usage, kind: string, requestId?: string): void => {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const) record.usage[key] = (record.usage[key] ?? 0) + (usage[key] ?? 0);
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) record.usage.cost[key] += usage.cost[key];
      this.persist();
      this.emit("usage", record, undefined, { usage, total: record.usage, kind }, requestId);
    };
    if (nativeLedger) record.native = new NativeResponses(record.id, this.options, this.runtime, this.model, reserveCall, accountUsage);
    const { session } = await createAgentSession({
      cwd: workspace, agentDir: directory, modelRuntime: this.runtime, model: this.model,
      thinkingLevel: this.options.effort ?? (this.model.provider === "opencode-go" ? "high" : "xhigh"),
      settingsManager, resourceLoader, sessionManager, tools: ["exec_py"],
      customTools: [{
        name: "exec_py", label: "Python", description: "Execute arbitrary Python in your persistent sandbox. Use display(image) to see images; rpc and agent helpers access game, artifacts, history and same-model subagents. Code may perform real game actions; errors/interruption are never automatically retried.",
        parameters: Type.Object({ code: Type.String({ description: "Python code; persistent globals, top-level await supported" }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800000 })) }),
        executionMode: "sequential",
        execute: async (toolId, params, signal) => {
          if (!params || typeof params !== "object" || !("code" in params) || typeof params.code !== "string") throw new Error("exec_py requires a code string");
          const timeoutMs = "timeoutMs" in params && typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
          const ledger = record.native ?? record.provider!;
          ledger.executionStarted(toolId, params);
          const combined = AbortSignal.any([signal ?? new AbortController().signal, record.controller?.signal ?? new AbortController().signal]);
          try {
            const result = await this.options.execute(record.id, params.code, { timeoutMs, signal: combined });
            ledger.toolResult(toolId, result.content);
            for (const name of result.artifacts ?? []) if (!record.artifacts.includes(name)) record.artifacts.push(name);
            this.persist();
            if (result.isError) throw new Error(result.content.filter(part => part.type === "text").map(part => part.text).join("\n") || "Python execution failed; see the durable native tool result.");
            return { content: result.content, details: { isError: result.isError ?? false, artifacts: result.artifacts ?? [] } };
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            ledger.toolResult(toolId, [{ type: "text", text: `Execution failed: ${text}. Any interrupted side effect has UNKNOWN outcome; inspect state before repeating.` }]);
            throw error;
          }
        },
      }],
    });
    record.session = session;
    record.sessionFile = sessionManager.getSessionFile();
    if (!nativeLedger) record.provider = new ProviderCompletions(record.id, this.options, session.agent.streamFunction, this.model, reserveCall, accountUsage);
    // Both paths own durable request and execution identity; Pi owns tool orchestration.
    if (record.provider) record.provider.importHistory(await session.agent.convertToLlm(session.state.messages));
    session.agent.streamFunction = (_model, context, streamOptions) => (record.native ?? record.provider!).stream(context, streamOptions);
    session.agent.toolExecution = "sequential";
    session.agent.state.systemPrompt = playerPrompt(record.id, record.parentId);
    session.subscribe(event => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") this.emit("text", record, event.assistantMessageEvent.delta);
      else if (event.type === "tool_execution_start") this.emit("tool_start", record, event.toolName, { toolCallId: event.toolCallId });
      else if (event.type === "tool_execution_end") this.emit("tool_end", record, event.toolName, { toolCallId: event.toolCallId, isError: event.isError });
    });
    this.persist();
    return session;
  }

  private start(record: AgentRecord, text: string): Promise<void> {
    if (record.run) throw new Error(`Agent ${record.id} already has an active run`);
    record.pendingMessages.push(text);
    record.status = "queued";
    record.error = undefined;
    record.text = "";
    record.controller = new AbortController();
    const signal = record.controller.signal;
    this.persist();
    journal(join(this.directory, "tasks.jsonl"), { kind: "task", agentId: record.id, text });
    const run = (async () => {
      try {
        if (this.options.maxModelCalls !== undefined && this.calls >= this.options.maxModelCalls) throw new Error(`Run model-call budget (${this.options.maxModelCalls}) exhausted; no request was sent.`);
        await this.acquire(record, signal);
        const session = await this.session(record);
        signal.throwIfAborted();
        (record.native ?? record.provider!).recoverUnanswered();
        record.status = "running";
        this.persist();
        this.emit("agent_start", record);
        do {
          signal.throwIfAborted();
          // Dispatched mail is durable but is never replayed after failure/restart:
          // its prompt may already have caused actions with an unknown outcome.
          record.activeMessages = record.pendingMessages.splice(0);
          this.persist();
          journal(join(this.directory, "tasks.jsonl"), { kind: "dispatch", agentId: record.id, messages: record.activeMessages });
          await session.prompt(record.activeMessages.join("\n\n"), { expandPromptTemplates: false });
          const last = session.state.messages.findLast(message => message.role === "assistant");
          if (last?.role === "assistant") {
            record.text = last.content.filter(part => part.type === "text").map(part => part.text).join("\n");
            if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage ?? last.stopReason);
          }
          record.activeMessages = undefined;
          this.persist();
          const listed = await this.options.rpc(record.id, "artifact.list", { prefix: `${record.id}/` });
          if (!listed || typeof listed !== "object" || !("files" in listed) || !Array.isArray(listed.files) || !listed.files.every(name => typeof name === "string")) throw new Error("artifact.list returned invalid files metadata");
          for (const name of listed.files) if (!record.artifacts.includes(name)) record.artifacts.push(name);
          signal.throwIfAborted();
          // A send accepted during prompt completion or artifact listing belongs
          // to this run, and must drain before releasing its scheduler lease.
        } while (record.pendingMessages.length);
        record.status = "completed";
        this.emit("agent_complete", record, record.text, { artifacts: record.artifacts });
      } catch (error) {
        record.status = signal.aborted ? "interrupted" : "failed";
        record.error = error instanceof Error ? error.message : String(error);
        this.emit("agent_error", record, record.error);
        throw error;
      } finally {
        this.release(record);
        record.waitingFor.clear();
        record.run = undefined;
        this.persist();
      }
    })();
    record.run = run;
    // Child failures remain observable via wait/list/events, not process-level rejection noise.
    void run.catch(() => {});
    return run;
  }

  async prompt(text: string): Promise<void> {
    await this.ready;
    this.assertOpen();
    if (!text.trim()) throw new Error("Prompt must not be empty");
    const main = this.record("main");
    if (main.run) {
      main.pendingMessages.push(text);
      this.persist();
      return;
    }
    await this.start(main, text);
  }

  private assertOpen(): void {
    if (this.closed || this.aborting) throw new Error("Player is closed or aborting");
  }

  private canReach(from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of this.record(from).waitingFor) if (this.canReach(next, target, seen)) return true;
    return false;
  }

  private async wait(caller: AgentRecord, args: Arguments): Promise<unknown> {
    let ids: string[];
    if (args.ids !== undefined) {
      if (!Array.isArray(args.ids) || !args.ids.every(id => typeof id === "string")) throw new Error("ids must be an array of agent ids");
      ids = args.ids;
    } else if (args.id !== undefined) ids = [requiredText(args, "id")];
    else ids = [...this.agents.values()].filter(agent => agent.parentId === caller.id).map(agent => agent.id);
    ids = [...new Set(ids)];
    const targets = ids.map(id => this.record(id));
    for (const target of targets) if (this.canReach(target.id, caller.id)) throw new Error(`Cyclic agent wait rejected: ${caller.id} -> ${target.id}`);
    if (caller.waitingFor.size) throw new Error("An agent may have only one active wait operation");
    const timeout = args.timeoutMs === undefined ? 60000 : args.timeoutMs;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > 1800000) throw new Error("timeoutMs must be between 0 and 1800000");
    const hadLease = !!caller.lease;
    const oldStatus = caller.status;
    const signal = caller.controller?.signal ?? new AbortController().signal;
    for (const id of ids) caller.waitingFor.add(id);
    if (hadLease) { caller.status = "waiting"; this.release(caller); this.persist(); }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) throw abortError();
      const deadline = Promise.withResolvers<void>();
      timer = setTimeout(deadline.resolve, timeout);
      const cancellation = Promise.withResolvers<never>();
      onAbort = () => cancellation.reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      await Promise.race([
        Promise.all(targets.map(target => target.run ?? Promise.resolve())),
        deadline.promise,
        cancellation.promise,
      ]);
      const failed = targets.find(target => target.status === "failed" || target.status === "interrupted");
      if (failed) throw new Error(`Agent ${failed.id} ${failed.status}: ${failed.error}`);
      return targets.map(target => this.result(target));
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      caller.waitingFor.clear();
      if (hadLease && !signal.aborted) {
        await this.acquire(caller, signal);
        caller.status = oldStatus;
      }
      this.persist();
    }
  }

  /** Only agent.* dispatch lives here. All other RPC belongs to the parent host. */
  async rpc(agentId: string, method: string, args: Arguments): Promise<unknown> {
    await this.ready;
    this.assertOpen();
    const caller = this.record(agentId);
    if (method === "agent.list" || method === "agent.status") return { totalCalls: this.calls, active: this.active, maxConcurrentAgents: this.limit, agents: [...this.agents.values()].map(agent => this.result(agent)) };
    if (method === "agent.spawn") {
      const task = requiredText(args, "task");
      const name = args.name === undefined ? "Analyst" : requiredText(args, "name");
      const id = `agent_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const child = this.newRecord(id, name, caller.id);
      this.agents.set(id, child);
      this.persist();
      void this.start(child, task).catch(() => {});
      return { id, name, status: child.status, parentId: caller.id };
    }
    if (method === "agent.send") {
      const target = this.record(requiredText(args, "id"));
      const message = requiredText(args, "message");
      if (target.run) {
        target.pendingMessages.push(message);
        this.persist();
      } else void this.start(target, message).catch(() => {});
      journal(join(this.directory, "tasks.jsonl"), { kind: "send", from: caller.id, to: target.id, message });
      return { id: target.id, status: target.status, pendingMessages: target.pendingMessages.length };
    }
    if (method === "agent.wait") return this.wait(caller, args);
    if (method === "agent.cancel") {
      const target = this.record(requiredText(args, "id"));
      if (caller.id !== "main" && target.parentId !== caller.id) throw new Error("Only main or the direct parent may cancel an agent");
      target.controller?.abort();
      target.session?.agent.abort();
      return { id: target.id, cancellationRequested: true };
    }
    throw new Error(`Unknown agent RPC method ${method}`);
  }

  async abort(): Promise<void> {
    this.aborting = true;
    try {
      for (const record of this.agents.values()) {
        record.controller?.abort();
        record.session?.agent.clearAllQueues();
        record.session?.agent.abort();
      }
      const runs = [...this.agents.values()].flatMap(record => record.run ? [record.run] : []);
      const deadline = Promise.withResolvers<boolean>();
      const timer = setTimeout(() => deadline.resolve(false), 10000);
      const settled = await Promise.race([
        Promise.allSettled(runs).then(() => true),
        deadline.promise,
      ]);
      clearTimeout(timer);
      if (!settled) throw new Error("Cancellation exceeded 10 seconds; execution host must terminate remaining Python workers before this player can be reused");
    } finally {
      this.persist();
      this.aborting = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.abort(); }
    finally { for (const record of this.agents.values()) record.session?.dispose(); }
  }
}
