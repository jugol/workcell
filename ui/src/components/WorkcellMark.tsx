import { cn } from "@/lib/utils";

// WC-70 (Orchestration brand): the Workcell product mark — an orchestration
// hub. A filled central node (the board/orchestrator) drives three connected
// satellite nodes (the agents operating "like a company"). Uses currentColor
// so it inherits the brand/foreground color of its context (sidebar, design
// guide, favicon). Replaces the inherited paperclip-as-brand artifact.
export function WorkcellMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-5", className)}
      aria-hidden="true"
    >
      {/* spokes: orchestrator -> agents */}
      <path d="M12 12V5.4M12 12l5.7 3.3M12 12l-5.7 3.3" />
      {/* satellite agent nodes */}
      <circle cx="12" cy="4" r="2" />
      <circle cx="19" cy="16" r="2" />
      <circle cx="5" cy="16" r="2" />
      {/* central orchestrator node (filled) */}
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
