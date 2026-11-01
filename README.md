# Pi Claude DirectSDK

[![CI](https://github.com/joaomj/pi-claude-directsdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/joaomj/pi-claude-directsdk/actions/workflows/ci.yml?query=branch%3Amain)
[![npm version](https://img.shields.io/npm/v/pi-claude-directsdk.svg)](https://www.npmjs.com/package/pi-claude-directsdk)
[![License](https://img.shields.io/github/license/joaomj/pi-claude-directsdk)](LICENSE)

Use Claude inside Pi through the official Claude Agent SDK and the unmodified Claude Code executable. Pi owns the transcript, tools, approvals, and retries; Claude Code supplies subscription authentication and the model.

One Claude Code session serves each Pi conversation. Assistant output streams through as it arrives, tool calls return to Pi for authorization and execution, and the same session continues with those results. Claude Code runs with no native tools, no settings, no skills, and no MCP servers except the one Pi supplies.

## Requirements

- Pi. The maintainer installation runs Pi 1.4.0; see [verification details](docs/testing.md#verified-environments).
- Node 20 or later for Node-based Pi installations and local development. Compiled Pi uses its bundled runtime.
- Claude Code installed and reachable. This project pins no version range: the version reported in the SDK init frame is recorded in the failure log, and a CLI that cannot complete the handshake fails with the CLI's own message. Claude Code 2.1.281 is the version under test.
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

## Documentation

- [Usage and configuration](docs/usage.md): local checkout, environment settings, costs, and diagnostics.
- [Architecture](docs/architecture.md): session lifecycle, prompt composition, tool bridge, and rebuild rules.
- [Troubleshooting](docs/troubleshooting.md): missing CLI, login, and conflicting environment settings.
- [Testing](docs/testing.md) and [startup](docs/startup.md): what each check proves, and what the extension does at load.
- [Architecture decision](docs/adr/001-official-agent-sdk.md): why this transport uses the official Agent SDK.

## Issues and security

Bug reports, feature requests, and questions are welcome through [issue forms](https://github.com/joaomj/pi-claude-directsdk/issues/new/choose). This project does not accept unsolicited public pull requests; see [contribution guidance](CONTRIBUTING.md). Report vulnerabilities privately as described in the [security policy](SECURITY.md).
