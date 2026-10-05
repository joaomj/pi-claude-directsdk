import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Run outside the test runner: its own handles would mask early process exit.
test("one-shot supervision waits for child exit after output streams close", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-directsdk-lifetime-"));
  try {
    const childFile = join(dir, "child.cjs");
    writeFileSync(childFile, `
      const fs = require("node:fs");
      process.stdout.write("ready\\n", () => {
        fs.closeSync(0);
        fs.closeSync(1);
        fs.closeSync(2);
        setTimeout(() => process.exit(7), 200);
      });
    `);
    const moduleUrl = new URL("../../src/process.js", import.meta.url).href;
    const runnerFile = join(dir, "runner.mjs");
    writeFileSync(runnerFile, `
      import { spawnSupervised } from ${JSON.stringify(moduleUrl)};
      const child = spawnSupervised({
        command: process.execPath,
        args: [${JSON.stringify(childFile)}],
        env: process.env,
        cwd: ${JSON.stringify(dir)},
        timeoutMs: 2000,
      });
      const line = await child.nextLine();
      const eof = await child.nextLine();
      const exit = await child.wait();
      console.log(JSON.stringify({ line, eof, exit }));
    `);
    const runner = spawn(process.execPath, [runnerFile], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    runner.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    runner.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const exit = await new Promise<number | null>((resolve, reject) => {
      runner.once("error", reject);
      runner.once("close", resolve);
    });
    assert.equal(exit, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      line: "ready",
      eof: null,
      exit: { code: 7, signal: null },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
