# Pi Claude DirectSDK — implementation plan

This plan implements `PRD.md`. It registers Claude as a Pi model provider through the unmodified `claude` executable. Pi owns the transcript, tools, approvals, branches, compaction, and retries. The `claude` executable supplies authentication and acts only as a model transport.

Behavioral reference: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk) (MIT). That code speaks native `stream-json` directly and does not use the Agent SDK package. Copy its behavior contract, not its Python runtime. Preserve attribution for copied code.

## 1. Result and boundaries

### 1.1 Result

- Pi lists Claude models from this provider.
- Each Pi model call spawns one request-scoped `claude -p ... --input-format stream-json --output-format stream-json` process.
- Pi sends the current system prompt and tool schemas through private files.
- Pi replays prior history in native `stream-json` form.
- An inert Model Context Protocol (MCP) server advertises Pi tools and never executes them.
- A request-scoped localhost admission relay permits at most one upstream Messages request per Pi call.
- Pi converts native text, thinking, images, tool calls, stop reasons, usage, and failures to Pi stream events.
- Pi executes all tools. Native tools, skills, settings sources, persistence, and native compaction stay disabled where flags exist.
- Interactive, print (`pi -p`), and resumed Pi sessions work.

### 1.2 Boundaries

- No native tool execution, account login, OAuth token extraction, credential read/print/persist/refresh, API-header spoofing, or alternate billing fallback.
- No persistent Claude session as a second history store. Pi context stays authoritative.
- No claim that subscription-authenticated requests consume plan allowance.
- No automatic paid test calls. Subscription tests need explicit approval.
- No release in this phase.

## 2. Architecture

### 2.1 Request lifecycle

1. Pi calls `streamSimple(model, transcriptContext, options)`.
2. The provider reads the current prompt with `getCurrentSystemPrompt(context.messages)` and tools with `getCurrentTools(context.messages)`. It never expects `context.systemPrompt` or `context.tools`.
3. The provider validates history and builds ordered native frames. Historical user frames get `shouldQuery: false`. Only the final frame queries.
4. The provider calls `options.onPayload` with the native-equivalent payload and uses a returned replacement when present.
5. The provider writes private files (system prompt, settings with `CLAUDE_CODE_EXTRA_BODY`, tool manifest) into a per-request directory with owner-only permissions.
6. The provider starts the admission relay on `127.0.0.1` with an ephemeral port and a random per-request route. It sets `ANTHROPIC_BASE_URL` to the relay URL in the child environment only.
7. The provider spawns one `claude` child in a private working directory with isolation flags and the inert MCP config.
8. The provider replays frames on child stdin, consumes zero-turn acknowledgments for historical frames, then reads the final response from stdout `stream-json`.
9. The relay forwards the first upstream `POST <route>/v1/messages` request, preserves native authentication and identity headers in memory, captures the streamed response (text, thinking with signatures, tool input JSON, usage, stop reason), and rejects later requests locally with a terminal error the child cannot recover from.
10. The provider calls `options.onResponse` after headers arrive and before it consumes the body path it controls (relay response headers plus child exit status).
11. The provider publishes tool calls only after the first upstream response completes, usage and stop reason are captured, and the child has exited.
12. The provider emits Pi events (`start`, content events, one terminal `done` or `error`), sets exact usage, and cleans up the child tree, relay sockets, and private files.

### 2.2 Component map

| Component | File | Duty |
|---|---|---|
| Extension entry | `extensions/claude-directsdk/index.ts` | `registerProvider("claude-directsdk", {...})` with models and `streamSimple`. No process or socket work in the factory. |
| Model catalog | `src/models.ts` | Pinned native routes, aliases, context windows, `[1m]` selection rule, cost metadata, reasoning flags. |
| Setup probes | `src/setup.ts` | `claude` resolution, `auth status` login check, live picker discovery, install/login hints. No network to Anthropic. |
| History replay | `src/replay.ts` | Pi `Message[]` to native frames, strict validation, signed-thinking carrier encode/decode. |
| Request assembly | `src/request.ts` | Tool manifest, private settings body, schema normalization, stop/temperature/max-token mapping. |
| Child supervisor | `src/process.ts` | Request-scoped spawn, stdout line reader, stdin replay writer, full-tree kill, timeout, cleanup. |
| Admission relay | `src/admission.ts` | Loopback HTTP gate, one-request admission, header passthrough, SSE capture, denial counting, abort/close. |
| Stream converter | `src/stream.ts` | Native `stream-json` to `AssistantMessageEventStream`, gated tool publication, usage/stop mapping, error mapping. |
| Inert MCP server | `src/inert-mcp.ts` (executable helper) | `initialize`, `tools/list` from manifest, `tools/call` denial. No host imports, no effects. |
| Errors | `src/errors.ts` | Typed errors: missing CLI, logged out, env conflict, replay unsupported, incomplete response, admission consumed. |

