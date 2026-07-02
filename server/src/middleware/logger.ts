import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { sanitizeRecord } from "../redaction.js";

// Defensively redact a request body/params/query before it is attached to a log
// line. Failed requests to secret-bearing routes (e.g. POST /companies/:id/secrets,
// /secrets/:id/rotate, agent-key create, webhook create, `{type:"plain"}` env
// bindings) would otherwise write the PLAINTEXT secret into server.log. The
// shared sanitizer redacts known secret field names, JWT-shaped values, plain
// secret bindings, and inline command secrets while leaving non-secret fields
// readable for debugging.
function sanitizeLoggedRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  try {
    return sanitizeRecord(value as Record<string, unknown>);
  } catch {
    // Never let redaction failure crash the request logger; drop to a marker
    // rather than risk emitting an unredacted payload.
    return "[unserializable]";
  }
}

function resolveServerLogDir(): string {
  const envOverride = process.env.WORKCELL_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

// Known secret-bearing field names. pino `redact` only sees the structured
// log object (req.headers, plus the props we attach below); the deeper
// sanitizeRecord pass handles arbitrary nesting in req bodies. These wildcard
// paths are a belt-and-braces backstop so any future code that logs one of
// these fields at the top level of a payload is still scrubbed.
const SECRET_FIELD_NAMES = [
  "material",
  "secret",
  "token",
  "apiKey",
  "password",
  "value",
  "bearerToken",
  "signingSecret",
];
const SECRET_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  ...SECRET_FIELD_NAMES.flatMap((field) => [
    `reqBody.${field}`,
    `reqBody.*.${field}`,
    `reqParams.${field}`,
    `reqQuery.${field}`,
    `errorContext.${field}`,
  ]),
];

export const logger = pino({
  level: "debug",
  redact: SECRET_REDACT_PATHS,
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: sanitizeLoggedRecord(ctx.reqBody),
          reqParams: sanitizeLoggedRecord(ctx.reqParams),
          reqQuery: sanitizeLoggedRecord(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = sanitizeLoggedRecord(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = sanitizeLoggedRecord(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = sanitizeLoggedRecord(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
