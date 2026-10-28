# Contributing

Bug reports, questions, and feature requests are welcome through [issues](https://github.com/joaomj/pi-claude-directsdk/issues/new/choose).
This project does not accept unsolicited public pull requests. The repository owner maintains the implementation.

## Before opening an issue

1. Search existing issues for the same problem or request.
2. Read the [troubleshooting guide](docs/troubleshooting.md) and check the supported versions in the [README](README.md#requirements).
3. Select the bug report, feature request, or help form.
4. Include a minimal example and the relevant versions when reporting a bug.

Do not share credentials, authentication files, tokens, private prompts, or unredacted conversation traces.
Share only the relevant error excerpt after removing sensitive information.
Do not run paid verification scenarios just to file an issue.

Report suspected vulnerabilities through [private security reporting](https://github.com/joaomj/pi-claude-directsdk/security/advisories/new).
See [SECURITY.md](SECURITY.md) for scope and reporting guidance.

## Issue handling

New issues receive a type label, `needs-triage`, and an assignment to the maintainer.
The label, not the assignment, shows triage state.
The maintainer uses `needs-info` when a report needs more information and `confirmed` for a verified problem.

Only issues labeled `needs-info` are eligible for inactivity cleanup.
After 30 inactive days, automation posts a reminder. After another 14 inactive days, it closes the issue.
Confirmed issues and issues assigned to a milestone are exempt. Pull requests are not subject to this cleanup.
A response before closure resets the inactivity timer.

Closed issues are automatically locked, including issues closed by cleanup.
To request reopening, open a new help issue, link the closed issue, and provide the missing information or explain why it needs reopening.
Reopening does not automatically unlock the discussion; the maintainer must unlock it manually.

Feature requests and confirmed bugs are not closed merely because implementation has not started.
