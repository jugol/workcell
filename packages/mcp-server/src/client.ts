import type { WorkcellMcpConfig } from "./config.js";

export class WorkcellApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "WorkcellApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

export interface JsonRequestOptions {
  body?: unknown;
  includeRunId?: boolean;
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return `${method} ${path} failed with ${status}: ${body.error}`;
  }
  return `${method} ${path} failed with ${status}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class WorkcellApiClient {
  constructor(private readonly config: WorkcellMcpConfig) {}

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
  }

  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because WORKCELL_COMPANY_ID is not set");
    }
    return resolved;
  }

  resolveAgentId(agentId?: string | null): string {
    const resolved = agentId?.trim() || this.config.agentId;
    if (!resolved) {
      throw new Error("agentId is required because WORKCELL_AGENT_ID is not set");
    }
    return resolved;
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }

    const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if ((options.includeRunId ?? isWriteMethod(method)) && this.config.runId) {
      headers["X-Workcell-Run-Id"] = this.config.runId;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
      throw new WorkcellApiError({
        status: response.status,
        method: method.toUpperCase(),
        path,
        body: parsedBody,
        message: buildErrorMessage(method.toUpperCase(), path, response.status, parsedBody),
      });
    }

    return parsedBody as T;
  }

  // Build an absolute URL for a server-relative asset content path (e.g.
  // "/api/assets/<id>/content"). The path is root-absolute, so it resolves
  // against the API ORIGIN, correctly ignoring any "/api" suffix already on
  // apiUrl (so "http://host/api" + "/api/assets/.." does NOT become
  // "/api/api/.."). The result is an absolute http(s) URL that passes the
  // server's z.string().url() validation on design-artifact `url`.
  absoluteAssetUrl(contentPath: string): string {
    return new URL(contentPath, this.config.apiUrl).toString();
  }

  // POST a multipart/form-data body (file upload). Mirrors requestJson's URL
  // resolution and auth / run-id headers, but deliberately does NOT set a
  // Content-Type header — the global fetch derives the correct multipart
  // boundary from the FormData body itself (setting it manually would break the
  // boundary).
  async uploadMultipart<T>(path: string, form: FormData): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }

    const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    if (this.config.runId) {
      headers["X-Workcell-Run-Id"] = this.config.runId;
    }

    const response = await fetch(url, { method: "POST", headers, body: form });
    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
      throw new WorkcellApiError({
        status: response.status,
        method: "POST",
        path,
        body: parsedBody,
        message: buildErrorMessage("POST", path, response.status, parsedBody),
      });
    }

    return parsedBody as T;
  }
}
