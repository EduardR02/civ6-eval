import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { validateApiRates, type ApiRates } from "./usage.ts";

export interface Config {
  model: string;
  provider: "openai" | "codex" | "opencode-go";
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  authPath: string;
  baseUrl?: string;
  apiRates?: ApiRates;
  pythonPath: string;
  distro: string;
  tunerHost: string;
  tunerPort: number;
  maxConcurrentAgents: number;
  maxModelCalls: number | "unlimited";
  compactThreshold: number;
  compactThresholds?: Record<string, number>;
  runsDir: string;
}
export async function loadConfig(projectRoot: string, filename?: string): Promise<Config> {
  const config: Config = {
    model: "gpt-6-astra", provider: "codex", effort: "high",
    authPath: join(homedir(), ".omp", "agent", "agent.db"), pythonPath: resolve(projectRoot, ".venv/Scripts/python.exe"),
    distro: "Ubuntu-24.04", tunerHost: "127.0.0.1", tunerPort: 4318,
    maxConcurrentAgents: 4, maxModelCalls: 200, compactThreshold: 180000,
    runsDir: resolve(projectRoot, ".civ6/runs"),
  };
  const path = resolve(projectRoot, filename ?? "civ6.config.json");
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (filename || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Configuration must be a JSON object");
  for (const key of Object.keys(raw)) if (!Object.hasOwn(config, key) && key !== "baseUrl" && key !== "apiRates" && key !== "compactThresholds") throw new Error(`Unknown configuration key: ${key}`);
  Object.assign(config, raw);
  if (raw.provider === "opencode-go" && raw.model === undefined) config.model = "glm-5.3-flash";
  if (!["openai", "codex", "opencode-go"].includes(config.provider)) throw new Error("provider must be openai, codex or opencode-go");
  if (!["low", "medium", "high", "xhigh", "max"].includes(config.effort)) throw new Error("Invalid reasoning effort");
  for (const key of ["model", "authPath", "pythonPath", "distro", "tunerHost", "runsDir"] as const) {
    if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`${key} must be a nonempty string`);
  }
  for (const key of ["tunerPort", "maxConcurrentAgents", "compactThreshold"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (config.maxModelCalls !== "unlimited" && (!Number.isSafeInteger(config.maxModelCalls) || config.maxModelCalls <= 0)) {
    throw new Error("maxModelCalls must be a positive integer or unlimited");
  }
  if (config.compactThresholds !== undefined) {
    const thresholds = config.compactThresholds;
    if (typeof thresholds !== "object" || thresholds === null || Array.isArray(thresholds)) throw new Error("compactThresholds must be an object keyed by provider");
    for (const [provider, threshold] of Object.entries(thresholds)) {
      if (!["openai", "codex", "opencode-go"].includes(provider)) throw new Error(`compactThresholds key must be openai, codex or opencode-go, not: ${provider}`);
      if (!Number.isSafeInteger(threshold) || threshold <= 0) throw new Error(`compactThresholds.${provider} must be a positive integer`);
    }
  }
  if (config.tunerPort > 65535) throw new Error("tunerPort exceeds 65535");
  for (const key of ["authPath", "pythonPath", "runsDir"] as const) config[key] = resolve(projectRoot, config[key].replace(/^~(?=[/\\])/, homedir()));
  if (config.baseUrl !== undefined && (typeof config.baseUrl !== "string" || !/^https?:\/\//.test(config.baseUrl))) throw new Error("baseUrl must be an HTTP(S) URL");
  if (config.apiRates !== undefined) validateApiRates(config.apiRates);
  return config;
}
