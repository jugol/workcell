import { Command } from "commander";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

const execFileAsync = promisify(execFile);

// WC-122 (D20 S4 operational): client-side Graphify producer — the operational
// glue that ties the external code-graph engine to Workcell's Knowledge Graph.
//
// Runs the external Graphify CLI (`graphify update <repo> --no-cluster`) to
// build a code graph, then POSTs the raw graph.json to the server's
// code-graph/ingest-graphify route, which maps it (mapGraphifyGraphToImport,
// the single tested source of truth) and persists kind="code" nodes/edges.
//
// Graphify is an OPTIONAL external tool (PyPI `graphifyy`, Python 3.10+) — when
// it is not installed, this command fails with an actionable message rather
// than a stack trace, and `--graph-json <file>` lets a user ingest a pre-built
// export without the tool on PATH (e.g. produced by a CI job).

interface CodeGraphFromRepoOptions extends BaseClientOptions {
  path: string;
  projectId?: string;
  graphJson?: string;
  cluster?: boolean; // commander leaves this undefined unless --cluster is passed
  dryRun?: boolean;
}

// Graphify writes its export to <repo>/graphify-out/graph.json by default
// (verified against graphifyy 0.8.28 `graphify update`).
export function resolveGraphifyOutPath(repoPath: string): string {
  return path.join(path.resolve(repoPath), "graphify-out", "graph.json");
}

export interface GraphifyExportSummary {
  nodes: number;
  links: number;
}

// Count nodes/links in a raw Graphify (NetworkX node-link) export for logging
// and --dry-run. Tolerant of `links` vs `edges` and missing arrays so a partial
// export still summarizes instead of throwing.
export function summarizeGraphifyExport(graph: unknown): GraphifyExportSummary {
  const g = (graph && typeof graph === "object" ? graph : {}) as Record<string, unknown>;
  const nodes = Array.isArray(g.nodes) ? g.nodes.length : 0;
  const links = Array.isArray(g.links)
    ? g.links.length
    : Array.isArray(g.edges)
      ? g.edges.length
      : 0;
  return { nodes, links };
}

export async function readGraphJson(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as unknown;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function runGraphifyUpdate(repoPath: string, cluster: boolean): Promise<void> {
  const args = ["update", path.resolve(repoPath)];
  // Default to --no-cluster: clustering invokes an LLM for community labels,
  // which we do not want for a hermetic, no-cost code-graph build.
  if (!cluster) args.push("--no-cluster");
  try {
    await execFileAsync("graphify", args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new Error(
        "The `graphify` CLI was not found on PATH. Install it with `pip install graphifyy` " +
          "(Python 3.10+), or pass --graph-json <file> to ingest a pre-built graph.json.",
      );
    }
    throw err;
  }
}

interface IngestGraphifyResponse {
  nodesUpserted: number;
  edgesUpserted: number;
  edgesSkipped: number;
  mappedNodes: number;
  mappedEdges: number;
}

async function codeGraphFromRepoCommand(opts: CodeGraphFromRepoOptions) {
  try {
    const ctx = resolveCommandContext(opts);
    const companyId = opts.companyId ?? ctx.companyId;
    if (!companyId) {
      console.error(pc.red("companyId is required (pass --company-id or set a default context)"));
      process.exit(1);
    }

    let graphJsonPath: string;
    if (opts.graphJson) {
      graphJsonPath = path.resolve(opts.graphJson);
    } else {
      console.log(pc.cyan(`Building code graph with graphify: ${path.resolve(opts.path)}`));
      await runGraphifyUpdate(opts.path, opts.cluster === true);
      graphJsonPath = resolveGraphifyOutPath(opts.path);
    }

    if (!(await isFile(graphJsonPath))) {
      console.error(pc.red(`graph.json not found at ${graphJsonPath}`));
      process.exit(1);
    }

    const graph = await readGraphJson(graphJsonPath);
    const summary = summarizeGraphifyExport(graph);

    if (opts.dryRun) {
      console.log(
        pc.cyan(
          `Dry run — ${graphJsonPath} has ${summary.nodes} nodes / ${summary.links} links; ` +
            "would POST to code-graph/ingest-graphify.",
        ),
      );
      return;
    }

    const result = await ctx.api.post<IngestGraphifyResponse>(
      `/companies/${companyId}/knowledge-graph/code-graph/ingest-graphify`,
      { graph, projectId: opts.projectId },
    );
    console.log(
      pc.green(
        `Ingested code graph: ${result?.nodesUpserted ?? 0} nodes, ${result?.edgesUpserted ?? 0} edges ` +
          `(${result?.edgesSkipped ?? 0} skipped) from ${result?.mappedNodes ?? summary.nodes} mapped nodes.`,
      ),
    );
  } catch (err) {
    handleCommandError(err);
  }
}

export function registerCodeGraphCommands(program: Command): void {
  const codeGraph = program
    .command("code-graph")
    .description("Build and ingest a code graph (via the external Graphify tool)");
  addCommonClientOptions(
    codeGraph
      .command("from-repo")
      .description("Run graphify on a local repo and ingest the code graph into Workcell")
      .requiredOption("--path <path>", "Path to the local repo to graph")
      .option("--company-id <id>", "Target company id (defaults to active context)")
      .option("--project-id <id>", "Associate ingested code nodes with a project id")
      .option("--graph-json <file>", "Ingest an existing graph.json instead of running graphify")
      .option("--cluster", "Enable Graphify clustering (uses an LLM; off by default)")
      .option("--dry-run", "Build/read the graph and print a summary without ingesting"),
  ).action(async (opts: CodeGraphFromRepoOptions) => {
    await codeGraphFromRepoCommand(opts);
  });
}
