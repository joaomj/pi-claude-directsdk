# Architecture

One Pi model call spawns one request-scoped `claude` process and admits at most one upstream Messages request.

```mermaid
flowchart TD
    A["Pi calls streamSimple(model, transcript)"] --> B["Provider reads system prompt + tools from transcript messages"]
    B --> C["Provider writes private files: system.md, settings.json (CLAUDE_CODE_EXTRA_BODY), tools.json"]
    C --> D["Provider starts admission relay on 127.0.0.1 with per-request token route"]
    D --> E["Provider spawns one request-scoped claude process (ANTHROPIC_BASE_URL points at relay, child env only)"]
    E --> F["Provider replays history on child stdin (shouldQuery: false, final frame queries)"]
    F --> G["CLI sends POST /v1/messages through relay"]
    G -->|first request| H["Relay forwards to api.anthropic.com, captures SSE"]
    G -->|later requests| I["Relay denies locally, no upstream contact"]
    E --> J["Provider converts child stdout stream-json to Pi events"]
    H --> K["Provider publishes tool calls only after upstream completes and child exits"]
    K --> L["Pi executes tools (inert MCP advertises them, never executes)"]
    L --> M["done with exact usage, or error"]
```

## Components

### Provider entry (`src/provider.ts`, `extensions/claude-directsdk/index.ts`)

The extension registers a complete Pi provider with id `claude-directsdk` and an initially empty catalog. Cache-only refresh restores verified snapshots from Pi’s model store without CLI probes or network work. Live refresh runs after editor startup and reports failures instead of returning pinned models.

`streamSimple` uses `src/lazy-stream.ts` to return a stream immediately. The wrapper loads `src/stream.ts` asynchronously and preserves the model, transcript, and request options. See [startup.md](startup.md).

### History replay (`src/replay.ts`)

Pi owns the transcript. Each call replays prior assistant, user, and tool-result frames in native `stream-json` form through a fresh child.

Rules:

- Historical user frames carry `shouldQuery: false` and expect a zero-turn acknowledgment. Only the final frame may generate.
- The last frame must be a nonempty user or tool-result message. Assistant prefill is unsupported.
- Thinking without a matching native carrier is replayed as ordinary assistant text. This allows switching providers during a session.
- Other unsupported history is rejected with a `replay` error, never flattened into prose.
- Signed native thinking survives only inside a durable carrier (`pi-claude-directsdk/native`) attached to the Pi assistant message. The carrier is restored only when the visible projection (text, thinking, tool calls) still matches. Any edit drops the native blocks. Session files persist the carrier, so resumed turns replay exactly.

### Request assembly (`src/request.ts`)

The current system prompt and tool schemas travel through per-request private files with owner-only permissions:

- `system.md`: the system prompt.
- `settings.json`: carries `CLAUDE_CODE_EXTRA_BODY`.
- `tools.json`: the inert MCP manifest.
- `inert-mcp.mjs`: the inert MCP server source.

Files avoid OS argument and environment-string limits. Authentication and identity headers are never replaced. The relay preserves them.

The child argv (`buildArgv`) runs the CLI with `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--max-turns 1`, `--permission-mode dontAsk`, `--no-session-persistence`, `--strict-mcp-config`, `--disable-slash-commands`, and an empty `--setting-sources`. `--max-turns 1` is accepted by the qualified CLI even though recent `--help` output hides it. The fake-upstream gate re-verifies it on every CLI version change.

