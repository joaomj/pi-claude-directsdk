/**
 * Inert MCP server source.
 *
 * Inventory only: it advertises the current Pi tool set to the native child
 * and denies every call. Pi alone executes tools. The source is written into
 * the per-request private directory and spawned with the current Node
 * executable, so the provider ships no extra runtime dependency.
 *
 * No host imports, no effects, no executable tool implementations, and no
 * logging of tool payloads.
 */

export const INERT_MCP_SOURCE = `import { readFileSync } from "node:fs";

const manifestPath = process.argv[2];
if (!manifestPath) {
  process.stderr.write("inert MCP server needs a manifest path\\n");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end = buffer.indexOf("\\n");
  while (end !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) {
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        row = null;
      }
      if (row) {
        const method = row.method;
        let result = {};
        if (method === "initialize") {
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "pi-inert-inventory", version: "1" },
          };
        } else if (method === "tools/list") {
          result = { tools: manifest };
        } else if (method === "tools/call") {
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: "Denied: native tools are inert; only Pi executes tools.",
              },
            ],
          };
        }
        if (row.id !== undefined) {
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\\n",
          );
        }
      }
    }
    end = buffer.indexOf("\\n");
  }
});
`;