## 3. Repository layout

```text
/
├── PLAN.md
├── PRD.md
├── README.md
├── LICENSE
├── package.json              # pi manifest, scripts, engines, peerDependencies
├── tsconfig.json             # strict, NodeNext, noUncheckedIndexedAccess
├── extensions/
│   └── claude-directsdk/
│       └── index.ts          # thin registration only
├── src/
│   ├── models.ts
│   ├── setup.ts
│   ├── replay.ts
│   ├── request.ts
│   ├── process.ts
│   ├── admission.ts
│   ├── stream.ts
│   ├── inert-mcp.ts
│   └── errors.ts
└── tests/
    ├── fixtures/
    │   ├── stream-json/      # synthetic native stdout lines
    │   └── upstream-sse/     # synthetic upstream SSE bodies
    ├── replay.test.ts
    ├── admission.test.ts
    ├── stream.test.ts
    ├── process-cleanup.test.ts
    ├── gateway-mode.test.ts  # explicit opt-in, needs OpenRouter key
    └── cli-fake-upstream.test.ts  # explicit opt-in, needs claude binary
```

### 3.1 Packaging rules

- `package.json` declares `pi.extensions: ["./extensions/claude-directsdk/index.ts"]`.
- Pi loads TypeScript through `jiti`. Ship source, not a build step.
- Declare `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` in `peerDependencies` with `"*"`. Do not bundle them.
- Keep Node built-ins only (`node:http`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:crypto`). Add zero runtime dependencies in this phase.
- Engine: Node 20+ (match local Pi runtime). Test Linux and macOS first, then Windows (`taskkill /F /T`, `CREATE_NEW_PROCESS_GROUP`, Windows-essential env passthrough).

## 4. Pi contract obligations

- Use the legacy `pi.registerProvider(name, ProviderConfig)` form with `models` and `streamSimple`. Prefer a complete `Provider` object only when native auth, filtering, or refresh behavior needs it. Keep `models.json` overrides composable.
- Read prompt and tools from transcript system messages. Call `collapseSystemMessages(context)` when this transport cannot place mid-conversation system messages. This transport cannot, so collapse.
- `streamSimple` must:
  1. Build a pending assistant message (provider `claude-directsdk`, model id, timestamp, `stopReason: "pending"`, zeroed usage).
  2. Emit one `start` event after request setup succeeds and before content events.
  3. Update the message while emitting balanced `text_start`/`text_delta`/`text_end`, `thinking_start`/`thinking_delta`/`thinking_end`, `toolcall_start`/`toolcall_delta`/`toolcall_end`. Set valid parsed tool arguments by `toolcall_end`.
  4. Finalize usage, cost, content, and stop reason.
  5. Emit exactly one terminal `done` or `error` event and close the stream.
  6. Convert `options.signal` abortion to an `aborted` result with `errorMessage`.
- Request setup may fail with `error` before `start`. After `start`, fail with `error`.
- Honor `options.onPayload`, `options.onResponse`, `options.signal`, and provider-scoped `options.env`. Merge `options.env` over `process.env` for this call only.
- Honor `options.headers` by merge. Never let caller headers replace native authentication or identity headers at the relay.
- Map context overflow to `context_length_exceeded` in a guarded `message_end` handler only for this provider. Do not rewrite rate limits or transient failures as overflow.
- Report exact `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and cost. Label native `total_cost_usd` / `modelUsage` list-price amounts as estimate, not subscription charge. Never report a failed or interrupted request as free.
- Support Unicode boundaries, empty text, tool rounds, image input and image tool results when the native route supports them, cross-provider handoff (carrier ignored by other providers), and malformed/partial streams as errors.

## 5. Implementation phases

### Phase 0 — Scaffold

- Add `package.json`, `tsconfig.json`, `extensions/claude-directsdk/index.ts` stub, `src/*.ts` stubs, test runner config.
- Use `node:test` plus `node:assert/strict`, or `vitest` when Pi repo convention requires it. Keep offline tests dependency-free when practical.
- Acceptance: `pi -e ./extensions/claude-directsdk` loads, `pi --list-models` shows the pinned catalog, a call without `claude` on `PATH` fails with the install hint.

### Phase 1 — Models and setup probes

- Implement `src/models.ts`:
  - Pinned routes with context windows (for example Sonnet/Opus 1M, Haiku 200K; confirm against the qualified CLI at implementation time).
  - Aliases (`sonnet`, `opus`, `haiku`, `fable` or current set).
  - `native_model()` long-context rule: append `[1m]` for 1M routes, reject `[1m]` on routes without 1M support.
  - Per-model `ProviderModelConfig`: `id`, `name`, `reasoning`, `input: ["text", "image"]`, `cost` list-price rates, `contextWindow`, `maxTokens`.
  - Adaptive-thinking support table and mandatory-thinking families (routes that reject `thinking: {type: "disabled"}`).
- Implement `src/setup.ts`:
  - Resolve `claude` from `CLAUDE_DIRECTSDK_COMMAND` or `PATH`. On Windows resolve the full path so process creation does not depend on shim lookup.
  - `setupStatus()`: run `claude auth status` with nonessential-traffic flags, parse `loggedIn` and plan, return install/login hints. Never print credential values.
  - `discoverModels()`: optional live picker through the `initialize` control handshake with the admission relay counting upstream requests. Return `None`/`null` on any anomaly so the caller falls back to the pinned catalog.
- Acceptance: missing CLI and logged-out states produce actionable errors. Picker discovery makes zero upstream requests.

### Phase 2 — History replay and native carrier

Port Hermes `prepare_history`, `projection`, and carrier logic to Pi `Message` types.

- Map Pi roles:
  - `system` before history: join to one system string. Reject `system` after history starts.
  - `user`: text plus base64 `data:` images only. Reject other block kinds.
  - `assistant`: text, thinking, tool calls. Preserve order.
  - `toolResult`: single native `tool_result` frame with `tool_use_id`, string or block content, `is_error` passthrough.
- Merge consecutive user frames into one native user frame, as Hermes does.
- Reject, do not flatten:
  - Assistant prefill (history must end in a nonempty user or tool-result frame).
  - Mid-conversation system messages after collapse is bypassed (this transport collapses, so this case must not reach replay).
  - Non-base64 image URLs, document blocks Pi cannot represent, unsupported roles, empty final frame, duplicate or malformed tool names.
- Durable signed-thinking carrier:
  - Pi `AssistantMessage.content` holds `TextContent`, `ThinkingContent`, `ToolCall`. Native blocks carry `signature` fields Pi cannot represent.
  - Store native assistant messages plus a visible projection (`content` stripped text plus tool id/name/input) in a carrier entry attached to the Pi assistant message in a Pi-compatible field (for example a `details` or diagnostics carrier that survives compaction and branch storage; confirm the exact durable field against Pi `AssistantMessage` at implementation time).
  - Restore native blocks only when the current visible projection equals the carrier projection. On any edit, drop the carrier and never attach stale signatures.
  - Version the carrier (`version: 1`). Reject unknown versions.
- Acceptance: round-trip tests for text, thinking with signature, multi-tool batches, image input, tool-error results, edited-history signature drop, and every rejection case.

### Phase 3 — Request assembly, private files, inert MCP

- Implement `src/request.ts`:
  - Normalize tool schemas: strip nullable unions and top-level `oneOf`/`allOf`/`anyOf` when the native validator rejects them; default missing `properties` to `{}` on object schemas. Keep nested unions untouched. Mirror only what the qualified CLI version requires.
  - Validate tool names (unique ASCII, max 50 chars). Reject strict schemas when unsupported.
  - Map Pi `thinkingLevel`/`reasoning` to native `thinking` and `output_config.effort`. Omit disable blocks on mandatory-thinking routes. Omit adaptive blocks on routes that reject them.
  - Drop sampling controls (`temperature`, `top_p`) when subscription routes reject them, or reject them explicitly; match Hermes behavior for the qualified version.
  - Accept `max_tokens` / `max_completion_tokens` (exactly one), `stop` to `stop_sequences`. Validate ranges.
- Write per-request private files with owner-only permissions (`0700` directory, `0600` files):
  - `system.md`: current system prompt.
  - `settings.json`: `{env: {CLAUDE_CODE_EXTRA_BODY: <body JSON>}}` to avoid argument and environment length limits.
  - `tools.json`: inert MCP manifest (name, description, `inputSchema` identical to the request body shape).
- Implement `src/inert-mcp.ts` as a stdio JSON-RPC helper:
  - `initialize` returns protocol version and `tools` capability.
  - `tools/list` returns the manifest.
  - `tools/call` returns denial text. Never executes.
  - No host imports, no effects, no logging of payloads.
- Spawn flags (confirm against the qualified CLI `--help` at implementation time): `--tools ""` (empty allowlist), `--permission-mode dontAsk`, `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--max-turns 1`, `--no-session-persistence`, `--system-prompt-file`, `--settings`, `--mcp-config`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, model selection from the catalog.
- Set child env: `ENABLE_TOOL_SEARCH=false`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_MAX_RETRIES=0`, `DISABLE_AUTO_COMPACT=1`, `DISABLE_COMPACT=1`, token-budget reminder off when Pi owns budgets, `ANTHROPIC_BASE_URL` to the relay URL. Remove `CLAUDE_CODE_EXTRA_BODY` from the inherited env before writing settings. Honor `CLAUDE_CONFIG_DIR` override from explicit config only.
- Acceptance: fixture tests assert argv, env, file contents, manifest-body schema equality, and that no prompt or schema travels on the command line.

### Phase 4 — Child supervision

- Implement `src/process.ts`:
  - One `spawn` per Pi call. Store the handle under a per-request record guarded against concurrent sharing.
  - Put the child in its own process group (`start_new_session: true` on POSIX, `CREATE_NEW_PROCESS_GROUP` on Windows).
  - Stream stdout as newline-delimited JSON. Treat a non-JSON line as `Invalid native stream-json output` with the first 300 chars of the line.
  - Enforce a positive timeout. Reset the idle deadline on each received line, as Hermes does.
  - Replay historical frames with `shouldQuery: false` and require a zero-turn acknowledgment (`num_turns == 0`, no error) for each. Fail on early exit, error acknowledgment, or timeout.
  - Close stdin after replay. Wait for child exit with a bounded wait.
  - On abort, failure, or timeout: kill the full tree (`killpg SIGKILL` on POSIX, `taskkill /F /T` on Windows), close pipes, delete the per-request directory. Cleanup must not mask the original error.
  - Keep one stable client working directory per provider client (fresh temp root per request moves the native cache prefix and harms cache reuse; Hermes keeps one cwd per client).
- Acceptance: cancellation during generation kills `node` descendants, concurrent calls never share a child, zombie and pipe-leak checks pass.

### Phase 5 — Admission relay

Port Hermes `admission.py` to Node `node:http`.

- Bind `127.0.0.1` with port `0` and a random per-request path (`/admit/<token>/v1/messages`).
- Accept only `POST` to that path without an `Origin` header. Return `404` otherwise.
- First request: mark used, stream upstream (`https`, or `http` only for loopback fixtures), forward native headers except hop-by-hop ones (`host`, `connection`, `content-length`, `transfer-encoding`, proxy headers, `accept-encoding`), set `Accept-Encoding: identity`, preserve body bytes and identity headers.
- Capture SSE frames (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`) into one native message. Track `input_json_delta` fragments per block index and parse them at `content_block_stop`. Record `status`, `request-id`, bounded error body (64 KB cap), and a `complete` flag (message, `stop_reason`, no pending tool JSON).
- Later requests, or any request after cancel: `denied += 1`, return `400` with `HERMES_MODEL_ADMISSION_CONSUMED` equivalent (`PI_MODEL_ADMISSION_CONSUMED`), no upstream contact.
- Never log or persist headers, body, or the per-call route.
- Close all tracked sockets on abort and `close()` the server after each request.
- Validate the configured upstream before binding: `https`, or `http` only for loopback fixtures. Reject URLs with user info, query, or fragment.
- Acceptance: fixture tests for first-request pass-through, second-request denial, cancel denial, upstream 429 capture with error text, truncated stream marked incomplete, header preservationCRLF normalization, socket cleanup.

