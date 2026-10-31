# Measurements

Three questions were measured against the installed Claude Code on 2026-10-31: how much a turn costs in tokens compared with plain `claude -p`, whether a continued session reuses its prompt cache, and what happens when a turn is cancelled or the CLI stops producing output.

All three results come from the same installation:

| Component | Version |
|---|---|
| Claude Code | 2.1.281 |
| Claude Agent SDK | 0.3.316 |
| Model | `claude-haiku-4-5-20251001` |
| Node | 24.22.1 |
| Host | Linux, arm64 |

Raw results are committed beside this document as `docs/measurements/*.json`. They hold token counters and timings, not conversation content. Every number below is one run; nothing here is an average.

## Summary

- **Token cost.** For the same three-turn conversation, the transport sent 37,526 prompt tokens where `claude -p --resume` sent 88,700, and Claude Code's own cost estimate was $0.0293 against $0.0684. The gap is the 28 native tools and the larger base prompt that vanilla ships.
- **Cache use.** A continued session reaches **98.8% cache-read share** once the prompt is large enough to be cacheable. Below roughly 4,000 prompt tokens the transport shows no cache activity at all: no reads and no writes.
- **Cancellation.** Cancelling mid-generation returns `aborted` and keeps the partial text. Closing with a parked tool call reaps the process in about 7 seconds. A frozen CLI trips the frame deadline with a `timeout` error, and no process survives.

## Method

```sh
npm run measure session        # token velocity and cache, short prompt
npm run measure cache          # the same with a 33,573-character instruction block
npm run measure cancellation   # cancel, close, and stall
```

Both arms answer the same three user turns: name three primary colours, name three secondary colours, then list all six. The transport arm runs them in **one** session. The vanilla arm runs them as three `claude -p` invocations, the first with `--session-id` and the rest with `--resume`, so both arms carry the same conversation.

`costUsd` is the value Claude Code reports, cumulative from the start of each conversation. It is an estimate against Anthropic's price list, not a charge to a plan.

## 1. Token velocity

Short prompt: Pi's instructions only, no native tools.

| Turn | Transport prompt | Transport cache read | Vanilla prompt | Vanilla cache read | Transport cost | Vanilla cost | Transport wall | Vanilla wall |
|---|---|---|---|---|---|---|---|---|
| 1 | 3,524 | 0 | 20,040 | 16,284 | $0.004069 | $0.010780 | 1,861 ms | 3,343 ms |
| 2 | 3,656 | 0 | 20,232 | 20,030 | $0.008160 | $0.013582 | 1,107 ms | 2,557 ms |
| 3 | 3,767 | 0 | 20,366 | 20,222 | $0.012302 | $0.016303 | 1,085 ms | 2,727 ms |

The transport needs **3.5k prompt tokens per turn** against vanilla's **20k**, because Claude Code runs with `tools: []` and no settings sources. Vanilla reports 28 native tools in its initialize frame.

With a 33,573-character instruction block added to both arms:

| Turn | Transport prompt | Transport cache read | Vanilla prompt | Vanilla cache read | Transport cost | Vanilla cost | Transport wall | Vanilla wall |
|---|---|---|---|---|---|---|---|---|
| 1 | 12,370 | 0 | 28,905 | 0 | $0.025295 | $0.059266 | 2,136 ms | 3,122 ms |
| 2 | 12,512 | 12,360 | 29,809 | 28,895 | $0.027335 | $0.064563 | 1,219 ms | 3,491 ms |
| 3 | 12,644 | 12,502 | 29,986 | 29,799 | $0.029289 | $0.068387 | 1,100 ms | 3,242 ms |

Three turns of the same conversation:

| Arm | Prompt tokens | Cost estimate | Wall time |
|---|---|---|---|
| Transport, short prompt | 10,947 | $0.0123 | 4,053 ms |
| Vanilla, short prompt | 60,638 | $0.0163 | 8,627 ms |
| Transport, long prompt | 37,526 | $0.0293 | 4,455 ms |
| Vanilla, long prompt | 88,700 | $0.0684 | 9,855 ms |

Two effects explain the difference. First, the transport offers no native tools, so Claude Code's tool schemas never enter the request. Second, the vanilla arm started a process per turn; the transport reused one.

Wall time is not a model-speed claim. Turn 1 of each arm pays process startup, and the vanilla turns 2 and 3 pay it again on every turn.

## 2. Cache use

The cache either works completely or not at all, and the deciding factor is prompt size:

- **3,524 prompt tokens: no cache activity.** Zero `cache_read` and zero `cache_creation` on every turn. The transport re-sends the whole prompt each turn.
- **12,370 prompt tokens: caching engages.** Turn 1 wrote 12,360 tokens, and turns 2 and 3 read 12,360 and 12,502 at **98.8 and 98.9% cache-read share**.
- **A rebuilt session keeps most of the cache.** After an earlier message was rewritten, the new session read **11,857 of the same 12,360 tokens** (94.9% share) and wrote only 633. The identical instruction prefix survives a rebuild; only the changed conversation tail is rewritten.

The practical consequence: a short conversation pays full input price on every turn, and it is still cheaper than vanilla's cached 20k prompt. A long conversation pays about 1% of the prompt price after the first turn.

## 3. Cancellation and stalls

Three cases, each on the real binary through the transport:

| Case | Observed | Result |
|---|---|---|
| Cancel after the first text delta | `stopReason: aborted`, `Claude request cancelled`, 25 characters of partial text kept | Pass |
| Close while a tool call is parked | Tool call published to Pi, then the session closed. The CLI exited 6,880 ms later, and the next call for the same conversation started a fresh session and answered | Pass, slow close |
| Freeze both CLI processes with `SIGSTOP` before any frame, 3,000 ms deadline | `stopReason: error`, `no output from Claude Code within 3000ms`, 0 content blocks, deadline hit at 3,239 ms | Pass |

Process accounting for the third case: two `claude` processes serve one session. At close both were stopped (`Tl`), because a stopped process cannot act on the close signal. After `SIGCONT` both ran again (`Sl`), and the count of surviving `claude` processes went from 2 at close to **0 within 15 seconds**. No orphan was left behind.

The 3,000 ms deadline is per frame wait, not per turn. A turn that keeps producing output never expires; a turn that goes silent fails after the configured `timeoutMs`, which defaults to 180,000 ms.

## Limits

These numbers answer less than they appear to.

- **Plan-window consumption is not measured.** Subscription usage is metered against a client label that Claude Code sends, and nothing on the client reports how much of the 5-hour window a turn consumed. Token counts and cost estimates are the only observable proxies.
- **The label differs between the arms and is not observable here.** The transport's label is set by the Agent SDK; `claude -p` sets its own. If Anthropic meters the two differently, these token numbers will not predict plan consumption.
- **No vanilla interactive arm.** `claude` in a terminal has its own startup and prompt composition, and was not measured. The comparison arm is the closest scriptable equivalent.
- **One model, one machine, one run per arm.** Cache thresholds, prompt composition, and startup cost differ by model and platform.
- **The cost estimate is Claude Code's, not a bill.** It prices tokens against a published list; it does not observe plan deductions.
- **Not covered:** long conversations beyond three turns, compaction, multiple concurrent sessions, Windows, and compiled Pi.
