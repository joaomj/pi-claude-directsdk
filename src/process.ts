/**
 * Request-scoped child supervision for the official `claude` executable.
 *
 * Each Pi model call owns one child in its own process group, so abort and
 * failure kill the full tree (the npm `claude` shim is `cmd.exe` -> `node`
 * on Windows; plain `kill()` would orphan the node child holding the real
 * request open). Stdout is consumed as newline-delimited JSON with an idle
 * deadline that resets on every received line.
 */

import { ChildProcess, spawn, spawnSync } from "node:child_process";

import {
  cancelledError,
  timeoutError,
} from "./errors.js";

const STDERR_CAP = 16 * 1024;

/** Kill a process and every descendant. Idempotent. */
export function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`taskkill failed for native process ${pid}: exit ${result.status}, signal ${result.signal}`);
    }
    return;
  }
  try {
    // windows-footgun: guarded, the win32 branch above never reaches this line.
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
    // The process group has already exited.
  }
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ChildHandle {
  writeLine(line: string): Promise<void>;
  closeStdin(): void;
  /** Next stdout line, or null on EOF. Throws on timeout or cancellation. */
  nextLine(): Promise<string | null>;
  /** Observe child closure within timeoutMs, including after cancellation. */
  wait(): Promise<ExitInfo>;
  killTree(): void;
  /** Reject pending reads and kill the tree. */
  cancel(): void;
  readonly exitInfo: ExitInfo | null;
  stderrTail(maxChars?: number): string;
}

