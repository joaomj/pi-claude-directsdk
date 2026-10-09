/**
 * Shared black-box helpers for the end-to-end suite.
 *
 * These helpers only locate the repository and consume the public Pi event
 * protocol. They never reach into provider internals.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Api,
  Model,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai/compat";

/** Repository root, found by walking up from this file to package.json. */
export function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("repository root not found");
    }
    dir = parent;
  }
}

export type TerminalEvent = Extract<
  AssistantMessageEvent,
  { type: "done" } | { type: "error" }
>;

/**
 * Consume a provider event stream until the single terminal event.
 * Rejects when the stream ends without one or the timeout expires.
 */
export async function collectTerminal(
  stream: AssistantMessageEventStream,
  timeoutMs: number,
): Promise<{ events: AssistantMessageEvent[]; terminal: TerminalEvent }> {
  const events: AssistantMessageEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no terminal event within ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    const consume = (async (): Promise<TerminalEvent> => {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "done" || event.type === "error") {
          return event;
        }
      }
      throw new Error("stream ended without a terminal event");
    })();
    const terminal = await Promise.race([consume, timeout]);
    return { events, terminal };
  } finally {
    clearTimeout(timer);
  }
}

/** Explicit transport fixture, independent of catalog discovery and pricing. */
export function fixtureModel(id = "sonnet"): Model<Api> {
  return {
    id, name: "Transport fixture", api: "claude-directsdk",
    provider: "claude-directsdk", baseUrl: "process://claude-directsdk",
    reasoning: true, thinkingLevelMap: { minimal: "low", low: "low", high: "high" },
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 32000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
}
