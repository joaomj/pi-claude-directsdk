# ADR 001: Use the official Agent SDK as Pi's Claude subscription transport

## Status

Accepted migration direction. Not implemented or release-qualified.

## Context

The product outcome is Claude subscription access inside Pi. Pi should provide the workflow, instructions, tools, and permissions. Exact native replay is not a user requirement.

The current transport directly drives `claude -p`, reconstructs history, and interposes an HTTP admission relay. Its initial requirements adopted Hermes's direct stream-json architecture. They made exact replay and a one-upstream-request boundary part of the contract before implementation.

Those constraints require maintenance beyond the desired product outcome. They also tie prompt handling and request behavior to version-sensitive Claude Code interfaces.

OpenCode v2.2.3 demonstrates a different boundary. It uses the official SDK with the user's Claude executable, appends host instructions to Claude Code's base prompt, disables native tools, and sends host tool results through SDK MCP handlers.

See the [PRD](../PRD.md) for user-facing requirements and source references.

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

### Benefits expected, not yet measured

- Delegate supported process and protocol plumbing to the official SDK.
- Follow a shipped integration pattern for host-owned tools and appended instructions.
- Remove maintenance devoted solely to exact replay and upstream request rewriting.

### Accepted trade-offs

- Claude receives Claude Code instructions as well as Pi instructions. Pi's prompt is no longer the sole instruction layer.
- A Claude session can diverge from Pi's visible history. The provider must adapt or rebuild it explicitly.
- Claude Code may make multiple upstream attempts within a turn.
- Cache reuse, latency, and subscription usage may differ from the old transport.
- SDK packaging adds dependency and runtime compatibility work.
- Upstream billing and policy risks remain. This decision is not a claim of Anthropic endorsement.

## Qualification and follow-up

The [PRD acceptance criteria](../PRD.md#release-acceptance) govern the migration. Implementation planning must resolve session recovery, supported versions, installation behavior, configuration migration, and available usage-credit signals.

The existing README and architecture describe the shipped implementation until migration lands. The old roadmap's requirement to preserve exact replay, exclusive Pi prompt ownership, and one-request admission no longer gates this migration.

Revisit the integration design if qualification shows that native tools cannot remain disabled, Pi permission decisions can be bypassed, or normal Pi conversation actions cannot retain usable task context. Do not restore discarded transport guarantees solely because the previous implementation had them.
