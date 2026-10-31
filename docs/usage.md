# Usage and configuration

## Run from a local checkout

Start Pi with the local extension without installing or publishing it:

```sh
pi -e ./extensions/claude-directsdk/index.ts
```

Open `/model` and wait for catalog refresh. Then select a DirectSDK model. Later invocations can use the verified snapshot:

```sh
pi -e ./extensions/claude-directsdk/index.ts --list-models claude-directsdk
pi -e ./extensions/claude-directsdk/index.ts -p --model claude-directsdk/sonnet -- "Hello."
```

To keep the checkout loaded across invocations, run `pi install ./` and remove it again with `pi remove ./`. Both forms leave the package version and the published release untouched.

Startup performs no CLI probes or web requests. Pi restores only a previously verified catalog snapshot, labeled as such. A fresh offline install has no DirectSDK models. Interactive Pi refreshes catalogs in the background after the editor is ready.

Refresh uses Claude Code's account picker and Anthropic's public model, pricing, and effort documentation. Models absent from the account picker are labeled `not in CLI picker`; their account entitlement is unverified. Missing required metadata excludes the affected model with a warning. A failed refresh reports the error and removes the snapshot. There is no pinned fallback.

The Agent SDK and the MCP server load on the first Claude request. See [docs/startup.md](startup.md) for behavior and limits.

## Configuration

| Setting | Purpose |
|---|---|
| `CLAUDE_DIRECTSDK_COMMAND` | Override the `claude` executable path. |
| `CLAUDE_DIRECTSDK_CONFIG_DIR` | Point at a logged-in CLI config directory. Forwarded as `CLAUDE_CONFIG_DIR`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Supply a token from `claude setup-token` in the environment Pi runs in. |
| `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS` | Set to `1` to allow turns that Claude Code reports as charged to usage credits. Unset or `0` stops later turns after an overage charge. |

Conflicting auth and backend overrides are rejected before a session starts: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY`. See [troubleshooting.md](troubleshooting.md) for the error and its fix.

## Diagnostics

Completed and failed turns carry a `pi-claude-directsdk/session` diagnostic with:

- `nativeModel`: the model id Claude Code received.
- `cliVersion` and `claudeSessionId`: from the session's initialize handshake.
- `mcpServers`: the reported state of the Pi tool server.
- `resultSubtype`: the SDK's own result classification.
- `nativeCostUsd`: the SDK's cost estimate, which is not the subscription charge.
- `pendingToolCalls`: tool calls still waiting for Pi when the turn ended.

Turns that received rate-limit information also carry a `pi-claude-directsdk/rate-limit` diagnostic with `status`, `rateLimitType`, `resetsAt`, and overage fields.

Token counters come from Claude Code and are per turn. A tool round trip does not double count them, because each Pi model call reads one assistant step.

Caching depends on prompt size. Measured: no cache reads or writes at about 3,500 prompt tokens, and 98.8 to 98.9 percent cache-read share on continued turns at about 12,400. A rebuilt session still reuses the unchanged instruction prefix. See [Measurements](measurements.md).

See [docs/troubleshooting.md](troubleshooting.md) for login and environment errors.

## Plan usage metering

Claude Code reports a client label with every request, and subscription usage is metered against that label. Headless SDK sessions have been reported to consume the 5-hour window roughly 1.6 to 2.9 times faster per token than the interactive CLI for the same work; see [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074) for the measurements and for Anthropic's silence on whether the difference is intended.

DirectSDK does not set that label. The Agent SDK starts the process and supplies it, so the previous custom `pi-claude-directsdk` label is gone. This is a behavior change from the direct-CLI transport and is not verified either way for plan consumption; treat the 5-hour window as the budget that matters and watch it during your first long session.

The usage-credit guard below is the backstop if Anthropic classifies these requests as third-party traffic. It stops later turns, but not the first charged one.

## Cost reporting

Pi's per-model costs are estimates from [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), not subscription charges. Failed or interrupted requests are never reported as free.

## Usage-credit guard

Claude Code can report that a turn used pay-as-you-go usage credits instead of plan limits. When that report arrives, DirectSDK stops the turn with a `billing` error unless `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` is set. The error includes the reported status and reset time.

The guard runs after the response and usage are captured. It cannot undo the charge for the turn that was already charged, and Pi does not retry it. Upstream rejections that mention usage credits or extra usage become the same actionable error.

## Changing the tool set

Claude Code sees the tools Pi offers for the current turn. When Pi adds or removes a tool, or you switch model, the live session is dropped and rebuilt from Pi's history, including completed tool results. Pi never sends a tool call to a tool it is not currently offering, and a call to any other tool fails the turn.

## Verification

```sh
npm test                       # offline, no model calls
npm run smoke                  # two real calls on your own login
npm run measure session        # token and cache measurements, several real calls
```

See [docs/testing.md](testing.md) for what each command proves and what remains unverified.
