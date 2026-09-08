import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Arguments, Content, ExecuteOptions, ExecutionOptions, ExecutionResult } from "./contracts.ts";

const MAX_WIRE_BYTES = 48 * 1024 * 1024;
const MAX_CODE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 1_800_000;

type Message = Record<string, unknown>;

interface ChannelOptions {
  maxRequestBytes?: number;
  firstMessage?: (message: Message) => void;
}

/** Private JSONL transport shared by the isolated and native Python services. */
export class JsonLineChannel {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private dead: Error | undefined;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private exitResolve!: () => void;
  private stderr = "";
  private fragments: string[] = [];
  private fragmentBytes = 0;
  private decoder = new StringDecoder("utf8");
  private readyTimer: NodeJS.Timeout;

  constructor(command: string, args: string[], private onMessage: (message: Message) => void | Promise<void>, cwd?: string, private options: ChannelOptions = {}) {
    const ready = Promise.withResolvers<void>();
    this.ready = ready.promise;
    this.readyResolve = ready.resolve;
    this.readyReject = ready.reject;
    // A failed startup can precede the first caller's await.
    void this.ready.catch(() => {});
    const exited = Promise.withResolvers<void>();
    this.exited = exited.promise;
    this.exitResolve = exited.resolve;
    this.child = spawn(command, args, { cwd, stdio: "pipe", windowsHide: true });
    this.readyTimer = setTimeout(() => this.fail(new Error("Python worker did not become ready within 30 seconds")), 30_000);
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16_384); });
    this.child.stdin.on("error", error => this.fail(error));
    this.child.on("error", error => { this.fail(error); this.exitResolve(); });
    this.child.on("exit", (code, signal) => {
      this.fail(new Error(`Python worker exited (${signal ?? code})${this.stderr ? `: ${this.stderr}` : ""}`));
      this.exitResolve();
    });
  }

  get alive(): boolean { return this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined; }

  private consume(text: string): void {
    if (this.dead) return;
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      const part = end < 0 ? text.slice(start) : text.slice(start, end);
      this.fragmentBytes += Buffer.byteLength(part);
      if (this.fragmentBytes > MAX_WIRE_BYTES) {
        this.fail(new Error("Python worker exceeded the JSONL message size limit"));
        this.child.stdout.pause();
        return;
      }
      if (part) this.fragments.push(part);
      if (end < 0) return;
      const line = this.fragments.join("");
      this.fragments = [];
      this.fragmentBytes = 0;
      if (line.trim()) {
        try { this.receive(JSON.parse(line)); }
        catch (error) { this.fail(new Error(`Invalid Python worker protocol: ${error instanceof Error ? error.message : String(error)}`)); return; }
      }
      if (this.dead) return;
      start = end + 1;
    }
  }

  private receive(message: Message): void {
    if (this.dead) return;
    if (!message || typeof message !== "object" || typeof message.type !== "string") throw new Error("message must have a type");
    if (this.options.firstMessage) {
      const accept = this.options.firstMessage;
      this.options.firstMessage = undefined;
      accept(message);
      return;
    }
    if (message.type === "ready") { clearTimeout(this.readyTimer); this.readyResolve(); return; }
    if (message.type === "result") {
      const entry = this.pending.get(String(message.id));
      if (!entry) throw new Error(`unknown response id ${String(message.id)}`);
      this.pending.delete(String(message.id));
      if (message.error !== undefined) entry.reject(new Error(String(message.error)));
      else entry.resolve(message.result);
      return;
    }
    Promise.resolve(this.onMessage(message)).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  fail(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    clearTimeout(this.readyTimer);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.child.stdout.pause();
    this.readyReject(error);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  send(message: Message): void {
    if (this.dead) throw this.dead;
    const encoded = JSON.stringify(message) + "\n";
    const limit = this.options.maxRequestBytes ?? MAX_WIRE_BYTES;
    if (Buffer.byteLength(encoded) > limit) throw new Error(`RPC request exceeds the ${limit / (1024 * 1024)} MiB wire limit; use artifacts for large data`);
    this.child.stdin.write(encoded);
  }

  async request(payload: Message): Promise<unknown> {
    await this.ready;
    if (this.dead) throw this.dead;
    const id = `host-${++this.nextId}`;
    const response = Promise.withResolvers<unknown>();
    this.pending.set(id, response);
    try { this.send({ ...payload, id }); }
    catch (error) { this.pending.delete(id); response.reject(error); }
    return response.promise;
  }
}

function linuxPath(value: string): string {
  const absolute = path.resolve(value);
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (!drive) throw new Error(`WSL launcher requires an absolute Windows drive path, received ${absolute}`);
  return `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`;
}

async function runTermination(command: string, args: string[]): Promise<void> {
  const terminated = Promise.withResolvers<void>();
  const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
  const timer = setTimeout(() => { child.kill(); terminated.resolve(); }, 5_000);
  child.once("error", () => { clearTimeout(timer); terminated.resolve(); });
  child.once("exit", () => { clearTimeout(timer); terminated.resolve(); });
  await terminated.promise;
}

interface Worker {
  channel: JsonLineChannel;
  linuxPid?: number;
  stopping?: Promise<void>;
}

/** Persistent arbitrary Python in a networkless Linux user/mount/PID namespace, never a native fallback. */
export class ExecutionService {
  private workers = new Map<string, Worker>();
  private queues = new Map<string, Promise<unknown>>();
  private epochs = new Map<string, number>();
  private closed = false;

  constructor(private options: ExecutionOptions) {}

  private validateAgent(agentId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error("Invalid agent id");
  }

  private async createWorker(agentId: string): Promise<Worker> {
    const workspace = path.join(this.options.runDir, "workspaces", agentId);
    await mkdir(workspace, { recursive: true });
    if (this.closed) throw new Error("Execution service is closed");
    const args = [
      "-d", this.options.distro ?? "Ubuntu-24.04", "-u", "root", "--",
      "/bin/sh", linuxPath(path.join(this.options.projectRoot, "python", "launch.sh")),
      "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--dir", "/etc", "--ro-bind", "/etc/alternatives", "/etc/alternatives",
      "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--dir", "/opt", "--ro-bind", linuxPath(path.join(this.options.projectRoot, "python", "worker.py")), "/opt/worker.py",
      "--bind", linuxPath(workspace), "/workspace", "--chdir", "/workspace",
      "--uid", "1000", "--gid", "1000", "--cap-drop", "ALL", "--hostname", "astra",
      "--setenv", "HOME", "/workspace", "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "LANG", "C.UTF-8", "--setenv", "PYTHONUNBUFFERED", "1",
      "--setenv", "OPENBLAS_NUM_THREADS", "1", "--setenv", "OMP_NUM_THREADS", "1",
      "/usr/bin/python3", "-u", "/opt/worker.py",
    ];
    let worker!: Worker;
    const channel = new JsonLineChannel("wsl.exe", args, message => {
      if (worker.stopping) return;
      if (message.type !== "rpc" || typeof message.id !== "string" || typeof message.method !== "string" || !message.args || typeof message.args !== "object" || Array.isArray(message.args)) {
        throw new Error("Malformed Python RPC request");
      }
      return (async () => {
        try {
          const result = await this.options.rpc(agentId, message.method as string, message.args as Arguments);
          if (!worker.stopping) channel.send({ type: "rpc_result", id: message.id, result: result ?? null });
        } catch (error) {
          if (!worker.stopping) channel.send({ type: "rpc_result", id: message.id, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    }, undefined, {
      firstMessage: message => {
        if (message.type !== "sandbox" || typeof message.pid !== "number" || !Number.isSafeInteger(message.pid) || message.pid <= 1) {
          throw new Error("Expected the trusted sandbox launcher PID before worker startup");
        }
        worker.linuxPid = message.pid;
      },
    });
    worker = { channel };
    this.workers.set(agentId, worker);
    try { await channel.ready; return worker; }
    catch (error) { await this.stopWorker(agentId, worker); throw error; }
  }

  private async stopWorker(agentId: string, worker: Worker): Promise<void> {
    if (worker.stopping) return worker.stopping;
    worker.stopping = (async () => {
      worker.channel.fail(new Error("Python namespace was terminated and is lost; workspace files remain. Executed code is never retried."));
      // Killing the outer bwrap process triggers --die-with-parent in its PID namespace.
      if (worker.channel.alive && worker.linuxPid) {
        await runTermination("wsl.exe", ["-d", this.options.distro ?? "Ubuntu-24.04", "-u", "root", "--", "/bin/kill", "-KILL", String(worker.linuxPid)]);
      }
      if (worker.channel.alive && worker.channel.child.pid) {
        await runTermination("taskkill.exe", ["/PID", String(worker.channel.child.pid), "/T", "/F"]);
      }
      if (this.workers.get(agentId) === worker) this.workers.delete(agentId);
    })();
    return worker.stopping;
  }

  async execute(agentId: string, code: string, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    this.validateAgent(agentId);
    if (typeof code !== "string" || Buffer.byteLength(code) > MAX_CODE_BYTES) throw new Error("Python code must be a string no larger than 1 MiB");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
    const epoch = this.epochs.get(agentId) ?? 0;
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async (): Promise<ExecutionResult> => {
      if (this.closed) throw new Error("Execution service is closed");
      if ((this.epochs.get(agentId) ?? 0) !== epoch) throw new Error("Execution was cancelled by a namespace reset before it started");
      if (options.signal?.aborted) throw new Error("Execution cancelled before it started; code was not run");
      let worker: Worker | undefined;
      let timer: NodeJS.Timeout | undefined;
      let abort: (() => void) | undefined;
      try {
        worker = this.workers.get(agentId) ?? await this.createWorker(agentId);
        if (this.closed || (this.epochs.get(agentId) ?? 0) !== epoch || options.signal?.aborted) {
          await this.stopWorker(agentId, worker);
          throw new Error("Execution cancelled during startup; code was not run");
        }
        const activeWorker = worker;
        const interrupted = Promise.withResolvers<never>();
        const interrupt = (reason: string) => {
          interrupted.reject(new Error(`${reason}. Python namespace is lost; earlier game actions and files may already have changed. Code was not retried.`));
          void this.stopWorker(agentId, activeWorker);
        };
        timer = setTimeout(() => interrupt(`Execution exceeded ${timeoutMs} ms`), timeoutMs);
        abort = () => interrupt("Execution cancelled");
        options.signal?.addEventListener("abort", abort, { once: true });
        const result = await Promise.race([worker.channel.request({ type: "execute", code }), interrupted.promise]);
        if (!result || typeof result !== "object" || !Array.isArray((result as ExecutionResult).content)) throw new Error("Malformed Python execution result");
        return result as ExecutionResult;
      } catch (error) {
        if (worker) await this.stopWorker(agentId, worker);
        return { isError: true, content: [{ type: "text", text: `${error instanceof Error ? error.message : String(error)}\nThe Python namespace is unavailable. Start a fresh execution to recreate it; inspect game state before repeating any action.` } satisfies Content] };
      } finally {
        clearTimeout(timer);
        if (abort) options.signal?.removeEventListener("abort", abort);
      }
    });
    this.queues.set(agentId, operation);
    void operation.finally(() => { if (this.queues.get(agentId) === operation) this.queues.delete(agentId); }).catch(() => {});
    return operation;
  }

  async reset(agentId: string): Promise<void> {
    this.validateAgent(agentId);
    this.epochs.set(agentId, (this.epochs.get(agentId) ?? 0) + 1);
    const worker = this.workers.get(agentId);
    if (worker) await this.stopWorker(agentId, worker);
    await this.queues.get(agentId)?.catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workers].map(([id, worker]) => this.stopWorker(id, worker)));
    await Promise.allSettled([...this.queues.values()]);
  }
}
