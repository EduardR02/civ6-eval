import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, readOmpApiKey, readOmpCredential } from "./auth.ts";
import { NativeResponses, emptyUsage } from "./native.ts";
import { saveJson } from "./storage.ts";

test("OMP pinned reader refreshes the same account; startup rotates only after OMP blocks it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "civ-auth-"));
  const path = join(directory, "auth.db");
  const database = new Database(path, { create: true });
  try {
    database.exec("CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, disabled_cause TEXT, data TEXT, updated_at INTEGER); CREATE TABLE auth_credential_blocks(credential_id INTEGER, blocked_until_ms INTEGER)");
    const insert = database.query("INSERT INTO auth_credentials VALUES(?, 'openai-codex', 'oauth', NULL, ?, ?)");
    const data = (accountId: string, access: string) => JSON.stringify({ accountId, access, expires: Date.now() + 3600000 });
    insert.run(1, data("account-a", "fixture-old"), 1);
    insert.run(2, data("account-b", "fixture-other"), 2);
    expect(readOmpCredential(path, "account-a").access).toBe("fixture-old");
    database.query("UPDATE auth_credentials SET data = ?, updated_at = 3 WHERE id = 1").run(data("account-a", "fixture-fresh"));
    expect(readOmpCredential(path, "account-a").access).toBe("fixture-fresh");
    database.query("INSERT INTO auth_credential_blocks VALUES(1, ?)").run(Date.now() + 3600000);
    expect(() => readOmpCredential(path, "account-a")).toThrow("No available unexpired");
    const runDir = join(directory, "run");
    saveJson(join(runDir, "player", "auth-source.json"), { accountId: "account-a" });
    const runtime = await createRuntime({ runDir, projectRoot: process.cwd(), provider: "codex", model: "gpt-6-sol", authPath: path, rpc: async () => ({}), execute: async () => ({ content: [] }) });
    expect(runtime.startupAccountSwitched).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir, "player", "auth-source.json"), "utf8")).accountId).toBe("account-b");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex quota switches accounts without changing opaque context; transient throttles and exhausted pools stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "civ-codex-rotation-"));
  const path = join(directory, "auth.db");
  const database = new Database(path, { create: true });
  const attempts: { account: string | null; input: unknown }[] = [];
  let transient = true;
  let bodyless = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { input: unknown };
    const account = request.headers.get("chatgpt-account-id");
    attempts.push({ account, input: body.input });
    if (account === "account-a" && bodyless) return new Response(null, { status: 429 });
    if (account === "account-a") return Response.json({ error: { code: transient ? "rate_limit_exceeded" : "usage_limit_reached", echo: "private-provider-error" } }, { status: 429, headers: { "retry-after": "42" } });
    if (attempts.length > 4) return Response.json({ error: { code: "usage_limit_reached" } }, { status: 429 });
    return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    database.exec("CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, disabled_cause TEXT, data TEXT, updated_at INTEGER); CREATE TABLE auth_credential_blocks(credential_id INTEGER, blocked_until_ms INTEGER)");
    const insert = database.query("INSERT INTO auth_credentials VALUES(?, 'openai-codex', 'oauth', NULL, ?, ?)");
    for (const [id, account] of [[1, "account-b"], [2, "account-a"]] as const) {
      const access = `fixture.${Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: account },
      })).toString("base64url")}.fixture`;
      insert.run(id, JSON.stringify({ accountId: account, access, expires: Date.now() + 3600000 }), id);
    }
    const options = { runDir: directory, projectRoot: process.cwd(), provider: "codex" as const, model: "gpt-6-sol", authPath: path, baseUrl: `http://127.0.0.1:${server.port}`, rpc: async () => ({}), execute: async () => ({ content: [] }) };
    const { runtime, model, rotateCodexAccount } = await createRuntime(options);
    const nativePath = join(directory, "player", "agents", "main", "native.json");
    const opaque = { type: "reasoning", encrypted_content: "opaque-prior-conversation", summary: [] };
    saveJson(nativePath, { version: 1, items: [opaque], seenInputs: [], completedCalls: [], inputTokens: 0, compactions: 0, totalUsage: emptyUsage() });
    const events: string[] = [];
    const ledger = new NativeResponses("main", { ...options, onEvent: event => events.push(event.type) }, runtime, model, () => {}, () => {}, rotateCodexAccount);
    const context = { messages: [{ role: "user" as const, content: "continue", timestamp: 1 }] };
    expect((await ledger.stream(context).result()).stopReason).toBe("error");
    expect(attempts.map(attempt => attempt.account)).toEqual(["account-a"]);
    expect(JSON.parse(readFileSync(join(directory, "player", "auth-source.json"), "utf8")).accountId).toBe("account-a");

    bodyless = true;
    expect((await ledger.stream(context).result()).stopReason).toBe("error");
    expect(attempts.map(attempt => attempt.account)).toEqual(["account-a", "account-a"]);
    expect(JSON.parse(readFileSync(join(directory, "player", "auth-source.json"), "utf8")).accountId).toBe("account-a");
    bodyless = false;

    transient = false;
    expect((await ledger.stream(context).result()).stopReason).toBe("stop");
    expect(attempts.map(attempt => attempt.account)).toEqual(["account-a", "account-a", "account-a", "account-b"]);
    expect(attempts[2]!.input).toEqual(attempts[3]!.input);
    expect(JSON.stringify(attempts[3]!.input)).toContain(opaque.encrypted_content);
    expect(events.filter(event => event === "account_switch")).toHaveLength(1);
    const binding = JSON.parse(readFileSync(join(directory, "player", "auth-source.json"), "utf8")) as { accountId: string; exhausted: Record<string, number> };
    expect(binding.accountId).toBe("account-b");
    expect(binding.exhausted["account-a"]).toBeGreaterThan(Date.now() + 35_000);
    expect(binding.exhausted["account-a"]).toBeLessThan(Date.now() + 50_000);
    expect(readFileSync(join(directory, "player", "agents", "main", "native.jsonl"), "utf8")).not.toContain("private-provider-error");

    expect((await ledger.stream(context).result()).stopReason).toBe("error");
    expect(attempts.map(attempt => attempt.account)).toEqual(["account-a", "account-a", "account-a", "account-b", "account-b"]);
    expect(JSON.parse(readFileSync(join(directory, "player", "auth-source.json"), "utf8")).exhausted["account-b"]).toBeGreaterThan(Date.now());
    await expect(createRuntime(options)).rejects.toThrow("All Codex subscription accounts");
  } finally {
    server.stop(true);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("OMP API-key source is read-only and excludes blocked or disabled credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "civ-auth-key-"));
  const path = join(directory, "auth.db");
  const database = new Database(path, { create: true });
  try {
    database.exec("CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, disabled_cause TEXT, data TEXT, updated_at INTEGER); CREATE TABLE auth_credential_blocks(credential_id INTEGER, blocked_until_ms INTEGER)");
    const insert = database.query("INSERT INTO auth_credentials VALUES(?, 'opencode-go', 'api_key', ?, ?, ?)");
    insert.run(1, null, JSON.stringify({ key: "fixture-available", source: "test" }), 1);
    insert.run(2, null, JSON.stringify({ key: "fixture-blocked" }), 2);
    insert.run(3, "disabled", JSON.stringify({ key: "fixture-disabled" }), 3);
    database.query("INSERT INTO auth_credential_blocks VALUES(2, ?)").run(Date.now() + 3600000);
    expect(readOmpApiKey(path)).toBe("fixture-available");
    expect(database.query("SELECT COUNT(*) AS count FROM auth_credentials").get()).toEqual({ count: 3 });
    database.query("INSERT INTO auth_credential_blocks VALUES(1, ?)").run(Date.now() + 3600000);
    expect(() => readOmpApiKey(path)).toThrow("No opencode-go API key");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline Codex and OpenAI catalogs accept literal max only for verified models", async () => {
  const directory = mkdtempSync(join(tmpdir(), "civ-codex-models-"));
  const access = `fixture.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
  })).toString("base64url")}.fixture`;
  const authPath = join(directory, "source.json");
  writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: access, account_id: "fixture-account" } }));
  const options = { projectRoot: process.cwd(), authPath, rpc: async () => ({}), execute: async () => ({ content: [] }) };
  try {
    const sol = await createRuntime({ ...options, runDir: join(directory, "sol"), model: "gpt-6-sol" });
    const luna = await createRuntime({ ...options, runDir: join(directory, "luna"), model: "gpt-6-luna" });
    expect(sol.runtime.getModel("openai-codex", "gpt-6-sol")?.thinkingLevelMap?.max).toBe("max");
    expect(luna.model).toMatchObject({ provider: "openai-codex", api: "openai-codex-responses", contextWindow: 272000, maxTokens: 128000, input: ["text", "image"] });
    expect(JSON.parse(await Bun.file(join(directory, "sol", "player", "profile.json")).text())).toMatchObject({ effort: "high", pricingKnown: true });
    expect(JSON.parse(await Bun.file(join(directory, "luna", "player", "profile.json")).text())).toMatchObject({ effort: "max", pricingKnown: true });
    await createRuntime({ ...options, runDir: join(directory, "sol-max"), model: "gpt-6-sol", effort: "max" });
    await expect(createRuntime({ ...options, runDir: join(directory, "astra-max"), model: "gpt-6-astra", effort: "max" })).rejects.toThrow("does not support reasoning effort max");
    const apiLuna = await createRuntime({ ...options, provider: "openai", apiKey: "fixture-only", runDir: join(directory, "api-luna"), model: "gpt-6-luna" });
    expect(apiLuna.model).toMatchObject({ api: "openai-responses", contextWindow: 1050000, maxTokens: 128000, thinkingLevelMap: { max: "max" } });
    expect(JSON.parse(await Bun.file(join(directory, "api-luna", "player", "profile.json")).text())).toMatchObject({ effort: "max", pricingKnown: true });
    await expect(createRuntime({ ...options, provider: "openai", apiKey: "fixture-only", runDir: join(directory, "api-astra-max"), model: "gpt-6-astra", effort: "max" })).rejects.toThrow("does not support reasoning effort max");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