### Phase 6 — Stream conversion and completion gating

- Implement `src/stream.ts` on top of `createAssistantMessageEventStream()`:
  - Forward native `text_delta` as Pi `text_delta` events and `thinking_delta` as Pi `thinking_delta` events during generation.
  - Hold tool calls back. Publish `toolcall_*` events only after: the relay reports one used request with status 200 and complete capture, or the native path reports a complete assistant plus `message_stop` and exactly one `result`; usage is present and valid; the child has exited successfully.
  - Prefer the relay-captured message over stdout assistant messages when the relay was used. This defeats native recovery replacement.
  - Verify streamed text equals final text. When final text extends streamed text, emit the tail. When they diverge, fail.
  - Map stop reasons: `end_turn` to `stop`, `tool_use` to `toolUse`, `max_tokens` to `length`, `model_context_window_exceeded` to `context_length_exceeded` through the guarded handler, `refusal` to provider-native refusal handling with denial awareness.
  - Treat `subtype: error_max_turns` with exit code 1 as a tool-batch boundary only when tool calls exist. Otherwise fail on nonzero exit, `is_error`, or non-`success` subtype.
  - Reject native tools outside the current Pi inventory (`mcp__<provider>__` prefix check or Pi-native equivalent).
  - Rebuild Pi tool calls with stringified JSON arguments. Attach the signed-thinking carrier from Phase 2.
  - Set exact usage: `input = input_tokens + cache_read + cache_creation`, `output = output_tokens`, reasoning subset when reported, `cacheRead`/`cacheWrite` split, list-price cost marked estimate. Include `request-id`, upstream/denied counts, CLI version in message metadata where Pi permits it.
