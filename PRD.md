# Pi Claude DirectSDK — product requirements

## Outcome

Expose Claude as a Pi model provider through the unmodified Claude Code executable. Pi owns the transcript, system prompt, tools, approvals, tool results, branches, compaction, and retries. Claude Code handles its own authentication and acts only as a model transport. Do not use Pi's Anthropic OAuth credential or impersonate Claude Code over a direct API connection.

This is a Pi port of the **behavioral contract** of [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk), not a claim of Anthropic endorsement. Hermes uses native stream-json, not the Agent SDK package. Its MIT-licensed code is a reference; preserve attribution if code is copied.

## Scope and boundaries

- Register an installable TypeScript Pi provider with discoverable Claude models and a `streamSimple` implementation. Support interactive, print, and resumed Pi sessions.
- Use one request-scoped official `claude` process per Pi model call. Keep Pi's current context authoritative; never use a persistent Claude session as a second history store.
- Send the current system prompt and tool schemas through private files. Disable native tools, skills, settings sources, persistence, and native compaction where supported. An inert Model Context Protocol (MCP) server advertises Pi tools but never executes them.
- Replay prior assistant, user, and tool-result frames in native stream-json form. Require zero-turn acknowledgments for historical user frames; only the final frame may generate. Reject unsupported history instead of flattening it into prose. Preserve signed thinking only when its visible assistant projection is unchanged; never attach stale signatures to edited history. Design a durable Pi-compatible carrier for native blocks that Pi's message types cannot represent.
- Convert native text, thinking, images, tool calls, stop reasons, token/cache usage, and failures to Pi stream events. Publish tool calls only after the first upstream response is complete, usage and stop reason are captured, and the child has exited. Pi alone executes and records tools.
- Enforce at most **one upstream Messages request per Pi model call** with a request-scoped localhost admission relay. Preserve the official client's upstream authentication and identity headers in memory. Deny later native recovery or retries locally. Do not turn an incomplete first response into success.
- Honor Pi's abort signal, `onPayload`, `onResponse`, and provider-scoped environment. Kill the full child process tree, close relay sockets, and remove private files on abort or failure. Prevent concurrent calls from sharing a cancellable child or relay.
- Reject inherited API-key, custom Anthropic endpoint, and cloud-backend overrides in subscription mode. Never read, print, persist, or refresh Claude credentials. Fail with an actionable error when `claude` is missing or not logged in. Never fall back to another billing route.
- Report exact native input, output, cache-read, and cache-write counts when available. Label any native list-price amount **estimate, not subscription charge**. Do not report failed or interrupted requests as free. Show model and context limits consistent with native selection.

## Not in scope

Claude Code's agent loop, native tool execution, account-login implementation, OAuth token extraction, API-header spoofing, or a claim that subscription-authenticated requests consume interactive-plan allowance. No automatic paid test calls or release in this phase.

## Verification and cost gates

1. **Offline fixtures (no subscription, no network):** Test replay, signed-history edits, tool batches, response completeness, single-request admission, upstream errors, cancellation, concurrent calls, and process-tree cleanup against synthetic protocol fixtures.
2. **Real CLI + fake upstream (no subscription):** Run the installed official CLI against a local synthetic Anthropic Messages endpoint with a fixture API key in a separate, explicit test mode. This qualifies CLI protocol behavior without vendor calls; it does **not** qualify subscription authentication. Hermes provides a reference evaluation at `evals/directsdk_admission.py`.
3. **OpenRouter integration (optional, pay-as-you-go):** In a separate explicit gateway test mode, run the official CLI against OpenRouter's Anthropic-compatible endpoint with an OpenRouter key. Use a Claude model routed to an Anthropic provider. Never treat a non-Claude model, gateway result, or gateway token as proof of subscription behavior. Never reuse gateway credentials in production subscription mode.
4. **Subscription qualification (requires explicit approval and an eligible account):** Verify native login, one admitted upstream request per Pi call, Pi-owned tool execution, restart/branch/compaction, cancellation, and measured cache reuse. Record cache-read fraction, cache writes, context size, model, and CLI version for each call. On a stable-prefix long-context run with at least five tool rounds, target at least 95% follow-up cache reads; investigate any miss. Do not claim this target is met from fixture or gateway tests.

Pin a qualified Claude Code version range. Fail clearly on changed replay acknowledgments or incomplete native responses. The relay and replay behavior are version-sensitive interfaces. Keep paid tests opt-in and bounded.

## External references

- [Hermes DirectSDK README and transport](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk)
- [Pi custom-provider contract](https://pi.dev/docs/latest/custom-provider)
- [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [OpenRouter Claude Code integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)
- [Anthropic Agent SDK and `claude -p` billing guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
