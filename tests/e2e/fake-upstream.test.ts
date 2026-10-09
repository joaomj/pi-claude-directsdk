/**
 * E2E-03: the full pipeline against a fake upstream (opt-in).
 *
 * Runs only when PI_DIRECTSDK_CLI points at a `claude` executable. Spins up
 * a loopback synthetic Anthropic Messages endpoint, runs the real CLI
 * against it with a fixture key in an isolated env, and asserts:
 *   (a) a grammar tool uses JSON schema and returns a usable tool call,
 *   (b) exactly one upstream POST /v1/messages is admitted per Pi call, and
 *   (c) required strict decoding fails before contacting upstream.
 * A second case holds the upstream open, aborts mid-flight, and asserts the
 * call terminates as `aborted` instead of hanging.
 *
 * Justification: this is the only test that proves the whole pipeline --
 * spawn, history replay, admission relay, stream conversion, cleanup --
 * without spending subscription allowance. No network beyond loopback.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { MODELS, streamSimple } from "../../src/provider.js";
import { collectTerminal } from "./helpers.js";

const CLI = process.env["PI_DIRECTSDK_CLI"];
const SKIP_REASON =
  "needs PI_DIRECTSDK_CLI=/path/to/claude (real CLI against a loopback fixture)";

function context(strict = false): TranscriptContext {
  return normalizeContext({
    tools: [{
      name: "codemode",
      description: "Run JavaScript supplied in code.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
      constrainedSampling: strict
        ? { type: "json_schema", strict: "require" }
        : { type: "grammar", variants: { openai_lark: "start: /[\\s\\S]+/" } },
    }],
    messages: [
      {
        role: "system",
        content: "You are a test assistant. Reply briefly.",
        timestamp: Date.now(),
      },
      { role: "user", content: "Say hello in one sentence.", timestamp: Date.now() },
    ],
  });
}

function model(): Model<Api> {
  const found = MODELS.find((entry) => entry.id === "sonnet");
  assert.ok(found, "pinned catalog must contain sonnet");
  return found as unknown as Model<Api>;
}

/** Isolated child env: fixture credentials, temp homes, no real user login. */
function fixtureEnv(upstream: string): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "pi-directsdk-home-"));
  return {
    PI_DIRECTSDK_TEST_UPSTREAM: "1",
    ANTHROPIC_BASE_URL: upstream,
    ANTHROPIC_AUTH_TOKEN: "[REDACTED]",
    CLAUDE_DIRECTSDK_COMMAND: CLI ?? "",
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pi-directsdk-claude-")),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Complete Anthropic text and tool response as server-sent events. */
function toolResponse(text: string): string {
  return (
    sseLine({
      type: "message_start",
      message: {
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }) +
    sseLine({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sseLine({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    sseLine({ type: "content_block_stop", index: 0 }) +
    sseLine({
      type: "content_block_start", index: 1,
      content_block: { type: "tool_use", id: "toolu_codemode", name: "mcp__pi__codemode", input: {} },
    }) +
    sseLine({
      type: "content_block_delta", index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ code: "return 42;" }) },
    }) +
    sseLine({ type: "content_block_stop", index: 1 }) +
    sseLine({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 8 },
    }) +
    sseLine({ type: "message_stop" })
  );
}

test(
  "e2e-03a: grammar tool falls back to JSON schema through the real CLI",
  { timeout: 180_000, skip: CLI ? false : SKIP_REASON },
  async () => {
    let messagePosts = 0;
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/messages") {
          messagePosts += 1;
          bodies.push(body);
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "request-id": "req_e2e_1",
          });
          res.end(toolResponse("Hello from the fake upstream."));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "no fixture" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const stream = streamSimple(model(), context(), {
        env: fixtureEnv(`http://127.0.0.1:${port}`),
      });
      const { terminal } = await collectTerminal(stream, 150_000);
      assert.equal(terminal.type, "done", JSON.stringify(terminal).slice(0, 500));
      const text = terminal.message.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join("");
      assert.match(text, /Hello from the fake upstream/);
      assert.equal(messagePosts, 1, `expected 1 upstream request, saw ${messagePosts}`);
      const request = JSON.parse(bodies[0] ?? "{}") as {
        tools: Array<{ name: string; input_schema: unknown }>;
      };
      assert.deepEqual(request.tools.find((tool) => tool.name === "mcp__pi__codemode")?.input_schema, {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      });
      assert.equal(terminal.reason, "toolUse");
      const call = terminal.message.content.find((block) => block.type === "toolCall");
      assert.ok(call && call.type === "toolCall");
      assert.equal(call.name, "codemode");
      assert.deepEqual(call.arguments, { code: "return 42;" });

      const strict = await collectTerminal(streamSimple(model(), context(true), {
        env: fixtureEnv(`http://127.0.0.1:${port}`),
      }), 30_000);
      assert.equal(strict.terminal.type, "error");
      assert.match(strict.terminal.error.errorMessage ?? "", /Strict constrained sampling.*codemode/);
      assert.equal(messagePosts, 1, "required strict decoding must fail before contacting upstream");
    } finally {
      server.close();
    }
  },
);

test(
  "e2e-03b: aborting mid-flight terminates as aborted instead of hanging",
  { timeout: 180_000, skip: CLI ? false : SKIP_REASON },
  async () => {
    let arrived: (() => void) | undefined;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    // Upstream accepts the request and never answers.
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/messages") {
        req.resume();
        arrived?.();
        const timer = setTimeout(() => res.end(), 120_000);
        timer.unref?.();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const controller = new AbortController();
      const stream = streamSimple(model(), context(), {
        env: fixtureEnv(`http://127.0.0.1:${port}`),
        signal: controller.signal,
      });
      const finished = collectTerminal(stream, 150_000);
      await Promise.race([
        requestArrived,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("upstream never saw the request")), 90_000),
        ),
      ]);
      const abortAt = Date.now();
      controller.abort();
      const { terminal } = await finished;
      assert.equal(terminal.type, "error");
      assert.equal(terminal.reason, "aborted");
      assert.ok(
        Date.now() - abortAt < 15_000,
        "abort must unblock the call promptly",
      );
    } finally {
      server.close();
    }
  },
);
