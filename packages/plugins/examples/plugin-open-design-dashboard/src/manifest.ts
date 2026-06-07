import type { WorkcellPluginManifestV1 } from "@workcell/plugin-sdk";

// WC-31 (PLAN §9 #4 first slice): Open Design Dashboard scaffold.
//
// Per D13: Open Design is a plugin capability pack, not a core fork. This
// manifest reserves the page slot ("design") where the dashboard mounts
// and declares the future capability surface (artifact preview, design
// skills, area annotations). Each capability ships in a later slice — this
// scaffold is just enough to register the plugin and route /design to a
// placeholder.
export const PLUGIN_ID = "workcell.plugin-open-design-dashboard";
export const PLUGIN_VERSION = "0.1.0";
export const DESIGN_PAGE_SLOT_ID = "design-dashboard-page";
export const DESIGN_PAGE_EXPORT_NAME = "OpenDesignDashboardPage";

const manifest: WorkcellPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Open Design Dashboard (Scaffold)",
  description:
    "First-slice scaffold for the Open Design Dashboard. Surfaces a placeholder page at /design where future slices will mount artifact lists, version diffs, and sandbox iframe previews.",
  author: "Workcell",
  categories: ["ui"],
  // WC-66: mcp.client lets the worker call the Open Design MCP sidecar via
  // ctx.mcpClients; plugin.state.* caches the fetched artifacts per issue.
  capabilities: ["ui.page.register", "mcp.client", "plugin.state.read", "plugin.state.write"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: DESIGN_PAGE_SLOT_ID,
        displayName: "Design",
        exportName: DESIGN_PAGE_EXPORT_NAME,
        routePath: "design",
      },
    ],
  },
};

export default manifest;
