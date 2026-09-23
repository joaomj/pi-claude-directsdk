/** Scriptable ChildHandle for Gate 1 stream tests. */

import type { ChildHandle, ExitInfo } from "../../src/process.js";

export type ScriptedRead = string | { error: Error };

export class FakeChild implements ChildHandle {
  written: string[] = [];
  stdinClosed = false;
  killCount = 0;
  cancelled = false;
  exit: ExitInfo;
  stderrText = "";
  private reads: ScriptedRead[];

  constructor(
    reads: ScriptedRead[] = [],
    exit: ExitInfo = { code: 0, signal: null },
  ) {
    this.reads = [...reads];
    this.exit = exit;
  }

  async writeLine(line: string): Promise<void> {
    this.written.push(line);
  }

  closeStdin(): void {
    this.stdinClosed = true;
  }

  async nextLine(): Promise<string | null> {
    const next = this.reads.shift();
    if (next === undefined) {
      return null;
    }
    if (typeof next === "string") {
      return next;
    }
    throw next.error;
  }

  async wait(): Promise<ExitInfo> {
    return this.exit;
  }

  killTree(): void {
    this.killCount += 1;
  }

  cancel(): void {
    this.cancelled = true;
    this.killCount += 1;
  }

  get exitInfo(): ExitInfo | null {
    return this.exit;
  }

  stderrTail(): string {
    return this.stderrText;
  }
}
