import { readFileSync, existsSync, appendFileSync, truncateSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PlayerEvent } from "./contracts.ts";
import { journal, privateDirectory } from "./player/storage.ts";

export interface ApiRates {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  longContextThreshold?: number;
  longContextInputMultiplier?: number;
  longContextOutputMultiplier?: number;
}
export interface TurnReference { gameId: string; playerId: number; turn: number; snapshotId?: string }
export interface UsageTokens { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; totalTokens: number }
export type RequestOutcome = "completed" | "incomplete" | "failed" | "cancelled" | "interrupted" | "unknown";
interface Pricing { model: string; rates: ApiRates | null; source: string | null; basis: "standard API-equivalent USD per million tokens" }
export interface UsageRequest {
  requestId: string;
  agentId: string;
  kind: string;
  provider: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: RequestOutcome;
  attribution: TurnReference | null;
  snapshotReference: TurnReference | null;
  tokens: UsageTokens | null;
  pricing: Pricing;
  estimatedUsd: number | null;
  longContext: boolean | null;
}
export interface UsageTotals {
  requests: number;
  reportedRequests: number;
  unreportedRequests: number;
  tokens: UsageTokens;
  estimatedUsd: number | null;
  knownEstimatedUsd: number;
  unpricedRequests: number;
}
export interface UsageReport {
  version: 1;
  summary: UsageTotals;
  turns: (UsageTotals & { gameId: string | null; playerId: number | null; turn: number | null })[];
  agents: (UsageTotals & { agentId: string })[];
  requests: UsageRequest[];
  notes: string[];
  actualSubscriptionCharge: null;
  imageTokens: "Included in input; separate breakout unavailable";
}
type LedgerEvent =
  | { version: 1; type: "observation"; agentId: string | null; reference: TurnReference }
  | { version: 1; type: "start"; request: UsageRequest }
  | { version: 1; type: "usage"; requestId: string; tokens: UsageTokens; estimatedUsd: number | null; longContext: boolean | null }
  | { version: 1; type: "end"; requestId: string; outcome: RequestOutcome; endedAt: string | null; durationMs: number | null };
const ASTRA_SOURCE = "https://developers.openai.com/api/docs/models/gpt-6-astra (verified 2026-09-08)";
const ASTRA_RATES: ApiRates = { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50, longContextThreshold: 272000, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5 };
const SOL_SOURCE = "https://developers.openai.com/api/docs/models/gpt-6-sol (verified 2026-09-22)";
const SOL_RATES: ApiRates = { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10, longContextThreshold: 272000, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5 };
const LUNA_SOURCE = "https://developers.openai.com/api/docs/models/gpt-6-luna (verified 2026-09-22)";
const LUNA_RATES: ApiRates = { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5, longContextThreshold: 272000, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5 };
const GLM_SOURCE = "@earendil-works/pi-ai 0.84.4 opencode-go catalog, glm-5.3-flash (verified 2026-09-08)";
const GLM_RATES: ApiRates = { input: 0.075, cachedInput: 0.015, cacheWrite: 0, output: 0.25 };
const MUSE_SOURCE = "@earendil-works/pi-ai 0.84.4 opencode-go catalog, muse-spark-1.3-contributor (verified 2026-09-09)";
const MUSE_RATES: ApiRates = { input: 0.1, cachedInput: 0.002, cacheWrite: 0, output: 0.2 };
const DEEPSEEK_SOURCE = "https://pi.dev/api/models/providers/opencode-go, deepseek-flash (verified 2026-09-10)";
const DEEPSEEK_RATES: ApiRates = { input: 0.15, cachedInput: 0.003, cacheWrite: 0, output: 0.6 };

