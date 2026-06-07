# Plugin Authoring Smoke Example

A Workcell plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into Workcell

```bash
pnpm workcell plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@workcell/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
