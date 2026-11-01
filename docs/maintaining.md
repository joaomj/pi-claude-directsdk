# Maintaining the repository

## Triage issues

Use these issue searches:

- New reports: `is:issue is:open label:needs-triage`
- Waiting for a reporter: `is:issue is:open label:needs-info`
- Verified bugs: `is:issue is:open label:bug label:confirmed`

Remove `needs-triage` after reviewing an issue. Use `needs-info` only when specific information is missing.
Remove `needs-info` and `awaiting-response` when the requested information arrives. Use `confirmed` for verified problems.
Link duplicates to the existing issue before closing them.

New issues and pull requests are assigned to the maintainer by
`.github/workflows/auto-assign.yml`. Assignment is therefore a notification, not a claim of
ownership; the labels carry triage state.

The daily cleanup workflow only handles `needs-info` issues. It reminds after 30 inactive days and closes after another 14.
Confirmed issues and milestone issues are exempt. The workflow does not clean up pull requests.

Closing an issue automatically locks its discussion. Cleanup also locks the issues it closes.
Existing closed issues are not backfilled. To continue a discussion after reopening an issue, manually unlock it in GitHub.
Reporters can request reopening through a new help issue that links the closed issue.
See [contribution guidance](../CONTRIBUTING.md) for the reporter-facing policy.

Public contributions are issue-only. If an unsolicited pull request arrives, explain that policy and close it.
Maintainer pull requests remain available for branch review and CI.

## Watch the upstream SDK and CLI

The transport reads SDK message shapes, SDK options, and the `system/init` and
`result` frames of Claude Code. Two dependencies therefore need a deliberate
update instead of a floating range:

- `@anthropic-ai/claude-agent-sdk` is pinned to an exact version in `package.json`.
- `@modelcontextprotocol/sdk` is pinned to the version whose handler signatures
  the transport satisfies.

Before you raise either pin, read the upstream changelog for changes to options,
message types, or the MCP server API, then run:

```sh
npm run check
npm test
npm run smoke      # two real model calls on the maintainer login
npm run measure cancellation   # token, cache, and process accounting
```

`npm run smoke` is the check that catches a breaking frame change: it fails when
the tool call does not come back to Pi or the session does not continue.
`npm run measure cancellation` is the check that catches a lifecycle change: it
fails when a cancelled turn is not `aborted`, when a parked session does not
close, or when a `claude` process survives. Also repeat the two-tool Pi run in
[testing.md](testing.md#full-pi-run) after a Claude Code update, because the CLI,
not the SDK alone, produces the frames. Record the before and after values in the
commit message when a measured number moves.

The former `upstream-watch.yml` workflow and its CLI range check were removed
with the direct-CLI transport. Watching upstream issues for identifier changes
is still useful, but it no longer gates a version range.

## Develop on branches

Push work to a branch. CI checks types and compilation on branch pushes and pull requests targeting `main`.
These checks do not exercise the installed Pi runtime or make paid model requests.
Use the [verification guidance](testing.md) for local runtime checks.

Merge your maintenance branch into `main` when the changes are ready for a release.
Merging does not publish a package or generate release notes. Only pushing a `v*` tag starts the release workflow.

## Release

1. Update `package.json` and `package-lock.json` to the chosen version on your branch.
2. Complete the relevant local verification and review the branch CI results.
3. Merge the branch into `main` and confirm its CI checks pass.
4. Tag the release commit with `v` followed by the package version and push that tag.
5. Confirm that the Release workflow passed. It stages the npm package and creates a draft GitHub Release with generated notes.
6. Approve the staged package on npm using the configured maintainer approval process.
7. Automation publishes the draft GitHub Release after confirming the exact package version is available on npm.

The publication workflow checks after a successful Release workflow and every 15 minutes.
GitHub can delay scheduled runs. You can also run `Publish available GitHub releases` manually from the Actions tab.
It only publishes version-tagged drafts created by GitHub Actions; it does not rewrite their generated notes.
If you want to review the notes, do so before approving the staged npm package.

Do not move or reuse a published release tag. Investigate a failed workflow before rerunning it; package staging is a remote mutation.
Release tags are protected against creation, movement, and deletion except by repository administrators.
Generated notes remain part of releases only; there is no per-commit changelog automation.

## Security and dependencies

Dependabot vulnerability alerts remain enabled. Automatic security-update and version-update pull requests are disabled.
The Agent SDK and MCP dependencies are pinned exactly and updated by hand, because their message shapes are part of this transport's contract.
Review alerts in GitHub's Security tab and update affected dependencies on a maintenance branch.
Review CodeQL and secret-scanning alerts there as well. See the [security policy](../SECURITY.md) for private reports.

Workflow actions are pinned to full commit SHAs. When updating one, verify the upstream release and commit before changing the pin.
Release jobs receive publishing permissions only where needed. Branch CI has read-only repository access.
