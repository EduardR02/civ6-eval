// Isolate Bun's Windows TCP teardown from the full suite's HTTP/subprocess churn.
import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { TunerTransport } from "../../src/bridge/transport";
const transports: TunerTransport[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  const closed: Promise<unknown>[] = [];
  for (const transport of transports.splice(0)) {
    const socket = transport["socket"];
    transport.close();
    if (socket && !socket.closed) closed.push(once(socket, "close"));
  }
  for (const socket of sockets.splice(0)) {
    if (!socket.closed) closed.push(once(socket, "close"));
    socket.destroy();
  }
  await Promise.all(closed);
  await Promise.all(servers.splice(0).map(server => {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    return promise;
  }));
});

async function connection() {
  const accepted = Promise.withResolvers<Socket>();
  const server = createServer(socket => { sockets.push(socket); accepted.resolve(socket); });
  servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  const transport = new TunerTransport();
  transports.push(transport);
  await transport.connect("127.0.0.1", address.port, 1000);
  return { transport, socket: await accepted.promise };
}

function frame(tag: number, text: string) {
  const body = Buffer.from(text + "\0");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(body.length);
  header.writeInt32LE(tag, 4);
  return Buffer.concat([header, body]);
}

test("fragmented headers and UTF-8 bodies preserve adjacent frame boundaries", async () => {
  const { transport, socket } = await connection();
  const bytes = Buffer.concat([frame(4, "0\0InGame"), frame(3, "O\0InGame: café 漢")]);
  const first = transport.receive(1000);
  for (let offset = 0; offset < bytes.length; offset++) {
    // Wait for this byte to reach the parser so TCP coalescing cannot erase fragmentation.
    const consumed = once(transport["socket"]!, "data");
    socket.write(bytes.subarray(offset, offset + 1));
    await consumed;
  }
  expect(await first).toEqual({ tag: 4, payload: "0\0InGame" });
  expect(await transport.receive(1000)).toEqual({ tag: 3, payload: "O\0InGame: café 漢" });
});

test("oversized frame lengths fail before allocating their claimed body", async () => {
  const { transport, socket } = await connection();
  const result = transport.receive(1000);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xffffffff);
  socket.write(header);
  await expect(result).rejects.toThrow("Invalid FireTuner frame length");
  expect(transport.connected).toBe(false);
});

test("timeout closes the stream and does not replay a submitted command", async () => {
  const { transport, socket } = await connection();
  let received = Buffer.alloc(0);
  socket.on("data", bytes => { received = Buffer.concat([received, typeof bytes === "string" ? Buffer.from(bytes) : bytes]); });
  const ended = once(socket, "end");
  await transport.send(3, "CMD:0:trusted_action()");
  await expect(transport.receive(50)).rejects.toThrow("never replayed");
  await ended;
  expect(received).toEqual(frame(3, "CMD:0:trusted_action()"));
  expect(transport.connected).toBe(false);
});

test("close rejects an active receive rather than leaving a hanging waiter", async () => {
  const { transport } = await connection();
  const result = transport.receive(1000);
  transport.close();
  await expect(result).rejects.toThrow("closed");
});

test("a dropped live session terminates pending reads and refuses further commands", async () => {
  const { transport, socket } = await connection();
  const pending = transport.receive(1000);
  socket.destroy();
  const error = await pending.catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain("EnableTuner");
  expect(transport.connected).toBe(false);
  await expect(transport.send(3, "CMD:0:must_not_replay()")).rejects.toBe(error);
});
