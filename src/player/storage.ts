import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Host-only storage. Never mount this directory in Python or expose it through artifact RPC. */
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function loadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function saveJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(temporary, path);
}

export function journal(path: string, value: unknown): void {
  appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...value as object }) + "\n", { mode: 0o600, flush: true });
}
