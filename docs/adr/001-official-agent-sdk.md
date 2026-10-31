# ADR 001: Use the official Agent SDK as Pi's Claude subscription transport

## Status

Accepted and implemented on `feat/official-agent-sdk`: transport, offline suite, real round trip, and [measurements](../measurements.md). Not release-qualified.

## Context

The product outcome is Claude subscription access inside Pi. Pi should provide the workflow, instructions, tools, and permissions. Exact native replay is not a user requirement.

The current transport directly drives `claude -p`, reconstructs history, and interposes an HTTP admission relay. Its initial requirements adopted Hermes's direct stream-json architecture. They made exact replay and a one-upstream-request boundary part of the contract before implementation.

Those constraints require maintenance beyond the desired product outcome. They also tie prompt handling and request behavior to version-sensitive Claude Code interfaces.

OpenCode v2.2.3 demonstrates a different boundary. It uses the official SDK with the user's Claude executable, appends host instructions to Claude Code's base prompt, disables native tools, and sends host tool results through SDK MCP handlers.

User-facing requirements and source references came from the PRD that scoped this migration; it is a working document and is not part of this repository.

## Decision

Use `@anthropic-ai/claude-agent-sdk` as the supported transport. Run the user's installed, logged-in Claude Code executable through the SDK.

Compose prompts from the Claude Code base preset plus Pi's applicable instructions. Do not retain a docs-text workaround as the target design. Prompt acceptance must still be verified against the real upstream service.

Expose Pi tools through SDK MCP integration. Disable native tools and independent Claude Code settings, hooks, skills, memory, and compaction where supported. Pi remains the authority for tool execution and permission decisions.

Allow SDK-managed process continuation and Claude session state. Pi owns the visible conversation, while the provider adapts that conversation to Claude's session interface. Exact native replay and signed-thinking preservation are not required.

Delegate request-level retries to Claude Code. Do not layer automatic Pi/provider retries on top of the same failed turn. Remove the one-HTTP-request requirement and the custom admission relay from the target architecture.

Preserve subscription authentication boundaries and billing transparency. Do not silently fall back to other billing routes. Do not assume that SDK use fixes subscription metering or third-party usage classification.

Remove obsolete direct-transport machinery as the replacement becomes qualified. Do not maintain both transports as permanent product modes.

## Responsibility boundary

| Pi and this provider own | SDK and Claude Code own |
|---|---|
| Visible conversation and user workflow | Native Claude session representation and continuation |
| Pi instructions appended to the base prompt | Claude Code base prompt and its upstream composition |
| Offered tools, approvals, execution, and visible results | MCP transport and delivery of returned results to Claude |
| Branching, edits, compaction, and host-to-Claude session adaptation | Model inference and internal request-level retries |
| Pi-facing stream conversion, cancellation coordination, and diagnostics | Supported subprocess and protocol plumbing |
| Authentication-route validation and usage-credit policy from available signals | Claude login and upstream authentication |

Using the SDK does not remove the provider's session adaptation, tool bridge, event mapping, or error-handling responsibilities.

## Alternatives considered

### Retain the direct CLI transport

Retains exact replay, custom request rewriting, and the hard HTTP admission boundary. Rejected as the target direction because those guarantees are not needed for the approved product outcome and keep custom transport maintenance in scope.

### Use the SDK while retaining the relay and exact replay

Could preserve stronger transport controls, but would keep the machinery this decision intends to remove. No product requirement currently justifies that combination.

### Use Claude Code as a delegated coding agent

Would hand native tools or workflow control to Claude Code. Rejected because the product is a Pi model provider, not a second agent environment.

## Consequences

### Benefits

- Delegate supported process and protocol plumbing to the official SDK.
- Follow a shipped integration pattern for host-owned tools and appended instructions.
- Remove maintenance devoted solely to exact replay and upstream request rewriting. Roughly 3,000 deleted source lines of relay, replay, and transcript code went with them.
- Cost less per conversation: 37,526 prompt tokens and a $0.0293 estimate for three turns, against 88,700 and $0.0684 for `claude -p --resume`. Vanilla sends 28 native tool schemas that this transport never sends.

### Accepted trade-offs

- Claude receives Claude Code instructions as well as Pi instructions. Pi's prompt is no longer the sole instruction layer.
- A Claude session can diverge from Pi's visible history. The provider must adapt or rebuild it explicitly.
- Claude Code may make multiple upstream attempts within a turn.
- Cache reuse depends on prompt size. Measured: no cache activity below roughly 4,000 prompt tokens, 98.8 to 98.9 percent cache-read share above it on continued turns, and 94.9 percent reuse of the instruction prefix after a rebuild.
- Latency per turn is lower than `claude -p --resume` mostly because one process serves every turn (1.1 to 2.1 s against 2.6 to 3.5 s). A close with a parked tool call takes about seven seconds.
- Subscription usage is neutral per conversation and worse per token. Three identical conversations drained 5 points of the 5-hour window on each arm; the transport sent 2.4 times fewer prompt tokens, so per token it drains about 2.4 times more. The lower cost estimate is not a quota saving.
- SDK packaging adds dependency and runtime compatibility work.
- Upstream billing and policy risks remain. This decision is not a claim of Anthropic endorsement.

## Qualification and follow-up

The migration's acceptance criteria still govern release. Session recovery, supported versions, installation behavior, configuration migration, and the usage-credit signals are settled by tests and by [Measurements](../measurements.md). Unverified: cache lifetime beyond the 28-minute gap measured, conversations longer than six turns, Windows, and compiled Pi.

The existing README and architecture describe the shipped implementation until migration lands. The old roadmap's requirement to preserve exact replay, exclusive Pi prompt ownership, and one-request admission no longer gates this migration.

Revisit the integration design if qualification shows that native tools cannot remain disabled, Pi permission decisions can be bypassed, or normal Pi conversation actions cannot retain usable task context. Do not restore discarded transport guarantees solely because the previous implementation had them.
