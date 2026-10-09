# Troubleshooting

## Error kinds

`DirectSdkError` in `src/errors.ts` carries a `kind`. The provider surfaces these hints:

| Symptom | Kind | Fix |
|---|---|---|
| No `claude` on `PATH` | `missing` | Install with `npm install -g @anthropic-ai/claude-code` or set `CLAUDE_DIRECTSDK_COMMAND` to the executable path. |
| CLI installed but not logged in | `logged-out` | Run `claude auth login` as the user Pi runs as, set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment Pi runs in, or point `CLAUDE_DIRECTSDK_CONFIG_DIR` at a logged-in config directory. Then select the provider again. |
| Conflicting auth or backend overrides | `env-conflict` | Remove the named variables from the launching environment. Values are never printed. |
| Catalog refresh fails | catalog | Read the warning for the source or CLI failure. Retry `/model` or run `pi update --models`. No pinned fallback is used. |
| Model excluded from catalog | metadata | Read the warning for the missing field. Update Claude Code if picker metadata is incomplete. Unverified limits and prices are never guessed. |
| No DirectSDK models on a fresh offline install | catalog | Connect once and run `pi update --models`, or start interactive Pi and open `/model`. |
| History cannot be replayed | `replay` | Compact or restart the session. Common causes: an empty assistant message, a tool call outside the current inventory, assistant prefill, or an unsupported content block. |
| Native request failed | `native` | Read the native detail in the message. |
| Upstream response incomplete | `upstream` | Retry the request. |
| Request timed out | `timeout` | Retry the request. The default timeout is 180 seconds. |
| Request cancelled | `cancelled` | Re-run the request. Cancel kills the full child process tree. |

Missing CLI and logged-out CLI fail before any upstream contact. The messages are actionable and safe to show.

## Environment reference

| Variable | Set by | Purpose |
|---|---|---|
| `CLAUDE_DIRECTSDK_COMMAND` | User | Override the `claude` executable path or argv head. Used by `resolveClaude`. |
| `CLAUDE_DIRECTSDK_CONFIG_DIR` | User | Logged-in config directory. Mapped to `CLAUDE_CONFIG_DIR` for children and setup probes. Never forwarded under its own name. |
| `CLAUDE_CODE_OAUTH_TOKEN` | User | Token from `claude setup-token` for environments without an interactive login. |
| `PI_DIRECTSDK_CLI` | Test operator | Path to the `claude` executable for opt-in loopback and gateway suites. See [testing.md](testing.md). |
| `PI_DIRECTSDK_GATEWAY` | Test operator | Set to `1` to enable paid OpenRouter gateway suites. Requires `OPENROUTER_API_KEY`. |
| `PI_DIRECTSDK_TEST_UPSTREAM` | Tests only | Explicit test-mode bypass for the subscription environment guard. Never set it in production. |

## Subscription guard

Subscription mode refuses conflicting native auth and backend overrides in the merged environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY`. The error names the variables without printing values. Explicit test mode (`PI_DIRECTSDK_TEST_UPSTREAM=1`) allows them for loopback and gateway fixtures.

## Version mismatch

The qualified CLI range is `>=2.1.263 <2.2.0` (`QUALIFIED_CLI_RANGE` in `src/models.ts`). The detected version is recorded per call. Behavior failures outside the range fail at runtime. Install the qualified version from [README](../README.md#install), then re-run the fake-upstream gate from [testing.md](testing.md).

## Session recovery

Switching providers does not require compaction or a restart. Thinking without a matching native carrier is replayed as ordinary assistant text. This also applies after editing an assistant message that carried signed thinking.

For other unsupported history, compact or restart the session. Do not hand-edit session files to reattach native blocks. A stale signature is never attached to rewritten content by design.
