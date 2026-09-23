import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALIAS_IDS,
  ALIASES,
  CATALOG,
  CONTEXT_WINDOWS,
  PROVIDER_ID,
  QUALIFIED_CLI_RANGE,
  acceptsThinkingDisable,
  cliVersionSupported,
  contextWindowFor,
  nativeModel,
  parseCliVersion,
  supportsAdaptiveThinking,
} from "../src/models.js";

describe("models", () => {
  it("exposes the claude-directsdk provider id", () => {
    assert.equal(PROVIDER_ID, "claude-directsdk");
  });

  it("selects native routes with the long-context rule", () => {
    assert.equal(nativeModel("claude-opus-5-5"), "claude-opus-5-5[1m]");
    assert.equal(nativeModel("sonnet"), "claude-sonnet-5[1m]");
    assert.equal(nativeModel("haiku"), "claude-haiku-4-5-20251001");
    assert.throws(() => nativeModel(""), /model is required/);
    assert.throws(
      () => nativeModel("claude-haiku-4-5-20251001[1m]"),
      /does not support a 1M context window/,
    );
  });

  it("resolves every alias into the pinned catalog", () => {
    const ids = new Set(CATALOG.map((entry) => entry.id));
    for (const alias of ALIAS_IDS) {
      const route = nativeModel(alias).replace(/\[1m\]$/, "");
      assert.ok(ids.has(route), `${alias} resolves outside the pinned catalog`);
      assert.ok(ALIASES[alias], `${alias} missing from the alias table`);
    }
  });

  it("documents a context window for every pinned route", () => {
    for (const entry of CATALOG) {
      assert.ok(
        (CONTEXT_WINDOWS[entry.id] ?? 0) > 0,
        `missing context window for ${entry.id}`,
      );
      assert.equal(entry.contextWindow, CONTEXT_WINDOWS[entry.id]);
    }
    assert.equal(contextWindowFor("claude-opus-5-5"), 1_000_000);
    assert.equal(contextWindowFor("unknown-route"), 200_000);
  });

  it("parses CLI versions", () => {
    assert.equal(parseCliVersion("2.1.267 (Claude Code)"), "2.1.267");
    assert.equal(parseCliVersion("2.0.1"), "2.0.1");
    assert.equal(parseCliVersion("no version here"), "unknown");
  });

  it("qualifies exactly the documented CLI range", () => {
    assert.match(QUALIFIED_CLI_RANGE, /2\.1\.263/);
    assert.equal(cliVersionSupported("2.1.263"), true);
    assert.equal(cliVersionSupported("2.1.267"), true);
    assert.equal(cliVersionSupported("2.1.262"), false);
    assert.equal(cliVersionSupported("2.2.0"), false);
    assert.equal(cliVersionSupported("3.0.0"), false);
    assert.equal(cliVersionSupported("unknown"), false);
  });

  it("reports thinking support per route", () => {
    assert.equal(supportsAdaptiveThinking("claude-opus-5-5"), true);
    assert.equal(supportsAdaptiveThinking("claude-haiku-4-5-20251001"), false);
    assert.equal(acceptsThinkingDisable("claude-fable-5-1"), false);
    assert.equal(acceptsThinkingDisable("claude-opus-5-5"), true);
  });
});
