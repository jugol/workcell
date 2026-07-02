import { describe, it, expect } from "vitest";
import {
  canonicalScreenKey,
  effectiveScreenKey,
  groupDesignsByScreen,
} from "./design-screens.js";
import type { IssueWorkProduct } from "./types/work-product.js";

describe("canonicalScreenKey", () => {
  it("strips trailing version / issue-ref / staging markers so revisions share one key", () => {
    // The exact LOR-268 case: agent baked the version into screen_key.
    expect(canonicalScreenKey("real-education-json-bundle-home-v9")).toBe("real-education-json-bundle-home");
    expect(canonicalScreenKey("real-education-json-bundle-home-v10")).toBe("real-education-json-bundle-home");
    expect(canonicalScreenKey("real-education-json-bundle-home-v11")).toBe("real-education-json-bundle-home");
    // issue-ref + version combined
    expect(canonicalScreenKey("real-edu-home-lor476-v11")).toBe("real-edu-home");
    expect(canonicalScreenKey("home-lor458")).toBe("home");
    expect(canonicalScreenKey("login-staging")).toBe("login");
  });

  it("leaves a clean key untouched and only strips TRAILING markers (not mid-slug)", () => {
    expect(canonicalScreenKey("learner-home")).toBe("learner-home");
    expect(canonicalScreenKey("lesson-v2-quiz")).toBe("lesson-v2-quiz"); // version mid-slug kept
    expect(canonicalScreenKey("Login")).toBe("login");
  });
});

function wp(overrides: Partial<IssueWorkProduct>): IssueWorkProduct {
  const now = new Date("2026-06-16T00:00:00Z");
  return {
    id: "x", companyId: "c", projectId: null, issueId: "i",
    executionWorkspaceId: null, runtimeServiceId: null,
    type: "design" as IssueWorkProduct["type"], provider: "workcell", externalId: null,
    screenKey: null, screenName: null, title: "t", url: null, status: "active",
    reviewState: "none", isPrimary: false, healthStatus: "unknown", summary: null,
    metadata: null, createdByRunId: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

describe("groupDesignsByScreen with version-suffixed keys (the 3-version bug)", () => {
  it("collapses v9/v10/v11 of one screen into ONE screen, newest as current", () => {
    const designs = [
      wp({ id: "v9", screenKey: "real-education-json-bundle-home-v9", screenName: "홈 v9", updatedAt: new Date("2026-06-16T01:00:00Z") }),
      wp({ id: "v10", screenKey: "real-education-json-bundle-home-v10", screenName: "홈 v10", updatedAt: new Date("2026-06-16T02:00:00Z") }),
      wp({ id: "v11", screenKey: "real-education-json-bundle-home-v11", screenName: "홈 v11", isPrimary: true, updatedAt: new Date("2026-06-16T03:00:00Z") }),
    ];
    const screens = groupDesignsByScreen(designs);
    expect(screens).toHaveLength(1); // ONE screen, not three
    expect(screens[0].versions).toHaveLength(3);
    expect(screens[0].current.id).toBe("v11"); // newest/primary is current
  });

  it("all three resolve to the same effectiveScreenKey", () => {
    const k9 = effectiveScreenKey({ screenKey: "real-education-json-bundle-home-v9", title: "" });
    const k11 = effectiveScreenKey({ screenKey: "real-education-json-bundle-home-v11", title: "" });
    expect(k9).toBe(k11);
  });
});
