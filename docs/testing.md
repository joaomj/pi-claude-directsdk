# Testing

## Default suite

```sh
npm test
```

`npm test` builds the project (`tsc -p tsconfig.build.json`) and runs `node --test` over `.build/tests/**/*.test.js`. It runs offline checks only, including the one-shot child-lifetime check. It consumes no subscription allowance.

Coverage by default:

- `provider-list.test.ts` (E2E-01): loads the extension through the real `pi` binary and lists the pinned catalog. Proves provider registration and catalog wiring.
- `missing-cli.test.ts` (E2E-02): runs `streamSimple` with an empty `PATH` and asserts the install hint. Proves the missing-CLI failure path.
- `process-lifetime.test.ts`: runs outside the test runner and asserts the caller receives the child final exit status after its output streams close.

## Opt-in suites

These suites never run by default. Each is gated by an environment variable.

### Loopback pipeline (no cost)

```sh
PI_DIRECTSDK_CLI=/path/to/claude npm test
```

`fake-upstream.test.ts` (E2E-03) runs the full pipeline against the real CLI with a loopback synthetic Anthropic Messages endpoint and fixture credentials in an isolated environment. It asserts:

1. A grammar tool uses JSON-schema fallback and returns a usable tool call.
2. Exactly one upstream `POST /v1/messages` is admitted per Pi call.
3. Required strict decoding fails before contacting upstream.

A second case holds the upstream open, aborts mid-flight, and asserts the call terminates as `aborted` instead of hanging. No traffic leaves loopback. No subscription allowance is consumed.

### Gateway suites (paid)

```sh
PI_DIRECTSDK_GATEWAY=1 PI_DIRECTSDK_CLI=/path/to/claude npm test
```

`gateway.test.ts` (E2E-04) points the real CLI at OpenRouter with an isolated home directory and asserts a text prompt returns terminal `done` with real text and nonzero usage, and a forced tool call publishes valid JSON arguments with a `toolUse` stop reason.

`multi-turn.test.ts` (E2E-05) replays a completed script-writing turn and asserts the follow-up turn ends `done` / `toolUse` with a `.py` tool call that uses the `secrets` module over the 1-1000 range. This shape caught the missing `shouldQuery: false` bug that single-turn tests cannot see.

Gateway runs require `OPENROUTER_API_KEY` in the environment. The key is never logged or written by the tests. Gateway results prove protocol behavior only, never subscription behavior. Cost is pay-as-you-go per call. These suites never run in CI.

## Focused regression checks

```sh
npm run build
PI_DIRECTSDK_CLI="$(command -v claude)" node --test \
  --test-name-pattern='grammar tool|one-shot supervision' \
  .build/tests/e2e/fake-upstream.test.js \
  .build/tests/e2e/process-lifetime.test.js
```

The grammar check uses the real CLI with fixture credentials and a loopback upstream. It verifies JSON-schema fallback, tool-call delivery, single-request admission, and rejection of required strict decoding before an upstream call. The lifetime check runs in a separate process. It verifies that the caller receives the child final exit status after its output streams close. Neither check consumes subscription allowance.

## Qualification status

Qualified: offline e2e, loopback pipeline against CLI 2.1.281, gateway runs against Opus 5.5, and live subscription runs (text, Pi-side tool execution, cancel cleanup, ~92% follow-up cache reads, 5-round tool chaining, session resume).

Re-run the fake-upstream gate before widening `QUALIFIED_CLI_RANGE` in `src/models.ts`.
