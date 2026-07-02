// Design-artifact lineage grouping — the SINGLE source of truth shared by the
// Design System UI (which groups artifacts into one card per screen) and the
// server's auto-delete-on-approval (which must only supersede same-screen
// siblings, never a different screen's board on the same issue).
//
// WC-199: only an explicit "v" version token (v2, " - v1.0") is a version
// suffix. A BARE trailing number is NOT a version marker — "Dashboard 2024",
// "Onboarding Step 2" are distinct screens; stripping their number would
// collapse real designs. So the regex requires a leading `v`.
export const DESIGN_VERSION_SUFFIX = /\s*[-–—]?\s*v\d+(?:\.\d+)*\s*$/i;

// Normalize a design artifact's title to its lineage key: strip a trailing
// version token, trim, lowercase. Falls back to the original (lowercased) when
// stripping would leave it empty. Two artifacts share a lineage iff this
// returns the same value for both — i.e. the same screen across versions.
export function normalizeDesignLineageTitle(title: string): string {
  const stripped = title.replace(DESIGN_VERSION_SUFFIX, "").trim();
  return (stripped || title).toLowerCase();
}

// The de-versioned display title (NOT lowercased) for a lineage's current card.
export function designLineageDisplayTitle(title: string): string {
  return title.replace(DESIGN_VERSION_SUFFIX, "").trim() || title;
}
