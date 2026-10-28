# Troubleshooting

## Error kinds

`DirectSdkError` in `src/errors.ts` carries a `kind` for model-call failures. Catalog refresh reports ordinary errors.

| Symptom | Kind or source | Action |
|---|---|---|
| No `claude` on `PATH` | `missing` | Install with `npm install -g @anthropic-ai/claude-code` or set `CLAUDE_DIRECTSDK_COMMAND` to the executable path. |
| CLI installed but not logged in | `logged-out` | Run `claude auth login` as the user Pi runs as, set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment Pi runs in, or point `CLAUDE_DIRECTSDK_CONFIG_DIR` at a logged-in config directory. Then select the provider again. |
| Conflicting auth or backend overrides | `env-conflict` | Remove the named variables from the launching environment. Values are never printed. |
| A turn used usage credits | `billing` | The turn may already be charged. Later turns stop unless `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` is set. Disable usage credits in the Claude account settings to stay on plan limits. |
| Catalog refresh fails | catalog | Read the warning for the source or CLI failure. Open `/model` in interactive Pi and wait for refresh. No pinned fallback is used. |
| Model excluded from catalog | metadata | Read the warning for the missing field. Update Claude Code if picker metadata is incomplete. Unverified limits and prices are never guessed. |
| No DirectSDK models on a fresh offline install | catalog | Connect once, start interactive Pi, and open `/model`. Wait for refresh before selecting a model from the command line. |
| History cannot be replayed | `replay` | Compact or restart the session. Common causes: an empty assistant message, assistant prefill, an unsupported content block, or a tool call outside the current inventory on a model without mid-conversation tool changes. |
| Prompt is too long | `native` | Read the reported route and context window. Remove stale `contextWindow` overrides in `models.json` to use verified limits, or compact the session. |
| Native request failed | `native` | Read the native detail in the message. |
| `Response was truncated before completion` and no answer | `native` | The turn spent its whole output budget on thinking. Lower the thinking level or switch models, then retry. |
| Upstream response incomplete | `upstream` | Retry the request. |
| Request timed out | `timeout` | Retry the request. The default timeout is 180 seconds. |
| Request cancelled | `cancelled` | Re-run the request. Cancel kills the full child process tree. |

Missing CLI and logged-out CLI fail before any upstream contact. The messages are actionable and safe to show.

## Compiled Pi compatibility

Upgrade to DirectSDK v0.1.7 or later if compiled Pi shows either symptom:

- Catalog refresh fails with `Claude discovery cleanup failed` or `ERR_SERVER_NOT_RUNNING`, even after the CLI picker succeeds.
- Model calls create extra Pi sessions in the native child working directory, or the helper reports `No API key found for the selected model` instead of answering MCP requests.

Version 0.1.7 handles Bun's server-shutdown behavior and starts the MCP helper in Bun runtime mode instead of restarting Pi. Do not set `BUN_BE_BUN` globally: the provider applies it only to the helper.

Follow the [upgrade instructions](../README.md#upgrade), restart Pi, then open `/model` and wait for refresh. In Pi 1.3.0, `pi update --models` does not load this extension.

## High token usage

Use DirectSDK v0.1.7 or later to get the historical prompt-cache repair. The provider still sends history on each call. A cache hit reuses a stable prefix; it does not eliminate history transmission.

Check cache-read share in message diagnostics across a stable, sufficiently long conversation. Short conversations, changed prompts or tools, cache expiry, and upstream eviction can prevent reuse. Token counters do not establish subscription allowance deductions. See [transport-measurements.md](transport-measurements.md) for the recorded evidence and its limits.

## Environment reference

| Variable | Set by | Purpose |
|---|---|---|
| `CLAUDE_DIRECTSDK_COMMAND` | User | Override the `claude` executable path or argv head. Used by `resolveClaude`. |
| `CLAUDE_DIRECTSDK_CONFIG_DIR` | User | Logged-in config directory. Mapped to `CLAUDE_CONFIG_DIR` for children and setup probes. Never forwarded under its own name. |
| `CLAUDE_CODE_OAUTH_TOKEN` | User | Token from `claude setup-token` for environments without an interactive login. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Provider | The model's `maxTokens`, or Pi's per-call override. Claude Code replaces the request's `max_tokens` with its own default of 32,000 for models missing from its table, so the model limit reaches the child through this variable. |
| `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS` | User | Set to `1` to allow turns that Claude Code reports as charged to usage credits. Unset or `0` stops later turns after overage. |
| `CLAUDE_DIRECTSDK_ENTRYPOINT` | User | Client label for `cc_entrypoint`, which plan usage is metered by. Defaults to `pi-claude-directsdk` and replaces an inherited label. An empty value lets Claude Code label the session. Must be 1 to 64 characters of letters, digits, dot, underscore, or hyphen. |
| `PI_DIRECTSDK_TEST_UPSTREAM` | Development only | Bypass the subscription environment guard for an explicit custom endpoint. Never set it in normal subscription use. |

## Subscription guard

Subscription mode refuses conflicting native auth and backend overrides in the merged environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY`. The error names the variables without printing values. The development override `PI_DIRECTSDK_TEST_UPSTREAM=1` bypasses this guard. The installed-Pi harness does not set it.

## Usage credits

Claude Code can report that a response used pay-as-you-go usage credits instead of plan limits. DirectSDK stops the turn with a `billing` error unless `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` is set. The error names the reported status and reset time. The guard runs after the response and usage are captured, so it cannot undo the charge for that turn.

Upstream rejections that mention third-party usage, extra usage, or usage credits produce the same error. Pi's retry classifier treats messages containing `billing` as non-retryable. To stay on plan limits only, disable usage credits in the Claude account settings and leave the override unset. Do not set the override just to silence the error.

Completed and failed turns carry a `pi-claude-directsdk/rate-limit` diagnostic when the native child reported rate-limit status.

## Version mismatch

The qualified CLI range is `>=2.1.263 <2.2.0` (`QUALIFIED_CLI_RANGE` in `src/models.ts`). The detected version is recorded per call. Behavior failures outside the range fail at runtime. Install the qualified version from [README](../README.md#install), then run the installed-Pi verification scenarios from [testing.md](testing.md).

## Session recovery

Switching providers does not require compaction or a restart. Thinking without a matching native carrier is replayed as ordinary assistant text. This also applies after editing an assistant message that carried signed thinking.

For other unsupported history, compact or restart the session. Do not hand-edit session files to reattach native blocks. A stale signature is never attached to rewritten content by design.

## Tool changes

Models whose built-in metadata supports mid-conversation tool changes replay `tool_addition` and `tool_removal` blocks at assistant boundaries. A tool used earlier in the conversation can be removed from the current inventory without failing replay. Pi still validates the model response against the current inventory, so a removed tool is never executed.

Unsupported models keep the collapsed system message and current tool set. On those models, removing a tool after it was used can still produce `Tool call outside the current inventory`; compact or restart the session.

## Cross-provider history

The provider replays foreign thinking as ordinary text and maps incompatible tool-call IDs together with their result references. Failed or aborted responses with empty text or thinking placeholders do not block the next request. The stored session remains unchanged.
