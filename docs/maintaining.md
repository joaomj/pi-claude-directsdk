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

## Watch the upstream tracker

`.github/workflows/upstream-watch.yml` runs daily and appends upstream
[anthropics/claude-code](https://github.com/anthropics/claude-code) issues to a single
`Upstream Claude Code watch` issue. It looks for two kinds of report:

- A literal identifier this transport writes or reads: the billing identity label, the
  `CLAUDE_CODE_*` variables the child receives, `isUsingOverage`, or `unifiedWindows`.
- A report about the SDK, `claude -p`, or headless use that also discusses metering. Reports
  about the desktop app, VS Code, Cowork, and other clients stay out of this group.

Search hits are only a recall step, because GitHub search treats hyphens and underscores as
word breaks. Relevance is decided on the raw issue text. The tracker issue body holds the last
scan date and the numbers already reported, so a rerun never repeats an item, and that issue
doubles as the archive. Deleting the state marker stops the job rather than duplicating the
archive.

The same job reports when the published `@anthropic-ai/claude-code` version leaves
`QUALIFIED_CLI_RANGE`. That is the signal to repeat the verification in [testing.md](testing.md).

Run the workflow manually from the Actions tab to preview a report with `dry_run`. Set
`lookback_days` to widen the window, which applies only while no previous report exists.

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
Review alerts in GitHub's Security tab and update affected dependencies on a maintenance branch.
Review CodeQL and secret-scanning alerts there as well. See the [security policy](../SECURITY.md) for private reports.

Workflow actions are pinned to full commit SHAs. When updating one, verify the upstream release and commit before changing the pin.
Release jobs receive publishing permissions only where needed. Branch CI has read-only repository access.
