import { describe, it, expect } from "vitest";
import type { DesignFlowScreen, DesignScreenLink } from "@workcell/shared";
import { layout } from "./WireframeFlow";

function screen(screenKey: string, screenName = screenKey): DesignFlowScreen {
  return {
    screenKey,
    screenName,
    workProductId: `wp-${screenKey}`,
    issueId: "i1",
    previewUrl: null,
    reviewState: "none",
    approved: false,
  };
}
function link(from: string, to: string, label = ""): DesignScreenLink {
  return {
    id: `${from}->${to}`,
    companyId: "c1",
    projectId: null,
    fromScreenKey: from,
    toScreenKey: to,
    label,
    sourceWorkProductId: null,
    createdByKind: "agent",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("WireframeFlow layout (R4)", () => {
  // The edu-app flow has a BACK-LINK (lesson → home "닫기"), so "no inbound" can't
  // identify the entry. The home screen must still be the representative at layer 0.
  const screens = [
    screen("learner-home", "학습자 홈"),
    screen("lesson-solve", "문제 풀이"),
    screen("result-review", "결과/복습"),
    screen("admin-studio", "관리자"),
  ];
  const links = [
    link("learner-home", "lesson-solve"),
    link("learner-home", "result-review"),
    link("lesson-solve", "result-review"),
    link("lesson-solve", "learner-home"), // back-link
    link("result-review", "lesson-solve"),
    link("admin-studio", "lesson-solve"),
  ];

  it("puts the representative home screen at the left edge despite a back-link", () => {
    const { placed } = layout(screens, links);
    const home = placed.find((p) => p.screen.screenKey === "learner-home")!;
    const lesson = placed.find((p) => p.screen.screenKey === "lesson-solve")!;
    expect(home.isEntry).toBe(true); // home is the single representative
    expect(home.x).toBe(0); // leftmost column
    expect(lesson.x).toBeGreaterThan(home.x); // flows rightward from home
    // exactly one representative
    expect(placed.filter((p) => p.isEntry)).toHaveLength(1);
  });

  it("places every screen, including ones unreachable from the entry (secondary roots)", () => {
    const { placed } = layout(screens, links);
    expect(placed).toHaveLength(4);
    const admin = placed.find((p) => p.screen.screenKey === "admin-studio")!;
    expect(admin.x).toBe(0); // not reachable from home → its own left-edge root
    expect(admin.isEntry).toBe(false);
  });

  it("only draws links between real screens (drops dangling)", () => {
    const { realLinks } = layout(screens, [...links, link("learner-home", "ghost-screen")]);
    expect(realLinks).toHaveLength(links.length);
    expect(realLinks.some((l) => l.toScreenKey === "ghost-screen")).toBe(false);
  });
});
