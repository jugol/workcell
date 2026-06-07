/**
 * esbuild configuration for building the workcell CLI for npm.
 *
 * Bundles all workspace packages (@workcell/*) into a single file.
 * External npm packages remain as regular dependencies.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Workspace packages whose code should be bundled into the CLI.
// Note: "server" is excluded — it's published separately and resolved at runtime.
const workspacePaths = [
  "cli",
  "packages/db",
  "packages/shared",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
];

// Workspace packages that should NOT be bundled — they'll be published
// to npm and resolved at runtime (e.g. @workcell/server uses dynamic import).
const externalWorkspacePackages = new Set([
  "@workcell/server",
]);

// Collect all external (non-workspace) npm package names.
//
// Seed it with optional, runtime-only deps that are loaded via dynamic import
// (Open Design headless capture in commands/client/design.ts) and are
// deliberately absent from every package.json `dependencies`. Because the loop
// below derives externals from declared dependencies, these would otherwise be
// pulled into the bundle — and esbuild would then try to resolve playwright's
// chromium-bidi peer, which isn't installed in a normal CLI install, breaking
// the build. Keeping them external leaves the dynamic import as a runtime
// require that degrades gracefully when Playwright isn't present.
const externals = new Set([
  "@playwright/test",
  "playwright",
  "playwright-core",
]);
for (const p of workspacePaths) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, p, "package.json"), "utf8"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (externalWorkspacePackages.has(name)) {
      externals.add(name);
    } else if (!name.startsWith("@workcell/")) {
      externals.add(name);
    }
  }
  for (const name of Object.keys(pkg.optionalDependencies || {})) {
    externals.add(name);
  }
}
// Also add all published workspace packages as external
for (const name of externalWorkspacePackages) {
  externals.add(name);
}

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  banner: { js: "#!/usr/bin/env node" },
  external: [...externals].sort(),
  treeShaking: true,
  sourcemap: true,
};
