import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOmpApiKey, readOmpCredential } from "./auth.ts";

test("OMP pinned account rereads fresh credentials but never switches to a newer unblocked account", () => {
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
    expect(() => readOmpCredential(path, "account-a")).toThrow("never switched automatically");
  } finally {
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
