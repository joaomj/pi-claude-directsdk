/**
 * E2E-03: the full pipeline against a fake upstream (opt-in).
 *
 * Runs only when PI_DIRECTSDK_CLI points at a `claude` executable. Spins up
 * a loopback synthetic Anthropic Messages endpoint, runs the real CLI
 * against it with a fixture key in an isolated env, and asserts:
 *   (a) a text prompt streams back to a terminal `done` event, and
 *   (b) exactly one upstream POST /v1/messages is admitted per Pi call.
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
import { streamClaudeDirectSdk } from "../../src/stream.js";
import { MODELS } from "../../src/provider.js";
import { collectTerminal } from "./helpers.js";

const CLI = process.env["PI_DIRECTSDK_CLI"];
const SKIP_REASON =
  "needs PI_DIRECTSDK_CLI=/path/to/claude (real CLI against a loopback fixture)";

function context(): TranscriptContext {
  return normalizeContext({
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

/** Minimal complete Anthropic text response as server-sent events. */
function textResponse(text: string): string {
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
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    }) +
    sseLine({ type: "message_stop" })
  );
}

test(
  "e2e-03a: real CLI against a fake upstream streams text with one admitted request",
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
          res.end(textResponse("Hello from the fake upstream."));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "no fixture" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const stream = streamClaudeDirectSdk(model(), context(), {
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
      assert.match(bodies[0] ?? "", /"messages"/);
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
      const stream = streamClaudeDirectSdk(model(), context(), {
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
