# @workcell/plugin-open-design-dashboard (Scaffold)

First-slice scaffold for the **Open Design Dashboard** (PLAN §9 #4 /
D13). Adds a `/design` page slot to a host Workcell instance where future
slices will mount artifact lists, version diff views, and a sandbox
iframe preview launcher.

This scaffold lands the plugin shape only. The actual Open Design
integration — outbound MCP client, artifact sync via
`issue_work_products`, current/deprecated version chips — ships in
subsequent slices.

## Status

| Capability | Status |
|---|---|
| Plugin manifest + worker setup | ✅ |
| `/design` page placeholder (renders empty state with copy explaining the surface) | ✅ |
| Artifact list (driven by issue_work_products / assets) | 🔲 future slice |
| Version diff (current/deprecated) | 🔲 future slice |
| Sandbox iframe preview launcher | 🔲 future slice |
| Outbound MCP client (Open Design bridge) | 🔲 future slice |

## Install (local development)

```
cd packages/plugins/examples/plugin-open-design-dashboard
pnpm install
pnpm build
workcell plugin install $(pwd)
```

## Layout

- `src/manifest.ts` — declares the `design-dashboard-page` slot with
  `routePath: "design"`.
- `src/worker.ts` — no-op worker (scaffold-only; future slices add the
  artifact sync handlers here).
- `src/ui/index.tsx` — placeholder Design page.
- `src/index.ts` — public re-exports for host pickup.
