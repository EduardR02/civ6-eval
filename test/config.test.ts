import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { loadConfig } from "../src/config.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("ambient API credentials cannot switch a subscription player to API billing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-config-"));
  directories.push(directory);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "configuration-test-not-a-real-key";
  try {
    const config = await loadConfig(directory);
    expect(config.provider).toBe("codex");
    await writeFile(join(directory, "civ6.config.json"), JSON.stringify({ provider: "openai", authPath: "~/.codex/auth.json" }));
    const explicit = await loadConfig(directory);
    expect(explicit.provider).toBe("openai");
    expect(explicit.authPath).toBe(join(homedir(), ".codex", "auth.json"));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("unknown options and non-object configuration fail rather than silently changing defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-config-"));
  directories.push(directory);
  const file = join(directory, "civ6.config.json");
  await writeFile(file, '{"maxModelCall":300}');
  await expect(loadConfig(directory)).rejects.toThrow("Unknown configuration key");
  await writeFile(file, 'null');
  await expect(loadConfig(directory)).rejects.toThrow("JSON object");
});

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENAI_API_KEY: "" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("CLI rejects invalid arguments before opening a run", async () => {
  for (const [args, message] of [
    [["play", "--unknown"], "Unknown option"],
    [["play", "--calls"], "--calls requires a value"],
    [["usage"], "usage requires --run"],
    [["usage", "--run", "unused", "--json", "true"], "Unexpected argument"],
    [["play", "--run", "a", "--resume", "b"], "mutually exclusive"],
    [["exec", "--code", "print(1)", "--file", "script.py"], "mutually exclusive"],
    [["play", "--model", "a", "--model", "b"], "Duplicate option"],
  ] as const) {
    const result = await cli([...args]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("Run:");
  }
});

test("offline usage reports absent accounting honestly and leaves the run untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-usage-cli-"));
  directories.push(directory);
  const json = await cli(["usage", "--run", directory, "--json"]);
  expect(json.exitCode).toBe(0);
  expect(json.stderr).toBe("");
  const report = JSON.parse(json.stdout);
  expect(report.summary.requests).toBe(0);
  expect(report.summary.estimatedUsd).toBeNull();
  expect(report.actualSubscriptionCharge).toBeNull();
  const text = await cli(["usage", "--run", directory]);
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("API-equivalent");
  expect(text.stdout).toContain("unavailable");
  expect(await readdir(directory)).toEqual([]);
});

test("usage failures exit nonzero rather than creating or silently accepting a run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-usage-cli-"));
  directories.push(directory);
  const missing = await cli(["usage", "--run", join(directory, "missing"), "--json"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("missing");
  expect(await readdir(directory)).toEqual([]);
  await writeFile(join(directory, "usage.jsonl"), "not-json\n");
  const corrupt = await cli(["usage", "--run", directory, "--json"]);
  expect(corrupt.exitCode).toBe(1);
  expect(corrupt.stdout).toBe("");
});
