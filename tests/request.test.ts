import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_SERVER_NAME,
  TOOL_NAME_PREFIX,
  buildArgv,
  buildChildEnv,
  buildRequestBody,
  checkEnvConflicts,
  normalizeInputSchema,
  toolBareName,
  toolPrefixedName,
  writeRequestFiles,
} from "../src/request.js";
import { readTool } from "./helpers/pi-fixtures.js";

describe("request", () => {
  it("rejects conflicting auth and backend overrides", () => {
    assert.deepEqual(checkEnvConflicts({ ANTHROPIC_API_KEY: "x" }), [
      "ANTHROPIC_API_KEY",
    ]);
    assert.deepEqual(checkEnvConflicts({ CLAUDE_CODE_USE_BEDROCK: "true" }), [
      "CLAUDE_CODE_USE_BEDROCK",
    ]);
    assert.deepEqual(checkEnvConflicts({}), []);
  });

  it("bypasses the guard only in explicit test mode", () => {
    assert.deepEqual(
      checkEnvConflicts({
        PI_DIRECTSDK_TEST_UPSTREAM: "1",
        ANTHROPIC_AUTH_TOKEN: "test",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1/",
      }),
      [],
    );
  });

  it("round-trips prefixed tool names", () => {
    assert.equal(toolPrefixedName("read"), `${TOOL_NAME_PREFIX}read`);
    assert.equal(toolBareName(`${TOOL_NAME_PREFIX}read`), "read");
    assert.equal(toolBareName("read"), null);
    assert.equal(MCP_SERVER_NAME, "pi");
  });

  it("normalizes tool schemas for the native validator", () => {
    const schema = normalizeInputSchema({
      type: ["object", "null"],
      oneOf: [{ type: "string" }],
      properties: { a: { type: "string" } },
    });
    assert.equal(schema["type"], "object");
    assert.ok(!("oneOf" in schema));
    assert.throws(() => normalizeInputSchema([]), /must be an object/);
  });

  it("builds the native body with prefixed tools", () => {
    const build = buildRequestBody({
      tools: [readTool()],
      toolChoice: "auto",
      nativeModelId: "claude-opus-4-6",
    });
    const tools = build.body["tools"] as Array<{ name: string }>;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "mcp__pi__read");
    assert.deepEqual(build.toolNames, ["read"]);
    assert.equal(build.manifest.length, 1);
  });

  it("supports tool_choice none", () => {
    const build = buildRequestBody({
      tools: [readTool()],
      toolChoice: "none",
      nativeModelId: "claude-opus-4-6",
    });
    assert.deepEqual(build.body["tools"], []);
    assert.deepEqual(build.toolNames, []);
  });

  it("rejects unsupported tool choices and shapes", () => {
    assert.throws(
      () =>
        buildRequestBody({
          tools: [],
          toolChoice: "required" as never,
          nativeModelId: "claude-opus-4-6",
        }),
      /Only tool_choice auto and none/,
    );
    assert.throws(
      () =>
        buildRequestBody({
          tools: [readTool(), readTool()],
          nativeModelId: "claude-opus-4-6",
        }),
      /Duplicate tool name/,
    );
    assert.throws(
      () =>
        buildRequestBody({
          tools: [{ ...readTool(), name: "has space" }],
          nativeModelId: "claude-opus-4-6",
        }),
      /unique ASCII identifiers/,
    );
    assert.throws(
      () =>
        buildRequestBody({
          tools: [
            { ...readTool(), name: "x", constrainedSampling: {} } as never,
          ],
          nativeModelId: "claude-opus-4-6",
        }),
      /Grammar-constrained/,
    );
  });

  it("maps reasoning to adaptive thinking and effort", () => {
    const build = buildRequestBody({
      tools: [],
      reasoning: "high",
      thinkingLevelMap: { minimal: "low" },
      nativeModelId: "claude-opus-4-6",
    });
    assert.deepEqual(build.body["thinking"], { type: "adaptive" });
    assert.deepEqual(build.body["output_config"], { effort: "high" });
    assert.ok(!("temperature" in build.body));
  });

  it("omits thinking keys for unmapped levels", () => {
    const build = buildRequestBody({
      tools: [],
      reasoning: "low",
      thinkingLevelMap: { low: null },
      nativeModelId: "claude-opus-4-6",
    });
    assert.ok(!("thinking" in build.body));
    assert.ok(!("output_config" in build.body));
  });

  it("validates maxTokens", () => {
    const build = buildRequestBody({
      tools: [],
      nativeModelId: "claude-opus-4-6",
      maxTokens: 100,
    });
    assert.equal(build.body["max_tokens"], 100);
    assert.throws(
      () =>
        buildRequestBody({ tools: [], nativeModelId: "x", maxTokens: 0 }),
      /positive integer/,
    );
  });

  it("builds argv with the documented flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-directsdk-req-"));
    const files = writeRequestFiles(dir, {
      systemPrompt: "sys",
      body: { tools: [] },
      manifest: [],
    });
    const { command, args } = buildArgv({
      claudeBin: "/bin/claude",
      nativeModelId: "claude-opus-4-6",
      files,
    });
    assert.equal(command, "/bin/claude");
    for (const flag of [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--disable-slash-commands",
    ]) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    assert.ok(args.includes("claude-opus-4-6"));
  });

  it("writes private request files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-directsdk-req-"));
    const files = writeRequestFiles(dir, {
      systemPrompt: "sys",
      body: { tools: [], max_tokens: 50 },
      manifest: [],
    });
    for (const path of [files.systemPath, files.settingsPath, files.toolsPath, files.mcpPath]) {
      const stat = statSync(path);
      if (process.platform !== "win32") {
        assert.equal(stat.mode & 0o777, 0o600);
      }
    }
    const childEnv = buildChildEnv({
      baseEnv: { ANTHROPIC_BASE_URL: "https://example.test/", CLAUDE_CODE_EXTRA_BODY: "x" },
      relayUrl: "http://127.0.0.1:9/",
      body: { tools: [], max_tokens: 50 },
    });
    assert.equal(childEnv["ANTHROPIC_BASE_URL"], "http://127.0.0.1:9/");
    assert.equal(childEnv["CLAUDE_CODE_MAX_RETRIES"], "0");
    assert.equal(childEnv["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "50");
    assert.ok(!("CLAUDE_CODE_EXTRA_BODY" in (childEnv as Record<string, string>)));
  });
});
