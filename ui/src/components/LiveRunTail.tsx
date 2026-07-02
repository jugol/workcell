import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRunEvent } from "@workcell/shared";
import { ApiError } from "../api/client";
import { heartbeatsApi } from "../api/heartbeats";
import { useTranslation } from "@/i18n";

// Live tail of an in-progress run's output, mounted inline on the issue screen
// (pair round timeline + solo-run ledger). Answers "is it actually doing
// something or is it stuck?" without opening the run detail page.
//
// Data sources (both EXISTING endpoints, polled together every 2.5s):
// - GET /heartbeat-runs/:runId/log — the persisted NDJSON shell log
//   ({ts, stream, chunk} records). This is where the real adapter
//   stdout/stderr (the LLM output) lives.
// - GET /heartbeat-runs/:runId/events — lifecycle/system events
//   (run started, adapter invocation, errors). Useful signal before the
//   first log byte arrives and for error surfacing.
// Polling stops once the run reaches a terminal status.

export interface TailLine {
  key: string;
  ts: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

const POLL_INTERVAL_MS = 2500;
const LOG_PAGE_BYTES = 65_536;
// Keep a little more than we show so stderr-only filtering or future tweaks
// don't starve the view; render is capped by max-height + scroll anyway.
const TAIL_KEEP_LINES = 80;
const FOLLOW_BOTTOM_TOLERANCE_PX = 24;

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

interface TailState {
  runId: string;
  afterSeq: number;
  logOffset: number | null;
  pendingLogRow: string;
  logMissing: boolean;
  lineSeq: number;
  lines: TailLine[];
}

function createTailState(runId: string): TailState {
  return {
    runId,
    afterSeq: 0,
    logOffset: null,
    pendingLogRow: "",
    logMissing: false,
    lineSeq: 0,
    lines: [],
  };
}

// Parse a chunk of persisted run-log content (NDJSON rows of
// {ts, stream, chunk}) into display lines. `state.pendingLogRow` carries a
// trailing partial row between polls. Exported for unit tests.
export function linesFromLogContent(
  content: string,
  state: { pendingLogRow: string; lineSeq: number },
): TailLine[] {
  if (!content) return [];
  const combined = `${state.pendingLogRow}${content}`;
  const rows = combined.split("\n");
  state.pendingLogRow = rows.pop() ?? "";

  const lines: TailLine[] = [];
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      if (!chunk) continue;
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      for (const text of chunk.split("\n")) {
        if (!text.trim()) continue;
        lines.push({ key: `log:${state.lineSeq++}`, ts, stream, text });
      }
    } catch {
      // Ignore malformed log rows (e.g. the first fetch landing mid-row).
    }
  }
  return lines;
}

// Map run events (lifecycle / adapter / error) to display lines. Only events
// carrying a human-readable message are shown. Exported for unit tests.
export function linesFromRunEvents(events: HeartbeatRunEvent[]): TailLine[] {
  const lines: TailLine[] = [];
  for (const event of events) {
    const message = typeof event.message === "string" ? event.message.trim() : "";
    if (!message) continue;
    const isError =
      event.stream === "stderr" || event.level === "error" || event.eventType === "error";
    const ts =
      typeof event.createdAt === "string"
        ? event.createdAt
        : new Date(event.createdAt).toISOString();
    for (const text of message.split("\n")) {
      if (!text.trim()) continue;
      lines.push({
        key: `evt:${event.seq}:${lines.length}`,
        ts,
        stream: isError ? "stderr" : "system",
        text,
      });
    }
  }
  return lines;
}

function isLogUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function LiveRunTail({ runId, title }: { runId: string; title?: string }) {
  const { t } = useTranslation();
  const stateRef = useRef<TailState>(createTailState(runId));
  if (stateRef.current.runId !== runId) {
    stateRef.current = createTailState(runId);
  }

  const tailQuery = useQuery({
    queryKey: ["live-run-tail", runId],
    queryFn: async () => {
      const state = stateRef.current;
      const run = await heartbeatsApi.get(runId);

      // First poll: start reading the log near its tail so a long-running
      // run doesn't dump megabytes of history into an inline widget.
      if (state.logOffset === null) {
        const knownBytes =
          typeof run.lastOutputBytes === "number" && run.lastOutputBytes > 0
            ? run.lastOutputBytes
            : typeof run.logBytes === "number" && run.logBytes > 0
              ? run.logBytes
              : 0;
        state.logOffset = Math.max(0, knownBytes - LOG_PAGE_BYTES);
      }

      const [events, log] = await Promise.all([
        heartbeatsApi.events(runId, state.afterSeq, 200).catch(() => [] as HeartbeatRunEvent[]),
        state.logMissing
          ? Promise.resolve(null)
          : heartbeatsApi.log(runId, state.logOffset, LOG_PAGE_BYTES).catch((err) => {
              if (isLogUnavailable(err)) return null;
              return null;
            }),
      ]);

      const batch: TailLine[] = [];
      if (events.length > 0) {
        state.afterSeq = Math.max(state.afterSeq, ...events.map((event) => event.seq));
        batch.push(...linesFromRunEvents(events));
      }
      if (log) {
        batch.push(...linesFromLogContent(log.content, state));
        if (log.nextOffset !== undefined) {
          state.logOffset = log.nextOffset;
        } else if (log.content.length > 0) {
          state.logOffset = (state.logOffset ?? 0) + log.content.length;
        }
      }
      if (batch.length > 0) {
        // Within a poll batch, interleave event + log lines chronologically.
        batch.sort((a, b) => a.ts.localeCompare(b.ts));
        state.lines = [...state.lines, ...batch].slice(-TAIL_KEEP_LINES);
      }

      return { status: run.status as string, lines: state.lines };
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_RUN_STATUSES.has(status) ? false : POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS,
  });

  const lines = tailQuery.data?.lines ?? [];

  // Auto-scroll: stick to the bottom while the user hasn't scrolled away
  // (standard "follow unless the user scrolled up" pattern).
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastLineKey = lines.length > 0 ? lines[lines.length - 1].key : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastLineKey, lines.length]);

  return (
    <section
      data-testid="live-run-tail"
      className="overflow-hidden rounded-md border border-border/60"
    >
      <header className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-2.5 py-1.5">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title ?? t("liveRunTail.heading", { defaultValue: "Live output" })}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          {runId.slice(0, 8)}
        </span>
      </header>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          followRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_TOLERANCE_PX;
        }}
        className="max-h-64 overflow-auto bg-muted/30 px-2.5 py-2 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground" data-testid="live-run-tail-empty">
            {t("liveRunTail.waiting", { defaultValue: "Waiting for output…" })}
          </p>
        ) : (
          lines.map((line) => (
            <div
              key={line.key}
              className={`whitespace-pre-wrap break-words ${
                line.stream === "stderr"
                  ? "text-amber-700 dark:text-amber-400"
                  : line.stream === "system"
                    ? "text-muted-foreground"
                    : "text-foreground"
              }`}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
