# Roadmap

Workcell's active, always-current roadmap lives in
[`docs/plan/ROADMAP.md`](docs/plan/ROADMAP.md), governed by
[`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) (the product specification) and
[`docs/plan/DECISIONS.md`](docs/plan/DECISIONS.md) (the decision log). This file is only a
directional summary.

## Direction

Workcell is a multi-agent operations platform **specialized for development projects**:
a human board, an AI team (Orchestrator · Developer · Designer · QA), the design system as
the source of truth, and proof-gated Done. Everything on the roadmap serves that loop.

- **Deepen the design-first loop.** Richer Open Design integration: design artifact
  pipelines, versioned diffs, annotation, and design-system extraction that agents build
  against by default.
- **Make the Knowledge Graph ambient.** Graphify-fed code graphs and the issue/decision
  graph injected into agent context, so agents navigate the project instead of
  rediscovering it every run.
- **Harden the recommended-team experience.** From one-click seat hires toward full team
  presets, role-aware routing improvements, and better orchestrator delegation telemetry.
- **Keep proof honest.** Stronger proof bundles, QA tooling, and compound-learning
  follow-ups that turn every finished issue into durable knowledge.
- **Stay local-first.** A single process with embedded Postgres remains a first-class way
  to run Workcell; production deployments point at their own infrastructure.

The list above is directional, not promised — priorities shift as we learn from running
real development projects with the product.

## Contributing to roadmap-level work

See [`CONTRIBUTING.md`](CONTRIBUTING.md): open a GitHub issue first for anything
roadmap-shaped. Bugs, docs, polish, and tightly scoped improvements are always welcome,
and the [plugin system](doc/plugins/PLUGIN_SPEC.md) is the best path for optional
capabilities that don't need to live in core.
