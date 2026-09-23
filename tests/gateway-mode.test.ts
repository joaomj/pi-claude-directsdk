/**
 * Gate 3: live gateway probe (OpenRouter) behind an explicit double opt-in.
 *
 * Runs only when PI_DIRECTSDK_GATEWAY=1 AND OPENROUTER_API_KEY is set. Makes
 * one real paid upstream request (tiny maxTokens, haiku route) through the
 * admission relay to prove the first-attempt capture path against a live
 * server. Never runs in CI or by default.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultDeps, streamClaudeDirectSdk } from "../src/stream.js";
import {
  collectEvents,
  contextWith,
  systemMessage,
  testModel,
  userMessage,
} from "./helpers/pi-fixtures.js";

const GATEWAY = process.env["PI_DIRECTSDK_GATEWAY"] === "1";
const KEY = process.env["OPENROUTER_API_KEY"];
const run = GATEWAY && KEY ? describe : describe.skip;

run("gateway probe (Gate 3)", { timeout: 180_000 }, () => {
  it("completes one haiku turn through the relay", async () => {
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel("claude-haiku-4-5-20251001"),
        contextWith(systemMessage("Answer with the word ok"), userMessage("ok?")),
        {
          timeoutMs: 150_000,
          maxTokens: 32,
          env: {
            PI_DIRECTSDK_TEST_UPSTREAM: "1",
            ANTHROPIC_AUTH_TOKEN: KEY ?? "",
            ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
          },
        },
        defaultDeps,
      ),
    );
    const done = events.find((e) => e.type === "done");
    assert.ok(done && done.type === "done", "expected a done event");
    assert.equal(done.message.stopReason, "stop");
  });
});
