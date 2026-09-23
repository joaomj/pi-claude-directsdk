import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSupervised, killProcessTree } from "../src/process.js";
import { DirectSdkError } from "../src/errors.js";

describe("process", () => {
  it("delivers stdout lines and the exit code", async () => {
    const child = spawnSupervised({
      command: process.execPath,
      args: ["-e", "console.log('a');console.log('b')"],
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    assert.equal(await child.nextLine(), "a");
    assert.equal(await child.nextLine(), "b");
    assert.equal(await child.nextLine(), null);
    const exit = await child.wait();
    assert.equal(exit.code, 0);
  });

  it("pipes stdin to the child", async () => {
    const child = spawnSupervised({
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    await child.writeLine("hello");
    assert.equal(await child.nextLine(), "hello");
    child.closeStdin();
    child.killTree();
    await child.wait();
  });

  it("times out on idle output", async () => {
    const child = spawnSupervised({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    try {
      await assert.rejects(child.nextLine(), (error: unknown) => {
        assert.ok(error instanceof DirectSdkError);
        assert.equal(error.kind, "timeout");
        return true;
      });
    } finally {
      child.cancel();
      await child.wait();
    }
  });

  it("rejects reads after cancellation", async () => {
    const child = spawnSupervised({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    child.cancel();
    await assert.rejects(child.nextLine(), /cancelled/i);
    await child.wait();
  });

  it("kills the process tree", async () => {
    killProcessTree(undefined);
    const child = spawnSupervised({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    child.killTree();
    const exit = await child.wait();
    assert.ok(exit.code !== 0 || exit.signal !== null);
  });
});
