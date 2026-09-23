/**
 * Gate 2: fake-upstream harness with the real `claude` executable.
 *
 * Opt-in only: set PI_DIRECTSDK_CLI to the absolute path of the official
 * `claude` binary. The test serves scripted Anthropic SSE from a loopback
 * server, routes the real CLI through the admission relay with
 * PI_DIRECTSDK_TEST_UPSTREAM=1 and a dummy token, and asserts the Pi event
 * stream completes. Makes zero subscription calls and zero paid calls.
 *
 * What this proves: argv/flags, env isolation, replay framing, the admission
 * protocol, and usage mapping against the qualified CLI. A logged-out CLI or
 * a CLI that refuses third-party base URLs fails here with the CLI's stderr
 * attached to the error.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { defaultDeps, streamClaudeDirectSdk } from "../src/stream.js";
import {
  collectEvents,
  contextWith,
  readTool,
  systemMessage,
  testModel,
  userMessage,
} from "./helpers/pi-fixtures.js";
import { scriptedExchange } from "./helpers/sse.js";

const CLI = process.env["PI_DIRECTSDK_CLI"];
const run = CLI ? describe : describe.skip;

function doneOf(events: Awaited<ReturnType<typeof collectEvents>>) {
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done", "expected a done event");
  return done.message;
}

run("cli fake-upstream (Gate 2)", { timeout: 120_000 }, () => {
  it("drives the real CLI against scripted SSE", async () => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf-8");
      });
      req.on("end", () => {
        assert.equal(req.method, "POST");
        assert.ok(req.url?.startsWith("/v1/messages"));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(scriptedExchange({ stop: "end_turn", toolName: "mcp__pi__read" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const events = await collectEvents(
        streamClaudeDirectSdk(
          testModel("claude-sonnet-4-6"),
          contextWith(
            systemMessage("Answer briefly", [readTool()]),
            userMessage("Say ok"),
          ),
          {
            timeoutMs: 100_000,
            env: {
              PI_DIRECTSDK_TEST_UPSTREAM: "1",
              ANTHROPIC_AUTH_TOKEN: "[REDACTED]",
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
              CLAUDE_DIRECTSDK_COMMAND: CLI ?? "",
            },
          },
          defaultDeps,
        ),
      );
      const message = doneOf(events);
      assert.equal(message.stopReason, "stop");
      const text = message.content.find((b) => b.type === "text");
      assert.ok(text && text.type === "text" && text.text.length > 0);
      assert.ok(message.usage.input > 0);
      const meta = message.diagnostics?.find(
        (d) => d.type === "pi-claude-directsdk/meta",
      );
      assert.ok(meta, "expected the meta diagnostic");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
