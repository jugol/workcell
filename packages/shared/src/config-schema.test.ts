import { describe, expect, it } from "vitest";
import { workcellConfigSchema } from "./config-schema.js";

describe("workcell config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = workcellConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.workcell/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.workcell/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.workcell/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.workcell/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.workcell/instances/default/secrets/master.key");
  });
});
