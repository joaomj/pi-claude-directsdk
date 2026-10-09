# Pi Claude DirectSDK

[![npm version](https://img.shields.io/npm/v/pi-claude-directsdk.svg)](https://www.npmjs.com/package/pi-claude-directsdk)

Use Claude inside Pi through the unmodified Claude Code executable. Pi owns the transcript, tools, approvals, and retries. The CLI supplies subscription authentication as a model transport.

Capabilities:

- Run `sonnet`, `opus`, `haiku`, and versioned routes as Pi models, including `claude-haiku-5-5`.
- Execute Pi tools (`read`, `bash`, `edit`, `write`, `codemode`) with Claude models.
- Resume sessions with exact replay of native signed thinking.
- Switch providers mid-session; foreign thinking replays as ordinary assistant text.
- Refresh model routes, limits, and prices from Claude Code and Anthropic documentation.
- Work in interactive, print (`-p`), and resumed sessions.

Limits:

- One Pi model call spawns one request-scoped `claude` process.
- One Pi model call produces at most one upstream Messages request.
- The provider never manages login, never reads credentials, and never falls back to another billing route.
- Required strict constrained decoding (`strict: "require"`) is rejected. See [docs/architecture.md](docs/architecture.md#tool-transport).

## Requirements

- Node 20 or later.
- Claude Code in the qualified range `>=2.1.263 <2.2.0` (see `QUALIFIED_CLI_RANGE` in `src/models.ts`).
- A Claude paid plan. The free plan excludes the CLI.
- A Claude Code login via `claude auth login`.

The installed-Pi harness is verified with Pi 1.1.0 and Claude Code 2.1.281. Verification includes offline startup and a paid request from a complete existing-session fork.

## Install

Install the qualified Claude Code version:

```sh
npm install -g --ignore-scripts=false @anthropic-ai/claude-code@2.1.281
```

Sign in through the official CLI login:

```sh
claude auth login
```

Install the extension, then restart Pi:

```sh
pi install git:github.com/joaomj/pi-claude-directsdk
```

Refresh model catalogs once before selecting a DirectSDK model on a fresh install:

```sh
pi update --models
```

Then start Pi with a DirectSDK model:

```sh
pi --model claude-directsdk/haiku
```

DirectSDK uses the CLI login, not the Pi Anthropic login. The `npm install` flag enables the Claude Code installer for that command only.

The model catalog does not guarantee account entitlement. Start with `haiku` for a small request. Models that require usage credits can incur separate charges. To use only the included subscription allowance, disable additional paid usage in your Claude account.

## Use

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

The request transport still loads on the first Claude request. See [docs/startup.md](docs/startup.md) for behavior and limits.

## Configuration

| Setting | Purpose |
|---|---|
| `CLAUDE_DIRECTSDK_COMMAND` | Override the `claude` executable path. |
| `CLAUDE_DIRECTSDK_CONFIG_DIR` | Point at a logged-in CLI config directory. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Supply a token from `claude setup-token` in the environment Pi runs in. |

See [docs/troubleshooting.md](docs/troubleshooting.md) for login and environment errors.

## Verify

```sh
npm test
```

This runs offline startup verification through your installed Pi and consumes no subscription allowance. Real model requests and complete-session replay require explicit approval. See [docs/testing.md](docs/testing.md).

## Costs

Per-model cost metadata comes from [Anthropic’s pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing). Pi reports it as an estimate, never as a subscription charge. Failed or interrupted requests are never reported as free.

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Request lifecycle, model routing, tool transport, admission relay. |
| [docs/startup.md](docs/startup.md) | Cache-only initialization and lazy loading. |
| [docs/testing.md](docs/testing.md) | Installed-Pi harness, paid scenarios, and complete-session replay. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Missing CLI, logged-out CLI, conflicting environment. |

## Acknowledgments

Behavioral reference: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk) (MIT). This project copies its behavior contract, not its code.

## License

MIT. See `LICENSE`.
