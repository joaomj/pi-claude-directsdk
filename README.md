# Pi Claude DirectSDK

[![CI](https://github.com/joaomj/pi-claude-directsdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/joaomj/pi-claude-directsdk/actions/workflows/ci.yml?query=branch%3Amain)
[![npm version](https://img.shields.io/npm/v/pi-claude-directsdk.svg)](https://www.npmjs.com/package/pi-claude-directsdk)
[![License](https://img.shields.io/github/license/joaomj/pi-claude-directsdk)](LICENSE)

Use Claude inside Pi through the official Claude Agent SDK and the unmodified Claude Code executable. Pi owns the transcript, tools, approvals, and retries; Claude Code supplies subscription authentication and the model.

One Claude Code session serves each Pi conversation. Assistant output streams through as it arrives, tool calls return to Pi for authorization and execution, and the same session continues with those results. Claude Code runs with no native tools, no settings, no skills, and no MCP servers except the one Pi supplies.

## Requirements

- Pi. The current maintainer installation is Pi 1.3.0; see [verification details](docs/testing.md#verified-environments).
- Node 20 or later for Node-based Pi installations and local development. Compiled Pi uses its bundled runtime.
- Claude Code installed and reachable. The SDK handshake tests the installed version at each session start, so this project does not pin a version range. Claude Code 2.1.281 is the version under test.
- A Claude paid plan. The free plan excludes the CLI.
- A Claude Code login via `claude auth login`.

## Install

Sign in through the official CLI:

```sh
claude auth login
```

Install the extension from npm, or from Git instead, but not both:

```sh
pi install npm:pi-claude-directsdk
pi install git:github.com/joaomj/pi-claude-directsdk  # alternative source
```

Start or restart interactive Pi, open `/model`, and wait for the DirectSDK catalog refresh. On a fresh install, this step must complete before selecting the model from the command line; later invocations can use the saved catalog, for example `pi --model claude-directsdk/haiku`.

DirectSDK uses the CLI login, not the Pi Anthropic login.

The model catalog does not guarantee account entitlement. Start with `haiku` for a small request. Models that require usage credits can incur separate charges, and DirectSDK cannot undo a charge that Claude Code already reported. See [usage credits](docs/usage.md#usage-credit-guard).

## Test a local checkout

A local run needs no release and no version bump. Run the extension directly from the checkout:

```sh
pi -e ./extensions/claude-directsdk/index.ts --model claude-directsdk/haiku
```

Pi loads the extension for that invocation only and leaves your settings unchanged. To keep it installed while developing, add the checkout itself:

```sh
pi install ./          # registers this directory as an extension source
pi remove ./           # removes it again
```

Two checks need no Pi session:

```sh
npm test               # offline: scripted Claude Agent SDK runtime, no model calls
npm run smoke          # two real model calls against your own Claude Code login
```

`npm run smoke` proves the tool round trip on the real binary: the first call must return a tool call, and the second must answer from the tool result Pi supplies. It closes the session it opened. Both commands are described in [testing.md](docs/testing.md).

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
| Conversation | One live Agent SDK session; rebuilt from Pi's history when that history changes | Live Agent SDK query with a mirrored Claude session | Fresh CLI; warm reuse for text-only turns |
| Latency and cache | Session and prompt cache survive tool calls; a rebuilt session still reuses the instruction prefix | Query continues across tool calls; rebuilds miss the cache | Warm text turns skip startup; tool loops replay |
| Models | CLI picker plus Anthropic docs, with verified prices | pi-ai Anthropic catalog, updated automatically | CLI discovery plus fallback metadata |

pi-claude-bridge requires Pi `>=0.86.1`. DirectSDK accepts the installed Claude Code version and fails with the CLI's own message when the SDK handshake cannot complete. All three use a Claude Code login, draw on the same subscription, and can be affected by Anthropic billing changes. None has a matched performance benchmark. DirectSDK's own numbers are in [Measurements](docs/measurements.md): 37,526 prompt tokens and a $0.0293 cost estimate against `claude -p --resume`'s 88,700 and $0.0684 for the same three turns, with 98.8 to 98.9 percent cache-read share on continued turns. Against the plan window the two arms drain the same per conversation, so the cost saving is not a quota saving. See the [full comparison](docs/comparison.md) for source-level detail.

## Documentation

- [Usage and configuration](docs/usage.md): local checkout, environment settings, costs, and diagnostics.
- [Architecture](docs/architecture.md): session lifecycle, prompt composition, tool bridge, and rebuild rules.
- [Troubleshooting](docs/troubleshooting.md): missing CLI, login, and conflicting environment settings.
- [Testing](docs/testing.md), [measurements](docs/measurements.md), [startup](docs/startup.md), and the [full Bridge comparison](docs/comparison.md).
- [Architecture decision](docs/adr/001-official-agent-sdk.md): why this transport uses the official Agent SDK.

## Issues and security

Bug reports, feature requests, and questions are welcome through [issue forms](https://github.com/joaomj/pi-claude-directsdk/issues/new/choose). This project does not accept unsolicited public pull requests; see [contribution guidance](CONTRIBUTING.md). Report vulnerabilities privately as described in the [security policy](SECURITY.md).

## Acknowledgments and license

Behavioral reference: [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk) (MIT). This project copies its behavior contract, not its code. DirectSDK is MIT licensed; see `LICENSE`.