- Failure rules:
  - Incomplete first response (bad status, incomplete capture, missing assistant/`message_stop`/single `result`, missing usage, text divergence) is an error. Never convert it to success.
  - Native recovery attempts after a completed first response do not replace the captured response and do not throw.
  - Upstream errors surface the first-attempt status, capture state, denial count, relay failure name, and truncated upstream message.
- Acceptance: fixture tests for text-only, thinking, tool batch, `tool_max_turns` boundary, refusal, max-tokens, context overflow, upstream 429, disconnect, and text-divergence cases.

### Phase 7 — Abort, concurrency, session modes

- Wire `options.signal` to relay `abort()` plus full-tree kill. Convert to Pi `aborted` with `errorMessage`. Close relay sockets so a blocked upstream read unblocks.
- Isolate every call: separate child, relay, route token, temp directory. No shared mutable request state. Guard the child handle with a per-request lock so `cancel()` from another thread is safe.
- Support interactive, print, and resumed sessions with no persistent native session. Resumed sessions replay stored Pi history including carriers through the Phase 2 path.
- Acceptance: cancel-during-generation test against a hanging synthetic upstream disconnects the socket in under 3 seconds; parallel-call test proves isolation.

### Phase 8 — Environment guard and error taxonomy

- In subscription mode reject inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` (truthy values) before spawn. Name the conflicting variables without printing values.
- Provide an explicit, separate test-only path that sets a fixture key and loopback or gateway base URL. Never reuse gateway credentials in production subscription mode.
- Error messages:
  - Missing CLI: install hint (`npm install -g @anthropic-ai/claude-code` or `CLAUDE_DIRECTSDK_COMMAND`).
  - Logged out (native `authentication_failed` before any upstream request): run `claude auth login` as the user Pi runs as, or point config override at a logged-in directory.
  - Env conflict: list names, require removal from the launching environment.
  - Replay unsupported: state the exact cause (role, block kind, prefill, empty final frame).
  - Incomplete response: first-attempt status, capture state, denial count, upstream text.
- Never fall back to another billing route. Never read, print, persist, or refresh Claude credentials.
- Acceptance: each error path has a fixture test that asserts the message and asserts no credential bytes reach logs or disk.

## 6. Verification and cost gates

Map each PRD gate to concrete tests. Keep paid tests opt-in and bounded.

### Gate 1 — Offline fixtures, no subscription, no network

Cover with unit tests over synthetic fixtures:

- Replay: text, thinking, images, tool batches, tool-error results, multi-turn merge.
- Carrier: signature preserved when projection matches, dropped on edit, version rejection.
- Tool batches and `tool_max_turns` boundary.
- Response completeness: missing assistant, missing `message_stop`, missing/extra `result`, missing usage, text divergence.
- Single-request admission: second-request denial, cancel denial, counter checks.
- Upstream errors: 429 with JSON message, truncated SSE, disconnect.
- Cancellation: abort during replay, generation, and idle wait.
- Concurrent calls: isolation of child, relay, temp files.
- Cleanup: process-tree kill, socket close, temp-file removal, Windows shim coverage in CI.

### Gate 2 — Real CLI plus fake upstream, no subscription

- Add `tests/cli-fake-upstream.test.ts`, skipped unless `PI_DIRECTSDK_CLI=/path/to/claude` is set.
- Start a local synthetic Anthropic Messages endpoint (HTTP loopback fixture). Run the installed official CLI against it with a fixture key in an isolated env (`HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` pointed at temp dirs).
- Mirror Hermes `evals/directsdk_admission.py` modes: final, tools, max, tool-max, context, thinking, refusal, error, disconnect, cancel.
- Assert exactly one upstream request per mode, usage passthrough, tool-name mapping, signature capture, cancel disconnect under 3 seconds, binary hash unchanged.
- This gate qualifies CLI protocol behavior. It does not qualify subscription authentication.

### Gate 3 — OpenRouter gateway, optional, pay-as-you-go

- Add `tests/gateway-mode.test.ts`, skipped unless `PI_DIRECTSDK_GATEWAY=1` with `OPENROUTER_API_KEY` set explicitly.
- Set `ANTHROPIC_BASE_URL=https://openrouter.ai/api` plus `ANTHROPIC_AUTH_TOKEN` in the isolated test env only. Route a Claude model to an Anthropic provider.
- Assert protocol behavior only. Never treat a gateway model, result, or token count as proof of subscription behavior. Never persist the gateway key.
- Document expected cost per run and require explicit invocation. No automatic runs in CI.

