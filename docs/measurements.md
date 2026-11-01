# Measurements

Six questions were measured against the installed Claude Code on 2026-10-31: how much a turn costs in tokens compared with plain `claude -p`, whether a continued session reuses its prompt cache, what survives a process restart, what Pi compaction does to the next turn, how much of the plan window each arm drains, and what happens when a turn is cancelled or the CLI stops producing output.

All results come from the same installation:

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
- **Across a restart.** A new process read back **11,887 tokens** of instruction prefix that the previous process had written 309 ms earlier. The conversation itself was rewritten, because a rebuild sends history as one flattened message; `claude -p --resume` read its whole conversation back instead.
- **Compaction.** Pi compaction cut the prompt from 13,192 to 3,709 tokens, and the first turn after it had **no cache at all** (zero reads, zero writes) and took 3,956 ms against 1,682 ms for an ordinary continued turn.
- **Plan window.** The endpoint's percentage is not a running total: it read 98% used and later 76% used in the same window while work was only being added, and the same workload charged 4 points once and 1 point the next time. No per-token quota cost can be derived from it. Cached input is not free, though: 123,560 cached tokens moved the figure as much as 62,000 uncached ones.
- **Cancellation.** Cancelling mid-generation returns `aborted` and keeps the partial text. Closing with a parked tool call reaps the process in about 7 seconds. A frozen CLI trips the frame deadline with a `timeout` error, and no process survives.

## Method

```sh
npm run measure session        # token velocity and cache, short prompt
npm run measure cache          # the same with a 33,573-character instruction block
npm run measure restart        # cache reuse across a process restart
npm run measure compaction     # what Pi compaction does to the next turn
npm run measure cancellation   # cancel, close, and stall
npm run measure quota          # plan-window drain for both arms
```

`session`, `cache`, and `restart` run both arms. `compaction` measures the transport only, because forcing Claude Code's own compaction into a comparable state is not scriptable.

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

## 3. Cache across a restart

`restart` runs two turns on one live session, closes every session, and hands the same history to a **new process**. The transport keeps nothing on disk, so the second process rebuilds the conversation from text. Both arms resume the same history; the vanilla arm does it with `--resume`. The instruction block carries a per-run marker, so a cache read in the second process can only come from that run's own write.

| Arm | Turn | Prompt | Cache read | Cache write | Share | Wall |
|---|---|---|---|---|---|---|
| Transport, process 1 | 1 | 12,392 | 0 | 12,382 | 0 | 3,973 ms |
| Transport, process 1 | 2 | 12,685 | 12,382 | 293 | 97.6% | 1,197 ms |
| Transport, process 2 | 3 | 12,475 | 11,887 | 578 | 95.3% | 4,741 ms |
| Vanilla, process chain | 1 | 29,605 | 12,318 | 17,277 | 41.6% | 5,699 ms |
| Vanilla, process chain | 2 | 29,897 | 29,595 | 292 | 99.0% | 3,483 ms |
| Vanilla, process 3 | 3 | 30,044 | 29,887 | 147 | 99.5% | 3,979 ms |

The gap between what the transport read and what it wrote is the rebuild, not a cache failure. A rebuilt session sends the conversation as one flattened message, so only the instruction prefix can match the previous request; the conversation (578 tokens here) is sent again as a cache write. `--resume` replays the original message sequence and reads the whole thing back.

The cache entry itself survives the restart. It also outlives the session that wrote it: an identical instruction block written during a run that finished at 19:07:58 was still read back at 19:35:41 in a different process, roughly **28 minutes** later.

## 4. Compaction

Pi owns compaction, so the transport never sees a Claude Code compaction. When Pi compacts, it replaces the earlier history with a summary message and keeps recent entries. The session cannot match after that, so the next turn is a rebuild.

The workload pastes a 33,573-character document, asks about it for four turns, then continues the same session once. Then the same question runs against the compacted history: Pi's own summary wrapper, the last kept answer, and the new request.

| Turn | Prompt | Cache read | Cache write | Share | Wall |
|---|---|---|---|---|---|
| 1, document pasted | 12,407 | 0 | 12,397 | 0 | 4,314 ms |
| 2 | 12,649 | 12,397 | 242 | 98.0% | 1,223 ms |
| 3 | 12,775 | 12,639 | 126 | 98.9% | 2,225 ms |
| 4 | 13,043 | 12,765 | 268 | 97.9% | 1,440 ms |
| 5, same session | 13,192 | 13,033 | 149 | 98.8% | 1,682 ms |
| 6, after compaction | 3,709 | 0 | 0 | 0 | 3,956 ms |

