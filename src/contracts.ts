export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Arguments = Record<string, unknown>;
export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

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
  execute: (agentId: string, code: string, options?: ExecuteOptions) => Promise<ExecutionResult>;
  rpc: AgentRpc;
  onEvent?: (event: PlayerEvent) => void;
}
