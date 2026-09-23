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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
    });
    return;
  }
  try {
    // windows-footgun: guarded, the win32 branch above never reaches this line.
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
    // ESRCH: already gone. EPERM: the group leader is a zombie; nothing to kill.
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
  const proc = spawn(options.command, options.args, {
    env: options.env,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group on both platforms (CREATE_NEW_PROCESS_GROUP on Windows).
    detached: true,
    windowsHide: true,
  });
  // The supervisor must never keep the Pi process alive on its own.
  proc.unref();

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
  let waitResolve: ((info: ExitInfo) => void) | null = null;

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
    failed = error;
    let waiter = waiters.shift();
    while (waiter) {
      waiter.reject(error);
      waiter = waiters.shift();
    }
  };

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
    if (!exit) {
      exit = info;
    }
    waitResolve?.(exit);
    waitResolve = null;
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
      if (cancelled) {
        throw cancelledError();
      }
      const stdin = proc.stdin;
      if (!stdin || stdin.destroyed) {
        throw new Error("Child stdin is closed");
      }
      const ok = stdin.write(`${line}\n`);
      if (!ok) {
        await new Promise<void>((resolve, reject) => {
          stdin.once("drain", () => resolve());
          stdin.once("error", reject);
        });
      }
    },

    closeStdin(): void {
      try {
        proc.stdin?.end();
      } catch {
        // Already closed; exit observation carries the outcome.
      }
    },

    async nextLine(): Promise<string | null> {
      for (;;) {
        if (cancelled || options.signal?.aborted) {
          throw cancelledError();
        }
        if (failed) {
          throw failed;
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
          throw timeoutError("no native output within the request timeout");
        }
        const result = await new Promise<string | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            const index = waiters.findIndex(
              (w) => w.resolve === resolve && w.reject === reject,
            );
            if (index !== -1) {
              waiters.splice(index, 1);
            }
            reject(timeoutError("no native output within the request timeout"));
          }, remaining);
          if (timer.unref) {
            timer.unref();
          }
          waiters.push({
            resolve: (line) => {
              clearTimeout(timer);
              resolve(line);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
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
        return Promise.resolve(exit);
      }
      return new Promise((resolve) => {
        waitResolve = resolve;
      });
    },

    killTree(): void {
      if (proc.pid !== undefined && proc.exitCode === null && !proc.killed) {
        killProcessTree(proc.pid);
      }
    },

    cancel(): void {
      if (cancelled) {
        return;
      }
      cancelled = true;
      handle.killTree();
      failAll(cancelledError());
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

/** Lazily created, process-wide stable child working directory. */
let stableCwd: string | null = null;

export function stableChildCwd(): string {
  if (!stableCwd) {
    // A fresh tempdir per request moves the native cache prefix every round
    // and destroys prompt-cache reuse; one stable cwd per process keeps it.
    stableCwd = mkdtempSync(join(tmpdir(), "pi-directsdk-cwd-"));
  }
  return stableCwd;
}
