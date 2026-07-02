// WC-31 (PLAN §9 #4): public entry for the Open Design Dashboard plugin.
// Re-exports the worker and UI components so the host's build pipeline
// can pick them up directly.
export { default as manifest } from "./manifest.js";
export { default as worker } from "./worker.js";
export { OpenDesignDashboardPage } from "./ui/index.js";
