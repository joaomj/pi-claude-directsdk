# Comparison with pi-claude-bridge

[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) is the closest alternative: both expose Claude as a Pi provider, let Pi execute provider tools, and now drive Claude Code through the official Agent SDK. The difference is who owns the conversation record. DirectSDK treats Pi's transcript as authoritative and rebuilds the Claude session when that transcript changes. Bridge mirrors Pi's history into a resumable Claude session and adds optional delegation to Claude agents.

The DirectSDK column reflects this branch, its Agent SDK transport. The Bridge column is a [source and documentation review of Bridge at `b2e7255`](https://github.com/elidickinson/pi-claude-bridge/tree/b2e7255ece0b8bfd3a6429fd5c147fd59984c785), reviewed on October 13, 2026, and not re-reviewed for this change. This is a source comparison, not a head-to-head benchmark.

| Dimension | DirectSDK | pi-claude-bridge |
|---|---|---|
| Transport and agent loop | Official Agent SDK `query()`. One streaming-input session per Pi conversation, continued across tool boundaries. | Official Agent SDK `query()`. An active query continues across Pi tool boundaries. |
| Tool execution | Pi tools are one MCP server named `pi`. The handler parks until Pi has authorized and run the call, then the result is delivered by tool-use id. Native tools, settings, skills, and hooks are disabled. | MCP handlers wait for Pi to execute tools and return results to the active query. Native tools are disabled in provider mode. |
| System prompt | Claude Code's `claude_code` preset with Pi's current system prompt appended. No settings sources, no `.claude` files, no skills. | Uses the Claude Code prompt preset with selected Pi context, skills, and instructions appended. Some injection routes are unsupported, and resumed sessions can retain earlier instructions. |
| Conversation state | Pi's transcript is the record. A session is reused only while the digest of everything Pi has shown still matches; any edit, branch, resume, compaction, model change, or tool-set change rebuilds it from a text checkpoint that includes completed tool results. No mirrored session. | Resumes a Claude session that mirrors Pi's history. Divergence, compaction, and some recovery paths require synchronization or rebuilding. |
| Process lifecycle | One Claude Code process per Pi conversation, including follow-up user turns and every tool round trip. A rebuild replaces it. Closing the Pi session closes the process. | Keeps the SDK query active across tool boundaries. Later user turns start a new query that can resume the saved session. |
| Prompt caching | A continued session keeps its prefix, so tool loops and follow-up turns reuse the cache: 98.8 and 98.9 percent cache-read share on turns two and three of a measured conversation. A rebuilt session still reuses the unchanged instruction prefix (94.9 percent of the cached tokens in the same measurement) and rewrites only the conversation tail. Prompts below the model's cacheable minimum are not cached at all. No explicit cache anchor. | Uses Claude Code caching and session resume, and suppresses changing Git instructions to stabilize the prefix. Its README reports cache misses after session rebuilds. |
| Connection reuse | Handled by the SDK and Claude Code. The provider has no equivalent custom pooling layer. | Networking is handled by the SDK and Claude Code; the provider has no equivalent custom pooling layer. |
| Plan-window drain | About 1.7 points of the 5-hour window per three-turn conversation, the same as `claude -p --resume` for identical work. Per prompt token it drains about 2.4 times more. | Not measured. |
| Authentication guards | Uses CLI login or a CLI setup token. Rejects conflicting API credentials, base URLs, and alternative backend settings before a session starts rather than switching billing routes. Stops after a reported usage-credit overage unless `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1` is set. | Uses Claude Code authentication through the SDK. Its README warns that inherited Anthropic API environment variables can redirect the child. |
| Startup and models | Cache-only startup and lazy loading of the SDK. Refresh combines the CLI account picker with Anthropic documentation to validate model metadata. | Registers models from Pi's Anthropic catalog, with plan and context-window settings. |
| Compatibility and maintenance | Pins the SDK and MCP packages exactly and gates on the SDK handshake instead of a CLI version range. Maintains the tool bridge, the session digest and rebuild, and the MCP tool server. | Uses a versioned Agent SDK dependency, with an optional external CLI. Maintains session synchronization, prompt projection, and MCP tool bridging. |
| Verification | 18 offline tests through the transport's own entry point against a scripted SDK runtime, a two-call real round trip (`npm run smoke`), and manual Pi runs. [Measurements](measurements.md) cover token cost, cache reuse, restart behaviour, compaction, and cancellation on the real binary for one model on one machine. | Provides offline unit tests and API-backed integration tests. Test availability alone does not prove greater reliability. |
| Additional features | Focused inference provider. | Optional `AskClaude` delegation, including read-only and full native-tool modes. |

Because both sides now use the same SDK interface, the meaningful differences are where the conversation record lives, how a rebuild is decided, and which injection routes are open. DirectSDK closes more of them: no settings, no skills, no native tools, and no resumed session that could carry instructions Pi no longer shows.

### Measurements

DirectSDK now has measurements for its Agent SDK transport on the real binary; see [Measurements](measurements.md) for the method and limits. Bridge has no matched measurement, so the right-hand column below is absent.

Against `claude -p --resume` for the same three-turn conversation:

| Arm, same instructions | Prompt tokens | Cost estimate | Wall time |
|---|---|---|---|
| DirectSDK | 37,526 | $0.0293 | 4,455 ms |
| `claude -p --resume` | 88,700 | $0.0684 | 9,855 ms |

The gap comes from Claude Code running with no native tools and no settings sources: the transport sends a 12.4k prompt where vanilla sends 28.9k, because vanilla advertises 28 tools. Cache behaviour is all or nothing by prompt size: no cache activity at 3.5k prompt tokens, 98.8 to 98.9 percent cache-read share at 12.4k. Wall time favours the transport mostly because one process serves every turn, and vanilla starts a new one per turn.

A restart is not a cache miss for the instructions: a new process read the prefix back 309 ms later, and rewrote only the flattened conversation. Pi compaction cuts the prompt by 72% and drops it below the cacheable minimum, so caching stops until the prompt grows again.

Plan-window consumption was measured: three identical conversations drained 5 points of the 5-hour window on each arm, while the transport sent 2.4 times fewer prompt tokens. Per conversation the arms are equal, so the transport's lower cost estimate is not a quota saving. Per prompt token it drains about 2.4 times more, which matches the 1.6 to 2.9 times per-token figure reported for headless SDK sessions.

Earlier releases measured the direct-CLI transport that this branch replaces: 99.59 and 99.71 percent cache-read share on two warm turns, 99.84 percent after restarting Pi, and a 2,345.663 ms median provider completion with a 436.408 ms child-spawn-to-replay interval. Those numbers described history replay and no longer apply.

### Subscription and policy limits

Using the official CLI or SDK does not, by itself, establish Anthropic approval of either extension. Anthropic's [subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) states that Agent SDK, `claude -p`, and third-party app usage can still draw from subscription limits. Its [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview) separately says that third-party developers need prior approval to offer claude.ai login or rate limits in their products. These statements address different conditions, and neither establishes project-specific approval. Billing and policy guidance can change.

### Which to choose

Choose DirectSDK when you want Pi's transcript to be the only record, with no Claude session that outlives it, and with Claude Code stripped of its own tools, settings, and skills. The trade-offs are a rebuilt session and a new process whenever the history changes, and a close that takes about seven seconds when a tool call is parked. A rebuild is not a fully cold prefix: the unchanged instructions still hit the cache.

Choose Bridge when you prefer a mirrored, resumable Claude session across Pi restarts, or optional Claude-agent delegation. The trade-off is mirrored-session recovery and a Claude Code instruction environment rather than direct forwarding of Pi's full system prompt. See its [compatibility notes and known issues](https://github.com/elidickinson/pi-claude-bridge/blob/b2e7255ece0b8bfd3a6429fd5c147fd59984c785/README.md#compatibility-with-other-extensions) before relying on prompt injection or session rebuild behavior.
