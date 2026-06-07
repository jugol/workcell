import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WC-157: the cloud-upstreams routes previously gated only with assertBoardOrgAccess
// (passes for any board user with any company) and then trusted a request-supplied
// companyId, which is a latent cross-tenant IDOR. These tests mount the router with
// mocked services and prove that assertCompanyAccess(req, companyId) now scopes every
// company-bound handler to the caller's own company and enforces write authorization.
const mocks = vi.hoisted(() => ({
  list: vi.fn(async () => ({ connections: [], runs: [] })),
  startConnect: vi.fn(async () => ({})),
  finishConnect: vi.fn(async () => ({})),
  preview: vi.fn(async () => ({})),
  createRun: vi.fn(async () => ({})),
  readRun: vi.fn(async () => ({})),
  cancelRun: vi.fn(async () => ({})),
  activateRunEntities: vi.fn(async () => ({})),
  getExperimental: vi.fn(async () => ({ enableCloudSync: true })),
}));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    cloudUpstreamService: () => ({
      list: mocks.list,
      startConnect: mocks.startConnect,
      finishConnect: mocks.finishConnect,
      preview: mocks.preview,
      createRun: mocks.createRun,
      readRun: mocks.readRun,
      cancelRun: mocks.cancelRun,
      activateRunEntities: mocks.activateRunEntities,
    }),
    instanceSettingsService: () => ({
      getExperimental: mocks.getExperimental,
    }),
  };
});

const { cloudUpstreamRoutes } = await import("../routes/cloud-upstreams.js");
const { errorHandler } = await import("../middleware/index.js");

type Actor = Express.Request["actor"];

function boardMember(opts: {
  companyIds: string[];
  role: "admin" | "operator" | "viewer";
  membershipCompanyId: string;
}): Actor {
  return {
    type: "board",
    userId: `${opts.role}-user`,
    userName: null,
    userEmail: null,
    source: "session",
    isInstanceAdmin: false,
    companyIds: opts.companyIds,
    memberships: [
      { companyId: opts.membershipCompanyId, membershipRole: opts.role, status: "active" },
    ],
  } as Actor;
}

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", cloudUpstreamRoutes({} as never));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, build: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await build(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe("cloud upstream route authorization (WC-157)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExperimental.mockResolvedValue({ enableCloudSync: true } as never);
  });

  it("blocks reading another company's cloud upstreams (cross-tenant IDOR)", async () => {
    const app = createApp(boardMember({ companyIds: ["company-a"], role: "admin", membershipCompanyId: "company-a" }));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/cloud-upstreams").query({ companyId: "company-b" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("blocks pushing a run to another company (cross-tenant write)", async () => {
    const app = createApp(boardMember({ companyIds: ["company-a"], role: "admin", membershipCompanyId: "company-a" }));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/cloud-upstreams/conn-1/push-runs").send({ companyId: "company-b" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("blocks activating imported entities in another company (cross-tenant write)", async () => {
    const app = createApp(boardMember({ companyIds: ["company-a"], role: "admin", membershipCompanyId: "company-a" }));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/cloud-upstreams/conn-1/push-runs/run-1/activation")
        .send({ companyId: "company-b", entityType: "agents" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mocks.activateRunEntities).not.toHaveBeenCalled();
  });

  it("allows a member to read their own company's cloud upstreams", async () => {
    const app = createApp(boardMember({ companyIds: ["company-a"], role: "admin", membershipCompanyId: "company-a" }));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/cloud-upstreams").query({ companyId: "company-a" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("company-a");
  });

  it("blocks a viewer from pushing a run even within their own company (write authorization)", async () => {
    const app = createApp(boardMember({ companyIds: ["company-a"], role: "viewer", membershipCompanyId: "company-a" }));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/cloud-upstreams/conn-1/push-runs").send({ companyId: "company-a" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mocks.createRun).not.toHaveBeenCalled();
  });
});
