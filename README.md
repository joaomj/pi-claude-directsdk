# Pi Claude DirectSDK

[![CI](https://github.com/joaomj/pi-claude-directsdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/joaomj/pi-claude-directsdk/actions/workflows/ci.yml?query=branch%3Amain)
[![npm version](https://img.shields.io/npm/v/pi-claude-directsdk.svg)](https://www.npmjs.com/package/pi-claude-directsdk)
[![License](https://img.shields.io/github/license/joaomj/pi-claude-directsdk)](LICENSE)

Use Claude inside Pi through the unmodified Claude Code executable. Pi owns the transcript, tools, approvals, and retries; the CLI supplies subscription authentication as a model transport.

Each request starts a fresh `claude -p` process that replays Pi's history with an explicit cache anchor, and every tool call returns to Pi for execution. Three measurements recorded 99.6% to 99.8% cache-read share on warm turns; see [transport measurements](docs/transport-measurements.md) for the workloads and their limits.

## Requirements

- Pi. The current maintainer installation is Pi 1.3.0; see [verification details](docs/testing.md#verified-environments).
- Node 20 or later for Node-based Pi installations and local development. Compiled Pi uses its bundled runtime.
- Claude Code in the qualified range `>=2.1.263 <2.2.0` (see `QUALIFIED_CLI_RANGE` in `src/models.ts`).
- A Claude paid plan. The free plan excludes the CLI.
- A Claude Code login via `claude auth login`.

## Install

Install the qualified Claude Code version, then sign in through the official CLI:

```sh
npm install -g --ignore-scripts=false @anthropic-ai/claude-code@2.1.281
claude auth login
```

Install the extension from npm, or from Git instead, but not both:

```sh
pi install npm:pi-claude-directsdk
pi install git:github.com/joaomj/pi-claude-directsdk  # alternative source
```

Start or restart interactive Pi, open `/model`, and wait for the DirectSDK catalog refresh. On a fresh install, this step must complete before selecting the model from the command line; later invocations can use the saved catalog, for example `pi --model claude-directsdk/haiku`.

DirectSDK uses the CLI login, not the Pi Anthropic login. The `npm install` flag enables the Claude Code installer for that command only.

The model catalog does not guarantee account entitlement. Start with `haiku` for a small request. Models that require usage credits can incur separate charges, and DirectSDK cannot undo a charge that Claude Code already reported. See [usage credits](docs/usage.md#usage-credit-guard).

## Upgrade

```sh
pi update npm:pi-claude-directsdk                              # npm installation
pi update git:github.com/joaomj/pi-claude-directsdk            # Git installation
```

Run only the command for your source; `pi list` shows installed declarations. Version-pinned sources remain pinned when updated, so change a pin or switch sources with `pi remove <old-source>` and a fresh install. Restart Pi afterwards, then open `/model` and wait for catalog refresh.

## Comparison with other Claude providers

Three extensions expose the Claude subscription through Claude Code while Pi owns the session. This table reflects DirectSDK `main`, [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 0.9.3, and [pi-claude-code](https://github.com/earendil-works/pi-claude-code) 0.1.0 (experimental) as of October 23, 2026.

| | DirectSDK | pi-claude-bridge | pi-claude-code |
|---|---|---|---|
| Extra charges | Stops after an overage charge unless opted in | No overage stop; 1M context Extra Usage is opt-in | Stops after an overage charge unless opted in |
| Tools | Pi executes; no delegation | Pi executes; optional AskClaude delegation, deprecated | Pi executes; no delegation |
| Conversation | Fresh CLI; full replay; tool changes on supported models | Live Agent SDK query with a mirrored Claude session | Fresh CLI; warm reuse for text-only turns |
| Latency and cache | 99.6–99.8% cache-read share on warm turns | Query continues across tool calls; rebuilds miss the cache | Warm text turns skip startup; tool loops replay |
| Models | CLI picker plus Anthropic docs, with verified prices | pi-ai Anthropic catalog, updated automatically | CLI discovery plus fallback metadata |

DirectSDK requires Claude Code `>=2.1.263 <2.2.0`; pi-claude-bridge requires Pi `>=0.86.1`; pi-claude-code accepts the installed Claude Code version. All three use a Claude Code login, draw on the same subscription, and can be affected by Anthropic billing changes. None has a matched performance benchmark. See the [full comparison](docs/comparison.md) for source-level detail.

## Documentation

- [Usage and configuration](docs/usage.md): local checkout, environment settings, costs, diagnostics, and verification.
- [Architecture](docs/architecture.md): request lifecycle, model routing, tool transport, and admission relay.
- [Troubleshooting](docs/troubleshooting.md): missing CLI, login, version, and conflicting environment settings.
- [Testing](docs/testing.md), [startup](docs/startup.md), [transport measurements](docs/transport-measurements.md), and the [full Bridge comparison](docs/comparison.md).

## Issues and security

Bug reports, feature requests, and questions are welcome through [issue forms](https://github.com/joaomj/pi-claude-directsdk/issues/new/choose). This project does not accept unsolicited public pull requests; see [contribution guidance](CONTRIBUTING.md). Report vulnerabilities privately as described in the [security policy](SECURITY.md).

## Acknowledgments and license

Behavioral reference: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk) (MIT). This project copies its behavior contract, not its code. DirectSDK is MIT licensed; see `LICENSE`.
