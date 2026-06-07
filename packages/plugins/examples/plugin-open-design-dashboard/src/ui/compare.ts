// WC-119/120: version-compare target selection for the Open Design dashboard.
//
// The artifact list for a title is sorted NEWEST-FIRST, so the chronologically
// PREVIOUS (older) version of the row at `idx` is the NEXT index. This returns
// that older version, or null for the oldest row (nothing older to diff). The
// dashboard uses it for BOTH the "Compare" button's visibility and its target,
// so the diff always runs older -> newer.
//
// Pre-WC-119 the button also appeared on the oldest row and fell back to
// versions[idx-1] — a NEWER artifact — which inverted the diff direction
// (added/removed lines swapped, header timeline backwards).
export function resolveCompareTarget<T>(versions: readonly T[], idx: number): T | null {
  if (idx < 0 || idx >= versions.length - 1) return null;
  return versions[idx + 1] ?? null;
}
