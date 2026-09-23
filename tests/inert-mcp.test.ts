import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INERT_MCP_SOURCE } from "../src/inert-mcp.js";

function runServer(
  serverPath: string,
  toolsPath: string,
  input: string,
): string[] {
  const run = spawnSync(process.execPath, [serverPath, toolsPath], {
    input,
    encoding: "utf-8",
    timeout: 15_000,
  });
  assert.equal(run.status, 0, `server exited ${run.status}: ${run.stderr}`);
  return String(run.stdout)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("inert-mcp", () => {
  it("serves the manifest and refuses every call", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-directsdk-mcp-"));
    const serverPath = join(dir, "inert-mcp.mjs");
    const toolsPath = join(dir, "tools.json");
    writeFileSync(serverPath, INERT_MCP_SOURCE, { encoding: "utf-8" });
    writeFileSync(
      toolsPath,
      JSON.stringify([
        {
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: {} },
        },
      ]),
      { encoding: "utf-8" },
    );
    const responses = runServer(
      serverPath,
      toolsPath,
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "mcp__pi__read", arguments: {} },
        }),
      ].join("\n"),
    );
    assert.equal(responses.length, 3);
    const list = (
      responses[1]?.["result"] as { tools: Array<{ name: string }> }
    ).tools;
    assert.deepEqual(
      list.map((t) => t.name),
      ["mcp__pi__read"],
    );
    const call = responses[2]?.["result"] as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(call.isError, true);
    assert.match(call.content[0]?.text ?? "", /host executes tools/);
  });

  it("fails closed on a missing manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-directsdk-mcp-"));
    const serverPath = join(dir, "inert-mcp.mjs");
    writeFileSync(serverPath, INERT_MCP_SOURCE, { encoding: "utf-8" });
    const child = spawn(process.execPath, [serverPath, join(dir, "absent.json")]);
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("inert server did not exit"));
      }, 10_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          assert.notEqual(code, 0);
          assert.match(stderr, /manifest/);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });
});
