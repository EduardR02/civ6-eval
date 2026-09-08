import { spawn } from "node:child_process";
import path from "node:path";
import type { Arguments, DesktopOptions } from "./contracts.ts";
import { JsonLineChannel } from "./execution.ts";

class DesktopTimeoutError extends Error {}

async function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new DesktopTimeoutError(`Native desktop request exceeded ${milliseconds} ms; earlier actions may already have changed the game`)), milliseconds);
  try { return await Promise.race([operation, expired.promise]); }
  finally { clearTimeout(timer); }
}

/** Native Windows Civ-only desktop worker. Never expose this process to sandbox code. */
export class DesktopService {
  private channel: JsonLineChannel | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private recovering: Promise<void> | undefined;

  constructor(private options: DesktopOptions) {}

  private getChannel(): JsonLineChannel {
    if (this.closed) throw new Error("Desktop service is closed");
    if (!this.channel) {
      this.channel = new JsonLineChannel(this.options.pythonPath, ["-u", path.join(this.options.projectRoot, "python", "desktop_worker.py")], message => {
        throw new Error(`Unexpected native desktop message: ${String(message.type)}`);
      }, this.options.projectRoot, { maxRequestBytes: 1024 * 1024 });
    }
    return this.channel;
  }

  async request(method: string, args: Arguments = {}): Promise<unknown> {
    if (typeof method !== "string" || !method.startsWith("desktop.")) throw new Error("DesktopService accepts only desktop.* methods");
    if (this.recovering) await this.recovering;
    const channel = this.getChannel();
    // Cancellation bypasses the native action loop and releases input immediately.
    try {
      return await deadline(channel.request({ type: method === "desktop.cancel" ? "cancel" : "request", method, args }), method === "desktop.cancel" ? 5_000 : 120_000);
    } catch (error) {
      if (error instanceof DesktopTimeoutError) {
        if (!this.recovering) {
          this.recovering = (async () => {
            try {
              await deadline(channel.request({ type: "cancel" }), 5_000);
            } catch {
              // A stuck native API cannot confirm key release. Shut down and
              // remain closed rather than silently retrying input in a new worker.
              await this.close();
              throw new Error("Native desktop timed out; service closed because input release could not be confirmed");
            }
          })();
        }
        try { await this.recovering; }
        finally { this.recovering = undefined; }
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const channel = this.channel;
    if (!channel) return;
    this.closing = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = Promise.withResolvers<never>();
      timer = setTimeout(() => deadline.reject(new Error("Native desktop shutdown timed out")), 5_000);
      try {
        await Promise.race([channel.request({ type: "close" }), deadline.promise]);
        await Promise.race([channel.exited, deadline.promise]);
      } catch (error) {
        if (channel.alive && channel.child.pid) {
          const terminated = Promise.withResolvers<void>();
          const killer = spawn("taskkill.exe", ["/PID", String(channel.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", terminated.resolve);
          killer.once("exit", terminated.resolve);
          await terminated.promise;
        }
        throw new Error(`Desktop shutdown could not confirm input release: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
        channel.fail(new Error("Desktop service closed"));
      }
    })();
    return this.closing;
  }
}
