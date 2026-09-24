/**
 * E2E-01: the Pi CLI loads this extension and lists the pinned catalog.
 *
 * Justification: provider registration and the model catalog are the entry
 * point of the whole extension. When the extension entry, the manifest, or
 * the catalog breaks, every later step fails. This test proves the wiring
 * through the real `pi` binary. Fully offline, no CLI, no cost.
 */
import { execFile } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join } from "node:path";
import { findRepoRoot } from "./helpers.js";

const root = findRepoRoot();

function runPi(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      join(root, "node_modules", ".bin", "pi"),
      args,
      {
        cwd: root,
        env: { ...process.env, PI_OFFLINE: "1" },
        timeout: 150_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `pi exited unsuccessfully: ${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test(
  "e2e-01: pi loads the extension and lists claude-directsdk models",
  { timeout: 180_000 },
  async () => {
    const { stdout } = await runPi([
      "--no-extensions",
      "-e",
      join(root, "extensions", "claude-directsdk", "index.ts"),
      "--list-models",
      "claude-directsdk",
    ]);
    for (const id of ["sonnet", "opus", "haiku"]) {
      assert.match(
        stdout,
        new RegExp(`claude-directsdk\\s+${id}\\b`),
        `expected model "${id}" in --list-models output`,
      );
    }
  },
);
