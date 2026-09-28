export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Arguments = Record<string, unknown>;
export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Default reasoning effort for model profiles without an explicit configured or run override. */
export function defaultReasoningEffort(model?: string): "high" | "max" {
  return model === "gpt-6-luna" ? "max" : "high";
}

/** Explicit provider transport and presentation limits for one configured run. */
export interface RequestLimits {
  maxImages?: number;
  retainedImages?: number;
  maxBytes?: number;
}

export function validateRequestLimits(value: unknown): asserts value is RequestLimits | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("requestLimits must be an object");
  const limits = value as Record<string, unknown>;
  for (const key of Object.keys(limits)) {
    if (key !== "maxImages" && key !== "retainedImages" && key !== "maxBytes") throw new Error(`Unknown requestLimits key: ${key}`);
  }
  for (const key of ["maxImages", "retainedImages", "maxBytes"] as const) {
    const current = limits[key];
    if (current !== undefined && (typeof current !== "number" || !Number.isSafeInteger(current) || current <= 0)) throw new Error(`requestLimits.${key} must be a positive integer`);
  }
  if (limits.retainedImages !== undefined && limits.maxImages === undefined) throw new Error("requestLimits.retainedImages requires maxImages");
  if (limits.retainedImages !== undefined && limits.maxImages !== undefined && (limits.retainedImages as number) > (limits.maxImages as number)) {
    throw new Error("requestLimits.retainedImages cannot exceed maxImages");
  }
}

export type PlayerContent = Content;
export interface ExecutionResult { content: Content[]; isError?: boolean; artifacts?: string[] }
export interface ExecuteOptions { timeoutMs?: number; signal?: AbortSignal }
export type AgentRpc = (agentId: string, method: string, args: Arguments) => Promise<unknown>;
export interface ExecutionOptions {
  projectRoot: string;
  runDir: string;
  rpc: AgentRpc;
  distro?: string;
}
export interface DesktopOptions { projectRoot: string; pythonPath: string }
export interface BridgeOptions { host?: string; port?: number; timeoutMs?: number }
export interface PlayerEvent {
  type: string;
  agentId: string;
  requestId?: string;
  at?: string;
  text?: string;
  data?: unknown;
}
/**
 * How an operator-dispatched task ends. `response` ends it when the model stops calling
 * tools, which is the right contract for one-shot analyses and children. `explicit` requires
 * the model to declare an outcome through the finish_task tool, so a progress report can
 * never silently end a running game.
 */
export type CompletionMode = "response" | "explicit";
export type TaskOutcome = "completed" | "blocked" | "protocol_failure" | "unfinished";
/** Durable record of the last concluded dispatch on one agent, written only in explicit mode. */
export interface TaskRecord {
  /** Dispatch identity; a declaration never carries over to a later dispatch. */
  dispatch: string;
  outcome: TaskOutcome;
  /** Declared evidence or blocker, or the harness diagnostic for a protocol failure. */
  reason: string;
  /** True when the bounded protocol reminder was sent for this dispatch. */
  repair: boolean;
  at: string;
}
export interface PlayerOptions {
  projectRoot: string;
  runDir: string;
  model?: string;
  provider?: "openai" | "codex" | "opencode-go";
  apiKey?: string;
  authPath?: string;
  baseUrl?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxConcurrentAgents?: number;
  maxModelCalls?: number;
  compactThreshold?: number;
  /** Transport and presentation limits for this run. Absent means each ledger applies only a
   * measured cap for its own route (see player/limits.ts); an unmeasured route keeps its history. */
  requestLimits?: RequestLimits;
  /** Supplied external reference for the expert-informed knowledge track. Absent on an uncoached
   * run. Given only to the main player; children receive bounded tasks, not the whole document. */
  expertGuide?: string;
  /** Defaults to "response": generic players and children end when the model stops. */
  completionMode?: CompletionMode;
  execute: (agentId: string, code: string, options?: ExecuteOptions) => Promise<ExecutionResult>;
  rpc: AgentRpc;
  onEvent?: (event: PlayerEvent) => void;
}
