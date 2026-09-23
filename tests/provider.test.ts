import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import { MODELS, refreshModels } from "../src/provider.js";
import { CATALOG } from "../src/models.js";

const savedPath = process.env["PATH"];
afterEach(() => {
  if (savedPath === undefined) {
    delete process.env["PATH"];
  } else {
    process.env["PATH"] = savedPath;
  }
});

describe("provider", () => {
  it("registers the pinned catalog with pricing metadata", () => {
    assert.ok(MODELS.length >= CATALOG.length);
    for (const model of MODELS) {
      assert.equal(model.api, "claude-directsdk");
      assert.equal(typeof model.contextWindow, "number");
      assert.equal(typeof model.maxTokens, "number");
      assert.ok(model.cost.input >= 0);
    }
    const ids = new Set(MODELS.map((m) => m.id));
    for (const entry of CATALOG) {
      assert.ok(ids.has(entry.id), `missing pinned model ${entry.id}`);
    }
  });

  it("keeps the pinned catalog when discovery is unavailable", async () => {
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "pi-directsdk-empty-"));
    const controller = new AbortController();
    const refreshed = await refreshModels({
      signal: controller.signal,
    } as unknown as RefreshModelsContext);
    assert.deepEqual(
      refreshed.map((m) => m.id),
      MODELS.map((m) => m.id),
    );
  });
});
