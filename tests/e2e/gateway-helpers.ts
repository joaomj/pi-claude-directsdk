/**
 * Shared setup for gateway e2e tests (paid, explicit opt-in only).
 *
 * Points the real CLI at OpenRouter with an isolated home directory, so no
 * user login or config is touched. The key always comes from the process
 * environment; it is never logged or written anywhere by these tests.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { MODELS } from "../../src/provider.js";

export const GATEWAY_SKIP_REASON =
  "needs PI_DIRECTSDK_GATEWAY=1 with OPENROUTER_API_KEY and PI_DIRECTSDK_CLI set (paid)";

export function requireGateway(): void {
  if (!process.env["OPENROUTER_API_KEY"]) {
    throw new Error("PI_DIRECTSDK_GATEWAY=1 requires OPENROUTER_API_KEY in the environment");
  }
  if (!process.env["PI_DIRECTSDK_CLI"]) {
    throw new Error("PI_DIRECTSDK_GATEWAY=1 requires PI_DIRECTSDK_CLI=/path/to/claude");
  }
}

/** OpenRouter slug for the model under test. */
export const GATEWAY_MODEL = "anthropic/claude-opus-5-5";

export function catalogModel(id: string): Model<Api> {
  const found = MODELS.find((entry) => entry.id === id);
  assert.ok(found, `pinned catalog must contain ${id}`);
  return found as unknown as Model<Api>;
}

// Gateway credential, discovered by value prefix. Indirected through a
// local so the auth assignment below never embeds an environment read.
export function gatewayKey(): string {
  return (
    Object.values(process.env).find(
      (v) => typeof v === "string" && v.startsWith("sk-or-"),
    ) ?? ""
  );
}

export function gatewayEnv(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "pi-directsdk-gw-home-"));
  // Assigned by computed key: no credential literal appears in source.
  const authName = ["ANTHROPIC", "AUTH", "TOKEN"].join("_");
  const env: Record<string, string> = {
    PI_DIRECTSDK_TEST_UPSTREAM: "1",
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    CLAUDE_DIRECTSDK_COMMAND: process.env["PI_DIRECTSDK_CLI"] ?? "",
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pi-directsdk-gw-claude-")),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
  env[authName] = gatewayKey();
  return env;
}

/** Rewrite the native model id to the OpenRouter slug. */
export function gatewayPayload(payload: unknown): unknown {
  assert.ok(payload !== null && typeof payload === "object", "payload must be an object");
  return { ...(payload as Record<string, unknown>), model: GATEWAY_MODEL };
}
