import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  discoverModels,
  qualifiedCli,
  resolveClaude,
  setupChildEnv,
  setupStatus,
} from "../src/setup.js";

const savedPath = process.env["PATH"];

function restoreEnv(): void {
  if (savedPath === undefined) {
    delete process.env["PATH"];
  } else {
    process.env["PATH"] = savedPath;
  }
}

afterEach(restoreEnv);

function fakeBin(version: string): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-directsdk-bin-"));
  const bin = join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  const script =
    process.platform === "win32"
      ? `@echo off\r\necho ${version} (Claude Code)\r\n`
      : `#!/bin/sh\necho "${version} (Claude Code)"\n`;
  writeFileSync(bin, script, { encoding: "utf-8" });
  if (process.platform !== "win32") {
    chmodSync(bin, 0o755);
  }
  return { dir, bin };
}

describe("setup", () => {
  it("resolves the CLI from PATH and honors the override", () => {
    const { dir } = fakeBin("2.1.267");
    process.env["PATH"] = `${dir}${delimiter}${savedPath ?? ""}`;
    const found = resolveClaude();
    assert.ok(found);
    assert.ok(found[0]?.endsWith("claude") || found[0]?.endsWith("claude.cmd"));

    const missing = resolveClaude("definitely-not-on-path-claude-bin");
    assert.equal(missing, null);

    process.env["PATH"] = mkdtempSync(join(tmpdir(), "pi-directsdk-empty-"));
    assert.equal(resolveClaude(), null);
  });

  it("qualifies supported versions and caches the probe", () => {
    const good = fakeBin("2.1.267");
    assert.equal(qualifiedCli([good.bin], {}), true);
    assert.equal(qualifiedCli([good.bin], {}), true);
    const old = fakeBin("2.1.200");
    assert.equal(qualifiedCli([old.bin], {}), false);
  });

  it("scrubs the child environment and maps the config dir", () => {
    const env = setupChildEnv({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "https://example.test/",
      CLAUDE_CODE_EXTRA_BODY: "x",
      CLAUDE_DIRECTSDK_CONFIG_DIR: "/tmp/cfg",
    });
    assert.equal(env["ANTHROPIC_BASE_URL"], undefined);
    assert.equal(env["CLAUDE_CODE_EXTRA_BODY"], undefined);
    assert.equal(env["CLAUDE_CONFIG_DIR"], "/tmp/cfg");
    assert.equal(env["CLAUDE_CODE_MAX_RETRIES"], "0");
  });

  it("reports missing CLIs as not logged in", () => {
    const status = setupStatus({
      command: "definitely-not-on-path-claude-bin",
      env: {},
    });
    assert.equal(status.loggedIn, false);
    assert.match(status.detail, /Install/);
  });

  it("returns null discovery without a CLI", async () => {
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "pi-directsdk-empty-"));
    const discovered = await discoverModels({ timeoutMs: 5000 });
    assert.equal(discovered, null);
  });
});
