import os from "node:os";
import path from "node:path";

export const DEFAULT_WORKCELL_INSTANCE_ID = "default";
export const WORKCELL_CONFIG_BASENAME = "config.json";
export const WORKCELL_ENV_FILENAME = ".env";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveWorkcellHomeDir(homeOverride?: string): string {
  const raw = homeOverride?.trim() || process.env.WORKCELL_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return path.resolve(os.homedir(), ".workcell");
}

export function resolveWorkcellInstanceId(instanceIdOverride?: string): string {
  const raw = instanceIdOverride?.trim() || process.env.WORKCELL_INSTANCE_ID?.trim() || DEFAULT_WORKCELL_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid WORKCELL_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveWorkcellInstanceRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWorkcellHomeDir(input.homeDir), "instances", resolveWorkcellInstanceId(input.instanceId));
}

export function resolveWorkcellInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWorkcellInstanceRoot(input), WORKCELL_CONFIG_BASENAME);
}

export function resolveWorkcellConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return resolveWorkcellInstanceConfigPath(input);
}

export function resolveWorkcellEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), WORKCELL_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWorkcellInstanceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWorkcellInstanceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWorkcellInstanceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWorkcellInstanceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWorkcellInstanceRoot(input), "data", "backups");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
