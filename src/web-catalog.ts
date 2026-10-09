/** Public Anthropic metadata. A changed or incomplete source fails closed. */
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { DiscoveredModel } from "./discovery.js";
import { PROVIDER_ID } from "./models.js";

const ROOT = "https://platform.claude.com/docs/en";
const OVERVIEW = `${ROOT}/about-claude/models/overview.md`;
const PRICING = `${ROOT}/about-claude/pricing.md`;
const EFFORT = `${ROOT}/build-with-claude/effort.md`;
const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

type ChatModel = Model<Api>;
export interface CatalogResult { models: ChatModel[]; warnings: string[] }

function plain(value: string): string {
  return value.replace(/<sup>.*?<\/sup>/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "").trim();
}

function tables(document: string): string[][][] {
  const result: string[][][] = [];
  let table: string[][] = [];
  for (const line of document.split("\n")) {
    if (line.trim().startsWith("|")) {
      const cells = line.trim().slice(1, -1).split("|").map(plain);
      if (!cells.every(cell => /^[:\s-]+$/.test(cell))) table.push(cells);
    } else if (table.length) {
      result.push(table);
      table = [];
    }
  }
  if (table.length) result.push(table);
  return result;
}

async function document(url: string, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(url, { signal, headers: { Accept: "text/markdown" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("empty response body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw new Error("document exceeds 2 MiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    throw new Error(`Cannot load model metadata from ${url}: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

function tokenLimit(value: string | undefined, field: string): number {
  const match = /^(\d+(?:\.\d+)?)([KM])?(?: tokens)?$/i.exec(value ?? "");
  const count = match ? Number(match[1]) * (match[2]?.toUpperCase() === "M" ? 1e6 : match[2]?.toUpperCase() === "K" ? 1e3 : 1) : NaN;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`missing or unsupported ${field}`);
  return count;
}

function price(value: string | undefined): number {
  const match = /^\$(\d+(?:\.\d+)?)\s*\/\s*MTok$/.exec(value ?? "");
  if (!match) throw new Error(`missing or unsupported price: ${value ?? "absent"}`);
  return Number(match[1]);
}

function pricingFor(name: string, pricing: string[][]): ChatModel["cost"] {
  const rows = pricing.slice(1).filter(row => row[0]?.split(" (")[0] === name);
  if (!rows.length) throw new Error("missing pricing");
  let base: ChatModel["cost"] | undefined;
  let ceiling: number | undefined;
  const tiers: NonNullable<ChatModel["cost"]["tiers"]> = [];
  for (const row of rows) {
    const rates = { input: price(row[1]), cacheWrite: price(row[2]), cacheRead: price(row[4]), output: price(row[5]) };
    if (price(row[3]) !== rates.input * 2) throw new Error("1-hour cache pricing cannot be represented by Pi");
    const label = row[0] ?? "";
    const over = /\(for prompts over ([\d,]+) tokens\)$/.exec(label);
    const upTo = /\(for prompts up to ([\d,]+) tokens\)$/.exec(label);
    if (over) {
      tiers.push({ ...rates, inputTokensAbove: Number(over[1]?.replace(/,/g, "")) });
    } else {
      if (base) throw new Error("ambiguous base pricing");
      if (label !== name && !upTo && !/\((?:limited availability|retired.*)\)$/.test(label)) {
        throw new Error("unrecognized pricing condition");
      }
      base = rates;
      if (upTo) ceiling = Number(upTo[1]?.replace(/,/g, ""));
    }
  }
  if (!base || (ceiling !== undefined && (tiers.length !== 1 || tiers[0]?.inputTokensAbove !== ceiling))) {
    throw new Error("incomplete pricing tiers");
  }
  if (tiers.length && ceiling === undefined) throw new Error("missing pricing tier boundary");
  return { ...base, ...(tiers.length ? { tiers } : {}) };
}

function cacheLifetimes(prices: string): NonNullable<ChatModel["promptCache"]> {
  const table = tables(prices).find(rows => rows[0]?.[0] === "Cache operation");
  const seconds = (operation: string): number => {
    const duration = table?.find(row => row[0] === operation)?.[2];
    const match = /^Cache valid for (\d+) (minutes?|hours?)$/.exec(duration ?? "");
    if (!match) throw new Error("missing prompt cache lifetime");
    return Number(match[1]) * (match[2]?.startsWith("hour") ? 3600 : 60);
  };
  return { short: seconds("5-minute cache write"), long: seconds("1-hour cache write") };
}

function thinkingMap(name: string, thinking: string, defaultEffort: string | undefined,
  live: DiscoveredModel | undefined, effort: string[][]): NonNullable<ChatModel["thinkingLevelMap"]> {
  let supported: string[];
  if (live?.supportsEffort === true && live.supportedEffortLevels?.length) {
    supported = live.supportedEffortLevels;
  } else if (live?.supportsEffort === false || /^extended$/i.test(thinking) && /^(?:not supported|—|n\/a)$/i.test(defaultEffort ?? "")) {
    supported = [];
  } else {
    if (!LEVELS.some(level => level === defaultEffort)) throw new Error("missing supported thinking levels");
    supported = LEVELS.filter(level => {
      const row = effort.find(cells => cells[0] === level);
      if (!row) throw new Error(`missing ${level} effort metadata`);
      if (level === "max" || level === "xhigh") {
        const listed = row[1]?.match(/Available on (.*?)(?:\.\s|\.$)/)?.[1];
        if (!listed) throw new Error(`missing ${level} model support list`);
        return listed.split(/,\s*(?:and )?| and /).includes(name);
      }
      return true;
    });
  }
  if (supported.some(level => !LEVELS.some(known => known === level))) throw new Error("unsupported effort level in Claude picker");
  return {
    off: null,
    minimal: supported.includes("low") ? "low" : null,
    low: supported.includes("low") ? "low" : null,
    medium: supported.includes("medium") ? "medium" : null,
    high: supported.includes("high") ? "high" : null,
    xhigh: supported.includes("xhigh") ? "xhigh" : null,
    max: supported.includes("max") ? "max" : null,
  };
}

export async function loadWebCatalog(picker: DiscoveredModel[], signal: AbortSignal): Promise<CatalogResult> {
  const [overview, prices, efforts] = await Promise.all([
    document(OVERVIEW, signal), document(PRICING, signal), document(EFFORT, signal),
  ]);
  const promptCache = cacheLifetimes(prices);
  const overviewTables = tables(overview);
  const current = overviewTables.find(table => table[0]?.[0] === "Feature")?.find(row => row[0] === "Claude API ID")?.slice(1);
  if (!current?.length) throw new Error(`Missing current model IDs in ${OVERVIEW}`);
  const pricing = tables(prices).find(table => table[0]?.join("|") ===
    "Model|Base input tokens|5m cache writes|1h cache writes|Cache hits and refreshes|Output tokens");
  if (!pricing) throw new Error(`Missing model pricing table in ${PRICING}`);
  const effort = tables(efforts).find(table => table.some(row => row[0] === "max") && table.some(row => row[0] === "low"));
  if (!effort) throw new Error(`Missing effort table in ${EFFORT}`);
  const links = new Map<string, { name: string; url: string }>();
  for (const match of overview.matchAll(/\[(Claude [^\]]+)\]\((https:\/\/platform\.claude\.com\/docs\/en\/models\/([a-z0-9-]+)\/overview)\)/g)) {
    links.set(match[3]!, { name: match[1]!, url: `${match[2]}.md` });
  }
  const ids = [...new Set([...current, ...picker.map(row => row.id)])];
  const models: ChatModel[] = [];
  const warnings: string[] = [];
  // Bound concurrent document requests independently of future catalog size.
  for (let start = 0; start < ids.length; start += 4) {
    await Promise.all(ids.slice(start, start + 4).map(async id => {
      signal.throwIfAborted();
      try {
        const link = links.get(id.replace(/^claude-/, "").replace(/-\d{8}$/, ""));
        if (!link) throw new Error("missing official model page");
        const page = tables(await document(link.url, signal));
        if (!page.some(table => table.some(row => row[0] === "Claude API" && row[1] === id))) {
          throw new Error("official model page does not confirm this model ID");
        }
        const features = page.find(table => table.some(row => row[0] === "Input → output"));
        const value = (key: string): string | undefined => features?.find(row => row[0] === key)?.[1];
        const thinking = value("Thinking");
        if (!thinking || !/^(Adaptive(?: \(always on\))?|Extended|Not supported)$/i.test(thinking)) throw new Error("missing thinking capability");
        const inputs = value("Input → output");
        if (inputs !== "Text and images → text" && inputs !== "Text → text") throw new Error("missing input modalities");
        const live = picker.find(row => row.id === id);
        const model: ChatModel = {
          id, name: `${link.name} (subscription${live ? "" : "; not in CLI picker"})`,
          api: PROVIDER_ID, provider: PROVIDER_ID, baseUrl: "process://claude-directsdk",
          reasoning: thinking !== "Not supported",
          thinkingLevelMap: thinkingMap(link.name, thinking, value("Default effort"), live, effort),
          input: inputs === "Text → text" ? ["text"] : ["text", "image"],
          contextWindow: tokenLimit(value("Context window"), "context window"),
          maxTokens: tokenLimit(value("Max output"), "output limit"),
          cost: pricingFor(link.name, pricing),
          promptCache,
        };
        models.push(model);
        for (const alias of picker.filter(row => row.id === id && row.alias !== id)) {
          models.push({ ...model, id: alias.alias, name: `${link.name} (${alias.alias} alias)${/usage credit/i.test(alias.description) ? " · usage credits" : ""}` });
        }
      } catch (error) {
        signal.throwIfAborted();
        warnings.push(`${id}: ${error instanceof Error ? error.message : error}`);
      }
    }));
  }
  const unique = new Map(models.map(model => [model.id, model]));
  return { models: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings: warnings.sort() };
}
