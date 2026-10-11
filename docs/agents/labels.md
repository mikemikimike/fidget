# Labels

Every label on `omesser/fidget`, and when it goes on an issue or a pull request.
`gh label list` is the tracker. This file is the rule. A label added or removed
on GitHub is updated here in the same change.

`docs/agents/triage-labels.md` holds what the five triage names mean.
`docs/agents/picking-work.md` holds what the four priority names mean, and the
order an agent picks in.

## Apply them

When you create an issue, open a pull request, or take one over:

1. Read the rows. Apply each row that matches the work. The section says
   whether that row goes on an issue, a pull request, or both. `gh issue
   edit <n> --add-label` on an issue, `gh pr edit <n> --add-label` on a pull
   request.
2. An issue carries exactly one of `p0`, `p1`, `p2`, `p3`.
3. Carry the issue's area and platform labels onto the pull request that
   closes it, then add any row the diff matches that the issue lacked. The
   pull request's labels are those area and platform rows.
4. Use a name from this file. A skill that names a label not listed here,
   such as `wayfinder:map`, still uses that name. Add the row when you create
   a label, and create one only when the user asks.

Done when every matching row is on the item. On a pull request, that set is
the area and platform rows: no triage label, no priority label, and no
`Done-when`.

## Triage

Issues only. `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, and `wontfix`. What each one means is
`docs/agents/triage-labels.md`.

## Priority

Issues only. Exactly one of `p0`, `p1`, `p2`, `p3`. What each one means, and
the order, is `docs/agents/picking-work.md`.

## Platform

Issues and pull requests. Add each platform the work has to be verified on.
Work that behaves the same on every platform gets no platform label for that
reason.

| Label | Apply it when |
|---|---|
| `macos` | The work is macOS-specific. |
| `linux` | The work is the Linux lane: X11, GTK, portals, packaging. |
| `windows` | The work is Windows-specific, or a pull request needs the Windows test steps. |

On a pull request, `windows` is a CI switch, separate from the platform claim.
The Windows job in `.github/workflows/tests.yml` already runs, and its Clippy
step always runs. The label forces that job's `cargo test` steps when the
diff is outside the job's path list. The tracker's own description calls this
the Windows compile job. Add the label for a `windows` issue's pull request,
and for a pull request whose Windows behavior that path list would skip.

## Area

Issues and pull requests. Several may match. A `fix` is `bug`, a `feat` is
`enhancement`, a documentation change is `documentation`, a `refactor` is
`refactoring`, and a `perf` change is `performance`. A pull request whose
product is the test takes `testing`. Tests that ship inside a behavior change
take that behavior's label. A `build` or `ci` change takes `maintenance` when
it is dependency or tooling upkeep. A `chore` or `revert` takes whichever area
row the change matches.

| Label | Apply it when |
|---|---|
| `bug` | Something that already ships misbehaves. |
| `enhancement` | A new capability. |
| `documentation` | Improvements or additions to documentation. |
| `docs` | The same meaning, with an empty tracker description, already on older items. New work takes `documentation` and leaves this off. |
| `testing` | Tests and verification scenarios. |
| `refactoring` | Structure changes, behavior stays. |
| `performance` | CPU, GPU, memory, idle cost, or a benchmark. |
| `maintenance` | Dependency and tooling upkeep, including a dependency bump. |
| `harness` | The Harness the user supplies: launch, ACP, permissions, its tools. |
| `prompting` | What a prompt contains and how it is shaped. |
| `local models` | Local model inference. |
| `security` | Security: secrets, passwords, the keychain, and the rest of that work. |
| `research` | Defining or carrying out an investigation. |
| `accessibility` | A barrier for people with disabilities. |
| `umbrella` | A parent issue that points at the child issues or pull requests. The parent only. |

## Ask, close, and invite

| Label | Surface | Apply it when |
|---|---|---|
| `question` | Issue | Further information is requested. The triage wait on the reporter is `needs-info`, and this label can sit beside it. |
| `duplicate` | Issue or pull request | You close it because another item already tracks the work. Name the survivor in the close comment. |
| `invalid` | Issue or pull request | You close it because it does not describe a real defect or change. |
| `good first issue` | Issue | The work is a good first change for a newcomer. |
| `help wanted` | Issue | The work needs extra attention. |
| `Done-when` | Neither | The label has no description and no items. Leave it off. |
