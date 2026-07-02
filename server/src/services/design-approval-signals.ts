import type { IssueWorkProduct } from "@workcell/shared";
import { groupDesignsByScreen, isDesignWorkProductType } from "@workcell/shared";

function flattenApprovalPayloadText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(payload);
  return parts.join("\n");
}

export function approvalPayloadRequestsDesignReviewApproval(
  payload: Record<string, unknown>,
): boolean {
  const text = flattenApprovalPayloadText(payload).toLowerCase();
  const requestsDesignReview =
    /\bdesign[-\s]?review\b/.test(text) ||
    /\bdesign[-\s]?artifact\b/.test(text) ||
    /시안/.test(text);
  const requestsApproval = /(\bapprove\b|\bapproved\b|승인)/.test(text);
  const referencesDesignArtifact =
    /(\bwork[-\s]?product\b|시안|source[-\s]?of[-\s]?truth|\bmockup\b|\bfigma\b)/.test(
      text,
    );
  return requestsDesignReview && requestsApproval && referencesDesignArtifact;
}

export function approvalPayloadWorkProductRefs(payload: Record<string, unknown>): string[] {
  const text = flattenApprovalPayloadText(payload);
  const refs = new Set<string>();
  for (const match of text.matchAll(/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8}/g)) {
    refs.add(match[0].toLowerCase());
  }
  return [...refs];
}

function refMatchesWorkProductId(ref: string, workProductId: string): boolean {
  const normalizedRef = ref.toLowerCase();
  const normalizedId = workProductId.toLowerCase();
  return normalizedId === normalizedRef || normalizedId.startsWith(normalizedRef);
}

export function designWorkProductIdsApprovedByBoardApproval(
  workProducts: IssueWorkProduct[],
  payloads: Array<Record<string, unknown>>,
): Set<string> {
  const currentDesigns = groupDesignsByScreen(
    workProducts.filter((wp) => isDesignWorkProductType(wp.type)),
  ).map((group) => group.current);
  const approvedIds = new Set<string>();
  if (currentDesigns.length === 0) return approvedIds;

  for (const payload of payloads) {
    if (!approvalPayloadRequestsDesignReviewApproval(payload)) continue;
    const refs = approvalPayloadWorkProductRefs(payload);
    const beforeSize = approvedIds.size;

    for (const design of currentDesigns) {
      if (refs.some((ref) => refMatchesWorkProductId(ref, design.id))) {
        approvedIds.add(design.id);
      }
    }

    if (approvedIds.size !== beforeSize) continue;

    if (refs.length === 0) {
      for (const design of currentDesigns) approvedIds.add(design.id);
    } else if (currentDesigns.length === 1) {
      approvedIds.add(currentDesigns[0]!.id);
    }
  }

  return approvedIds;
}
