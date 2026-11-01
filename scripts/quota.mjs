#!/usr/bin/env node
/**
 * Read the Claude subscription usage endpoint that Claude Code's own /status
 * uses, the same way @joaomj/pi-claude-usage does.
 *
 * The OAuth token is read from Claude Code's login file, used for one request,
 * and never printed, logged, or written anywhere. Only the usage payload is
 * printed.
 *
 *   node scripts/quota.mjs read          raw payload plus parsed windows
 *   node scripts/quota.mjs watch <secs>  poll every <secs> and print deltas
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOST = "api.anthropic.com";
const PATH = "/api/oauth/usage";
const BETA = "oauth-2025-04-20";

function token() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const raw = JSON.parse(readFileSync(join(base, ".credentials.json"), "utf8"));
  const oauth = raw?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    throw new Error("no OAuth access token in the Claude Code login file");
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now() + 30_000) {
    throw new Error("the Claude Code OAuth token has expired; run `claude auth login`");
  }
  return oauth.accessToken;
}

export async function fetchUsage() {
  const response = await fetch(`https://${HOST}${PATH}`, {
    headers: { Authorization: `Bearer ${token()}`, "anthropic-beta": BETA },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`usage endpoint returned ${response.status}: ${body.slice(0, 200)}`);
  }
  return JSON.parse(body);
}

/** Percent used and remaining for each window, keeping whatever precision the payload has. */
export function windows(payload) {
  const out = {};
  for (const entry of Array.isArray(payload?.limits) ? payload.limits : []) {
    if (!entry || typeof entry.percent !== "number") continue;
    out[entry.kind] = {
      usedPercent: entry.percent,
      remainingPercent: Number((100 - entry.percent).toFixed(4)),
      resetsAt: entry.resets_at ?? null,
    };
  }
  for (const [kind, key] of [["session", "five_hour"], ["weekly_all", "seven_day"]]) {
    if (out[kind]) continue;
    const bucket = payload?.[key];
    if (!bucket || typeof bucket.utilization !== "number") continue;
    out[kind] = {
      usedPercent: bucket.utilization,
      remainingPercent: Number((100 - bucket.utilization).toFixed(4)),
      resetsAt: bucket.resets_at ?? null,
    };
  }
  return out;
}

/**
 * One usage reading, as { session, weekly_all } with used/remaining percent.
 *
 * The endpoint rate-limits hard: a burst of reads returns 429. Calls are spaced
 * a minute apart, which is what @joaomj/pi-claude-usage does, and a 429 backs
 * off instead of failing the run.
 */
const MIN_INTERVAL_MS = 61_000;
let lastCall = 0;

export async function readPayload() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    lastCall = Date.now();
    try {
      return await fetchUsage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("429") || attempt === 3) throw error;
      const backoff = 60_000 * (attempt + 1);
      console.error(`[quota] rate limited, retrying in ${backoff / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw new Error("the usage endpoint kept rate-limiting");
}

export async function readWindows() {
  return windows(await readPayload());
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const mode = process.argv[2] ?? "read";

if (!isMain) {
  // Imported as a library; the sweep driver owns the loop.
} else if (mode === "read") {
  const payload = await readPayload();
  console.log(JSON.stringify({ windows: windows(payload), raw: payload }, null, 2));
} else if (mode === "watch") {
  // The endpoint allows about one read a minute.
  const seconds = Math.max(90, Number(process.argv[3] ?? 90));
  let previous = await readWindows();
  console.log(`${new Date().toISOString()} ${JSON.stringify(previous)}`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const current = await readWindows();
    const delta = {};
    for (const kind of Object.keys(current)) {
      const before = previous[kind]?.usedPercent;
      const after = current[kind]?.usedPercent;
      if (Number.isFinite(before) && Number.isFinite(after)) {
        delta[kind] = Number((after - before).toFixed(4));
      }
    }
    console.log(`${new Date().toISOString()} used=${JSON.stringify(delta)} ${JSON.stringify(current)}`);
    previous = current;
  }
} else {
  console.error("usage: node scripts/quota.mjs [read|watch <seconds>]");
  process.exit(2);
}
