import pc from "picocolors";

const WORKCELL_ART = [
  "██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗ ██████╗███████╗██╗     ██╗     ",
  "██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝██╔════╝██╔════╝██║     ██║     ",
  "██║ █╗ ██║██║   ██║██████╔╝█████╔╝ ██║     █████╗  ██║     ██║     ",
  "██║███╗██║██║   ██║██╔══██╗██╔═██╗ ██║     ██╔══╝  ██║     ██║     ",
  "╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗╚██████╗███████╗███████╗███████╗",
  " ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝╚══════╝",
] as const;

const TAGLINE = "Project-focused AI agent teams, directed by you";

export function printWorkcellCliBanner(): void {
  const lines = [
    "",
    ...WORKCELL_ART.map((line) => pc.cyan(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
