import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Spawning the fake stdio MCP server child process can take a moment to
    // boot on a cold machine; give connect/round-trip tests room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
