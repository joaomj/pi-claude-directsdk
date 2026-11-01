# Troubleshooting

## Error kinds

`DirectSdkError` in `src/errors.ts` carries a `kind` for model-call failures. Catalog refresh reports ordinary errors.

| Symptom | Kind or source | Action |
|---|---|---|
| No `claude` on `PATH` | `missing` | Install with `npm install -g @anthropic-ai/claude-code` or set `CLAUDE_DIRECTSDK_COMMAND` to the executable path. |
| CLI installed but not logged in | `logged-out` | Run `claude auth login` as the user Pi runs as, set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment Pi runs as, or point `CLAUDE_DIRECTSDK_CONFIG_DIR` at a logged-in config directory. Then select the provider again. |
| Conflicting auth or backend overrides | `env-conflict` | Remove the named variables from the launching environment. Values are never printed. |
| The Agent SDK cannot be loaded | `sdk` | Reinstall with dependencies: `npm install --omit=optional`. The optional CLI bundle is not required, because Pi uses the installed `claude`. |
| The SDK handshake fails or the CLI exits mid-turn | `sdk` | Read the reported CLI path and stderr tail. Update Claude Code or set `CLAUDE_DIRECTSDK_COMMAND` to another build. |
| A turn used usage credits | `billing` | The turn may already be charged. Later turns stop unless `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` is set. Disable usage credits in the Claude account settings to stay on plan limits. |
| Claude Code refused a tool Pi offered | `tool` | Read the message. A `system/permission_denied` for a host tool, or a Pi tool server reported as not connected, is a transport fault: the call never reached Pi and the turn stops instead of running without tools. |
| Claude called a tool Pi did not offer | `tool` | Pi never executes a tool outside the current inventory. Claude Code answers the call itself and the model usually continues in the same turn, so nothing is required. More than three such calls in one turn fail it as a `tool` error; retry, or give the model the tool it keeps asking for. |
| Catalog refresh fails | catalog | Read the warning for the source or CLI failure. Open `/model` in interactive Pi and wait for refresh. No pinned fallback is used. |
| Model excluded from catalog | metadata | Read the warning for the missing field. Update Claude Code if picker metadata is incomplete. Unverified limits and prices are never guessed. |
| No DirectSDK models on a fresh offline install | catalog | Connect once, start interactive Pi, and open `/model`. Wait for refresh before selecting a model from the command line. |
| Prompt is too long | `native` | Read the reported context window. Remove stale `contextWindow` overrides in `models.json` to use verified limits, or compact the session. |
| A step ended without output or usage | `incomplete` | The session ended mid-step or returned no usage. Retry the request; the next call rebuilds the session from Pi's history. |
| Truncated with no answer | `native` | The turn spent its whole output budget on thinking. Lower the thinking level or switch models, then retry. |
| Request timed out | `timeout` | Retry the request. The default timeout is 180 seconds per step, not for the whole turn. |
| Request cancelled | `cancelled` | Re-run the request. Cancel interrupts the turn and answers any parked tool call as not run. The Claude Code process stays alive, so the next message reuses its cache. |

Missing CLI, logged-out CLI, and a failed SDK handshake fail before any upstream contact. The messages are actionable and safe to show.

## Finding what failed

A failed or cancelled turn is recorded twice.

**Pi's session transcript** holds the assistant message with `stopReason` `error` or `aborted`, the full `errorMessage`, and a `pi-claude-directsdk/session` diagnostic with the native model, CLI version, Claude session id, and MCP server states. To read the failures of one session:

```sh
jq -r 'select(.type=="message" and .message.role=="assistant")
  | select(.message.stopReason=="error" or .message.stopReason=="aborted")
  | [.timestamp, .message.stopReason,
     ((.message.diagnostics[]? | select(.type=="pi-claude-directsdk/session") | .details.nativeModel) // "-"),
     (.message.errorMessage // "")] | @tsv' ~/.pi/agent/sessions/<project>/<session>.jsonl
```

**The transport log** holds what the transcript does not: the CLI's stderr tail and the upstream request id. It is one JSON line per failure in `~/.pi/agent/logs/claude-directsdk.jsonl`, written only when a turn fails or is cancelled. Read the last entries with `tail -n 5 ~/.pi/agent/logs/claude-directsdk.jsonl | jq .`, or the previous generation in `claude-directsdk.jsonl.1`.

| Setting | Effect |
|---|---|
| Unset | `~/.pi/agent/logs/claude-directsdk.jsonl` |
| `CLAUDE_DIRECTSDK_LOG=/path/to/file.jsonl` | Write to that file instead |
| `CLAUDE_DIRECTSDK_LOG=` or `CLAUDE_DIRECTSDK_LOG=off` | No log file |

The file is rotated once at 1 MiB: the live file starts over and the previous one is kept as `.1`. Logging never changes the outcome of a turn and never writes credentials or prompt text.

When Claude Code reports an API rejection it could not classify, the error names the provider's text and the upstream request id, for example `API Error: 400 … (request id req_011C…)`. Anthropic support asks for that id first, so include it in a report.

## Compiled Pi compatibility

Version 0.1.7 fixed two compiled-Pi failures for the earlier direct-CLI transport: catalog cleanup under Bun, and an MCP helper that restarted Pi instead of answering tool calls. Catalog discovery still uses that helper path, so keep v0.1.7 or later if compiled Pi reports `Claude discovery cleanup failed` or `ERR_SERVER_NOT_RUNNING`.

