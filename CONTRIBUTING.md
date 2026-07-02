# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

Workcell is a human-directed multi-agent platform for development projects: the human is
the board, agents execute, and nothing is *Done* without proof. Contributions are reviewed
with the same discipline the product enforces — small scoped changes, evidence attached.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All tests pass and CI is green
- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

These almost always get merged quickly when they're clean.

### Path 2: Bigger or Impactful Changes

- **First** open a GitHub issue describing what you're trying to solve and your rough
  approach, and wait for maintainer agreement before writing code
- Once there's rough agreement, build it
- In your PR include:
  - Before / After screenshots (or a short video for UI/behavior changes)
  - A clear description of what & why
  - Proof it works (test runs, manual verification notes)
  - All tests passing and CI green
  - The [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully filled out

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## PR Requirements (all PRs)

### Use the PR Template

Every pull request **must** follow the PR template at
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md): summary, linked
issue, scope, **proof (증거)**, risk review, and docs impact. If you create a PR via the
GitHub API or other tooling that bypasses the template, copy its contents into your PR
description manually.

### Proof Is Not Optional

Workcell's own workflow is proof-gated, and so are its PRs. Attach the evidence that your
change works: the test commands you ran and their results, and screenshots for anything
visible. "It should work" is not proof.

### Model Used

If an AI model produced or assisted with the change, say so in the PR (provider + model).
If no AI was used, write "None — human-authored". This applies to all contributors —
human and AI alike.

### Tests Must Pass

All tests must pass before a PR can be merged. Run them locally first (`pnpm typecheck`,
`pnpm test`, and `pnpm test:e2e` when behavior changes) and verify CI is green after
pushing.

## Feature Contributions

We actively manage the core Workcell feature roadmap (see
[`docs/plan/ROADMAP.md`](docs/plan/ROADMAP.md)).

Uncoordinated feature PRs against the core product may be closed, even when the
implementation is thoughtful and high quality. That is about roadmap ownership, product
coherence, and long-term maintenance commitment, not a judgment about the effort.

If you want to contribute a feature:

- Check [`ROADMAP.md`](ROADMAP.md) and [`docs/plan/ROADMAP.md`](docs/plan/ROADMAP.md) first
- Open a GitHub issue to discuss before writing code
- If the idea fits as an extension, prefer building it with the
  [plugin system](doc/plugins/PLUGIN_SPEC.md)
- Reference implementations are welcome as feedback even when they are not merged into core

Bugs, docs improvements, and small targeted improvements are still the easiest path to
getting merged, and we really do appreciate them.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Writing a Good PR Message

Start with a short "thinking path" that walks from the product down to your change. E.g.:

> - Workcell runs development projects with a human board and an AI team
> - Screen-facing issues are design-gated: implementation follows the approved design
> - But the design review panel didn't refresh after a board decision
> - So this PR invalidates the design-artifact query on review-state changes
> - The benefit is the board sees the gate state move without a manual reload

Then include what you did, why it matters, how we can verify it works (the proof), and any
risks. Include before/after screenshots whenever the change is visible.

Questions? Open a GitHub issue or discussion — we're happy to help.

Happy hacking!
