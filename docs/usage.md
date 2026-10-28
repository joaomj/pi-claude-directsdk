# Usage and configuration

## Run from a local checkout

Start Pi with the local extension without installing it:

```sh
pi -e ./extensions/claude-directsdk/index.ts
```

Open `/model` and wait for catalog refresh. Then select a DirectSDK model. Later invocations can use the verified snapshot:

```sh
pi -e ./extensions/claude-directsdk/index.ts --list-models claude-directsdk
pi -e ./extensions/claude-directsdk/index.ts -p --model claude-directsdk/sonnet -- "Hello."
```

Startup performs no CLI probes or web requests. Pi restores only a previously verified catalog snapshot, labeled as such. A fresh offline install has no DirectSDK models. Interactive Pi refreshes catalogs in the background after the editor is ready.

Refresh uses Claude Code's account picker and Anthropic's public model, pricing, and effort documentation. Models absent from the account picker are labeled `not in CLI picker`; their account entitlement is unverified. Missing required metadata excludes the affected model with a warning. A failed refresh reports the error and removes the snapshot. There is no pinned fallback.

The request transport still loads on the first Claude request. See [docs/startup.md](startup.md) for behavior and limits.

## Configuration

| Setting | Purpose |
|---|---|
| `CLAUDE_DIRECTSDK_COMMAND` | Override the `claude` executable path. |
| `CLAUDE_DIRECTSDK_CONFIG_DIR` | Point at a logged-in CLI config directory. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Supply a token from `claude setup-token` in the environment Pi runs in. |
| `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS` | Set to `1` to allow turns that Claude Code reports as charged to usage credits. Unset or `0` stops later turns after an overage charge. |
| `CLAUDE_DIRECTSDK_ENTRYPOINT` | Client label sent with each request. Defaults to `pi-claude-directsdk`. Set it to keep another label, or to an empty string to let Claude Code label the session. |
| `PI_DIRECTSDK_PROMPT_HASHES` | Set to `1` to add SHA-256 hashes of the provider-supplied system prompt and tool definitions to message diagnostics. Unset it or set it to `0` to disable hashes. |

Success and failure diagnostics include request-phase timings, replay counts, upstream request-body bytes, and cache-read share. Unobserved milestones and unavailable cache-read shares are `null`. Milestone times are elapsed milliseconds from call start; durations are separate intervals and are not additive. The spawn-to-replay interval includes CLI startup, and first response data is not necessarily the first generated token.

Cache-read share measures token reuse, not subscription allowance deductions. Prefix hashes cover the Pi-supplied system prompt and tool definitions; they do not detect system-prompt changes added by Claude Code. Diagnostics store hashes, not the prompt or tool definitions.

See [docs/troubleshooting.md](troubleshooting.md) for login and environment errors.

## Plan usage metering

Claude Code reports a client label in `cc_entrypoint` with every request, and subscription
usage is billed against that label. Headless `sdk-cli` and `sdk-ts` sessions consume the
5-hour window roughly 1.6 to 2.9 times faster per token than the interactive CLI or the VS Code
extension for the same work. See
[anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074) for the
controlled measurements and Anthropic's silence on whether the difference is intended.

DirectSDK labels its children `pi-claude-directsdk`, so plan usage is not billed as an SDK app.
The label is set on the child environment and replaces an inherited value, because a Pi started
from inside another Claude client would otherwise report that client's identity. Set `CLAUDE_DIRECTSDK_ENTRYPOINT` to
another label, of 1 to 64 characters of letters, digits, dot, underscore, or hyphen, to report a
different identity, or set it to an empty string to let Claude Code label the session itself.

This is a workaround. An unrecognized label currently falls into the CLI's own client bucket,
which Anthropic can change without notice. If Anthropic classifies unrecognized clients as
third-party traffic, the [usage-credit guard](#usage-credit-guard) stops later turns, but not
the first charged one.

## Cost reporting

Pi's per-model costs are estimates from [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
not subscription charges. Failed or interrupted requests are never reported as free.

## Usage-credit guard

Claude Code can report that a turn used pay-as-you-go usage credits instead of plan limits. When that report arrives, DirectSDK stops the turn with a `billing` error unless `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` is set. The error includes the reported status and reset time.

The guard runs after the response and usage are captured. It cannot undo the charge for the turn that was already charged. Upstream rejections that mention usage credits or extra usage become the same actionable error.

Completed and failed turns carry a `pi-claude-directsdk/rate-limit` diagnostic when the native child reported rate-limit status. The diagnostic includes `status`, `rateLimitType`, `resetsAt`, and overage fields.

## Tool changes

On models whose metadata supports mid-conversation tool changes, DirectSDK keeps later system messages instead of collapsing them. It sends the initial tools, a deferred placeholder, later tool declarations with `defer_loading: true`, and `tool_addition`/`tool_removal` blocks at assistant boundaries. The admitted request adds the `mid-conversation-tool-changes-2026-07-01` beta value.

This lets a conversation remove a tool after using it without failing replay. Pi still validates the response against the current tool inventory, so it never executes a removed tool. Unsupported models keep the collapsed request shape.

## Verification

```sh
npm test
```

This runs the offline regression suite on Node 22 and consumes no subscription allowance. It covers admission, replay carriers, environment guards, the usage-credit guard, and the tool-change plan. Run `npm run verify` for the installed-Pi startup check. Real model requests and complete-session replay require explicit approval. See [docs/testing.md](testing.md).