The transport itself no longer spawns the helper: the Agent SDK starts Claude Code. Do not set `BUN_BE_BUN` globally.

Follow the [upgrade instructions](../README.md#upgrade), restart Pi, then open `/model` and wait for refresh. In Pi 1.3.0, `pi update --models` does not load this extension.

## High token usage

The session, not the request, carries the history: a tool round trip or a follow-up message continues the same Claude Code process, so the prompt prefix and its cache stay in place. Measured on the real binary, continued turns read 98.8 to 98.9 percent of their prompt from cache.

Prompt caching has a size threshold. Below roughly 4,000 prompt tokens, Claude Code reports no cache reads and no cache writes, so every turn pays full input price for the whole prompt. A conversation that short is still cheaper than vanilla `claude -p`, which sends a 20k prompt of its own.

A rebuilt session is not a cold prefix: the unchanged instructions still match the cache, and only the conversation tail is rewritten (94.9 percent of cached tokens reused in the same measurement). Changed prompts or tools, model switches, and cache expiry do start a new prefix.

Check the token counters in the session diagnostic across a longer conversation. Token counters do not establish subscription allowance deductions.

If a conversation grows expensive, remember that Pi owns compaction. Claude Code's automatic compaction is disabled, so Pi's own compaction is what shrinks a long session.

## Environment reference

| Variable | Set by | Purpose |
|---|---|---|
| `CLAUDE_DIRECTSDK_COMMAND` | User | Override the `claude` executable path or argv head. Used by `resolveClaude`. |
| `CLAUDE_DIRECTSDK_CONFIG_DIR` | User | Logged-in config directory. Mapped to `CLAUDE_CONFIG_DIR` for the child and for discovery probes. Never forwarded under its own name. |
| `CLAUDE_CODE_OAUTH_TOKEN` | User | Token from `claude setup-token` for environments without an interactive login. |
| `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS` | User | Set to `1` to allow turns that Claude Code reports as charged to usage credits. Unset or `0` stops later turns after overage. |
| `CLAUDE_DIRECTSDK_LOG` | User | Failure log path. Defaults to `~/.pi/agent/logs/claude-directsdk.jsonl`; empty or `off` disables it. See [Finding what failed](#finding-what-failed). |
| `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, `CLAUDE_CODE_TOTAL_TOKENS_REMINDER` | Provider | Set in the child environment so Pi owns compaction and budgets. |
| `PI_DIRECTSDK_TEST_UPSTREAM` | Development only | Bypass the subscription environment guard for loopback test fixtures. Never set it in normal subscription use. |

The client label Claude Code reports is now set by the Agent SDK. The former `CLAUDE_DIRECTSDK_ENTRYPOINT` override is gone, along with the inherited label it replaced. See [usage.md](usage.md#plan-usage-metering).

## Subscription guard

Subscription mode refuses conflicting native auth and backend overrides in the merged environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY`. The error names the variables without printing values. The development override `PI_DIRECTSDK_TEST_UPSTREAM=1` bypasses this guard.

## Usage credits

Claude Code can report that a response used pay-as-you-go usage credits instead of plan limits. DirectSDK stops the turn with a `billing` error unless `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` is set. The error names the reported status and reset time. The guard runs after the response and usage are captured, so it cannot undo the charge for that turn.

Two different upstream rejections arrive with this wording, and they need different fixes.

- The request itself was refused because Anthropic classified it as third-party app usage:

  ```
  API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.
  ```

  The prompt causes this one. Pi's `<docs>` section lists Pi's documentation files, and the extension replaces that section with a pointer before the request leaves Pi. If the message appears, that substitution did not happen: an older copy of the extension is loaded, or a second source registers the same provider. Run `npm test` in the checkout, where `tests/extension-prompt.test.ts` covers it, and run `pi list` to look for another `directsdk` source.
- The turn completed and reported usage credits. That is the guard above, and the account setting is the fix.

Neither case is retried. Setting `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` does not make a refused request pass; it only lets a completed turn that reports usage credits finish. To stay on plan limits, keep usage credits disabled in the Claude account settings.

Completed and failed turns carry a `pi-claude-directsdk/rate-limit` diagnostic when Claude Code reported rate-limit status.

## Version mismatch

There is no qualified version range. Each session start is the test: the SDK handshake must complete, and a failure reports the CLI path, its message, and the stderr tail. Claude Code 2.1.281 with Agent SDK 0.3.316 is the version under test. See [testing.md](testing.md) for the checks to run before you rely on a newer CLI.

The SDK itself is pinned to an exact version in `package.json`, because its message shapes and options are what this transport reads.

## Session recovery

Switching providers needs no restart. A rebuilt session receives Pi's history as text, including completed tool results, so no operation is repeated. Thinking is not carried across a rebuild: Claude Code streams it as an encrypted signature, and Pi never attaches a stale signature to rewritten content.

Editing an earlier message, branching, resuming, compacting, or changing the model or tool set rebuilds the session. Pi does not try to preserve a Claude session whose context it can no longer describe exactly.

## Cross-provider history

Pi's transcript is the record. A conversation started on another provider is rebuilt from that transcript on the first DirectSDK call: assistant text, tool calls, and tool results become plain text in the checkpoint. Failed or aborted responses with empty content are omitted, and the stored session is never modified.