The child environment (`buildChildEnv`) points `ANTHROPIC_BASE_URL` at the relay. It sets native isolation flags (`ENABLE_TOOL_SEARCH=false`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_MAX_RETRIES=0`, `DISABLE_AUTO_COMPACT=1`, `DISABLE_COMPACT=1`, `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`). Sampling controls from Pi options (`temperature`, `top_p`) are dropped because subscription routes reject them.

### Admission relay (`src/admission.ts`)

The relay binds an ephemeral loopback port with a random per-request route (`/admit/<token>`). It forwards only the first upstream Messages request and rejects later native recovery or retry attempts locally with `PI_MODEL_ADMISSION_CONSUMED`. Only HTTP transfer encoding changes. Request identity and payload stay native.

The relay reconstructs the upstream assistant message from the SSE stream (`SseCapture`) and records status, request id, failure text, and an error body (capped at 64 KiB). Upstream targets must be HTTPS, except loopback HTTP fixtures used by tests. Request bodies are capped at 512 MiB.

### Child supervision (`src/process.ts`)

Each Pi model call owns one child in its own process group. Abort and failure kill the full tree. This matters on Windows, where the npm `claude` shim is `cmd.exe` -> `node` and a plain `kill()` would orphan the node child that holds the request open. Stdout is consumed as newline-delimited JSON with an idle deadline that resets on every received line. The caller receives the child final exit status after its output streams close.

### Stream conversion (`src/stream.ts`)

The provider converts child stdout `stream-json` to Pi events. Native tool calls are published only after the first upstream response is complete and the child has exited. Usage and stop reason come from the authoritative native usage. Incomplete native or upstream responses produce `incomplete` or `upstream` errors.

### Inert MCP (`src/inert-mcp.ts`)

The MCP server name in the native child is `pi`. Tool names are `mcp__pi__<name>`. The server advertises Pi tools so the CLI can call them. It never executes them. Pi alone executes tools.

### Catalog discovery (`src/discovery.ts`, `src/web-catalog.ts`)

Discovery runs the Claude Code `initialize` handshake through an asynchronous supervised child. It never calls synchronous authentication or version probes. A loopback guard denies all HTTP requests and detects attempted Messages requests; discovery cannot consume subscription allowance.

Public Anthropic Markdown documents supply current model IDs, model pages, prices, effort levels, and cache lifetimes. Model pages must confirm the canonical Claude API ID, input modalities, context window, output limit, and thinking capability. The account picker supplies resolved aliases and effort constraints. Current public models can appear even before the CLI picker includes them; their labels state that account availability is unverified.

Missing metadata excludes only the affected model with a warning. Shared-source failures reject refresh and remove the snapshot. Refresh uses a shared deadline and abort signal. Pi owns persistence and generation-checked publication.

### Request-time probes (`src/setup.ts`)

CLI resolution and version qualification run only when a model call needs them. They are not part of catalog discovery or editor startup.

## Guarantees

- The provider never executes native tools.
- The provider never manages login or reads credentials.
- The provider never falls back to another billing route.
- Missing CLI and logged-out CLI fail with actionable errors. See [troubleshooting.md](troubleshooting.md).

## Model routing

The catalog has no hand-written model inventory, aliases, limits, or price table. Its sources are:

- Claude Code’s account picker for resolved aliases and account-visible models.
- [Anthropic’s model overview](https://platform.claude.com/docs/en/about-claude/models/overview) and linked model pages for canonical routes and capabilities.
- [Anthropic’s pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing) for token prices, request-wide tiers, and cache lifetimes.
- [Anthropic’s effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort) for web-only model effort levels.

Verified context windows control native `[1m]` selection. Claude Code owns thinking mode; the request body sends only an effort level that the catalog supports. Missing metadata is never replaced with a guessed limit or a zero price.

`QUALIFIED_CLI_RANGE` in `src/models.ts` still controls transport qualification. Re-run the fake-upstream gate before widening it.

## Tool transport

Pi owns tool execution. The native child advertises Pi tools through the inert MCP server and never executes them. The authority is `src/request.ts` (`buildRequestBody`, `normalizeInputSchema`). The stable rules:

- Only `tool_choice` `auto` and `none` are supported.
- Constrained decoding is not enforced. Grammar and best-effort (`strict: "prefer"`) annotations fall back to normal JSON-schema tool calling. Required strict (`strict: "require"`) stays rejected. Malformed native tool input still fails downstream.
- Native tool calls reach Pi only after the first upstream response is complete and the child has exited.
