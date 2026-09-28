import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("absent reasoning effort follows the model default and compaction defaults to 272000", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-model-defaults-"));
  directories.push(directory);
  const file = join(directory, "civ6.config.json");
  expect(await loadConfig(directory)).toMatchObject({
    model: "gpt-6-astra", provider: "codex", effort: "high", compactThreshold: 272000,
  });
  for (const [model, effort] of [
    ["gpt-6-astra", "high"],
    ["gpt-6-sol", "high"],
    ["gpt-6-luna", "max"],
    ["deepseek-flash", "high"],
  ] as const) {
    await writeFile(file, JSON.stringify({ model }));
    expect((await loadConfig(directory)).effort).toBe(effort);
  }
  await writeFile(file, JSON.stringify({ model: "gpt-6-luna", effort: "medium" }));
  expect((await loadConfig(directory)).effort).toBe("medium");
  await writeFile(file, JSON.stringify({ provider: "opencode-go" }));
  expect(await loadConfig(directory)).toMatchObject({ model: "glm-5.3-flash", effort: "high" });
});

test("request limits are validated at load and absent means no added retention policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-limits-"));
  directories.push(directory);
  const file = join(directory, "civ6.config.json");
  expect((await loadConfig(directory)).requestLimits).toBeUndefined();
  await writeFile(file, JSON.stringify({ requestLimits: { maxImages: 12, retainedImages: 3, maxBytes: 8_000_000 } }));
  expect((await loadConfig(directory)).requestLimits).toEqual({ maxImages: 12, retainedImages: 3, maxBytes: 8_000_000 });
  for (const limits of [{ maxImages: 0 }, { maxBytes: 1.5 }, { maxImages: -1 }, { retainedImages: 3 }, { maxImages: 2, retainedImages: 3 }, { maxBytes: "9000" }, []]) {
    await writeFile(file, JSON.stringify({ requestLimits: limits }));
    await expect(loadConfig(directory)).rejects.toThrow("requestLimits");
  }
  await writeFile(file, JSON.stringify({ requestLimits: { maxImage: 45 } }));
  await expect(loadConfig(directory)).rejects.toThrow("Unknown requestLimits key");
});

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

test("unlimited calls require an explicit opt-in rather than an invalid numeric ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-calls-"));
  directories.push(directory);
  const file = join(directory, "civ6.config.json");
  await writeFile(file, JSON.stringify({ maxModelCalls: "unlimited" }));
  expect((await loadConfig(directory)).maxModelCalls).toBe("unlimited");
  for (const value of [0, -1, 1.5, null, "Infinity", "unlimted"]) {
    await writeFile(file, JSON.stringify({ maxModelCalls: value }));
    await expect(loadConfig(directory)).rejects.toThrow("maxModelCalls");
  }
});

test("per-provider compaction thresholds must be positive integers keyed by known providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-config-"));
  directories.push(directory);
  const file = join(directory, "civ6.config.json");
  await writeFile(file, JSON.stringify({ provider: "opencode-go", compactThresholds: { "opencode-go": 500000 } }));
  const config = await loadConfig(directory);
  expect(config.compactThresholds).toEqual({ "opencode-go": 500000 });
  for (const thresholds of [{ "opencode-go": 0 }, { "opencode-go": -5 }, { "opencode-go": 1.5 }, { "opencode-go": "500000" }]) {
    await writeFile(file, JSON.stringify({ compactThresholds: thresholds }));
    await expect(loadConfig(directory)).rejects.toThrow("must be a positive integer");
  }
  await writeFile(file, JSON.stringify({ compactThresholds: { "opencode-g0": 500000 } }));
  await expect(loadConfig(directory)).rejects.toThrow("compactThresholds key");
  await writeFile(file, JSON.stringify({ compactThresholds: [500000] }));
  await expect(loadConfig(directory)).rejects.toThrow("compactThresholds must be an object");
});

test("completion mode defaults to explicit and rejects unknown values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-config-"));
  directories.push(directory);
  const file = join(directory, "civ6.config.json");
  expect((await loadConfig(directory)).completionMode).toBe("explicit");
  await writeFile(file, JSON.stringify({ completionMode: "response" }));
  expect((await loadConfig(directory)).completionMode).toBe("response");
  await writeFile(file, JSON.stringify({ completionMode: "always" }));
  await expect(loadConfig(directory)).rejects.toThrow("completionMode must be explicit or response");
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
    [["play", "--calls", "0"], "--calls must be a positive integer or unlimited"],
    [["play", "--calls", "Infinity"], "--calls must be a positive integer or unlimited"],
    [["play", "--completion"], "--completion requires a value"],
    [["play", "--completion", "always"], "--completion must be explicit or response"],
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


