/** Read the account picker without a model request or synchronous CLI probes. */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSupervised, type ChildHandle } from "./process.js";
import { resolveClaude, setupChildEnv } from "./setup.js";
import { INSTALL_HINT } from "./errors.js";
import { isRecord } from "./types.js";

export interface DiscoveredModel {
  id: string;
  alias: string;
  label: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export async function discoverModels(signal: AbortSignal): Promise<DiscoveredModel[]> {
  signal.throwIfAborted();
  const env = setupChildEnv(process.env);
  const resolved = resolveClaude(undefined, env);
  if (!resolved) throw new Error(INSTALL_HINT);
  let contacted = false;
  // Discovery has no reason to send an API request. Deny even the first one.
  const guard = createServer((request, response) => {
    if (request.method === "POST" && request.url?.split("?")[0] === "/v1/messages") contacted = true;
    response.writeHead(403).end("Model requests are disabled during discovery");
  });
  await new Promise<void>((resolve, reject) => {
    guard.once("error", reject);
    guard.listen(0, "127.0.0.1", resolve);
  });
  let cwd: string | undefined;
  let child: ChildHandle | undefined;
  try {
    cwd = await mkdtemp(join(tmpdir(), "pi-directsdk-picker-"));
    const address = guard.address();
    if (!address || typeof address === "string") throw new Error("Discovery guard has no address");
    const [command = "", ...prefix] = resolved;
    child = spawnSupervised({
      command,
      args: [...prefix, "-p", "--model", "sonnet", "--input-format", "stream-json", "--output-format", "stream-json",
        "--verbose", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence"],
      env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}` },
      cwd,
      timeoutMs: 10_000,
      signal,
    });
    await child.writeLine(JSON.stringify({
      type: "control_request", request_id: "pi-picker", request: { subtype: "initialize" },
    }));
    child.closeStdin();
    let models: unknown;
    let bytes = 0;
    for (;;) {
      const line = await child.nextLine();
      if (line === null) break;
      bytes += Buffer.byteLength(line);
      if (bytes > 8 * 1024 * 1024) throw new Error("Claude discovery response exceeds 8 MiB");
      if (!line.startsWith("{")) continue;
      const row: unknown = JSON.parse(line);
      if (!isRecord(row) || row["type"] !== "control_response") continue;
      const response = row["response"];
      if (!isRecord(response) || response["request_id"] !== "pi-picker") continue;
      if (response["subtype"] === "error") throw new Error("Claude picker initialization failed; check claude auth status");
      const inner = response["response"];
      if (isRecord(inner)) models = inner["models"];
    }
    const exit = await child.wait();
    signal.throwIfAborted();
    if (contacted) throw new Error("Claude attempted an API request during model discovery; request blocked");
    if (exit.code !== 0) throw new Error(`Claude discovery exited with code ${exit.code}; check claude auth status`);
    if (!Array.isArray(models) || models.length === 0) throw new Error("Claude returned no model picker metadata");
    return models.map((row: unknown) => {
      if (!isRecord(row) || typeof row["resolvedModel"] !== "string" || typeof row["value"] !== "string") {
        throw new Error("Claude picker is missing resolvedModel or value; update Claude Code");
      }
      return {
        id: row["resolvedModel"].replace(/\[1m\]$/, ""),
        alias: row["value"],
        label: typeof row["displayName"] === "string" ? row["displayName"] : row["value"],
        description: typeof row["description"] === "string" ? row["description"] : "",
        ...(typeof row["supportsEffort"] === "boolean" ? { supportsEffort: row["supportsEffort"] } : {}),
        ...(Array.isArray(row["supportedEffortLevels"]) && row["supportedEffortLevels"].every(x => typeof x === "string")
          ? { supportedEffortLevels: row["supportedEffortLevels"] as string[] } : {}),
      };
    });
  } finally {
    if (child) {
      child.cancel();
      await child.wait();
    }
    guard.closeAllConnections();
    await new Promise<void>((resolve, reject) => guard.close(error => error ? reject(error) : resolve()));
    if (cwd) await rm(cwd, { recursive: true, force: true });
  }
}
