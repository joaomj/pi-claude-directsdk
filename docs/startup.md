# Startup

DirectSDK registers synchronously with an empty catalog. The extension factory starts no processes, sockets, timers, or web requests. The request transport remains lazy.

## Behavior

- Cache-only refresh restores a previously verified snapshot from Pi’s model store. It runs no CLI probes or web requests.
- Snapshot entries are labeled `last verified snapshot`. A fresh offline install has no DirectSDK models.
- Interactive Pi starts live refresh after the editor is ready. DirectSDK uses this existing lifecycle, not an extension startup hook.
- Live refresh loads discovery modules asynchronously. It uses a supervised child for the Claude Code picker and asynchronous requests for public Anthropic documentation.
- Refresh has a 12-second deadline and honors Pi’s abort signal. Document requests have a 2 MiB limit and at most four model pages load concurrently.
- Successful refresh persists verified metadata through Pi’s model store. Repeated refreshes reuse it for 15 minutes unless forced.
- Incomplete model metadata produces a warning and excludes that model. A refresh failure reports the error and deletes the snapshot, without a pinned fallback.

On a fresh installation, run `pi update --models` before selecting a DirectSDK model from the command line. Alternatively, start interactive Pi and open `/model` to refresh. This first refresh is required because startup does not invent offline models.

## Package resolution

The local lazy-stream wrapper imports `@earendil-works/pi-ai/compat`, which Pi resolves for extensions. It does not import the previously incompatible `@earendil-works/pi-ai/api/lazy` subpath. Discovery and transport modules remain outside the extension load path.

## Previous startup measurements

The following measurements describe the previous cache-only guard and lazy-loading changes, not the new discovery implementation.


The measurements use Pi 1.1.0 with the account's normal extensions and OpenAI selected. Readiness means that Pi renders an inserted input marker. It does not mean that a model request completes.

Each batch has one warm-up per configuration and five measured launches per configuration. The full-configuration batches use all six configuration order permutations, including the warm-up order.

| Batch | Normal median | Normal range | Explicit-loading median | Without DirectSDK median |
|---|---:|---:|---:|---:|
| Before the change | 6.774s | 6.030–7.733s | 6.386s | 1.833s |
| Cache-only guard | 2.423s | 2.314–2.656s | 2.290s | 1.816s |
| Guard and lazy loading | 1.964s | 1.808–2.485s | 2.068s | 2.168s |

Explicit loading selects the same extensions through individual paths. The without-DirectSDK control uses that same method. In the first batch, the matched contrast is 4.553s. Separate batches are not a precise measurement of an optimization's effect.

A final matched batch isolates lazy loading. Each configuration has one warm-up and six measured launches. Measured launches cover all six order permutations. A temporary guard-only entry loads the original transport and discovery modules eagerly. The lazy configuration uses the final provider. All configurations use explicit extension loading.

| Configuration | Median readiness | Range |
|---|---:|---:|
| Cache-only guard, eager imports | 2.243s | 2.122–3.016s |
| Cache-only guard, lazy imports | 2.071s | 1.794–2.403s |
| Without DirectSDK | 2.229s | 1.961–2.878s |

Lazy loading improves the observed median by 0.172s in this matched batch. The ranges overlap. The batch does not establish a guaranteed saving or zero extension overhead.

## Cause and profile evidence

Before the change, one profiled normal launch runs three discovery cycles. Nine synchronous CLI calls wait for a combined 4.202s:

| Probe | Combined elapsed time |
|---|---:|
| Authentication status | 1.483s |
| CLI version | 0.138s |
| Picker initialization | 2.581s |

Pi invokes provider refresh in a cache-only phase. The old callback ignores `allowNetwork` and runs CLI discovery in that phase. This repeats synchronous subprocess work before input is ready.

Profiles after the guard contain zero DirectSDK CLI calls during startup. Profiles after lazy loading also contain zero DirectSDK CLI calls. Profile timings include instrumentation overhead and are not benchmark medians.

## Measurement method

1. Launch the account's managed Pi executable in a 120×40 pseudo-terminal.
2. Use fullscreen mode without session persistence or approval prompts.
3. Wait until terminal input disables canonical mode and echo.
4. Insert a fixed marker with bracketed paste, without a newline.
5. Measure elapsed time until the marker appears in rendered input.
6. Stop the child without submitting the input.

The benchmark checks that the expected model remains visible and no configuration error appears. It records timings and credential-command counts, not terminal content or credential values. Every measured launch reports zero credential-command calls.

Separate diagnostic launches use a 1ms Node Inspector CPU sampling interval. Subprocess instrumentation records operation, duration, and caller location. It does not record subprocess arguments or output. Profile analysis uses the main Pi process, not a child profile.

## Current validation and limits

The cold-start regression loads the extension through the real Pi CLI with isolated configuration. It verifies zero Claude CLI invocations and no pinned model entries. Catalog tests verify that the event loop responds while discovery is running, cancellation stops a stalled child, and cache-only initialization performs no web requests.

These checks protect the cause of the previous delay. They do not establish a new interactive-readiness benchmark or promise zero extension overhead. No paid model requests are needed. See [testing.md](testing.md) for focused commands.
