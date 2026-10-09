# Pi Claude DirectSDK

[![npm version](https://img.shields.io/npm/v/pi-claude-directsdk.svg)](https://www.npmjs.com/package/pi-claude-directsdk)

Use Claude inside Pi through the unmodified Claude Code executable. Pi owns the transcript, tools, approvals, and retries. The CLI supplies subscription authentication as a model transport.

Capabilities:

- Run `sonnet`, `opus`, `haiku`, and versioned routes as Pi models, including `claude-haiku-5-5`.
- Execute Pi tools (`read`, `bash`, `edit`, `write`, `codemode`) with Claude models.
- Resume sessions with exact replay of signed thinking.
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

Transport qualification uses Pi 1.0.2 and Claude Code 2.1.281. Startup and extension loading are also verified with Pi 1.1.0. Those startup checks make no paid requests.

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

Start Pi with a DirectSDK model:

```sh
pi --model claude-directsdk/haiku
```

DirectSDK uses the CLI login, not the Pi Anthropic login. The `npm install` flag enables the Claude Code installer for that command only.

The model catalog does not guarantee account entitlement. Start with `haiku` for a small request. Models that require usage credits can incur separate charges. To use only the included subscription allowance, disable additional paid usage in your Claude account.

## Use

List models from a local checkout without installing it:

```sh
pi -e ./extensions/claude-directsdk/index.ts --list-models claude-directsdk
```

Run a prompt:

```sh
pi -e ./extensions/claude-directsdk/index.ts -p --model claude-directsdk/sonnet -- "Hello."
```

Cache-only initialization uses the pinned catalog without Claude CLI probes. The request transport loads on the first Claude request. See [docs/startup.md](docs/startup.md) for behavior, measurements, and limits.

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

This runs offline checks only and consumes no subscription allowance. Opt-in live suites are documented in [docs/testing.md](docs/testing.md).

## Costs

Per-model cost metadata is Anthropic list price. Pi reports it as an estimate, never as a subscription charge. Failed or interrupted requests are never reported as free.

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Request lifecycle, model routing, tool transport, admission relay. |
| [docs/startup.md](docs/startup.md) | Cache-only initialization, lazy loading, and startup measurements. |
| [docs/testing.md](docs/testing.md) | Offline and opt-in test suites. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Missing CLI, logged-out CLI, conflicting environment. |

## Acknowledgments

Behavioral reference: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk) (MIT). This project copies its behavior contract, not its code.

## License

MIT. See `LICENSE`.
