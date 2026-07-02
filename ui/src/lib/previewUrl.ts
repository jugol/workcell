// Normalize a 시안/asset preview URL for display in an iframe or link.
//
// design_attach stores the 시안 asset URL as an ABSOLUTE url built from the MCP
// client's configured apiUrl (e.g. "http://127.0.0.1:3100/api/assets/<id>/content")
// — the server's design-artifact `url` validation (z.string().url()) requires an
// absolute url, so it cannot be stored relative. But an absolute "127.0.0.1:3100"
// url BREAKS when the board opens the Workcell UI from a DIFFERENT origin (another
// device over Tailscale/LAN, localhost vs 127.0.0.1, the desktop app): the iframe
// tries to reach 127.0.0.1 on the VIEWER's machine, where nothing is listening →
// "127.0.0.1 refused to connect".
//
// The UI and the API are always served by the SAME server, so an /api/... path
// resolves correctly against whatever origin the UI was loaded from. This helper
// strips the scheme+host from same-app /api/ urls so the preview loads relative
// to the current origin. data:, already-relative, and genuinely external urls
// pass through unchanged.
export function toDisplayPreviewUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("data:") || url.startsWith("/")) return url;
  try {
    const u = new URL(url);
    if (u.pathname.startsWith("/api/")) return u.pathname + u.search;
  } catch {
    // not a parseable absolute url — leave as-is
  }
  return url;
}
