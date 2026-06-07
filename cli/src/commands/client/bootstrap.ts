import { Command } from "commander";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

// WC-48 (PLAN §9 #1): client-side repo scanner.
//
// Reads a local repo path, extracts whatever signals are practically
// available without dragging in heavy dependencies (README.md + package.json),
// and POSTs a bootstrap spec to /companies/:id/bootstrap/ingest (the
// WC-41 endpoint).
//
// Future iterations can extend the signal set — language detection via
// file extensions, .github/workflows scan, contributor counts from
// `git shortlog`, etc. The current ingest endpoint is open-enum on the
// spec body, so future scanners can attach richer fields without
// breaking server compatibility.

interface BootstrapFromRepoOptions extends BaseClientOptions {
  companyId?: string;
  path: string;
  projectName?: string;
  dryRun?: boolean;
}

interface ScannedRepo {
  projectName: string;
  description: string | null;
  suggestedIssues: Array<{ title: string; description?: string; priority?: string }>;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function extractTitleFromReadme(readme: string | null): string | null {
  if (!readme) return null;
  for (const line of readme.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) return trimmed.slice(2).trim();
  }
  return null;
}

export function extractDescriptionFromReadme(readme: string | null): string | null {
  if (!readme) return null;
  const lines = readme.split(/\r?\n/);
  // Take the first non-empty, non-heading paragraph.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith("```")) continue;
    // Collect until the next blank line.
    const out: string[] = [line];
    for (let j = i + 1; j < lines.length && lines[j].trim().length > 0; j++) {
      if (lines[j].trim().startsWith("#")) break;
      out.push(lines[j].trim());
    }
    return out.join(" ").slice(0, 800);
  }
  return null;
}

export function extractTodosFromReadme(readme: string | null): Array<{ title: string }> {
  if (!readme) return [];
  const out: Array<{ title: string }> = [];
  const lines = readme.split(/\r?\n/);
  let inTodoSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    // WC-114: match any heading depth (H1–H6). The old `##?` only matched H1/H2,
    // so an H3+ subsection neither opened a TODO/Roadmap section nor closed one —
    // bullets under a later `### Subsection` following a `## TODO` were wrongly
    // captured as suggested issues.
    if (/^#{1,6}\s+todo\b/i.test(line) || /^#{1,6}\s+roadmap\b/i.test(line)) {
      inTodoSection = true;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      inTodoSection = false;
      continue;
    }
    if (!inTodoSection) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      const title = bullet[1].replace(/^\[\s*[xX]?\s*\]\s*/, "").trim();
      if (title.length > 0 && title.length <= 200) out.push({ title });
    }
  }
  return out;
}

export async function scanRepo(repoPath: string, projectNameOverride?: string): Promise<ScannedRepo> {
  const absRoot = path.resolve(repoPath);
  const readme =
    (await readIfExists(path.join(absRoot, "README.md"))) ??
    (await readIfExists(path.join(absRoot, "readme.md"))) ??
    (await readIfExists(path.join(absRoot, "README"))) ??
    null;
  let pkg: Record<string, unknown> | null = null;
  try {
    const pkgText = await readIfExists(path.join(absRoot, "package.json"));
    if (pkgText) pkg = JSON.parse(pkgText);
  } catch {
    pkg = null;
  }

  const projectName =
    projectNameOverride?.trim() ||
    (typeof pkg?.name === "string" ? pkg.name : null) ||
    extractTitleFromReadme(readme) ||
    path.basename(absRoot);
  const description =
    (typeof pkg?.description === "string" ? pkg.description : null) ??
    extractDescriptionFromReadme(readme) ??
    null;
  const todos = extractTodosFromReadme(readme);

  return {
    projectName,
    description,
    suggestedIssues: todos,
  };
}

async function bootstrapFromRepoCommand(opts: BootstrapFromRepoOptions) {
  try {
    const ctx = resolveCommandContext(opts);
    const companyId = opts.companyId ?? ctx.companyId;
    if (!companyId) {
      console.error(pc.red("companyId is required (pass --company-id or set a default context)"));
      process.exit(1);
    }
    const scanned = await scanRepo(opts.path, opts.projectName);
    const payload = {
      project: { name: scanned.projectName, description: scanned.description },
      issues: scanned.suggestedIssues,
    };
    if (opts.dryRun) {
      console.log(pc.cyan("Dry run — would POST the following payload:"));
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    const body = await ctx.api.post<{ project: { name: string }; issues: unknown[] }>(
      `/companies/${companyId}/bootstrap/ingest`,
      payload,
    );
    console.log(
      pc.green(
        `Bootstrapped project ${body?.project?.name ?? scanned.projectName} with ${
          body?.issues?.length ?? 0
        } issues.`,
      ),
    );
  } catch (err) {
    handleCommandError(err);
  }
}

export function registerBootstrapCommands(program: Command): void {
  const bootstrap = program
    .command("bootstrap")
    .description("Bootstrap projects from external sources (e.g. existing repos)");
  addCommonClientOptions(
    bootstrap
      .command("from-repo")
      .description("Scan a local repo path and ingest project + issues into Workcell")
      .requiredOption("--path <path>", "Path to the local repo to scan")
      .option("--company-id <id>", "Target company id (defaults to active context)")
      .option("--project-name <name>", "Override the detected project name")
      .option("--dry-run", "Print the payload that would be sent and exit"),
  ).action(async (opts: BootstrapFromRepoOptions) => {
    await bootstrapFromRepoCommand(opts);
  });
}
