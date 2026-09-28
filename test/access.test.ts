import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, appendFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PlayerHost } from "../src/host.ts";
import { loadConfig } from "../src/config.ts";

const fixtures: { host: PlayerHost; directory: string }[] = [];
const consoleDirectories: string[] = [];
afterEach(async () => {
  for (const { host, directory } of fixtures.splice(0)) {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
  for (const directory of consoleDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "civ-player-access-"));
  const config = await loadConfig(directory);
  config.authPath = join(directory, "missing-test-auth.json");
  const host = new PlayerHost(resolve(import.meta.dir, ".."), directory, config);
  fixtures.push({ host, directory });
  await host.initialize();
  return { host, directory };
}

test("artifacts share selected work without exposing sibling private files", async () => {
  const { host, directory } = await fixture();
  await writeFile(join(directory, "private.json"), "private-provider-state");
  await host.rpc("analyst", "artifact.write", { name: "plans/layout.json", content: '{"tiles":[12,18]}' });
  const result = await host.rpc("main", "artifact.read", { name: "plans/layout.json" }) as { content: string };
  expect(JSON.parse(result.content)).toEqual({ tiles: [12, 18] });
  await expect(host.rpc("analyst", "artifact.read", { name: "../private.json" })).rejects.toThrow();
  await expect(host.rpc("analyst", "artifact.write", { name: "plans/../../private.json", content: "replace" })).rejects.toThrow();
  // An absolute host path is refused whatever it points at; the credential file is the case that
  // matters, so the shape is asserted without naming a real account's home directory.
  await expect(host.rpc("analyst", "artifact.read", { name: "C:/Users/example/.codex/auth.json" })).rejects.toThrow();
  await expect(host.rpc("analyst", "artifact.read", { name: "/home/example/.codex/auth.json" })).rejects.toThrow();
});

test("an analyst can inspect captured state but cannot operate the live game", async () => {
  const { host, directory } = await fixture();
  const snapshotId = "s-12345678-abcd-1234-abcd-123456789abc";
  await mkdir(join(directory, "snapshots"), { recursive: true });
  await writeFile(join(directory, "snapshots", `${snapshotId}.json`), JSON.stringify({ snapshotId, turn: 7, units: [{ id: "U1", x: 4, y: 8 }] }));
  const state = await host.rpc("analyst", "civ.snapshot", { snapshotId }) as { turn: number };
  expect(state.turn).toBe(7);
  await expect(host.rpc("analyst", "civ.action", { type: "move", unit: "U1", x: 5, y: 8 })).rejects.toThrow("Live game control belongs to main");
  await expect(host.rpc("analyst", "desktop.click", { x: 10, y: 10 })).rejects.toThrow("Live game control belongs to main");
  await expect(host.rpc("analyst", "control.grant", { agentId: "analyst" })).rejects.toThrow("Only main");
});

test("native screenshots remain available when popup observation is broken", async () => {
  const { host } = await fixture();
  host.bridge.preparePresentation = async () => { throw new Error("Popup transport unavailable"); };
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=";
  host.desktop.request = async method => {
    if (method === "desktop.screenshot") return { data: image, mimeType: "image/png", width: 1, height: 1 };
    throw new Error(`Unexpected native input: ${method}`);
  };
  const result = await host.rpc("main", "desktop.screenshot") as { data: string; presentationError: string };
  expect(result.data).toBe(image);
  expect(result.presentationError).toContain("Popup transport unavailable");
});

test("a coordinate click cannot auto-dismiss the screen its target belongs to", async () => {
  const { host } = await fixture();
  let modalVisible = true;
  host.bridge.preparePresentation = async () => {
    modalVisible = false;
    return { observed: [], presented: [], dismissed: ["popup:tech"], advanced: [], resolved: [], remaining: [], callbackFailures: [], unavailable: {}, more: false };
  };
  let activated: string | undefined;
  host.desktop.request = async method => {
    if (method !== "desktop.click") throw new Error(`Unexpected native input: ${method}`);
    activated = modalVisible ? "modal button" : "underlying map";
    return { submitted: true };
  };
  await host.rpc("main", "desktop.click", { x: 20, y: 30 });
  expect(activated).toBe("modal button");
});

for (const method of ["civ.action", "desktop.screenshot"]) {
  test(`control handoff during popup preparation prevents ${method} from starting`, async () => {
    const { host } = await fixture();
    let handoff: Promise<void> | undefined;
    const submitted: string[] = [];
    host.desktop.request = async method => {
      if (method !== "desktop.cancel") submitted.push(method);
      return {};
    };
    host.bridge.request = async method => { submitted.push(method); return {}; };
    host.bridge.preparePresentation = async () => {
      handoff = host.setController("analyst");
      return { observed: [], presented: [], dismissed: [], advanced: [], resolved: [], remaining: [], callbackFailures: [], unavailable: {}, more: false };
    };
    try {
      await expect(host.rpc("main", method, method === "civ.action" ? { type: "end_turn" } : {}))
        .rejects.toThrow("control handoff");
      expect(submitted).toEqual([]);
    } finally {
      await handoff;
    }
  });
}

test("history search returns bounded excerpts with recoverable full-record offsets", async () => {
  const { host, directory } = await fixture();
  await host.rpc("main", "history.read", {});
  const text = JSON.stringify({ marker: "rare-signal", payload: "a".repeat(5000), end: "recover-me" });
  await appendFile(join(directory, "history.jsonl"), text + "\n");
  const found = await host.rpc("analyst", "history.search", { query: "rare-signal", textLimit: 120 }) as { matches: { line: number; text: string; truncated: boolean; totalChars: number }[] };
  expect(found.matches[0]!.text.length).toBe(120);
  expect(found.matches[0]!.truncated).toBe(true);
  const recovered = await host.rpc("analyst", "history.read", { offset: found.matches[0]!.line - 1, limit: 1, textOffset: text.indexOf("recover-me"), textLimit: 10 }) as { rows: { text: string }[] };
  expect(recovered.rows[0]!.text).toBe("recover-me");
});

test("public evidence locates historical snapshot facts with exact coverage and recoverable pointers", async () => {
  const { host, directory } = await fixture();
  const oldId = "s-11111111-1111-4111-8111-111111111111";
  const previous = {
    snapshotId: oldId, gameId: "game-1", capturedAt: "2026-01-01T12:00:00.000Z", turn: 7,
    sections: ["core", "cities"], coverage: { units: "omitted", cities: "partial", map: "omitted" },
    cities: [{ id: "C1", name: "Amber Harbor", own: true, visibility: "visible" }],
  };
  await writeFile(join(directory, "snapshots", `${oldId}.json`), JSON.stringify(previous));
  host.bridge.preparePresentation = async () => ({ observed: [], presented: [], dismissed: [], advanced: [], resolved: [], remaining: [], callbackFailures: [], unavailable: {}, more: false });
  host.bridge.request = async () => ({ turn: 11, gameId: "game-1", playerId: 0, sections: ["core"], coverage: { units: "omitted", cities: "omitted", map: "omitted" } });
  host.bridge.exportKnowledge = () => null;
  await host.rpc("main", "civ.snapshot", {});
  const result = await host.rpc("analyst", "history.evidence", { query: "Amber Harbor", snapshotId: oldId }) as {
    matches: { source: string; snapshotId: string; pointer: string; section: string; turn: number; ageTurns: number; capturedAt: string; coverage: unknown; sections: string[] }[];
    latestObservedTurn: number; incomplete: boolean;
  };
  expect(result.matches[0]).toMatchObject({
    source: "snapshot", snapshotId: oldId, pointer: "/cities/0", section: "cities",
    turn: 7, ageTurns: 4, capturedAt: previous.capturedAt, coverage: previous.coverage, sections: previous.sections,
  });
  const recovered = await host.rpc("analyst", "civ.snapshot", { snapshotId: oldId }) as typeof previous;
  expect(recovered.cities[0]!.name).toBe("Amber Harbor");
  expect(result.latestObservedTurn).toBe(11);
  expect(result.incomplete).toBe(false);
  const absent = await host.rpc("analyst", "history.evidence", { query: "unknown city", snapshotId: oldId }) as { matches: unknown[]; incomplete: boolean };
  expect(absent.matches).toEqual([]);
  expect(absent.incomplete).toBe(false);
  host.bridge.request = async () => ({ turn: 20, gameId: "another-game", playerId: 0, sections: ["core"], coverage: { units: "omitted", cities: "omitted", map: "omitted" } });
  await host.rpc("main", "civ.snapshot", {});
  const differentGame = await host.rpc("analyst", "history.evidence", { query: "Amber Harbor", snapshotId: oldId }) as { matches: { ageTurns: number | null }[] };
  expect(differentGame.matches[0]!.ageTurns).toBeNull();
});

test("public evidence only exposes selected run outputs, with bounded excerpts and exact recovery", async () => {
  const { host, directory } = await fixture();
  const secret = "private-provider-needle";
  await writeFile(join(directory, "provider-session.json"), secret);
  await writeFile(join(directory, "inputs.json"), secret);
  await writeFile(join(directory, "knowledge.json"), secret);
  await appendFile(join(directory, "history.jsonl"), JSON.stringify({ kind: "provider_private", text: secret }) + "\n");
  await appendFile(join(directory, "history.jsonl"), JSON.stringify({ kind: "execution", executionId: "private-id", code: secret }) + "\n");
  const output = "before ".repeat(100) + "PUBLIC-SIGNAL" + " after".repeat(100);
  await appendFile(join(directory, "history.jsonl"), JSON.stringify({
    at: "2026-01-01T13:00:00Z", kind: "execution_result", executionId: "public-id",
    content: [{ type: "text", text: output }, { type: "image", artifact: "private/path.png" }],
  }) + "\n");
  const found = await host.rpc("analyst", "history.evidence", { query: "PUBLIC-SIGNAL" }) as {
    matches: { source: string; executionId: string; line: number; byteOffset: number; blockIndex: number; text: string; textOffset: number; totalChars: number; truncated: boolean; at: string }[];
  };
  expect(found.matches).toHaveLength(1);
  expect(found.matches[0]).toMatchObject({ source: "execution", executionId: "public-id", blockIndex: 0, at: "2026-01-01T13:00:00Z" });
  expect(found.matches[0]!.text).toContain("PUBLIC-SIGNAL");
  expect(found.matches[0]!.text.length).toBeLessThanOrEqual(320);
  expect(found.matches[0]!.truncated).toBe(true);
  const byLine = await host.rpc("analyst", "history.read", { offset: found.matches[0]!.line - 1, limit: 1 }) as { rows: { text: string }[] };
  expect(JSON.parse(byLine.rows[0]!.text).executionId).toBe("public-id");
  const recovered = await host.rpc("analyst", "history.evidence", {
    byteOffset: found.matches[0]!.byteOffset, blockIndex: 0, textOffset: output.indexOf("PUBLIC-SIGNAL"), textLimit: 13,
  }) as { text: string; totalChars: number };
  expect(recovered.text).toBe("PUBLIC-SIGNAL");
  expect(recovered.totalChars).toBe(output.length);
  const noteText = "PUBLIC-NOTE from an analyst";
  const note = await host.rpc("analyst", "history.note", { text: noteText }) as { recorded: boolean };
  expect(note.recorded).toBe(true);
  const notes = await host.rpc("analyst", "history.evidence", { query: "PUBLIC-NOTE" }) as { matches: { source: string; byteOffset: number }[] };
  expect(notes.matches[0]!.source).toBe("note");
  const recoveredNote = await host.rpc("analyst", "history.evidence", { byteOffset: notes.matches[0]!.byteOffset }) as { text: string };
  expect(recoveredNote.text).toBe(noteText);
  const privateSearch = await host.rpc("analyst", "history.evidence", { query: secret }) as { matches: unknown[] };
  expect(privateSearch.matches).toEqual([]);
  await expect(host.rpc("analyst", "history.evidence", { byteOffset: 0 })).rejects.toThrow("public record");
  await expect(host.rpc("analyst", "history.evidence", { byteOffset: 0, textLimit: 100000 })).rejects.toThrow();
});

test("public evidence bounds its history window, output, queries and snapshot archive", async () => {
  const { host, directory } = await fixture();
  const marker = "late-needle";
  const old = "x".repeat(1024 * 1024 + 100);
  await appendFile(join(directory, "history.jsonl"), JSON.stringify({ kind: "execution_result", content: [{ type: "text", text: old }] }) + "\n");
  await appendFile(join(directory, "history.jsonl"), JSON.stringify({
    kind: "execution_result", at: "2026-01-01T13:00:00Z", executionId: "late-id", content: [{ type: "text", text: `${marker} ${"z".repeat(20000)}` }],
  }) + "\n");
  const result = await host.rpc("analyst", "history.evidence", { query: marker, limit: 1 }) as {
    matches: { byteOffset: number; line: null; executionId: string; text: string }[];
    scanned: { historyBytes: number; snapshotBytes: number }; incomplete: boolean;
  };
  expect(result.matches[0]).toMatchObject({ line: null, executionId: "late-id" });
  expect(result.scanned.historyBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(result.incomplete).toBe(true);
  const recovered = await host.rpc("analyst", "history.evidence", { byteOffset: result.matches[0]!.byteOffset, textLimit: marker.length }) as { text: string };
  expect(recovered.text).toBe(marker);
  await expect(host.rpc("analyst", "history.evidence", { query: "a", limit: 1 })).rejects.toThrow();
  await expect(host.rpc("analyst", "history.evidence", { query: marker, limit: 9 })).rejects.toThrow();
  await expect(host.rpc("analyst", "history.evidence", { query: marker, snapshotId: "../provider-session" })).rejects.toThrow();
  const oldId = "s-22222222-2222-4222-8222-222222222222";
  await writeFile(join(directory, "snapshots", `${oldId}.json`), JSON.stringify({ snapshotId: oldId, turn: 2, cities: [{ name: marker }] }));
  const found = await host.rpc("analyst", "history.evidence", { query: marker, snapshotId: oldId }) as { matches: { source: string; ageTurns: number | null; coverage: unknown; sections: unknown }[] };
  expect(found.matches.find(match => match.source === "snapshot")).toMatchObject({ ageTurns: null, coverage: null, sections: null });
  const link = "s-33333333-3333-4333-8333-333333333333";
  await writeFile(join(directory, "provider-session.json"), JSON.stringify({ snapshotId: link, name: marker }));
  try {
    await symlink(join(directory, "provider-session.json"), join(directory, "snapshots", `${link}.json`), "file");
    const linked = await host.rpc("analyst", "history.evidence", { query: marker, snapshotId: link }) as { matches: { source: string }[]; incomplete: boolean };
    expect(linked.matches.every(match => match.source !== "snapshot")).toBe(true);
    expect(linked.incomplete).toBe(true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
});

test("public evidence prefers recent matches when the output limit is reached", async () => {
  const { host, directory } = await fixture();
  await appendFile(join(directory, "history.jsonl"),
    JSON.stringify({ kind: "note", text: "route-memory older" }) + "\n" +
    JSON.stringify({ kind: "note", text: "route-memory latest" }) + "\n");
  const result = await host.rpc("analyst", "history.evidence", { query: "route-memory", limit: 1 }) as {
    matches: { source: string; text: string; byteOffset: number }[];
  };
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]).toMatchObject({ source: "note", text: "route-memory latest" });
  const recovered = await host.rpc("analyst", "history.evidence", { byteOffset: result.matches[0]!.byteOffset }) as { text: string };
  expect(recovered.text).toBe("route-memory latest");
});

test("public evidence retains the latest capture when older archives exceed the directory window", async () => {
  const { host, directory } = await fixture();
  await Promise.all(Array.from({ length: 260 }, (_, index) => {
    const snapshotId = `s-${index.toString(16).padStart(8, "0")}`;
    return writeFile(join(directory, "snapshots", `${snapshotId}.json`), JSON.stringify({ snapshotId, turn: 1 }));
  }));
  host.bridge.preparePresentation = async () => ({ observed: [], presented: [], dismissed: [], advanced: [], resolved: [], remaining: [], callbackFailures: [], unavailable: {}, more: false });
  host.bridge.request = async () => ({ turn: 12, gameId: "current-game", playerId: 0, headline: "Latest Needle" });
  host.bridge.exportKnowledge = () => null;
  const latest = await host.rpc("main", "civ.snapshot", {}) as { snapshotId: string };
  const found = await host.rpc("analyst", "history.evidence", { query: "Latest Needle" }) as {
    matches: { source: string; snapshotId: string; pointer: string }[];
    latestSnapshotId: string; scanned: { snapshots: number }; incomplete: boolean;
  };
  expect(found.latestSnapshotId).toBe(latest.snapshotId);
  expect(found.matches[0]).toMatchObject({ source: "snapshot", snapshotId: latest.snapshotId, pointer: "/headline" });
  expect(found.scanned.snapshots).toBeLessThanOrEqual(16);
  expect(found.incomplete).toBe(true);
});

test("complaints expose readable bounded public evidence without private host paths", async () => {
  const { host, directory } = await fixture();
  await host.rpc("main", "history.read", {});
  await writeFile(join(directory, "private.json"), "opaque-private-provider-state");
  const records = Array.from({ length: 25 }, (_, index) => JSON.stringify({ index, payload: "a".repeat(4000), end: "recover-me" }));
  await appendFile(join(directory, "history.jsonl"), records.join("\n") + "\n");
  await host.setController("analyst");
  const result = await host.rpc("analyst", "harness.complain", { note: "Missing action feedback" }) as { logged: boolean; complaintId: string; artifact: string };
  expect(result.logged).toBe(true);
  expect(result.artifact).toMatch(/^complaints\/[a-f0-9-]+\.json$/);
  expect(JSON.stringify(result)).not.toContain(JSON.stringify(directory).slice(1, -1));
  const saved = await host.rpc("main", "artifact.read", { name: result.artifact, limit: 50000 }) as { content: string; truncated: boolean };
  expect(saved.truncated).toBe(false);
  expect(saved.content).not.toContain("opaque-private-provider-state");
  expect(saved.content).not.toContain(JSON.stringify(directory).slice(1, -1));
  const complaint = JSON.parse(saved.content);
  expect(complaint.complaintId).toBe(result.complaintId);
  expect(complaint.note).toBe("Missing action feedback");
  expect(complaint.agentId).toBe("analyst");
  expect(complaint.controller).toBe("analyst");
  expect(complaint.lastObservedSnapshot).toBeNull();
  expect(complaint.trace.total).toBe(27);
  expect(complaint.trace.rows).toHaveLength(20);
  const first = complaint.trace.rows[0];
  expect(first.line).toBe(8);
  expect(first.text).toBe(records[6]!.slice(0, 2000));
  expect(first.totalChars).toBe(records[6]!.length);
  expect(first.textOffset).toBe(0);
  expect(first.truncated).toBe(true);
  expect(JSON.parse(complaint.trace.rows.at(-1).text).controller).toBe("analyst");
  const recovered = await host.rpc("main", "history.read", { offset: first.line - 1, limit: 1, textOffset: records[6]!.indexOf("recover-me"), textLimit: 10 }) as { rows: { text: string }[] };
  expect(recovered.rows[0]!.text).toBe("recover-me");
  const history = await readFile(join(directory, "history.jsonl"), "utf8");
  expect(JSON.parse(history.trimEnd().split("\n").at(-1)!)).toMatchObject({ kind: "complaint", complaintId: result.complaintId });
});

test("simultaneous complaints retain distinct complete artifacts", async () => {
  const { host } = await fixture();
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    host.rpc("main", "harness.complain", { note: `Report ${index}` }) as Promise<{ complaintId: string; artifact: string }>));
  expect(new Set(results.map(result => result.complaintId)).size).toBe(12);
  for (const [index, result] of results.entries()) {
    const saved = await host.rpc("main", "artifact.read", { name: result.artifact, limit: 50000 }) as { content: string };
    expect(JSON.parse(saved.content).note).toBe(`Report ${index}`);
  }
});

