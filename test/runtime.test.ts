import { afterEach, expect, test } from "bun:test";
import { JsonLineChannel } from "../src/execution.ts";

const channels: JsonLineChannel[] = [];
afterEach(async () => {
  await Promise.all(channels.splice(0).map(async channel => {
    channel.fail(new Error("Test complete"));
    channel.child.kill();
    await channel.exited;
  }));
});

const echoWorker = `
process.stdout.write('{"type":"ready"}\\n');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\\n');
    if (end < 0) break;
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    process.stdout.write(JSON.stringify({type:'result', id:request.id, result:request.value}) + '\\n');
  }
});
`;

test("failed channel rejects queued RPCs from the same wire chunk", async () => {
  const seen: string[] = [];
  const channel = new JsonLineChannel(process.execPath, ["-e", `
process.stdout.write('{"type":"ready"}\\n');
process.stdin.once('data', () => {
  process.stdout.write('{"type":"rpc","method":"cancel"}\\n{"type":"rpc","method":"stale"}\\n');
});
`], message => {
    seen.push(String(message.method));
    channel.fail(new Error("Cancelled"));
  });
  channels.push(channel);
  await expect(channel.request({ type: "execute" })).rejects.toThrow("Cancelled");
  expect(seen).toEqual(["cancel"]);
});

test("native request byte limit rejects oversized input without poisoning the channel", async () => {
  const channel = new JsonLineChannel(process.execPath, ["-e", echoWorker], () => {
    throw new Error("Unexpected message");
  }, undefined, { maxRequestBytes: 1024 });
  channels.push(channel);
  await expect(channel.request({ type: "request", value: "é".repeat(600) })).rejects.toThrow("wire limit");
  expect(await channel.request({ type: "request", value: "still usable" })).toBe("still usable");
});

test("launcher identity is consumed only from the first message before ready", async () => {
  const identities: number[] = [];
  const channel = new JsonLineChannel(process.execPath, ["-e", `
process.stdout.write('{"type":"sandbox","pid":123}\\n{"type":"ready"}\\n');
process.stdin.once('data', () => {
  process.stdout.write('{"type":"sandbox","pid":1}\\n{"type":"rpc","method":"stale"}\\n');
});
`], () => { throw new Error("Unexpected sandbox message"); }, undefined, {
    firstMessage: message => {
      if (message.type !== "sandbox") throw new Error("Missing launcher handshake");
      identities.push(Number(message.pid));
    },
  });
  channels.push(channel);
  await expect(channel.request({ type: "execute" })).rejects.toThrow("Unexpected sandbox message");
  expect(identities).toEqual([123]);
});

test("worker readiness cannot precede the trusted launcher handshake", async () => {
  const channel = new JsonLineChannel(process.execPath, ["-e", echoWorker], () => {}, undefined, {
    firstMessage: message => {
      if (message.type !== "sandbox") throw new Error("Missing launcher handshake");
    },
  });
  channels.push(channel);
  await expect(channel.ready).rejects.toThrow("Missing launcher handshake");
});