### Gate 4 — Subscription qualification, explicit approval, eligible account

Manual checklist, recorded per call (cache-read fraction, cache writes, context size, model, CLI version):

- Native login, one admitted upstream request per Pi call, Pi-owned tool execution, restart/branch/compaction behavior, cancellation, measured cache reuse.
- Long-context run with stable prefix and at least five tool rounds. Target at least 95% follow-up cache reads. Investigate any miss. Do not claim the target from fixture or gateway tests.
- Record native list-price amounts as estimates, not subscription charges.

### Version pin

- Pin the qualified Claude Code version range in `src/models.ts` (or `src/versions.ts`) and in `README.md`.
- Fail clearly on changed replay acknowledgments or incomplete native responses.
- Treat relay and replay behavior as version-sensitive interfaces. Re-run Gate 2 on every CLI bump before updating the pin.

## 7. Risks and open questions

- Pi durable carrier field: confirm which `AssistantMessage` field survives compaction, branching, and session resume without leaking into the model prompt. Hermes uses `reasoning_details`. Check Pi `AssistantMessage` and diagnostics types before locking the carrier location.
- Pi image and document blocks: confirm base64 image input and image tool-result round-trip through Pi `ImageContent`. Reject what Pi cannot represent.
- Pi tool-schema expressiveness vs native validator: confirm whether Pi tool schemas need the same `strip_nullable_unions` plus combinator normalization, and where Pi already normalizes.
- Mid-conversation system messages and tool deltas: this plan collapses them. Confirm `getCurrentSystemPrompt` plus `getCurrentTools` replay covers Pi compaction summaries and skill-driven tool changes.
- `options.onResponse` semantics for a child-process transport: define what counts as the response (relay upstream headers plus child result) and document it, since there is no direct provider `fetch` response.
- Native flag drift: recheck every `--flag` in Phase 3 against `claude --help` for the pinned version. Fail closed on unknown flags.
- Windows shim and socket behavior: verify `taskkill /T`, `CREATE_NEW_PROCESS_GROUP`, SystemRoot passthrough, and loopback relay cleanup on Windows CI.

