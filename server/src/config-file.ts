import fs from "node:fs";
import { workcellConfigSchema, type WorkcellConfig } from "@workcell/shared";
import { resolveWorkcellConfigPath } from "./paths.js";

export function readConfigFile(): WorkcellConfig | null {
  const configPath = resolveWorkcellConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return workcellConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
