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

The provider is implemented and qualified end to end against Claude Code
2.1.281 (qualified range `>=2.1.263 <2.2.0`, see `QUALIFIED_CLI_RANGE` in
`src/models.ts`). The e2e suite proves extension loading, the install hint,
and the full pipeline against a loopback fixture with one admitted upstream
request per call.

## Acknowledgments

Inspired by [Hermes Claude Subscription DirectSDK](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk).

## Documentation

- `PRD.md` — product requirements, scope, and verification gates.
- `PLAN.md` — implementation phases and component map.

## Tests

- `npm test` — offline e2e tests (extension load, missing-CLI hint). Safe for CI.
- `PI_DIRECTSDK_CLI=/path/to/claude npm test` — also runs the fake-upstream
  pipeline and abort tests against the real CLI. Loopback only, no cost.

List-price cost metadata is an estimate, not a subscription charge.