test("CLI play treats a progress-only turn as undeclared and reports the durable declaration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-play-cli-"));
  directories.push(directory);
  const bodies: string[] = [];
  const sse = (payloads: unknown[]) => new Response(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.text());
    const declare = bodies.length === 2;
    const delta = declare
      ? { tool_calls: [{ index: 0, id: "call_finish", type: "function", function: { name: "finish_task", arguments: JSON.stringify({ status: "completed", reason: "Turn 70 held; next turn queued" }) } }] }
      : { content: "Turn 70 progress report; the game is still active." };
    return sse([
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: declare ? "tool_calls" : "stop" }] },
    ]);
  } });
  try {
    const runDir = join(directory, "run");
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      provider: "opencode-go", model: "glm-5.3-flash", effort: "high", completionMode: "explicit", maxModelCalls: 2,
      baseUrl: `http://127.0.0.1:${server.port}/v1`, authPath: join(directory, "missing-auth.json"),
      pythonPath: join(directory, "missing-python.exe"), distro: "no-live-sandbox", runsDir: join(directory, "runs"),
    }));
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "play", "--config", configPath, "--run", runDir, "--prompt", "play the game"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENCODE_API_KEY: "fixture-only", OPENAI_API_KEY: "" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    // The progress report bought exactly one reminder, and the declaration ended the run.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("[harness protocol]");
    expect(stdout).toContain("No task declaration in that turn; sending the single protocol reminder.");
    expect(stdout).toContain("Task completed: Turn 70 held; next turn queued");
    const registry = JSON.parse(await readFile(join(runDir, "player", "agents.json"), "utf8")) as { agents: { id: string; status: string; task?: { outcome: string; repair: boolean } }[] };
    expect(registry.agents.find(agent => agent.id === "main")).toMatchObject({ status: "completed", task: { outcome: "completed", repair: true } });
  } finally { server.stop(true); }
});

test("CLI play --completion response keeps the one-shot contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-play-cli-"));
  directories.push(directory);
  const bodies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.text());
    const payloads = [
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Still playing; report later." }, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    const runDir = join(directory, "run");
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      provider: "opencode-go", model: "glm-5.3-flash", effort: "high", maxModelCalls: 2,
      baseUrl: `http://127.0.0.1:${server.port}/v1`, authPath: join(directory, "missing-auth.json"),
      pythonPath: join(directory, "missing-python.exe"), distro: "no-live-sandbox", runsDir: join(directory, "runs"),
    }));
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "play", "--config", configPath, "--run", runDir, "--completion", "response", "--prompt", "play the game"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENCODE_API_KEY: "fixture-only", OPENAI_API_KEY: "" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Response mode is the explicit opt-out: one request, no reminder, no declaration, exit 0.
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(bodies).toHaveLength(1);
    expect(stdout).toContain("Still playing; report later.");
    const registry = JSON.parse(await readFile(join(runDir, "player", "agents.json"), "utf8")) as { agents: { id: string; task?: unknown }[] };
    expect(registry.agents.find(agent => agent.id === "main")?.task).toBeUndefined();
  } finally { server.stop(true); }
});

test("CLI play fails loudly when explicit mode never receives a declaration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-play-cli-"));
  directories.push(directory);
  const bodies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.text());
    const payloads = [
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Turn 70 report; the game is still active." }, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    const runDir = join(directory, "run");
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      provider: "opencode-go", model: "glm-5.3-flash", effort: "high", maxModelCalls: 2, completionMode: "explicit",
      baseUrl: `http://127.0.0.1:${server.port}/v1`, authPath: join(directory, "missing-auth.json"),
      pythonPath: join(directory, "missing-python.exe"), distro: "no-live-sandbox", runsDir: join(directory, "runs"),
    }));
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "play", "--config", configPath, "--run", runDir, "--prompt", "play the game"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENCODE_API_KEY: "fixture-only", OPENAI_API_KEY: "" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Explicit task protocol failure");
    // One report bought exactly one reminder; nothing claimed the task was completed.
    expect(bodies).toHaveLength(2);
    expect(stdout).not.toContain("Task completed");
    const registry = JSON.parse(await readFile(join(runDir, "player", "agents.json"), "utf8")) as { agents: { id: string; status: string; task?: { outcome: string } }[] };
    expect(registry.agents.find(agent => agent.id === "main")).toMatchObject({ status: "failed", task: { outcome: "protocol_failure" } });
  } finally { server.stop(true); }
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

test("CLI exec writes JPEG and PNG image bytes with matching filenames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civ-image-cli-"));
  directories.push(directory);
  const images = [
    { type: "image", mimeType: "image/jpeg", data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCLAGVxf//Z" },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGioAAAAASUVORK5CYII=" },
  ];
  const runDir = join(directory, "run");
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ authPath: join(directory, "missing-auth.json"), pythonPath: join(directory, "missing-python.exe"), distro: "no-live-sandbox" }));
  // Isolate the execution fixture in a subprocess; exercise the real CLI and file writes, never desktop/model services.
  const runner = join(directory, "images.ts");
  const cliPath = resolve(import.meta.dir, "../src/cli.ts");
  await writeFile(runner, `
    import { ExecutionService } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../src/execution.ts")).href)};
    ExecutionService.prototype.execute = async () => (${JSON.stringify({ content: images, isError: false })});
    process.argv = ${JSON.stringify([process.execPath, cliPath, "exec", "--config", configPath, "--run", runDir, "--code", "fixture"])};
    // Load the CLI only after installing the offline execution fixture and arguments.
    await import(${JSON.stringify(pathToFileURL(cliPath).href)});
  `);
  const child = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENAI_API_KEY: "" } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect((await readdir(runDir)).filter(name => name.startsWith("execution-")).sort()).toEqual(["execution-0.jpg", "execution-1.png"]);
  for (const [index, extension] of ["jpg", "png"].entries()) {
    const path = join(runDir, `execution-${index}.${extension}`);
    expect(await readFile(path)).toEqual(Buffer.from(images[index]!.data, "base64"));
    expect(stdout).toContain(path);
  }
});
