# Gate 4 subscription qualification record

Date: 2026-09-24. Account: Claude Pro (`claude.ai`, first-party).
CLI: 2.1.281 at `~/.local/bin/claude` (inside `QUALIFIED_CLI_RANGE`).
All runs used the production path: real login, no base-URL override, no test bypass.

## Measurements

| Check | Result |
|---|---|
| `claude auth status` | `loggedIn: true` |
| Text smoke (`pi -p`, haiku, no tools) | exit 0, `OK` |
| Tool ownership (temporary `testping` tool) | model called it, Pi executed it (`pong-alpha-executed-by-pi`); native side never executes |
| Cancel (SIGINT at 25 s into generation) | pi exit 130 promptly, zero orphan `claude` processes |
| Cache reuse (3 turns, ~23 k-char stable prefix, haiku) | turn 1 wrote 5314 cache tokens; turns 2-3 read 4954 back (~92% of input-side tokens from cache) |

List-price cost figures are estimates, not subscription charges. Total spend: 6 short calls.

## Cache note

Follow-up turns reuse ~92%, just under the 95% aspiration. The gap is the
per-turn suffix (new user message, request tail) that cannot cache, plus small
prefix drift from injected reminders. The stable prefix itself reuses at ~93%.
No code change indicated.

## Product limitation: grammar-constrained tools rejected

`src/request.ts` rejects any tool with truthy `constrainedSampling`. Pi
built-ins `read`, `bash`, `edit`, `write` all set
`{ type: "json_schema", strict: "prefer" }`, so a normal Pi session fails every
call with `Grammar-constrained tools are unsupported`. Only `--no-tools` or
custom unconstrained tools work.

Evidence that rejection is stricter than necessary:

- `strict: "prefer"` is best-effort by contract: constrain if the API can,
  otherwise proceed. Only `strict: "require"` demands refusal.
- Pi's own Anthropic Messages adapter contains no constrained-sampling code;
  it forwards the schema and proceeds. Our transport speaks the same protocol.
- The Hermes reference plugin
  (NousResearch/hermes-plugin-claude-subscription-directsdk, studied at
  `/tmp/hermes-directsdk`, shallow clone) has no grammar concept at all. It
  normalizes schemas (`strip_nullable_unions`, bans top-level
  `oneOf`/`allOf`/`anyOf`) and forwards them, exactly like our
  `normalizeInputSchema`.
- Constrained decoding exists only in pi-ai's OpenAI-family adapters
  (`openai-completions`, `openai-responses`, `codex`, `azure`). The Anthropic
  wire protocol has no such knob, and the fixed `claude` binary exposes none.
- Safety net already exists: malformed native tool input fails loudly.
  `parseToolInput` throws `DirectSdkError("native", ...)` on non-object input,
  and `JSON.parse` throws on malformed fragments, so ignoring `prefer` cannot
  corrupt a tool call silently. It converts to a terminal error instead.

## Options (no decision taken)

1. Ignore `strict: "prefer"`, keep rejecting `strict: "require"` and the
   `grammar` type. Matches the tool contract and the Anthropic adapter's
   precedent. Unblocks all four built-ins.
2. Keep rejecting everything (status quo). The provider stays unusable in
   normal Pi sessions.
3. Validate arguments client-side after capture and fail closed (already the
   behavior via `parseToolInput`; no extra work).

Option 1 is recommended. It needs explicit approval because it weakens a
fail-closed guard, even though the guard exceeds the contract.
