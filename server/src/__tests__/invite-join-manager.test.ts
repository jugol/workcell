import { describe, expect, it } from "vitest";
import { resolveJoinRequestAgentManagerId } from "../routes/access.js";

describe("resolveJoinRequestAgentManagerId", () => {
  it("returns null when no CEO exists in the company agent list", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "a1", role: "lead", reportsTo: null },
      { id: "a2", role: "engineer", reportsTo: "a1" },
    ]);

    expect(managerId).toBeNull();
  });

  it("selects the root CEO when available", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-child", role: "orchestrator", reportsTo: "manager-1" },
      { id: "manager-1", role: "lead", reportsTo: null },
      { id: "ceo-root", role: "orchestrator", reportsTo: null },
    ]);

    expect(managerId).toBe("ceo-root");
  });

  it("falls back to the first CEO when no root CEO is present", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-1", role: "orchestrator", reportsTo: "mgr" },
      { id: "ceo-2", role: "orchestrator", reportsTo: "mgr" },
      { id: "mgr", role: "lead", reportsTo: null },
    ]);

    expect(managerId).toBe("ceo-1");
  });
});
