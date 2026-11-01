# Verification

Verification has two layers. The offline suite runs in under a second and covers the transport's behaviour against a scripted Claude Agent SDK. The real checks run against the installed Claude Code and the installed Pi, and they cost model calls.

## Offline regression suite

```sh
npm test
```

The suite uses `node:test` and needs no credentials. A scripted runtime stands in for the Claude Agent SDK and emits the frames the real CLI emits. It covers:

- Streamed text, published usage, and the isolation options every session starts with: no native tools, no settings, no skills, `dontAsk`, no session persistence, the preset prompt with Pi's instructions appended.
- A tool call returned to Pi, the parked MCP handler, Pi's result delivered to that exact tool-use id, and the continuation on the same session without a second prompt.
- Parallel tool calls answered with their own results.
- A rebuild when an earlier message was rewritten, and a rebuild that keeps completed tool results instead of repeating them.
- Cancellation settling the parked call and dropping the session.
- An offered tool denied by Claude Code, a Pi tool server that failed to connect, a tool Pi never offered, an overage charge refused and allowed, a reply that merely mentions billing, and a silent CLI.
- A signature-only thinking block dropped from the published message.

The suite proves Pi-facing behaviour. It does not prove real generation, real CLI acceptance, or real cache reuse; [Measurements](measurements.md) covers those on the real binary.

```sh
npm run check   # types, including the tests
npm run build   # compilation
```

CI runs the three commands above on every branch and pull request. Paid checks stay local, because CI has no approved subscription credentials.

## Real round trip

```sh
npm run smoke
```

This spends two small model calls on the operator's own Claude Code login and is the fastest proof that the transport works on the real binary. It requires Claude Code installed and authenticated.

The first call must return a tool call to the host tool server. The second must be answered from the tool result Pi supplies, on the same session. The script prints the tool id, both stop reasons, the answer, the usage counters, and the elapsed time, then closes the session it opened.

A pass shows that the SDK handshake completed, the MCP tool server connected, the bridge parked and delivered the call, and the session continued without a second process.

## Full Pi run

```sh
pi -e ./extensions/claude-directsdk/index.ts -p --no-session \
  --model claude-directsdk/claude-haiku-4-5-20251001 \
  "Read package.json with the read tool, then run the bash tool once to print the result of \`date +%Y\`. Reply with one line: <version> <year>."
```

This exercises Pi's own tool loop, approvals, and transcript against the transport. A pass with two tools shows that Pi executed two tool calls in one turn on one live Claude session.

Use `pi install ./` instead of `-e` to keep the checkout loaded across invocations. Neither form publishes a release or changes the package version.

## Verified environments

The maintainer installation used for the results below:

| Component | Version |
|---|---|
| Pi | 1.3.0 |
| Node | 24.22.1 |
| Claude Code | 2.1.281 |
| Claude Agent SDK | 0.3.316 |
| Model under test | `claude-haiku-4-5-20251001` |

Results for the Agent SDK transport, all on the installation above:

- SDK handshake with native tools off, settings off, and the host tool server configured: complete in 671 ms, no model call.
- `npm run smoke`: tool call `mcp__pi__echo` published to Pi, answered, and continued on the same session. Final answer repeated the tool result. Usage `input 8, output 43, cacheRead 4260`, elapsed 2.85 s.
- Full Pi run with one tool: answered `0.3.1` from `package.json` in 8 s.
- Full Pi run with two tools in one turn: answered `0.3.1 2026` in 6 s.
- `npm test`: 18 of 18 pass.
- `npm run measure cancellation`: a cancelled turn returns `aborted`; closing with a parked tool call reaps the CLI in 6.9 s; a `SIGSTOP`ped CLI trips the frame deadline with a `timeout` error; no `claude` process survives.
- `npm run measure session` and `npm run measure cache`: 98.8 to 98.9 percent cache-read share on continued turns, no cache activity below roughly 4,000 prompt tokens, and 94.9 percent reuse of the instruction prefix after a rebuild.
- `npm run measure restart`: a new process read back the instruction prefix written by the previous one 309 ms earlier, and rewrote the flattened conversation.
- `npm run measure compaction`: the prompt fell from 13,192 to 3,709 tokens and the first turn after compaction had no cache activity at all.
- `npm run measure quota`: the quota endpoint's percentage decays inside the same window, and identical workloads charged 4 points and then 1, so this mode demonstrates the endpoint rather than measuring a cost. `scripts/quota.mjs read` prints the raw reading.

Not verified: cache lifetime beyond the 28-minute gap observed, conversations longer than six turns, Windows and compiled-Pi launches. Earlier releases measured the direct-CLI transport that this version replaces; those results do not carry over, because the request path and the process lifecycle changed.

## Options and safety

- `npm run smoke [-- <model>]` defaults to `claude-haiku-4-5-20251001`.
- Set `CLAUDE_DIRECTSDK_COMMAND` to test another Claude Code build.
- Neither command replaces your settings. `pi -e` loads the checkout for one invocation; `pi install ./` adds it as a source you can remove.
- `npm run smoke` prints token counters, not conversation content. Inspect output before sharing it.

## Known gaps

- The offline suite does not force a real subprocess stall, a real cancellation, or a real Ctrl+C during a tool call. `npm run measure cancellation` covers the first two on the real binary.
- No automated check covers Pi's own `/reload` against a live session.
- The two-tool Pi run is a manual check, not a permanent scenario.