export function validateApiRates(value: unknown): asserts value is ApiRates {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("apiRates must be an object");
  const rates = value as Record<string, unknown>;
  const required = ["input", "cachedInput", "cacheWrite", "output"];
  const optional = ["longContextThreshold", "longContextInputMultiplier", "longContextOutputMultiplier"];
  for (const key of Object.keys(rates)) if (![...required, ...optional].includes(key)) throw new Error(`Unknown apiRates key: ${key}`);
  for (const key of [...required, ...optional]) {
    const rate = rates[key];
    if (rate === undefined && optional.includes(key)) continue;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || (optional.includes(key) && rate === 0)) throw new Error(`apiRates.${key} must be a ${optional.includes(key) ? "positive" : "nonnegative"} finite number`);
  }
  if ((rates.longContextInputMultiplier !== undefined || rates.longContextOutputMultiplier !== undefined) && rates.longContextThreshold === undefined) throw new Error("apiRates long-context multipliers require longContextThreshold");
}
function pricing(model: string, provider: string, rates?: ApiRates): Pricing {
  const defaults = model === "gpt-6-astra" ? ASTRA_RATES : model === "gpt-6-sol" ? SOL_RATES : model === "gpt-6-luna" ? LUNA_RATES : model === "glm-5.3-flash" && provider === "opencode-go" ? GLM_RATES : model === "muse-spark-1.3-contributor" && provider === "opencode-go" ? MUSE_RATES : model === "deepseek-flash" && provider === "opencode-go" ? DEEPSEEK_RATES : null;
  const source = rates ? "configured apiRates" : defaults === ASTRA_RATES ? ASTRA_SOURCE : defaults === SOL_RATES ? SOL_SOURCE : defaults === LUNA_RATES ? LUNA_SOURCE : defaults === GLM_RATES ? GLM_SOURCE : defaults === MUSE_RATES ? MUSE_SOURCE : defaults === DEEPSEEK_RATES ? DEEPSEEK_SOURCE : null;
  return { model, rates: rates ? { ...rates } : defaults ? { ...defaults } : null, source, basis: "standard API-equivalent USD per million tokens" };
}
function reference(value: unknown): TurnReference | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.gameId !== "string" || !data.gameId || !Number.isSafeInteger(data.playerId) || (data.playerId as number) < 0 || !Number.isSafeInteger(data.turn) || (data.turn as number) < 0) return null;
  return { gameId: data.gameId, playerId: data.playerId as number, turn: data.turn as number, ...(typeof data.snapshotId === "string" ? { snapshotId: data.snapshotId } : {}) };
}
function tokens(value: unknown): UsageTokens {
  if (!value || typeof value !== "object") throw new Error("Usage tokens must be an object");
  const data = value as Record<string, unknown>;
  const result = {} as UsageTokens;
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "reasoning", "totalTokens"] as const) {
    const count = data[key] ?? (key === "reasoning" ? 0 : undefined);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid usage token count: ${key}`);
    result[key] = count;
  }
  if (result.reasoning > result.output) throw new Error("Reasoning tokens must be a subset of output");
  return result;
}
function estimate(usage: UsageTokens, price: Pricing): { estimatedUsd: number | null; longContext: boolean | null } {
  const rates = price.rates;
  if (!rates) return { estimatedUsd: null, longContext: null };
  const longContext = rates.longContextThreshold !== undefined && usage.input + usage.cacheRead + usage.cacheWrite > rates.longContextThreshold;
  const inputMultiplier = longContext ? rates.longContextInputMultiplier ?? 1 : 1;
  const outputMultiplier = longContext ? rates.longContextOutputMultiplier ?? 1 : 1;
  return { estimatedUsd: ((usage.input * rates.input + usage.cacheRead * rates.cachedInput + usage.cacheWrite * rates.cacheWrite) * inputMultiplier + usage.output * rates.output * outputMultiplier) / 1_000_000, longContext };
}
class LedgerState {
  readonly requests = new Map<string, UsageRequest>();
  readonly ended = new Set<string>();
  latest: TurnReference | null = null;
  readonly snapshots = new Map<string, TurnReference>();
  apply(event: LedgerEvent): void {
    if (event.version !== 1) throw new Error("Unsupported usage ledger version");
    if (event.type === "observation") {
      if (event.agentId === null) this.latest = event.reference;
      else this.snapshots.set(event.agentId, event.reference);
    } else if (event.type === "start") {
      if (!this.requests.has(event.request.requestId)) this.requests.set(event.request.requestId, event.request);
    } else {
      const request = this.requests.get(event.requestId);
      if (!request) throw new Error("Usage lifecycle event has no request start");
      if (event.type === "usage" && request.tokens === null) {
        request.tokens = tokens(event.tokens);
        request.estimatedUsd = event.estimatedUsd;
        request.longContext = event.longContext;
      } else if (event.type === "end" && !this.ended.has(event.requestId)) {
        this.ended.add(event.requestId);
        request.outcome = event.outcome;
        request.endedAt = event.endedAt;
        request.durationMs = event.durationMs;
      }
    }
  }
}
function reconstruct(text: string): LedgerState {
  const state = new LedgerState();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let event: LedgerEvent;
    try { event = JSON.parse(line); }
    catch (error) { if (i === lines.length - 1) break; throw error; }
    state.apply(event);
  }
  return state;
}

/** Public accounting only. Never reads native response items, sessions, auth, or old cost counters. */
export class UsageLedger {
  private readonly path: string;
  private readonly state: LedgerState;
  constructor(runDir: string, private readonly model: string, private readonly provider: string, private readonly rates?: ApiRates) {
    if (rates) validateApiRates(rates);
    privateDirectory(runDir);
    this.path = join(runDir, "usage.jsonl");
    const text = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    this.state = reconstruct(text);
    // An incomplete final append cannot contain a committed event. Keep every complete row.
    if (text && !text.endsWith("\n")) {
      const boundary = text.lastIndexOf("\n") + 1;
      let complete = true;
      try { JSON.parse(text.slice(boundary)); } catch { complete = false; }
      if (complete) appendFileSync(this.path, "\n", { flush: true });
      else truncateSync(this.path, Buffer.byteLength(text.slice(0, boundary)));
    }
    for (const request of this.state.requests.values()) if (!this.state.ended.has(request.requestId)) this.append({ version: 1, type: "end", requestId: request.requestId, outcome: "interrupted", endedAt: null, durationMs: null });
  }
  private append(event: LedgerEvent): void { journal(this.path, event); this.state.apply(event); }
  observe(value: unknown, agentId?: string): void {
    const observed = reference(value);
    if (!observed) return;
    this.append({ version: 1, type: "observation", agentId: agentId ?? null, reference: observed });
  }
  restoreObservation(value: unknown): void {
    if (!this.state.latest) this.observe(value);
  }
  onEvent(event: PlayerEvent): void {
    if (!event.requestId || !["model_call", "usage", "model_end"].includes(event.type)) return;
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === "model_call") {
      if (this.state.requests.has(event.requestId)) return;
      const provider = typeof data?.provider === "string" ? data.provider : this.provider;
      const request: UsageRequest = { requestId: event.requestId, agentId: event.agentId, kind: typeof data?.kind === "string" ? data.kind : "responses", provider, startedAt: event.at ?? new Date().toISOString(), endedAt: null, durationMs: null, outcome: "unknown", attribution: this.state.latest ? { ...this.state.latest } : null, snapshotReference: this.state.snapshots.has(event.agentId) ? { ...this.state.snapshots.get(event.agentId)! } : null, tokens: null, pricing: pricing(typeof data?.model === "string" ? data.model : this.model, provider, this.rates), estimatedUsd: null, longContext: null };
      this.append({ version: 1, type: "start", request });
      return;
    }
    const request = this.state.requests.get(event.requestId);
    if (!request) throw new Error("Usage event has no durable request start");
    if (event.type === "usage" && request.tokens === null) {
      const usage = tokens(data?.usage);
      this.append({ version: 1, type: "usage", requestId: event.requestId, tokens: usage, ...estimate(usage, request.pricing) });
    } else if (event.type === "model_end" && !this.state.ended.has(event.requestId)) {
      const outcome = data?.outcome;
      if (!["completed", "incomplete", "failed", "cancelled", "interrupted"].includes(String(outcome))) throw new Error("Invalid request outcome");
      const endedAt = event.at ?? new Date().toISOString();
      this.append({ version: 1, type: "end", requestId: event.requestId, outcome: outcome as RequestOutcome, endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(request.startedAt)) });
    }
  }
}
function totals(): UsageTotals {
  return { requests: 0, reportedRequests: 0, unreportedRequests: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, totalTokens: 0 }, estimatedUsd: null, knownEstimatedUsd: 0, unpricedRequests: 0 };
}
function add(total: UsageTotals, request: UsageRequest): void {
  total.requests++;
  if (request.tokens) {
    total.reportedRequests++;
    for (const key of Object.keys(total.tokens) as (keyof UsageTokens)[]) total.tokens[key] += request.tokens[key];
  } else total.unreportedRequests++;
  if (request.estimatedUsd === null) total.unpricedRequests++;
  else total.knownEstimatedUsd += request.estimatedUsd;
  total.estimatedUsd = total.unpricedRequests ? null : total.knownEstimatedUsd;
}
export async function readUsageReport(runDir: string): Promise<UsageReport> {
  if (!(await stat(runDir)).isDirectory()) throw new Error("Usage run path must be a directory");
  let text = "";
  try { text = await readFile(join(runDir, "usage.jsonl"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const requests = [...reconstruct(text).requests.values()];
  const summary = totals();
  const turns = new Map<string, UsageReport["turns"][number]>();
  const agents = new Map<string, UsageReport["agents"][number]>();
  for (const request of requests) {
    add(summary, request);
    const ref = request.attribution;
    const key = JSON.stringify(ref ? [ref.gameId, ref.playerId, ref.turn] : null);
    let turn = turns.get(key);
    if (!turn) { turn = { ...totals(), gameId: ref?.gameId ?? null, playerId: ref?.playerId ?? null, turn: ref?.turn ?? null }; turns.set(key, turn); }
    add(turn, request);
    let agent = agents.get(request.agentId);
    if (!agent) { agent = { ...totals(), agentId: request.agentId }; agents.set(request.agentId, agent); }
    add(agent, request);
  }
  return { version: 1, summary, turns: [...turns.values()], agents: [...agents.values()], requests, actualSubscriptionCharge: null, imageTokens: "Included in input; separate breakout unavailable", notes: ["API-equivalent estimates use persisted standard rates and request-level long-context pricing; not actual billed charges.", "Subscription access is not metered API billing. Actual subscription charge is unavailable and cannot be inferred from token counts.", "Reasoning is a subset of output, not added or billed twice. Image tokens are included in input; separate breakout unavailable.", "Turns are anchored at request start to the last confirmed host observation. Older per-agent snapshot references are retained separately.", "Missing usage, interrupted requests, and historical calls predating this ledger are unknown/unreported, never assumed free.", ...(requests.length ? [] : ["No usage records exist for this run; historical registry cost counters are not used."])] };
}
export function formatUsageReport(report: UsageReport): string {
  const describe = (value: UsageTotals) => `${value.requests} requests; ${value.tokens.totalTokens} reported tokens (fresh ${value.tokens.input}, cache read ${value.tokens.cacheRead}, cache write ${value.tokens.cacheWrite}, output ${value.tokens.output}, reasoning subset ${value.tokens.reasoning}); ${value.unreportedRequests} unreported; API-equivalent USD ${value.estimatedUsd === null ? `unknown (known subtotal $${value.knownEstimatedUsd.toFixed(6)}, ${value.unpricedRequests} unpriced requests)` : `$${value.estimatedUsd.toFixed(6)}`}`;
  return ["Usage — whole run", describe(report.summary), "", "Per game turn (request-start attribution)", ...report.turns.map(row => `${row.gameId === null ? "Unknown/pre-game" : `${row.gameId} / player ${row.playerId} / turn ${row.turn}`}: ${describe(row)}`), "", "Per agent (including compaction)", ...report.agents.map(row => `${row.agentId}: ${describe(row)}`), "", ...report.notes].join("\n");
}
