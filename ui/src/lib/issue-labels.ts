import type { TFunction } from "i18next";

// WC-85: shared, translatable issue status + priority labels. Previously each
// surface re-derived these inconsistently — StatusIcon and KanbanBoard
// title-cased the enum ("In Progress") while StatusBadge showed the raw
// lowercase value ("in progress"). This unifies them on Title Case (English)
// and makes them translatable via i18n keys.

const STATUS_FALLBACK: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

const PRIORITY_FALLBACK: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function statusLabel(status: string, t: TFunction): string {
  const key = (status ?? "").toLowerCase();
  return t(`issueStatus.${key}`, {
    defaultValue: STATUS_FALLBACK[key] ?? titleCase(status ?? ""),
  });
}

export function priorityLabel(priority: string, t: TFunction): string {
  const key = (priority ?? "").toLowerCase();
  return t(`issuePriority.${key}`, {
    defaultValue: PRIORITY_FALLBACK[key] ?? titleCase(priority ?? ""),
  });
}
