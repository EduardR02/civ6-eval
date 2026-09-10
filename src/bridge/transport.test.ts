import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("real TCP framing, timeout, close and game-loss behavior", async () => {
  const child = Bun.spawn([process.execPath, "test", "./test/fixtures/transport.socket.ts"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Socket regression subprocess failed (${exitCode}):\n${stdout}${stderr}`);
  expect(exitCode).toBe(0);
}, 15_000);

