# Labels

Every label on `omesser/fidget`, and when it goes on an issue or a pull request.
`gh label list` is the tracker. This file is the rule. A label added or removed
on GitHub is updated here in the same change.

`docs/agents/triage-labels.md` maps the five skill role names onto the triage
rows. `docs/agents/picking-work.md` uses the priority order when it picks.

## Apply them

When you create an issue, open a pull request, or take one over:

1. Read the rows. Apply each row that matches the work. The section says
   whether that row goes on an issue, a pull request, or both. `gh issue
   edit <n> --add-label` on an issue, `gh pr edit <n> --add-label` on a pull
   request.
2. An issue carries exactly one of `p0`, `p1`, `p2`, `p3`. A pull request
   carries none of them.
3. Carry the issue's area and platform labels onto the pull request that
   closes it, then add any row the diff matches that the issue lacked.
4. Triage labels stay on issues. A pull request does not take `needs-triage`,
   `needs-info`, `ready-for-agent`, `ready-for-human`, or `wontfix`.
5. Use a name from this file. Create a label only when the user asks for a new
   one, and add its row in the same change.

Done when every matching row is on the item, a pull request has no triage
label and no priority label, and `Done-when` is absent.

## Triage

Issues only. The skill role and the label string are the same name.

| Label | Apply it when |
|---|---|
| `needs-triage` | A maintainer still has to decide what the issue is. |
| `needs-info` | The tracker is waiting on the reporter. |
| `ready-for-agent` | The issue is fully specified and an agent can take it. |
| `ready-for-human` | The work needs a person to implement it. |
| `wontfix` | It will not be actioned. Close it in the same step. |

## Priority

Issues only. Exactly one of `p0`, `p1`, `p2`, `p3`. The words and the order
are in `docs/agents/picking-work.md`. `p1` is the default for scoped work.
`p0` is for work that is broken for users or blocking. `p3` is for work the
user says waits past `p2`. A pull request carries none of these.

## Platform

Issues and pull requests. Add each platform the work has to be verified on. A
change that is the same on every platform gets none of these.

| Label | Apply it when |
|---|---|
| `macos` | The work is macOS-specific. |
| `linux` | The work is the Linux lane: X11, GTK, portals, packaging. |
| `windows` | The work is Windows-specific, or the pull request must run the Windows test job. |

On a pull request, `windows` forces the Windows test job in
`.github/workflows/tests.yml` when the diff is outside that job's path list.
Clippy on that job already runs. Add it when the pull request fixes a
`windows` issue, or changes Windows behavior that path list would skip.

## Area

Issues and pull requests. Several may match. Prefer the commit type's word
where one exists: a `fix` is `bug`, a `feat` is `enhancement`, a `docs` change
is `docs`, a `test` change is `testing`, a `refactor` is `refactoring`, a
`perf` change is `performance`.

| Label | Apply it when |
|---|---|
| `bug` | Something that already ships misbehaves. |
| `enhancement` | A new capability. |
| `docs` | The product of the change is documentation. |
| `documentation` | GitHub's default for the same meaning. Already on older items. New work takes `docs` and leaves this off. |
| `testing` | Tests and verification scenarios. |
| `refactoring` | Structure changes, behavior stays. |
| `performance` | CPU, GPU, memory, idle cost, or a benchmark. |
| `maintenance` | Dependency and tooling upkeep, including a dependency bump. |
| `harness` | The Harness the user supplies: launch, ACP, permissions, its tools. |
| `prompting` | What a prompt contains and how it is shaped. |
| `local models` | Local model inference. |
| `security` | Secrets, passwords, or the keychain. |
| `research` | Defining or carrying out an investigation. |
| `accessibility` | A barrier for people with disabilities. |
| `umbrella` | A parent issue that points at the child issues or pull requests. The parent only. |

## Ask, close, and invite

| Label | Surface | Apply it when |
|---|---|---|
| `question` | Issue | The issue is itself a question. Waiting on the reporter is `needs-info`, not this label. |
| `duplicate` | Issue or pull request | You close it because another item already tracks the work. Name the survivor in the close comment. |
| `invalid` | Issue or pull request | You close it because it does not describe a real defect or change. |
| `good first issue` | Issue | The user asked to invite a newcomer. |
| `help wanted` | Issue | The user asked for outside help. |
| `Done-when` | Neither | The label has no description and no items. An acceptance section is prose in the issue body. Leave this label off. |
