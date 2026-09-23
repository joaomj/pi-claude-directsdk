# Pi Claude DirectSDK

Expose Claude as a Pi model provider through the unmodified Claude Code executable.

Pi owns the transcript, system prompt, tools, approvals, tool results, branches, compaction, and retries. Claude Code supplies authentication and acts only as a model transport.

## Scope

- Register an installable TypeScript Pi provider with a `streamSimple` implementation.
- Start one request-scoped `claude` process per Pi model call.
- Replay Pi history in native stream-json form. Pi executes all tools.
- Allow at most one upstream Messages request per Pi model call.
- Support interactive, print, and resumed Pi sessions.

The provider does not execute native tools, manage login, extract credentials, or fall back to another billing route. It fails with an actionable error when `claude` is missing or not logged in.

## Status

The project is in the requirements phase. `PRD.md` defines the outcome, boundaries, and verification gates. No installable provider exists yet.

## Acknowledgments

Inspired by [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk).

## Documentation

- `PRD.md` — product requirements, scope, and verification gates.
