# @workcell/create-workcell-plugin

Scaffolding tool for creating new Workcell plugins.

```bash
npx @workcell/create-workcell-plugin my-plugin
```

Or with options:

```bash
npx @workcell/create-workcell-plugin @acme/my-plugin \
  --template connector \
  --category connector \
  --display-name "Acme Connector" \
  --description "Syncs Acme data into Workcell" \
  --author "Acme Inc"
```

Supported templates: `default`, `connector`, `workspace`  
Supported categories: `connector`, `workspace`, `automation`, `ui`

Generates:
- typed manifest + worker entrypoint
- example UI widget using the supported `@workcell/plugin-sdk/ui` hooks
- test file using `@workcell/plugin-sdk/testing`
- `esbuild` and `rollup` config files using SDK bundler presets
- dev server script for hot-reload (`workcell-plugin-dev-server`)

The scaffold starts with plain React elements so the generated plugin stays minimal. For Workcell-native controls, import shared host components such as `MarkdownEditor`, `FileTree`, `AssigneePicker`, and `ProjectPicker` from `@workcell/plugin-sdk/ui`.

Inside this repo, the generated package uses `@workcell/plugin-sdk` via `workspace:*`.

Outside this repo, the scaffold snapshots `@workcell/plugin-sdk` from your local Workcell checkout into a `.workcell-sdk/` tarball and points the generated package at that local file by default. You can override the SDK source explicitly:

```bash
node packages/plugins/create-workcell-plugin/dist/index.js @acme/my-plugin \
  --output /absolute/path/to/plugins \
  --sdk-path /absolute/path/to/workcell/packages/plugins/sdk
```

That gives you an outside-repo local development path before the SDK is published to npm.

## Workflow after scaffolding

```bash
cd my-plugin
pnpm install
pnpm dev       # watch worker + manifest + ui bundles
pnpm dev:ui    # local UI preview server with hot-reload events
pnpm test
```
