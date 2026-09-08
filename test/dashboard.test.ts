import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunView } from "../src/dashboard.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "civ-dashboard-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
function message(timestamp: string, role: string, content: unknown[], extra: Record<string, unknown> = {}): string {
  return line({ type: "message", id: "m", parentId: null, timestamp, message: { role, content, ...extra } });
}

test("dashboard merges ledgers: zip fallback, turns, display images, compaction, failed HTTP", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, "2026-09-08T10-00-00-000Z_s1.jsonl"),
    line({ type: "session", version: 3, id: "s1", timestamp: "2026-09-08T10:00:00.000Z" })
    + line({ type: "model_change", timestamp: "2026-09-08T10:00:00.001Z", provider: "opencode-go", modelId: "glm-5.3-flash" })
    + message("2026-09-08T10:00:00.000Z", "user", [{ type: "text", text: "play turn 1" }])
    + message("2026-09-08T10:00:01.000Z", "assistant", [
      { type: "thinking", thinking: "capture first" },
      { type: "toolCall", name: "exec_py", arguments: { code: "civ.snapshot()" } },
    ], { stopReason: "toolUse" })
    + message("2026-09-08T10:00:02.000Z", "toolResult", [
      { type: "image", data: "base64dropped" },
      { type: "text", text: "stdout: ready" },
    ])
    + message("2026-09-08T10:00:04.000Z", "assistant", [{ type: "text", text: "done" }], {
      stopReason: "stop",
      usage: { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 300, reasoning: 100, cost: { total: 0.02 } },
    }));
  writeFileSync(join(dir, "usage.jsonl"),
    line({ time: "2026-09-08T10:00:01.000Z", version: 1, type: "start", request: { requestId: "r1", agentId: "main", kind: "completions" } })
    + line({ time: "2026-09-08T10:00:01.900Z", version: 1, type: "usage", requestId: "r1", tokens: { input: 100, cacheRead: 20, cacheWrite: 5, output: 10, reasoning: 4 }, estimatedUsd: 0.01 })
    + line({ time: "2026-09-08T10:00:03.000Z", version: 1, type: "start", request: { requestId: "c9", agentId: "main", kind: "compact" } })
    + line({ time: "2026-09-08T10:00:03.500Z", version: 1, type: "usage", requestId: "c9", tokens: { input: 900, cacheRead: 0, cacheWrite: 0, output: 50, reasoning: 0 }, estimatedUsd: 0.5 })
    + line({ time: "2026-09-08T10:00:04.000Z", version: 1, type: "start", request: { requestId: "r2", agentId: "main", kind: "completions" } })
    + line({ time: "2026-09-08T10:00:04.900Z", version: 1, type: "usage", requestId: "r2", tokens: { input: 777, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, estimatedUsd: 0.01 }));
  writeFileSync(join(dir, "history.jsonl"),
    line({ at: "2026-09-08T10:00:02.500Z", kind: "execution_result", workspaceFiles: [".executions/e1/display-1.png", ".executions/e1/stdout.txt"], artifacts: ["executions/main/a1-0.png"] })
    + line({ at: "2026-09-08T10:00:03.000Z", kind: "request", method: "civ.action", args: { action: "end_turn" } }));
  writeFileSync(join(main, "provider.jsonl"),
    line({ time: "2026-09-08T10:00:05.000Z", kind: "request_end", outcome: "failed", httpStatus: 413 }));

  const view = new RunView();
  await view.refresh(dir);
  expect(view.entries.length).toBe(4); // user, assistant, toolResult, assistant
  expect(view.endTurns).toEqual(["2026-09-08T10:00:03.000Z"]);
  expect(view.display).toEqual(["workspaces/main/.executions/e1/display-1.png"]); // workspace copy wins over artifact copy
  expect(view.model).toBe("glm-5.3-flash · opencode-go");
  const html = view.render(0, 5, "test-run");
  expect(html).toContain("<title>test-run run viewer</title>");
  expect(html).toContain("— turn 2 —"); // end_turn at 10:00:03 splits the second assistant into turn 2
  expect(html).toContain('src="workspaces/main/.executions/e1/display-1.png"');
  expect(html).toContain("fresh 100 · cached 20"); // zip fallback: session message carried no usage
  expect(html).toContain("fresh 1,000 · cached 2,000"); // session message usage preferred over ledger
  expect(html).toContain("final HTTP 413");
  expect(html).toContain("compaction 10:00:03"); // compact request time via usage.jsonl fallback
  expect(html).toContain("3 requests · est $0.52 (0 unpriced)"); // compaction usage counted in totals, not zipped
  expect(html).not.toContain("a1-0.png"); // artifact copy not double-mapped
});

test("appended tails, torn lines, resumed sessions and shrunk sources update without duplication", async () => {
  const dir = directory();
  const main = join(dir, "player", "agents", "main");
  mkdirSync(main, { recursive: true });
  const session = join(main, "2026-09-08T10-00-00-000Z_s1.jsonl");
  writeFileSync(session, message("2026-09-08T10:00:00.000Z", "user", [{ type: "text", text: "go" }]));
  writeFileSync(join(dir, "usage.jsonl"), line({ time: "2026-09-08T10:00:00.000Z", version: 1, type: "start", request: { requestId: "r1", agentId: "main", kind: "completions" } }));
  const view = new RunView();
  await view.refresh(dir);
  expect(view.entries.length).toBe(1);

  appendFileSync(session, '{"type":"message","timestamp":"2026-09-08T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"partial');
  await view.refresh(dir);
  expect(view.entries.length).toBe(1); // torn line held back, not duplicated

  appendFileSync(session, ' line"}],"stopReason":"stop","usage":{"input":5,"output":1}}}\n');
  await view.refresh(dir);
  expect(view.entries.length).toBe(2);
  expect(view.entries[1]!.blocks[0]).toEqual({ type: "text", text: "partial line" });
  expect(view.entries[1]!.usage?.input).toBe(5);

  writeFileSync(join(main, "2026-09-08T10-05-00-000Z_s2.jsonl"), message("2026-09-08T10:05:00.000Z", "assistant", [{ type: "text", text: "resumed" }], { stopReason: "stop" }));
  await view.refresh(dir);
  expect(view.entries.length).toBe(3); // resumed session merged chronologically

  writeFileSync(session, message("2026-09-08T10:00:00.000Z", "user", [{ type: "text", text: "rewritten" }])); // shrunk below offset
  await view.refresh(dir);
  expect(view.entries.length).toBe(2); // s1 reparsed from scratch, s2 retained
  expect(view.entries[0]!.blocks[0]).toEqual({ type: "text", text: "rewritten" });
  expect(view.render(0, 1, "test-run")).not.toContain("partial");
});
