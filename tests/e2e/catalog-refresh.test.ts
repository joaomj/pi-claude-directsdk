/** Exercise the real Pi model runtime with CLI and HTTP boundary fixtures. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryModelsStore } from "@earendil-works/pi-ai/compat";
import { createDirectSdkProvider } from "../../src/provider.js";

const page = (id: string, output = "64K") => `
| Platform | Model ID |
| --- | --- |
| Claude API | \`${id}\` |

| Feature | Value |
| --- | --- |
| Context window | 1M tokens |
| Max output | ${output} tokens |
| Thinking | Adaptive |
| Default effort | high |
| Input → output | Text and images → text |
`;

const overview = `
| Feature | Claude Future 9 | Claude Future 10 |
| --- | --- | --- |
| Claude API ID | \`claude-future-9\` | \`claude-future-10\` |

[Claude Future 9](https://platform.claude.com/docs/en/models/future-9/overview)
[Claude Future 10](https://platform.claude.com/docs/en/models/future-10/overview)
`;
const cache = `
| Cache operation | Multiplier | Duration |
| --- | --- | --- |
| 5-minute cache write | 1.25x | Cache valid for 5 minutes |
| 1-hour cache write | 2x | Cache valid for 1 hour |
`;
const effort = `
| Effort | Description | Use case |
| --- | --- | --- |
| max | Available on Claude Future 9 and Claude Future 10. | Deep work |
| xhigh | Available on Claude Future 9 and Claude Future 10. | Coding |
| high | High effort | Complex work |
| medium | Medium effort | Routine work |
| low | Low effort | Quick work |
`;

test("live refresh is nonblocking, updates routes and prices, and reports incomplete or failed metadata", async t => {
  const dir = await mkdtemp(join(tmpdir(), "directsdk-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, "claude.cjs");
  const exited = join(dir, "exited");
  const route = join(dir, "route");
  await writeFile(route, "claude-future-9");
  await writeFile(cli, `#!${process.execPath}
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(exited)}, "finished");
  console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:"pi-picker",response:{models:[{
    value:"future",resolvedModel:fs.readFileSync(${JSON.stringify(route)}, "utf8"),displayName:"Future",description:"Future 9",
    supportsEffort:true,supportedEffortLevels:["low","medium","high"]
  }]}}}));
}, 250));
`, { mode: 0o700 });
  const previous = process.env["CLAUDE_DIRECTSDK_COMMAND"];
  process.env["CLAUDE_DIRECTSDK_COMMAND"] = cli;
  t.after(() => {
    if (previous === undefined) delete process.env["CLAUDE_DIRECTSDK_COMMAND"];
    else process.env["CLAUDE_DIRECTSDK_COMMAND"] = previous;
  });
  let mode: "partial" | "complete" | "failure" = "partial";
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests++;
    const path = String(url);
    if (path.endsWith("models/overview.md")) return new Response(overview);
    if (path.endsWith("effort.md")) return new Response(effort);
    if (path.endsWith("future-9/overview.md")) return new Response(page("claude-future-9"));
    if (path.endsWith("future-10/overview.md")) return new Response(page("claude-future-10", "128K"));
    assert.ok(path.endsWith("pricing.md"), `unexpected document request: ${path}`);
    if (mode === "failure") return new Response("unavailable", { status: 503 });
    return new Response(`
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Future 9 (for prompts up to 100,000 tokens) | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.1 / MTok | $5 / MTok |
| Claude Future 9 (for prompts over 100,000 tokens) | $2 / MTok | $2.5 / MTok | $4 / MTok | $0.2 / MTok | $10 / MTok |
${mode === "complete" ? "| Claude Future 10 | $4 / MTok | $5 / MTok | $8 / MTok | $0.2 / MTok | $20 / MTok |" : ""}
${cache}`);
  });
  const warnings: string[] = [];
  const modelsStore = new InMemoryModelsStore();
  const runtime = createModels({ modelsStore });
  runtime.setProvider(createDirectSdkProvider(message => warnings.push(message)));
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual(runtime.getModels("claude-directsdk"), []);
  assert.equal(requests, 0, "cache-only startup must not fetch documents");
  assert.equal(existsSync(exited), false, "cache-only startup must not run the CLI");

  const refreshing = runtime.refresh();
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(exited), false, "the event loop must respond while the CLI is still running");
  const first = await refreshing;
  assert.equal(first.errors.size, 0);
  const alias = runtime.getModel("claude-directsdk", "future");
  assert.ok(alias);
  assert.equal(alias.maxTokens, 64000);
  assert.equal(alias.contextWindow, 1_000_000);
  assert.equal(alias.cost.input, 1);
  assert.equal(alias.cost.tiers?.[0]?.inputTokensAbove, 100000);
  assert.equal(alias.cost.tiers?.[0]?.output, 10);
  assert.equal(alias.thinkingLevelMap?.max, null, "picker effort constraints override web support");
  assert.deepEqual(alias.promptCache, { short: 300, long: 3600 });
  assert.equal(runtime.getModel("claude-directsdk", "claude-future-10"), undefined);
  assert.match(warnings.join("\n"), /claude-future-10: missing pricing/);

  mode = "complete";
  await writeFile(route, "claude-future-10");
  await runtime.refresh({ force: true });
  const discovered = runtime.getModel("claude-directsdk", "claude-future-10");
  assert.ok(discovered, "new models must appear without a source change or CLI picker update");
  assert.equal(discovered.maxTokens, 128000);
  assert.equal(discovered.cost.input, 4);
  assert.equal(discovered.thinkingLevelMap?.max, null);
  assert.equal(runtime.getModel("claude-directsdk", "future")?.cost.input, 4, "aliases must follow the refreshed picker resolution");
  assert.match(runtime.getModel("claude-directsdk", "claude-future-9")?.name ?? "", /not in CLI picker/);
  assert.equal(runtime.getModel("claude-directsdk", "claude-future-9")?.thinkingLevelMap?.max, "max");
  const beforeCacheOnly = requests;
  await runtime.refresh({ allowNetwork: false });
  assert.equal(requests, beforeCacheOnly);

  const restarted = createModels({ modelsStore });
  restarted.setProvider(createDirectSdkProvider(message => warnings.push(message)));
  await restarted.refresh({ allowNetwork: false });
  assert.equal(requests, beforeCacheOnly, "restoring a verified snapshot must not fetch documents");
  assert.match(restarted.getModel("claude-directsdk", "claude-future-10")?.name ?? "", /last verified snapshot/);

  mode = "failure";
  const failed = await runtime.refresh({ force: true });
  assert.match(failed.errors.get("claude-directsdk")?.message ?? "", /HTTP 503/);
  assert.deepEqual(runtime.getModels("claude-directsdk"), [], "failed discovery must not retain a pinned or stale catalog");
  assert.match(warnings.join("\n"), /No pinned fallback/);
  assert.equal(await modelsStore.read("claude-directsdk"), undefined, "failed discovery must remove the snapshot");
});

test("cancelling refresh stops a stalled CLI without publishing models", async t => {
  const dir = await mkdtemp(join(tmpdir(), "directsdk-cancel-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, "claude.cjs");
  await writeFile(cli, `#!${process.execPath}\nprocess.stdin.resume(); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const previous = process.env["CLAUDE_DIRECTSDK_COMMAND"];
  process.env["CLAUDE_DIRECTSDK_COMMAND"] = cli;
  t.after(() => {
    if (previous === undefined) delete process.env["CLAUDE_DIRECTSDK_COMMAND"];
    else process.env["CLAUDE_DIRECTSDK_COMMAND"] = previous;
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("aborted discovery must not contact the web"); });
  const runtime = createModels();
  runtime.setProvider(createDirectSdkProvider(() => { throw new Error("cancellation is not a refresh failure warning"); }));
  const controller = new AbortController();
  const refreshing = runtime.refresh({ signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await refreshing;
  assert.equal(result.aborted, true);
  assert.deepEqual(runtime.getModels("claude-directsdk"), []);
});