Compaction does what it promises for size: the prompt falls by 72%, so every later turn sends about 28% of the tokens the earlier ones did. It also lands under the cacheable minimum, so caching stops entirely: turn 6 read nothing and wrote nothing, and the following turns stay uncached until the prompt grows past roughly 4,000 tokens again.

Turn 6 is also the slowest of the six, because a rebuild starts a new process and pays the handshake. One sample; the ordering of the earlier turns shows wall time moves with network conditions too.

## 5. Plan-window drain

The 5-hour and weekly windows are what actually limit a plan, so the obvious question is what each kind of token costs there. It cannot be answered from this endpoint.

**The percentage is not a running total.** It read 98% used at 20:51 UTC and 76% used at 22:49 UTC with the same reset time (01:10 UTC) and the same window, during a period when usage only increased. It moved down while work was being added. The figure therefore behaves like a rolling estimate that lets older usage age out, not like a counter of what has been spent.

That makes single-run deltas meaningless, and the replications show it:

| Condition | Requests | Uncached input | Cache reads | Output | Points |
|---|---|---|---|---|---|
| `coldInput` run 1 | 5 | 61,968 | 0 | 1,384 | 4 |
| `coldInput` run 2 | 5 | 62,067 | 0 | 1,101 | 1 |
| `warmInput` run 1 | 10 | 100 | 123,560 | 2,007 | 4 |
| `warmInput` run 2 | 10 | 622 | 123,228 | 2,035 | 4 |
| `longOutput` | 3 | 10,620 | 0 | 2,722 | 1 |

The same uncached workload charged 4 points and then 1. The same cached workload charged 4 points twice. Small bursts sometimes moved nothing at all: six requests with 21,180 uncached tokens read 37% before and 37% after.

Earlier, a three-conversation arm comparison reported 5 points for the transport and 5 for `claude -p --resume`. In light of the above, that equality is what a decaying window produces over a long run, not evidence that the two arms cost the same.

What is safe to say:

- Cached input is **not** free. A burst of 123,560 cached tokens moved the percentage as much as a burst of 62,000 uncached tokens, in runs where output was nearly equal.
- Uncached input is charged more per token than cached input, but the ratio is not measurable at one-point resolution against a figure that decays.
- Nothing here can support a per-token quota cost, and the dollar cost estimate must not be read as plan consumption.

Measuring this properly needs either a per-request accounting source, which the endpoint does not expose, or bursts large enough to dominate the decay. Both are outside what this project can do today.

## 6. Cancellation and stalls

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

- **Plan-window numbers cannot be trusted at fine scale.** The percentage is whole, it lags by minutes, and it decays inside the same window. Only bursts large enough to dominate the decay would be measurable, and they were not run.
- **The label still differs between the arms.** The transport's label is set by the Agent SDK and `claude -p` sets its own. The drain measured here is what the endpoint reports, not a decomposition of how it was charged.
- **The drain test needs an interactive session.** The footer extension only activates in Pi's TUI, so each probe waits for its cached snapshot to pass five minutes and then opens a detached terminal session. That made the run 15 minutes long and adds a `screen` dependency to `npm run measure quota`.
- **Nothing else may use the account during the run.** The windows are shared, so background activity on the same login would be counted against whichever arm was running.
- **No vanilla interactive arm.** `claude` in a terminal has its own startup and prompt composition, and was not measured. The comparison arm is the closest scriptable equivalent.
- **One model, one machine, one run per arm.** Cache thresholds, prompt composition, and startup cost differ by model and platform.
- **The cost estimate is Claude Code's, not a bill.** It prices tokens against a published list; it does not observe plan deductions.
- **Cache lifetime is bounded by observation, not by a documented rule.** The longest gap measured here is about 28 minutes. Anthropic's published cache lifetimes and Claude Code's chosen TTL are the reference; a gap longer than that was not tested.
- **Compaction is simulated.** Pi's summary wrapper and kept-recent-entry layout are reproduced, but the summary text is written by hand instead of generated, and Pi's own cut point is not exercised.
- **Not covered:** conversations beyond six turns, multiple concurrent sessions, Windows, and compiled Pi.
