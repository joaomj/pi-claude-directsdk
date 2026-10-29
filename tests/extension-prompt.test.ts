import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import createExtension from "../extensions/claude-directsdk/index.ts";
import { PROVIDER_ID } from "../src/models.ts";

/** The routing line Anthropic's server treats as a third-party app fingerprint. */
const PI_DOCS = [
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
  "- When asked about: custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
].join("\n");

type PromptOptions = {
  customPrompt?: string;
  forceSystemPrompt?: string;
  sections: Record<string, string>;
};

function docsSectionAfterStart(
  provider: string | undefined,
  options: PromptOptions,
): string | undefined {
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  const api = {
    on(event: string, handler: (event: unknown, context: unknown) => void): void {
      handlers.set(event, handler);
    },
    registerProvider(): void {},
    unregisterProvider(): void {},
  } as unknown as ExtensionAPI;
  createExtension(api);
  const handler = handlers.get("before_agent_start");
  assert.ok(handler, "extension registers a before_agent_start handler");
  handler({ systemPromptOptions: options }, provider === undefined ? {} : { model: { provider } });
  return options.sections["docs"];
}

test("a DirectSDK turn sends a docs pointer instead of Pi's routing line", () => {
  const docs = docsSectionAfterStart(PROVIDER_ID, { sections: { docs: PI_DOCS } });
  assert.ok(docs, "the docs section is still present");
  assert.notEqual(docs, PI_DOCS);
  assert.equal(docs.includes("docs/custom-provider.md"), false);
  assert.equal(docs.includes("pi packages"), false);
  assert.match(docs, /documentation/u);
});

test("another provider keeps Pi's default docs section", () => {
  const docs = docsSectionAfterStart("anthropic", { sections: { docs: PI_DOCS } });
  assert.equal(docs, PI_DOCS);
});

test("a custom or forced prompt is left alone", () => {
  for (const options of [{ customPrompt: "Be brief.", sections: {} }, { forceSystemPrompt: "Be brief.", sections: {} }]) {
    assert.equal(docsSectionAfterStart(PROVIDER_ID, options), undefined);
    assert.equal("docs" in options.sections, false);
  }
});
