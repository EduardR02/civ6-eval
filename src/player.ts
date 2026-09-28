import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, defineTool, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { defaultReasoningEffort, type Arguments, type PlayerOptions, type TaskRecord } from "./contracts.ts";
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
  task?: TaskRecord;
}
/** An explicit-mode declaration. It describes this dispatch's end, not the agent's history. */
interface Declaration { status: "completed" | "blocked"; reason: string; at: string }
/** State belongs to one dispatch; completion prevents any later tool execution. */
interface DispatchState {
  id: string;
  declaration?: Declaration;
  repair?: boolean;
  executionFailure?: string;
}
interface AgentRecord extends SavedAgent {
  session?: AgentSession;
  native?: NativeResponses;
  provider?: ProviderCompletions;
  run?: Promise<TaskRecord | undefined>;
  controller?: AbortController;
  lease?: boolean;
  dispatch?: DispatchState;
  waitingFor: Set<string>;
}
interface Registry { version: 1; calls: number; agents: SavedAgent[] }
interface SlotWaiter { record: AgentRecord; signal: AbortSignal; resolve: () => void; reject: (reason: Error) => void; abort: () => void }

const FINISH_TOOL = "finish_task";
const MAX_TASK_REASON_BYTES = 8 * 1024;
/**
 * Explicit mode replaces "the model stopped talking" with a declaration. The bounded reminder
 * exists once per dispatch: it can have the model continue or declare, but it can never turn
 * an omission into a completion, and it is never repeated.
 */
