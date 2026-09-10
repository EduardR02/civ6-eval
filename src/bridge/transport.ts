import { createConnection, type Socket } from "node:net";

export interface TunerFrame { tag: number; payload: string }
const MAX_FRAME = 8 * 1024 * 1024;

/** Distinguish initial setup failures from loss of a previously reachable game. */
function connectFailureMessage(established: boolean, host: string, port: number, detail: string): string {
  return established
    ? `Cannot reconnect to Civ VI at ${host}:${port}: ${detail}. The previously working game connection is unavailable. Ask the operator to restore access, then reobserve; interrupted requests are not replayed.`
    : `Cannot connect to FireTuner at ${host}:${port}: ${detail}. EnableTuner=1 requires restarting Civ VI.`;
}

function connectTimeoutMessage(established: boolean, host: string, port: number): string {
  return established
    ? `FireTuner connection timed out at ${host}:${port}; the previously connected game process is unreachable or has exited.`
    : `FireTuner connection timed out at ${host}:${port}; enable EnableTuner=1 and restart Civ VI.`;
}

/** Nexus framing is payload length (not total frame length), then signed tag, then UTF-8/NUL. */
export class TunerTransport {
  private socket?: Socket;
  private header = Buffer.alloc(8);
  private headerUsed = 0;
  private body?: Buffer;
  private bodyUsed = 0;
  private tag = 0;
  private queued: TunerFrame[] = [];
  private queuedBytes = 0;
  private receiver?: { resolve: (frame: TunerFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private failure?: Error;
  /** Retain connection history across reconnects so setup hints do not mask a lost game. */
  private everConnected = false;

  get connected(): boolean { return !!this.socket && !this.socket.destroyed && !this.failure; }

  async connect(host: string, port: number, timeoutMs: number): Promise<void> {
    this.close();
    this.failure = undefined;
    this.headerUsed = 0;
    this.body = undefined;
    this.bodyUsed = 0;
    this.queued = [];
    this.queuedBytes = 0;
    const socket = createConnection({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (bytes: Buffer) => this.consume(bytes));
    socket.on("error", error => this.fail(this.lost(error)));
    socket.on("close", () => this.fail(this.lost(new Error("connection closed"))));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(connectTimeoutMessage(this.everConnected, host, port)));
    }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); this.everConnected = true; resolve(); });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(new Error(connectFailureMessage(this.everConnected, host, port, error.message)));
    });
    socket.once("close", () => { clearTimeout(timer); reject(new Error("FireTuner connection closed before ready.")); });
    await promise;
  }

  private consume(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length && !this.failure) {
      if (!this.body) {
        const take = Math.min(8 - this.headerUsed, bytes.length - offset);
        bytes.copy(this.header, this.headerUsed, offset, offset + take);
        this.headerUsed += take;
        offset += take;
        if (this.headerUsed < 8) continue;
        const length = this.header.readUInt32LE(0);
        this.tag = this.header.readInt32LE(4);
        this.headerUsed = 0;
        if (length < 1 || length > MAX_FRAME) { this.fail(new Error(`Invalid FireTuner frame length ${length}.`)); return; }
        this.body = Buffer.allocUnsafe(length);
        this.bodyUsed = 0;
      }
      const take = Math.min(this.body.length - this.bodyUsed, bytes.length - offset);
      bytes.copy(this.body, this.bodyUsed, offset, offset + take);
      offset += take;
      this.bodyUsed += take;
      if (this.bodyUsed !== this.body.length) continue;
      let end = this.body.length;
      while (end && this.body[end - 1] === 0) end--;
      const frame = { tag: this.tag, payload: this.body.toString("utf8", 0, end) };
      this.body = undefined;
      if (this.receiver) {
        const receiver = this.receiver;
        this.receiver = undefined;
        clearTimeout(receiver.timer);
        receiver.resolve(frame);
      } else {
        this.queuedBytes += Buffer.byteLength(frame.payload);
        if (this.queued.length >= 4096 || this.queuedBytes > MAX_FRAME * 2) { this.fail(new Error("FireTuner unsolicited output exceeded queue bound.")); return; }
        this.queued.push(frame);
      }
    }
  }

  async send(tag: number, payload: string): Promise<void> {
    if (!this.connected) throw this.failure ?? new Error("FireTuner is not connected.");
    const length = Buffer.byteLength(payload) + 1;
    if (length > MAX_FRAME) throw new Error("FireTuner command exceeds frame bound.");
    const frame = Buffer.allocUnsafe(length + 8);
    frame.writeUInt32LE(length, 0);
    frame.writeInt32LE(tag, 4);
    frame.write(payload, 8, "utf8");
    frame[frame.length - 1] = 0;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.socket!.write(frame, error => error ? reject(error) : resolve());
    await promise;
  }

  receive(timeoutMs: number): Promise<TunerFrame> {
    if (this.failure) return Promise.reject(this.failure);
    const frame = this.queued.shift();
    if (frame) { this.queuedBytes -= Buffer.byteLength(frame.payload); return Promise.resolve(frame); }
    if (this.receiver) return Promise.reject(new Error("Concurrent FireTuner receive is not permitted."));
    const { promise, resolve, reject } = Promise.withResolvers<TunerFrame>();
    const timer = setTimeout(() => {
      this.receiver = undefined;
      const error = new Error("FireTuner response timed out. Request outcome may be unknown; mutations are never replayed automatically.");
      this.fail(error);
      reject(error);
    }, Math.max(1, timeoutMs));
    this.receiver = { resolve, reject, timer };
    return promise;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.receiver) {
      clearTimeout(this.receiver.timer);
      this.receiver.reject(this.failure);
      this.receiver = undefined;
    }
    this.socket?.destroy();
  }

  /** A lost socket cannot establish whether the game crashed, exited, or became unreachable. */
  private lost(error: Error): Error {
    if (!this.everConnected) return error;
    return new Error(`FireTuner connection lost: the Civ VI process is unreachable or has exited (${error.message}). Ask the operator to restore access, then reobserve; interrupted requests may have unknown outcomes and are not replayed.`);
  }

  close(): void {
    this.fail(new Error("FireTuner transport closed."));
    this.socket?.removeAllListeners();
    this.socket = undefined;
    this.queued = [];
    this.queuedBytes = 0;
  }
}
