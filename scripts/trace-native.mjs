/** Observe real Claude children without changing their requests or responses. */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const destination = process.env.PI_VERIFY_TRACE;
const claude = process.env.CLAUDE_DIRECTSDK_COMMAND || "claude";
const matches = command => typeof command === "string" &&
  (command === claude || basename(command) === basename(claude));
const record = data => {
  if (destination) appendFileSync(destination, `${JSON.stringify(data)}\n`, { mode: 0o600 });
};
function observe(line) {
  if (!line.startsWith("{")) return;
  let event;
  try { event = JSON.parse(line); }
  catch (error) { record({ kind: "malformed-native-record", detail: error.message }); return; }
  if (event.type !== "result") return;
  record({
    kind: "native-result", subtype: event.subtype, isError: event.is_error,
    turns: event.num_turns,
    // Successful model text and replayed transcript records are never logged.
    ...(event.is_error ? {
      errors: Array.isArray(event.errors) ? event.errors.map(value => String(value).slice(0, 2000)) : [],
      detail: typeof event.result === "string" ? event.result.slice(0, 2000) : undefined,
    } : {}),
  });
}
const spawn = childProcess.spawn;
childProcess.spawn = function (command, ...args) {
  const child = spawn.call(this, command, ...args);
  if (!matches(command)) return child;
  const argv = Array.isArray(args[0]) ? args[0] : [];
  const modelAt = argv.indexOf("--model");
  record({ kind: "claude-spawn", pid: child.pid,
    model: modelAt >= 0 ? argv[modelAt + 1] : undefined });
  let pending = "";
  child.stdout?.on("data", chunk => {
    pending += chunk.toString();
    let boundary;
    while ((boundary = pending.indexOf("\n")) !== -1) {
      observe(pending.slice(0, boundary));
      pending = pending.slice(boundary + 1);
    }
    if (pending.length > 8 * 1024 * 1024) {
      record({ kind: "native-record-too-large" });
      pending = "";
    }
  });
  child.on("close", (code, signal) => {
    if (pending) observe(pending);
    record({ kind: "claude-exit", pid: child.pid, code, signal });
  });
  return child;
};
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, ...args) {
  if (matches(command)) record({ kind: "claude-sync-spawn" });
  return spawnSync.call(this, command, ...args);
};
syncBuiltinESMExports();