const TASK_PROTOCOL = `End this task with ${FINISH_TOOL}: status="completed" when the requested goal is achieved, or status="blocked" when further progress needs operator input or an external blocker cleared. Include concise observed evidence or the exact blocker in reason (under 8 KB).
This records your declaration, not an independently verified outcome. Later calls in the same reply will not execute. A progress report is not completion: an undeclared final receives one reminder, then stops as a protocol failure. Unresolved execution errors suppress that reminder; reobserve uncertain effects before choosing recovery. A separate context-summary request does not require ${FINISH_TOOL}.`;
const PROTOCOL_REPAIR = `[harness protocol] You ended your turn without declaring the current task's outcome, so it is still open. Continue working, or declare now with ${FINISH_TOOL} (status "completed" or "blocked", with reason). This is the single protocol reminder for this task: one more turn without a declaration stops the run as an explicit protocol failure.`;

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
/** The declaration reason is persisted in the registry on every request, so bound it loudly. */
function boundedReason(reason: string): string {
  if (Buffer.byteLength(reason, "utf8") <= MAX_TASK_REASON_BYTES) return reason;
  const marker = `\n… [declaration truncated to ${MAX_TASK_REASON_BYTES} bytes; keep long reports in an artifact and name it in the reason]`;
  const cut = Buffer.from(reason, "utf8").subarray(0, MAX_TASK_REASON_BYTES - Buffer.byteLength(marker, "utf8")).toString("utf8");
  return `${cut.endsWith("\uFFFD") ? cut.slice(0, -1) : cut}${marker}`;
}

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
  private rotateCodexAccount?: (failedAccountId: string, retryAfterMs?: number) => boolean;
  private calls = 0;
  private active = 0;
  private readonly slotWaiters: SlotWaiter[] = [];
  private readonly explicitMode: boolean;
  private closed = false;
  private aborting = false;

  constructor(private readonly options: PlayerOptions) {
    this.limit = options.maxConcurrentAgents ?? 4;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error("maxConcurrentAgents must be a positive integer");
    if (options.maxModelCalls !== undefined && (!Number.isSafeInteger(options.maxModelCalls) || options.maxModelCalls < 1)) throw new Error("maxModelCalls must be a positive integer");
    if (options.compactThreshold !== undefined && (!Number.isFinite(options.compactThreshold) || options.compactThreshold <= 0)) throw new Error("compactThreshold must be a positive token count");
    if (options.completionMode !== undefined && options.completionMode !== "response" && options.completionMode !== "explicit") throw new Error('completionMode must be "response" or "explicit"');
    this.explicitMode = options.completionMode === "explicit";
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
    const { runtime, model, rotateCodexAccount, startupAccountSwitched } = await createRuntime(this.options);
    this.runtime = runtime;
    this.model = model;
    this.rotateCodexAccount = rotateCodexAccount;
    if (startupAccountSwitched) this.options.onEvent?.({ type: "account_switch", agentId: "main", text: "Pinned Codex subscription unavailable; switched to another OMP account", at: new Date().toISOString() });
  }

  private newRecord(id: string, name: string, parentId?: string): AgentRecord {
    return { id, name, parentId, status: "idle", text: "", artifacts: [], calls: 0, compactionCalls: 0, usage: emptyUsage(), waitingFor: new Set(), pendingMessages: [] };
  }

  private saved(record: AgentRecord): SavedAgent {
    const { id, parentId, name, status, sessionFile, text, artifacts, error, calls, compactionCalls, usage, pendingMessages, activeMessages, task } = record;
    return { id, parentId, name, status, sessionFile, text, artifacts, error, calls, compactionCalls, usage, pendingMessages, activeMessages, task };
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


  private recordTask(record: AgentRecord, task: TaskRecord): void {
    record.task = task;
    this.persist();
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
    // The declaration protocol is part of the session's base system prompt, so every dispatched
    // turn carries it; a harness summarization request without tools can never satisfy or trip it.
    const explicit = this.explicitMode && !record.parentId;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, images: { autoResize: false, blockImages: false }, packages: [], extensions: [], skills: [], prompts: [], enableSkillCommands: false, enableAnalytics: false, enableInstallTelemetry: false });
    const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: playerPrompt(record.id, record.parentId, record.parentId ? undefined : this.options.expertGuide), appendSystemPrompt: explicit ? [TASK_PROTOCOL] : undefined });
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
    if (nativeLedger) record.native = new NativeResponses(record.id, this.options, this.runtime, this.model, reserveCall, accountUsage, this.rotateCodexAccount);
    /** A declaration is durable provider bookkeeping first and a recorded outcome second: a
     * failed ledger write must never be laundered into a completed task. */
    const finishTask = defineTool({
      name: FINISH_TOOL,
      label: "Finish task",
      description: "Declare the outcome of the task you were dispatched: completed when its goal is achieved or its requested work is done, blocked when you cannot continue without operator input or an external blocker. The reason is the durable record of what you verified or what stops you. Ends the turn; further tool calls are not part of the declaration.",
      parameters: Type.Object({
        status: Type.Unsafe<"completed" | "blocked">({ type: "string", enum: ["completed", "blocked"], description: '"completed" for an achieved goal or finished work; "blocked" when progress needs the operator or an external blocker must clear' }),
        reason: Type.String({ description: "Durable evidence for completed (turn, game state, artifact names) or the exact blocker and what you need; under 8 KB" }),
      }),
      executionMode: "sequential",
      execute: async (toolId, params) => {
        const dispatch = record.dispatch;
        if (!dispatch) throw new Error("No task is dispatched right now; finish_task is only valid while a task is running");
        if (params.status !== "completed" && params.status !== "blocked") throw new Error('finish_task status must be "completed" or "blocked"');
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!reason) throw new Error("finish_task requires a nonempty reason describing the verified outcome or the blocker");
        const declared = boundedReason(reason);
        const content = [{ type: "text" as const, text: `${params.status === "completed" ? "Task declared completed" : "Task declared blocked"} for the current dispatch; the turn ends here and this declaration is recorded durably. reason: ${declared}` }];
        const ledger = record.native ?? record.provider!;
        ledger.executionStarted(toolId, params);
        ledger.toolResult(toolId, content);
        dispatch.declaration = { status: params.status, reason: declared, at: new Date().toISOString() };
        this.persist();
        return { content, details: { dispatch: dispatch.id, status: params.status }, terminate: true };
      },
    });
    const { session } = await createAgentSession({
      cwd: workspace, agentDir: directory, modelRuntime: this.runtime, model: this.model,
      thinkingLevel: this.options.effort ?? defaultReasoningEffort(this.model.id),
      settingsManager, resourceLoader, sessionManager, tools: explicit ? ["exec_py", FINISH_TOOL] : ["exec_py"],
      customTools: [{
        name: "exec_py", label: "Python", description: "Execute arbitrary Python in your persistent sandbox. Use display(image) to see images; rpc and agent helpers access game, artifacts, history and same-model subagents. Code may perform real game actions; errors/interruption are never automatically retried.",
        parameters: Type.Object({ code: Type.String({ description: "Python code; persistent globals, top-level await supported" }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800000 })) }),
        executionMode: "sequential",
        execute: async (toolId, params, signal) => {
          if (!params || typeof params !== "object" || !("code" in params) || typeof params.code !== "string") throw new Error("exec_py requires a code string");
          const timeoutMs = "timeoutMs" in params && typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
          const ledger = record.native ?? record.provider!;
          ledger.executionStarted(toolId, params);
          if (record.dispatch?.declaration) {
            const content = [{ type: "text" as const, text: "Not executed: this dispatch already declared its outcome through finish_task." }];
            ledger.toolResult(toolId, content);
            return { content, details: { executed: false }, terminate: true };
          }
          const combined = AbortSignal.any([signal ?? new AbortController().signal, record.controller?.signal ?? new AbortController().signal]);
          try {
            const result = await this.options.execute(record.id, params.code, { timeoutMs, signal: combined });
            if (record.provider) record.provider.toolResult(toolId, result.content, result.isError);
            else record.native!.toolResult(toolId, result.content);
            for (const name of result.artifacts ?? []) if (!record.artifacts.includes(name)) record.artifacts.push(name);
            this.persist();
            if (result.isError) throw new Error(result.content.filter(part => part.type === "text").map(part => part.text).join("\n") || "Python execution failed; see the durable native tool result.");
            if (record.dispatch) delete record.dispatch.executionFailure;
            return { content: result.content, details: { isError: result.isError ?? false, artifacts: result.artifacts ?? [] } };
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (record.dispatch) record.dispatch.executionFailure = boundedReason(text);
            const content = [{ type: "text" as const, text: `Execution failed: ${text}. Any interrupted side effect has UNKNOWN outcome; inspect state before repeating.` }];
            if (record.provider) record.provider.toolResult(toolId, content, true);
            else record.native!.toolResult(toolId, content);
            throw error;
          }
        },
      }, ...(explicit ? [finishTask] : [])],
    });
    record.session = session;
    record.sessionFile = sessionManager.getSessionFile();
    if (!nativeLedger) record.provider = new ProviderCompletions(record.id, this.options, session.agent.streamFunction, this.model, reserveCall, accountUsage);
    // Both paths own durable request and execution identity; Pi owns tool orchestration.
    if (record.provider) record.provider.importHistory(await session.agent.convertToLlm(session.state.messages));
    let archivedSystemPrompt: string | undefined;
    session.agent.streamFunction = (_model, context, streamOptions) => {
      const systemPrompt = context.systemPrompt ?? "";
      if (systemPrompt !== archivedSystemPrompt) {
        const input = { systemPrompt, tools: context.tools ?? [], model: this.model.id, provider: this.model.provider, effort: this.options.effort };
        const sha256 = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const file = `inputs/${sha256}.json`;
        saveJson(join(directory, file), input);
        journal(join(directory, "inputs.jsonl"), { kind: "system_prompt", sha256, file });
        archivedSystemPrompt = systemPrompt;
      }
      return (record.native ?? record.provider!).stream(context, streamOptions);
    };
    session.agent.toolExecution = "sequential";
    session.subscribe(event => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") this.emit("text", record, event.assistantMessageEvent.delta);
      else if (event.type === "tool_execution_start") this.emit("tool_start", record, event.toolName, { toolCallId: event.toolCallId });
      else if (event.type === "tool_execution_end") this.emit("tool_end", record, event.toolName, { toolCallId: event.toolCallId, isError: event.isError });
    });
    this.persist();
    return session;
  }

  private start(record: AgentRecord, text: string): Promise<TaskRecord | undefined> {
    if (record.run) throw new Error(`Agent ${record.id} already has an active run`);
    record.pendingMessages.push(text);
    record.status = "queued";
    record.error = undefined;
    record.text = "";
    record.controller = new AbortController();
    const signal = record.controller.signal;
    this.persist();
    journal(join(this.directory, "tasks.jsonl"), { kind: "task", agentId: record.id, text });
    const explicit = this.explicitMode && !record.parentId;
    const run = (async (): Promise<TaskRecord | undefined> => {
      let task: TaskRecord | undefined;
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
          const dispatch: DispatchState = { id: randomUUID() };
          record.dispatch = dispatch;
          // Dispatched mail is durable but is never replayed after failure/restart:
          // its prompt may already have caused actions with an unknown outcome.
          record.activeMessages = record.pendingMessages.splice(0);
          this.persist();
          journal(join(this.directory, "tasks.jsonl"), { kind: "dispatch", agentId: record.id, dispatch: dispatch.id, messages: record.activeMessages });
          try {
            await this.turn(record, session, record.activeMessages.join("\n\n"));
            record.activeMessages = undefined;
            this.persist();
            if (explicit) await this.conclude(record, session, dispatch);
          } catch (error) {
            // A cancellation, provider failure, quota stop or tool failure ends a dispatch
            // without a declaration. It is never repaired, replayed, or recorded as completed.
            if (explicit && record.task?.dispatch !== dispatch.id) {
              const reason = error instanceof Error ? error.message : String(error);
              journal(join(this.directory, "tasks.jsonl"), { kind: "unfinished", agentId: record.id, dispatch: dispatch.id, reason });
              this.recordTask(record, { dispatch: dispatch.id, outcome: "unfinished", reason, repair: dispatch.repair ?? false, at: new Date().toISOString() });
            }
            throw error;
          } finally {
            record.dispatch = undefined;
          }
          if (explicit) task = record.task;
          const listed = await this.options.rpc(record.id, "artifact.list", { prefix: `${record.id}/` });
          if (!listed || typeof listed !== "object" || !("files" in listed) || !Array.isArray(listed.files) || !listed.files.every(name => typeof name === "string")) throw new Error("artifact.list returned invalid files metadata");
          for (const name of listed.files) if (!record.artifacts.includes(name)) record.artifacts.push(name);
          signal.throwIfAborted();
          // A send accepted during prompt completion or artifact listing belongs
          // to this run, and must drain before releasing its scheduler lease.
        } while (record.pendingMessages.length);
        record.status = "completed";
        this.emit("agent_complete", record, record.text, { artifacts: record.artifacts });
        return task;
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

  /** One model-facing turn. Pi owns the tool loop inside it; a provider failure, cancellation
   * or truncated reply surfaces here as a thrown error and is never retried or repaired. */
  private async turn(record: AgentRecord, session: AgentSession, text: string): Promise<void> {
    await session.prompt(text, { expandPromptTemplates: false });
    const last = session.state.messages.findLast(message => message.role === "assistant");
    if (last?.role === "assistant") {
      record.text = last.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage ?? last.stopReason);
    }
  }

  /**
   * The explicit-mode gate. A dispatch ends through its own declaration; a turn that merely
   * stops is answered with one bounded protocol reminder. A second undeclared turn is an
   * explicit protocol failure — never an implicit completion and never another reminder.
   */
  private async conclude(record: AgentRecord, session: AgentSession, dispatch: DispatchState): Promise<void> {
    if (!dispatch.declaration && dispatch.executionFailure) {
      throw new Error(`Task remains unfinished after an execution failure; no protocol reminder or replay was attempted: ${dispatch.executionFailure}`);
    }
    if (!dispatch.declaration) {
      dispatch.repair = true;
      journal(join(this.directory, "tasks.jsonl"), { kind: "protocol_repair", agentId: record.id, dispatch: dispatch.id });
      this.emit("protocol_repair", record, undefined, { dispatch: dispatch.id });
      await this.turn(record, session, PROTOCOL_REPAIR);
      this.persist();
    }
    const declaration = dispatch.declaration;
    if (!declaration) {
      const reason = `Explicit task protocol failure: ${record.id} ended two turns without a ${FINISH_TOOL} declaration. The task outcome is undeclared; the work may be incomplete.`;
      journal(join(this.directory, "tasks.jsonl"), { kind: "protocol_failure", agentId: record.id, dispatch: dispatch.id, reason });
      this.recordTask(record, { dispatch: dispatch.id, outcome: "protocol_failure", reason, repair: true, at: new Date().toISOString() });
      throw new Error(reason);
    }
    const task: TaskRecord = { dispatch: dispatch.id, outcome: declaration.status, reason: declaration.reason, repair: dispatch.repair ?? false, at: declaration.at };
    journal(join(this.directory, "tasks.jsonl"), { kind: "declare", agentId: record.id, ...task });
    this.recordTask(record, task);
    this.emit("task_outcome", record, undefined, task);
  }

  async prompt(text: string): Promise<TaskRecord | undefined> {
    await this.ready;
    this.assertOpen();
    if (!text.trim()) throw new Error("Prompt must not be empty");
    const main = this.record("main");
    if (main.run) {
      main.pendingMessages.push(text);
      this.persist();
      return undefined;
    }
    return this.start(main, text);
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
