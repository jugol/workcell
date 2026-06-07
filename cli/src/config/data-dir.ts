import path from "node:path";
import {
  expandHomePrefix,
  resolveDefaultConfigPath,
  resolveDefaultContextPath,
  resolveWorkcellInstanceId,
} from "./home.js";

export interface DataDirOptionLike {
  dataDir?: string;
  config?: string;
  context?: string;
  instance?: string;
}

export interface DataDirCommandSupport {
  hasConfigOption?: boolean;
  hasContextOption?: boolean;
}

export function applyDataDirOverride(
  options: DataDirOptionLike,
  support: DataDirCommandSupport = {},
): string | null {
  const rawDataDir = options.dataDir?.trim();
  if (!rawDataDir) return null;

  const resolvedDataDir = path.resolve(expandHomePrefix(rawDataDir));
  process.env.WORKCELL_HOME = resolvedDataDir;

  if (support.hasConfigOption) {
    const hasConfigOverride = Boolean(options.config?.trim()) || Boolean(process.env.WORKCELL_CONFIG?.trim());
    if (!hasConfigOverride) {
      const instanceId = resolveWorkcellInstanceId(options.instance);
      process.env.WORKCELL_INSTANCE_ID = instanceId;
      process.env.WORKCELL_CONFIG = resolveDefaultConfigPath(instanceId);
    }
  }

  if (support.hasContextOption) {
    const hasContextOverride = Boolean(options.context?.trim()) || Boolean(process.env.WORKCELL_CONTEXT?.trim());
    if (!hasContextOverride) {
      process.env.WORKCELL_CONTEXT = resolveDefaultContextPath();
    }
  }

  return resolvedDataDir;
}
