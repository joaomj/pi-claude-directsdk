# Startup

DirectSDK uses the pinned catalog during cache-only initialization. It does not run Claude CLI probes in that phase. The request transport loads on the first Claude request. Pi and the Claude executable remain unmodified.

## Behavior

- When `RefreshModelsContext.allowNetwork` is false, `refreshModels` returns `MODELS` immediately.
- When live refresh is allowed, `refreshModels` loads `src/setup.ts` and checks cancellation before discovery.
- Live discovery can still wait for CLI authentication status, version, and picker initialization. These probes make no Messages request.
- `streamSimple` uses the local `src/lazy-stream.ts` wrapper through Pi's compatibility API. It loads `src/stream.ts` asynchronously and preserves the transcript and request options.
- Module-load failures are reported as errors. Discovery failures keep the pinned catalog.

The change does not add credential caching or alter CLI-managed authentication. It does not change model routes, aliases, context windows, or prices. The catalog contains seven canonical models and five aliases, including Opus 5.5. Removing entries would not avoid the CLI probes that caused the main delay.

## Package resolution

The local lazy-stream wrapper imports `@earendil-works/pi-ai/compat`, which Pi resolves for extensions. It does not import `@earendil-works/pi-ai/api/lazy`. That subpath failed to resolve in a managed Pi 1.1.0 installation with no local peer package. The wrapper preserves deferred transport loading and reports setup failures as stream errors. No machine-specific package symlink is required.

## Haiku 5.5

Use the explicit route `claude-directsdk/claude-haiku-5-5`. The catalog entry sets a conservative 200,000-token context limit and a 10,000-token output limit. These are configured caps, not a claim about the model's maximum capacity. The existing `haiku` alias still selects Haiku 4.5.

Cost metadata follows [Anthropic's announcement](https://www.anthropic.com/claude-haiku-5-5). Requests above 100,000 input tokens use the higher published rate for the full request. Account entitlement and live transport behavior require separate verification.

## Startup measurements

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

## Validation and limits

The offline listing regression fails before the guard and passes afterward. It verifies Opus 5.5, existing aliases, and zero CLI invocations. Missing-CLI and loopback checks exercise the registered provider's lazy `streamSimple`. Loopback checks cover text, tool delivery, single-request admission, strict-decoding rejection, and mid-flight cancellation. Managed Pi 1.1.0 also reaches the expected missing-CLI error through the lazy transport.

No paid model requests are used. The first Claude request now pays the deferred module-load cost. Its real-world latency is not measured. The change does not promise faster model responses or eliminate explicit live-refresh waits. See [testing.md](testing.md) for validation commands and [architecture.md](architecture.md) for the request lifecycle.
