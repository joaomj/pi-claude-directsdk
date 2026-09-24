/**
 * E2E-02: a model call with no `claude` executable fails with the install hint.
 *
 * Justification: a missing CLI is the first error every new user meets. A
 * regression here turns an actionable one-line hint into a cryptic spawn
 * failure. This test proves the failure path through the real `streamSimple`
 * pipeline with an empty PATH. Fully offline, no CLI, no cost.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  Api,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { streamClaudeDirectSdk } from "../../src/stream.js";
import { MODELS } from "../../src/provider.js";
import { INSTALL_HINT } from "../../src/errors.js";
import { collectTerminal } from "./helpers.js";

function context(): TranscriptContext {
  return normalizeContext({
    messages: [
      {
        role: "system",
        content: "You are a test assistant. Reply briefly.",
        timestamp: Date.now(),
      },
      { role: "user", content: "Say hi.", timestamp: Date.now() },
    ],
  });
}

function model(): Model<Api> {
  const found = MODELS.find((entry) => entry.id === "sonnet");
  assert.ok(found, "pinned catalog must contain sonnet");
  return found as unknown as Model<Api>;
}

/** Environment with no executable `claude` and no leftover auth overrides. */
function noCliEnv(): Record<string, string> {
  return {
    PATH: "",
    CLAUDE_DIRECTSDK_COMMAND: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_BASE_URL: "",
    ANTHROPIC_FOUNDRY_API_KEY: "",
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
  };
}

test(
  "e2e-02: missing claude binary fails with the install hint",
  { timeout: 60_000 },
  async () => {
    const stream = streamClaudeDirectSdk(model(), context(), {
      env: noCliEnv(),
    });
    const { events, terminal } = await collectTerminal(stream, 30_000);
    assert.equal(terminal.type, "error");
    assert.equal(terminal.reason, "error");
    assert.match(terminal.error.errorMessage ?? "", /not installed/);
    assert.equal(terminal.error.errorMessage, INSTALL_HINT);
    assert.ok(
      events.every((event) => event.type !== "start"),
      "setup must fail before the start event",
    );
  },
);