test("complaints reject invalid notes and missing evidence instead of claiming success", async () => {
  const { host, directory } = await fixture();
  for (const note of [undefined, "", "  ", 42, "a".repeat(12001)]) {
    await expect(host.rpc("main", "harness.complain", { note })).rejects.toThrow();
  }
  await host.rpc("main", "history.read", {});
  await rm(join(directory, "history.jsonl"));
  await expect(host.rpc("main", "harness.complain", { note: "Evidence unavailable" })).rejects.toThrow();
  expect(await host.rpc("main", "artifact.list", { prefix: "complaints/" })).toEqual({ files: [], limit: 1000 });
});

test("concurrent artifact replacements publish complete versions to readers", async () => {
  const { host } = await fixture();
  const versions = ["a", "b"].map(value => JSON.stringify({ value: value.repeat(16000) }));
  await host.rpc("main", "artifact.write", { name: "shared.json", content: versions[0] });
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    await host.rpc(`analyst${index}`, "artifact.write", { name: "shared.json", content: versions[index % 2] });
    const result = await host.rpc("main", "artifact.read", { name: "shared.json", limit: 50000 }) as { content: string };
    expect(versions).toContain(result.content);
  }));
});

async function consoleRun(lines: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "civ-console-"));
  consoleDirectories.push(directory);
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    provider: "openai", baseUrl: "http://127.0.0.1:1", maxModelCalls: 9,
    pythonPath: join(directory, "no-desktop-python.exe"), distro: "no-live-sandbox",
  }));
  const runDir = join(directory, "run");
  const child = Bun.spawn([
    process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "play", "--config", configPath, "--run", runDir,
  ], {
    stdin: new Blob([lines.join("\n") + "\n"]), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OPENAI_API_KEY: "offline-console-test-not-a-real-key" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode, runDir };
}

test("console status reflects granted control and calls used; usage and quit stay offline", async () => {
  const result = await consoleRun(["/control analyst", "/status", "/agents", "/usage", "/quit", "Never dispatch this prompt"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Control: analyst");
  expect(result.stdout).toContain("Calls: 0/9");
  expect(result.stdout).toContain("main: idle");
  expect(result.stdout).toContain("API-equivalent");
  const registry = JSON.parse(await readFile(join(result.runDir, "player", "agents.json"), "utf8"));
  expect(registry.calls).toBe(0);
});

test("abort discards queued prompts without launching desktop or Python workers", async () => {
  const result = await consoleRun(["Never dispatch this prompt", "/abort", "/usage", "/quit"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const registry = JSON.parse(await readFile(join(result.runDir, "player", "agents.json"), "utf8"));
  expect(registry.calls).toBe(0);
});

test("unknown console commands fail visibly instead of becoming model prompts", async () => {
  const result = await consoleRun(["/usgae", "/quit"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Unknown console command");
  const registry = JSON.parse(await readFile(join(result.runDir, "player", "agents.json"), "utf8"));
  expect(registry.calls).toBe(0);
});