export function spawnSupervised(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}): ChildHandle {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("timeoutMs must be positive finite milliseconds");
  }
  const proc = spawn(options.command, options.args, {
    env: options.env,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group on both platforms (CREATE_NEW_PROCESS_GROUP on Windows).
    detached: true,
    windowsHide: true,
  });
  // Keep Pi alive until the request-scoped child closes. One-shot callers
  // must receive final usage and tool calls before the process can exit.

  const queue: string[] = [];
  const waiters: Array<{
    resolve: (line: string | null) => void;
    reject: (error: Error) => void;
  }> = [];
  let stdoutText = "";
  let stdoutClosed = false;
  let exit: ExitInfo | null = null;
  let failed: Error | null = null;
  let cancelled = false;
  let lastActivity = Date.now();
  let stderrBuf = "";
  const exitWaiters = new Set<(info: ExitInfo) => void>();
  const pendingWrites = new Set<(error: Error) => void>();

  const poke = (): void => {
    lastActivity = Date.now();
  };

  const settleWaiter = (line: string | null, error: Error | null): boolean => {
    const waiter = waiters.shift();
    if (!waiter) {
      return false;
    }
    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve(line);
    }
    return true;
  };

  const failAll = (error: Error): void => {
    failed ??= error;
    for (const reject of [...pendingWrites]) reject(failed);
    let waiter = waiters.shift();
    while (waiter) {
      waiter.reject(failed);
      waiter = waiters.shift();
    }
  };

  const terminate = (error: Error): void => {
    let failure = failed ?? error;
    try {
      handle.killTree();
    } catch (killError) {
      failure = new AggregateError([failure, killError], "Native request failed and its process tree could not be terminated");
      failed = failure;
    }
    failAll(failure);
  };
  proc.stdin?.on("error", (error: Error) => terminate(error));
  proc.stdin?.on("close", () => {
    if (pendingWrites.size > 0) terminate(new Error("Native stdin closed before a write completed"));
  });

  proc.stdout?.setEncoding("utf-8");
  proc.stdout?.on("data", (chunk: string) => {
    stdoutText += chunk;
    let index = stdoutText.indexOf("\n");
    while (index !== -1) {
      const line = stdoutText.slice(0, index);
      stdoutText = stdoutText.slice(index + 1);
      poke();
      if (!settleWaiter(line, null)) {
        queue.push(line);
      }
      index = stdoutText.indexOf("\n");
    }
  });
  proc.stdout?.on("close", () => {
    stdoutClosed = true;
    if (stdoutText.length > 0) {
      const line = stdoutText;
      stdoutText = "";
      poke();
      if (!settleWaiter(line, null)) {
        queue.push(line);
      }
    }
    let waiter = waiters.shift();
    while (waiter) {
      waiter.resolve(null);
      waiter = waiters.shift();
    }
  });
  proc.stderr?.setEncoding("utf-8");
  proc.stderr?.on("data", (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_CAP);
  });
  proc.on("error", (error) => {
    failAll(error);
    finish({ code: null, signal: null });
  });
  proc.on("close", (code, signal) => {
    finish({ code, signal });
  });

  const finish = (info: ExitInfo): void => {
    options.signal?.removeEventListener("abort", onAbort);
    if (!exit) {
      exit = info;
    }
    for (const resolve of [...exitWaiters]) resolve(exit);
  };

  const onAbort = (): void => {
    handle.cancel();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      queueMicrotask(onAbort);
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const handle: ChildHandle = {
    async writeLine(line: string): Promise<void> {
      if (failed) throw failed;
      if (cancelled || options.signal?.aborted) throw cancelledError();
      const stdin = proc.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) {
        throw new Error("Child stdin is closed");
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingWrites.delete(onFailure);
          if (error) reject(error);
          else resolve();
        };
        const onFailure = (error: Error): void => finish(error);
        const timer = setTimeout(() => {
          terminate(timeoutError("native stdin did not accept a frame within the request timeout"));
        }, options.timeoutMs);
        timer.unref();
        pendingWrites.add(onFailure);
        try {
          stdin.write(`${line}\n`, (error) => {
            if (error) terminate(error);
            else finish();
          });
        } catch (error) {
          terminate(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    closeStdin(): void {
      proc.stdin?.end();
    },

    async nextLine(): Promise<string | null> {
      for (;;) {
        if (failed) throw failed;
        if (cancelled || options.signal?.aborted) {
          throw cancelledError();
        }
        const queued = queue.shift();
        if (queued !== undefined) {
          return queued;
        }
        if (stdoutClosed) {
          return null;
        }
        const remaining = options.timeoutMs - (Date.now() - lastActivity);
        if (remaining <= 0) {
          terminate(timeoutError("no native output within the request timeout"));
          throw failed;
        }
        const result = await new Promise<string | null>((resolve, reject) => {
          const waiter = {
            resolve: (line: string | null) => {
              clearTimeout(timer);
              resolve(line);
            },
            reject: (error: Error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          const timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            terminate(timeoutError("no native output within the request timeout"));
            waiter.reject(failed!);
          }, remaining);
          timer.unref();
          waiters.push(waiter);
        });
        if (result !== null) {
          return result;
        }
        // EOF marker arrived while waiting.
        if (stdoutClosed && queue.length === 0) {
          return null;
        }
      }
    },

    wait(): Promise<ExitInfo> {
      if (exit) {
        return failed && !cancelled ? Promise.reject(failed) : Promise.resolve(exit);
      }
      return new Promise((resolve, reject) => {
        const onExit = (info: ExitInfo): void => {
          clearTimeout(timer);
          exitWaiters.delete(onExit);
          if (failed && !cancelled) reject(failed);
          else resolve(info);
        };
        const timer = setTimeout(() => {
          exitWaiters.delete(onExit);
          terminate(timeoutError("native process did not close within the request timeout"));
          reject(failed);
        }, options.timeoutMs);
        timer.unref();
        exitWaiters.add(onExit);
      });
    },

    killTree(): void {
      if (proc.pid !== undefined && proc.exitCode === null && !proc.killed) {
        killProcessTree(proc.pid);
      }
    },

    cancel(): void {
      if (cancelled || exit) return;
      cancelled = true;
      terminate(cancelledError());
    },

    get exitInfo(): ExitInfo | null {
      return exit;
    },

    stderrTail(maxChars = 300): string {
      return stderrBuf.slice(-maxChars);
    },
  };
  return handle;
}
