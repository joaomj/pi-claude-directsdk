# Verification through the installed Pi

The repository has no isolated test suite, mocked provider runtime, or fake upstream. The harness runs the operator’s installed `pi` executable with real settings, credentials, tools, and extensions. It uses a private copy of the user’s configuration and replaces only the DirectSDK extension source with the local checkout. This prevents the installed package from overwriting the local code during extension loading.

## Requirements

- Python 3 and the user’s installed Pi on `PATH`.
- Claude Code installed and authenticated for paid scenarios.
- A discovered model in the user’s Pi configuration or verified model snapshot.

Use `--pi /absolute/path/to/pi` or `PI_VERIFY_PI` to select another installed executable. The harness excludes repository `node_modules` directories from automatic executable lookup.

## Scenarios

### Offline startup

```sh
npm test
```

Equivalent command:

```sh
python3 scripts/verify.py startup
```

The harness runs offline model listing through the installed Pi. It checks the process result and verifies that no Claude child starts. This is not an interactive editor-readiness benchmark.

### Fresh model request

```sh
python3 scripts/verify.py fresh --paid
```

The harness starts a real Pi session and requests a short greeting from Haiku 5.5. It requires a successful terminal response, nonempty visible text, and output usage. It does not require exact model wording. Pi can exit successfully after a model error.

### Complete existing-session replay

```sh
python3 scripts/verify.py session --paid --session /absolute/path/to/session.jsonl
```

The harness copies every session entry into a private temporary snapshot. Pi forks that snapshot and submits the verification prompt. It does not filter errors, replace tools, remove thinking, shorten history, or write to the original session. The user’s working directory, credential values, tool inventory, and other extensions remain in effect. Configuration and credentials are copied privately, not written back.

This is the primary regression check for provider switching and accumulated session history. A fresh request passing does not establish that an existing session works.

## Options and safety

- `--model provider/model` selects the model. The default is `claude-directsdk/claude-haiku-5-5`.
- `--extension PATH` selects the extension. The default is this checkout’s entry point.
- `--timeout SECONDS` bounds the scenario. The default is 120 seconds.
- `--paid` explicitly approves real model requests. Without it, paid scenarios refuse to run.

Run from the same project directory as the original session. Existing tool permissions and extension behavior still apply. The verification prompt asks the model not to call tools, but the harness does not replace the user’s tool inventory.

Private artifacts go to `/tmp/pi-directsdk-verify-*`. The harness removes copied configuration, credentials, input snapshots, and Pi-generated test sessions after the run. It retains summaries and bounded native error diagnostics. It does not save model responses, credentials, or successful native transcript records. Native errors can quote input fragments; inspect the diagnostics before sharing them.

The observer records real Claude process starts, replay acknowledgments, terminal result errors, and exits. It does not substitute native responses or alter the provider request. Automatic Pi retries, if enabled in the user’s settings, can consume additional allowance.

## Build checks and CI

```sh
npm run check
npm run build
```

These commands check types and compilation, not runtime behavior. Release CI runs only those checks. Runtime verification stays local because CI is not the user’s Pi installation and has no approved subscription credentials.

The harness does not yet exercise an in-process `/reload`, cancellation, or an explicit tool round trip. Do not claim those behaviors are verified by these scenarios.