## 8. Acceptance criteria

- `pi -e <package>` registers the provider, lists pinned Claude models, and streams text, thinking, images, and tool calls per the Pi event protocol.
- One Pi call produces at most one upstream Messages request. Blocked native retries never replace a completed first response and never convert failure to success.
- Abort kills the full child tree, closes relay sockets, removes private files, and reports `aborted`.
- Missing CLI, logged-out CLI, env conflicts, unsupported history, and incomplete responses fail with actionable errors and no credential exposure.
- Usage reports exact native input, output, cache-read, and cache-write counts. List-price amounts carry the estimate label. Failed or interrupted requests never report zero cost as free.
- Gates 1 and 2 pass. Gates 3 and 4 remain explicit and opt-in with recorded measurements.

## 9. Work order

1. Phase 0 scaffold plus Phase 1 catalog and setup probes.
2. Phase 2 replay plus carrier, with fixture tests.
3. Phase 5 admission relay, with fixture tests (build before the child supervisor so later phases have a deterministic peer).
4. Phase 3 request assembly plus inert MCP.
5. Phase 4 child supervision wired to replay and relay.
6. Phase 6 stream conversion with completion gating.
7. Phase 7 abort, concurrency, session modes.
8. Phase 8 env guard and error taxonomy.
9. Gate 1 suite green, then Gate 2 harness, then Gate 3 and 4 checklists.
10. `README.md` update: install, login, version pin, test modes, cost labels, Hermes attribution.
