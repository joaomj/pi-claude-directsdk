# Startup

DirectSDK registers synchronously with an empty catalog. The extension factory starts no processes, sockets, timers, or web requests. The streaming API is registered independently of the catalog, so an empty catalog does not disable dispatch. The request transport remains lazy.

## Catalog initialization

- Cache-only refresh restores a previously verified snapshot from Pi’s model store. It runs no CLI probes or web requests.
- Restored entries are labeled `last verified snapshot`. A fresh offline install has no DirectSDK models.
- Interactive Pi starts live refresh after the editor is ready. DirectSDK uses this lifecycle, not an extension startup hook.
- Live refresh loads discovery modules asynchronously. It uses a supervised child for the Claude Code picker and asynchronous requests for public Anthropic documentation.
- Refresh has a 12-second deadline and honors Pi’s abort signal. Documents have a 2 MiB limit. At most four model pages load concurrently.
- Successful refresh persists verified metadata. Repeated refreshes reuse it for 15 minutes unless forced.
- Missing metadata excludes the affected model with a warning. A refresh failure reports the error and deletes the snapshot. There is no pinned fallback.

On a fresh installation, run `pi update --models` before selecting DirectSDK from the command line. Alternatively, start interactive Pi and open `/model` to refresh.

## Lazy loading

The stream wrapper imports `@earendil-works/pi-ai/compat`, which Pi resolves for extensions. It does not import the incompatible `@earendil-works/pi-ai/api/lazy` subpath. Discovery and transport modules stay outside the extension load path.

## Verification

The installed-Pi harness checks offline model listing and verifies that no Claude child starts. Paid scenarios verify fresh requests and complete-session forks through the user’s real Pi executable.

Offline listing is not an interactive editor-readiness benchmark. The harness does not promise zero extension overhead. See [testing.md](testing.md).
