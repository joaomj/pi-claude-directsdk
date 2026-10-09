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
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { findRepoRoot } from "./helpers.js";

const root = findRepoRoot();

function runPi(
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      join(root, "node_modules", ".bin", "pi"),
      args,
      {
        cwd: root,
        env: { ...process.env, ...extraEnv, PI_OFFLINE: "1" },
        timeout: 150_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Pi offline model listing failed (exit ${error.code}, signal ${error.signal ?? "none"}).`,
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
  "pi lists Opus 5.5 offline without probing the Claude CLI",
  { timeout: 180_000 },
  async (t) => {
    const isolated = await mkdtemp(join(tmpdir(), "directsdk-offline-catalog-"));
    t.after(() => rm(isolated, { recursive: true, force: true }));
    const marker = join(isolated, "cli-probes.log");
    const cli = join(isolated, "claude-probe.cjs");
    await writeFile(
      cli,
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.DIRECTSDK_PROBE_MARKER, "probe\\n");
if (process.argv.includes("--version")) console.log("2.1.281 (Claude Code)");
else console.log(JSON.stringify({ loggedIn: false }));
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(isolated, "settings.json"),
      JSON.stringify({ packages: [] }),
      { mode: 0o600 },
    );
    const { stdout } = await runPi([
      "--no-extensions",
      "-e",
      join(root, "extensions", "claude-directsdk", "index.ts"),
      "--list-models",
      "claude-directsdk",
    ], {
      PI_CODING_AGENT_DIR: isolated,
      CLAUDE_DIRECTSDK_COMMAND: cli,
      DIRECTSDK_PROBE_MARKER: marker,
    });
    assert.equal(
      existsSync(marker),
      false,
      "offline catalog loading must not invoke the Claude CLI",
    );
    for (const id of ["claude-opus-5-5", "sonnet", "opus", "haiku"]) {
      assert.match(
        stdout,
        new RegExp(`claude-directsdk\\s+${id}\\b`),
        `expected model "${id}" in --list-models output`,
      );
    }
  },
);
