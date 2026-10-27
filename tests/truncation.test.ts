import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  Api,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID } from "../src/models.ts";
import { streamClaudeDirectSdk, defaultDeps, type CallDeps } from "../src/stream.ts";

// A high-thinking turn can spend the whole output budget before writing
// anything. The native transport reports that as stop_reason max_tokens with
// thinking only, which used to publish an empty message.
const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

if (process.env.FAKE_DUMP) {
  const settingsPath = process.argv[process.argv.indexOf("--settings") + 1];
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  writeFileSync(process.env.FAKE_DUMP, JSON.stringify({
    body: JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY),
    maxOutputTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
  }));
}

const usage = {
  input_tokens: 2,
  output_tokens: 32000,
  cache_creation_input_tokens: 19648,
  cache_read_input_tokens: 0,
  output_tokens_details: { thinking_tokens: 32000 },
};
const withText = process.env.FAKE_TRUNCATION === "text";
const content = [{ type: "thinking", thinking: "", signature: "sig" }];
if (withText) content.push({ type: "text", text: "partial answer" });
const events = [
  { type: "message_start", message: { id: "msg_test", role: "assistant", content: [], usage } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_stop", index: 0 },
  ...(withText
    ? [
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "partial answer" } },
        { type: "content_block_stop", index: 1 },
      ]
    : []),
  { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage },
  { type: "message_stop" },
];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage }));
    continue;
  }
  for (const event of events) console.log(JSON.stringify({ type: "stream_event", event }));
  console.log(JSON.stringify({
    type: "assistant",
    message: { id: "msg_test", role: "assistant", content, stop_reason: "max_tokens", usage },
  }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage, total_cost_usd: 0 }));
}
`;

function model(): Model<Api> {
  return {
    id: "claude-haiku-5-5",
    name: "Haiku",
    api: "claude-directsdk" as Api,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-directsdk",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<{
  executable: string;
  root: string;
  deps: CallDeps;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-directsdk-truncation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);
  const deps: CallDeps = {
    ...defaultDeps,
    checkCli: () => true,
    makeRequestDir: () => mkdtempSync(join(root, "request-")),
    childCwd: () => root,
  };
  return { executable, root, deps };
}

const context = {
  messages: [
    { role: "system", content: "system", timestamp: 0 },
    { role: "user", content: "continue", timestamp: 1 },
  ],
} as unknown as TranscriptContext;

async function run(
  executable: string,
  deps: CallDeps,
  env: Record<string, string>,
  options: Partial<SimpleStreamOptions> = {},
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  const stream = streamClaudeDirectSdk(model(), context, {
    timeoutMs: 5_000,
    env: {
      PI_DIRECTSDK_TEST_UPSTREAM: "1",
      CLAUDE_DIRECTSDK_COMMAND: executable,
      ...env,
    },
    ...options,
  }, deps);
  for await (const event of stream) events.push(event);
  return events;
}

test("a truncated thinking-only turn fails with the cause instead of an empty message", async (t) => {
  const { executable, deps } = await fixture(t);

  const empty = await run(executable, deps, { FAKE_TRUNCATION: "empty" });
  const failure = empty.find((event) => event.type === "error");
  assert.ok(failure && failure.type === "error");
  assert.match(
    failure.error.errorMessage ?? "",
    /^Native request failed: claude-haiku-5-5 spent its whole output budget on thinking and returned no answer\. Lower the thinking level or switch models, then retry\.$/,
  );
  // The budget was billed, so the failed turn must not report zero output.
  assert.equal(failure.error.usage.output, 32000);

  const partial = await run(executable, deps, { FAKE_TRUNCATION: "text" });
  assert.equal(partial.some((event) => event.type === "error"), false);
  const done = partial.find((event) => event.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.message.stopReason, "length");
  assert.equal(
    done.message.content.some((block) => block.type === "text" && block.text === "partial answer"),
    true,
  );
});

test("forwards the model output limit so the native default cannot cap the turn", async (t) => {
  const { executable, deps, root } = await fixture(t);
  const dump = join(root, "request.json");
  const seen = (): { body: Record<string, unknown>; maxOutputTokens: string | null } =>
    JSON.parse(readFileSync(dump, "utf8")) as {
      body: Record<string, unknown>;
      maxOutputTokens: string | null;
    };

  await run(executable, deps, { FAKE_DUMP: dump, FAKE_TRUNCATION: "text" });
  assert.equal(seen().body["max_tokens"], 128_000);
  assert.equal(seen().maxOutputTokens, "128000");

  // Pi's per-call override still wins over the catalog limit.
  await run(executable, deps, { FAKE_DUMP: dump, FAKE_TRUNCATION: "text" }, { maxTokens: 2_048 });
  assert.equal(seen().body["max_tokens"], 2_048);
  assert.equal(seen().maxOutputTokens, "2048");
});
