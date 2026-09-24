/**
 * E2E-04: the full pipeline against OpenRouter (explicit opt-in, paid).
 *
 * Runs only when PI_DIRECTSDK_GATEWAY=1 with OPENROUTER_API_KEY set in the
 * process environment. Points the real CLI at https://openrouter.ai/api and:
 *   (a) asserts a text prompt returns a terminal `done` with real text and
 *       nonzero usage, and
 *   (b) asserts a forced tool call publishes `toolcall_*` events with valid
 *       JSON arguments and a `toolUse` stop reason.
 *
 * Justification: the loopback fixture in E2E-03 is hand-written SSE. Only a
 * real Anthropic-compatible endpoint proves the relay capture, usage mapping,
 * and tool-publication gating match reality. Cost is pay-as-you-go per call
 * (fractions of a cent on Haiku, a few cents on Opus). Never runs in CI.
 * Gateway results prove protocol behavior only, never subscription behavior.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  Model,
  Tool,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { streamClaudeDirectSdk } from "../../src/stream.js";
import { MODELS } from "../../src/provider.js";
import { collectTerminal } from "./helpers.js";

const GATEWAY = process.env["PI_DIRECTSDK_GATEWAY"] === "1";
const KEY = process.env["OPENROUTER_API_KEY"];
const CLI = process.env["PI_DIRECTSDK_CLI"];
const SKIP_REASON =
  "needs PI_DIRECTSDK_GATEWAY=1 with OPENROUTER_API_KEY and PI_DIRECTSDK_CLI set (paid)";

if (GATEWAY && !KEY) {
  throw new Error("PI_DIRECTSDK_GATEWAY=1 requires OPENROUTER_API_KEY in the environment");
}
if (GATEWAY && !CLI) {
  throw new Error("PI_DIRECTSDK_GATEWAY=1 requires PI_DIRECTSDK_CLI=/path/to/claude");
}

/** OpenRouter slug for the model under test. */
const GATEWAY_MODEL = "anthropic/claude-opus-5-5";

function model(): Model<Api> {
  const found = MODELS.find((entry) => entry.id === "opus");
  assert.ok(found, "pinned catalog must contain opus");
  return found as unknown as Model<Api>;
}

function gatewayEnv(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "pi-directsdk-gw-home-"));
  return {
    PI_DIRECTSDK_TEST_UPSTREAM: "1",
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: KEY ?? "",
    CLAUDE_DIRECTSDK_COMMAND: CLI ?? "",
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pi-directsdk-gw-claude-")),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

/** Rewrite the native model id to the OpenRouter slug. */
function gatewayPayload(payload: unknown): unknown {
  assert.ok(payload !== null && typeof payload === "object", "payload must be an object");
  return { ...(payload as Record<string, unknown>), model: GATEWAY_MODEL };
}

test(
  "e2e-04a: gateway text round-trip returns done with usage",
  { timeout: 240_000, skip: GATEWAY ? false : SKIP_REASON },
  async () => {
    const context: TranscriptContext = normalizeContext({
      systemPrompt: "You are a test assistant. Reply in one short sentence.",
      messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
    });
    const stream = streamClaudeDirectSdk(model(), context, {
      env: gatewayEnv(),
      onPayload: gatewayPayload,
    });
    const { terminal } = await collectTerminal(stream, 210_000);
    assert.equal(terminal.type, "done", JSON.stringify(terminal).slice(0, 500));
    const text = terminal.message.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("")
      .trim();
    assert.ok(text.length > 0, "expected non-empty text from the gateway model");
    assert.ok(terminal.message.usage.input > 0, "expected nonzero input usage");
    assert.ok(terminal.message.usage.output > 0, "expected nonzero output usage");
  },
);

test(
  "e2e-04b: gateway tool call publishes toolcall events with JSON arguments",
  { timeout: 240_000, skip: GATEWAY ? false : SKIP_REASON },
  async () => {
    const tools = [
      {
        name: "get_test_value",
        description: "Return the test value for a given key.",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
      },
    ] as unknown as Tool[];
    const context: TranscriptContext = normalizeContext({
      systemPrompt:
        "You are a test assistant. You MUST call the get_test_value tool " +
        'with {"key": "hello"} and nothing else. Do not write any text.',
      messages: [{ role: "user", content: "Call the tool now.", timestamp: Date.now() }],
      tools,
    });
    const stream = streamClaudeDirectSdk(model(), context, {
      env: gatewayEnv(),
      onPayload: gatewayPayload,
    });
    const { events, terminal } = await collectTerminal(stream, 210_000);
    assert.equal(terminal.type, "done", JSON.stringify(terminal).slice(0, 500));
    assert.equal(terminal.reason, "toolUse");
    const starts = events.filter((event) => event.type === "toolcall_start");
    assert.equal(starts.length, 1, `expected 1 tool call, saw ${starts.length}`);
    const calls = terminal.message.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.name ?? "", /get_test_value/);
    const args = (calls[0] as ToolCall).arguments as Record<string, unknown>;
    assert.equal(args["key"], "hello");
  },
);
