import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

type ErrorBoundaryFallbackRender = (args: { error: Error; reset: () => void }) => ReactNode;

type ErrorBoundaryProps = {
  children: ReactNode;
  /**
   * When any value in this array changes while the boundary is showing its
   * fallback, the boundary resets and re-renders `children`. Pass the route
   * pathname here so navigating away from a crashed page auto-recovers.
   */
  resetKeys?: ReadonlyArray<unknown>;
  /** Custom fallback. Receives the caught error + a `reset()` callback. */
  fallback?: ErrorBoundaryFallbackRender;
  /** Side-effect on catch (telemetry/logging). Never used for rendering. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Extra classes for the default fallback's outer container. */
  className?: string;
};

type ErrorBoundaryState = {
  error: Error | null;
};

function resetKeysChanged(
  prev: ReadonlyArray<unknown> | undefined,
  next: ReadonlyArray<unknown> | undefined,
): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * A reusable React error boundary. On the happy path it is a pure passthrough
 * (renders `children` verbatim), so wrapping a subtree changes nothing until a
 * descendant throws during render. When one does, it renders a graceful,
 * localized fallback instead of letting the crash propagate to the root and
 * blank the whole control plane.
 *
 * Use it at the route level (keyed on the pathname) to keep the app shell —
 * sidebar, nav, breadcrumb — alive when a single page component throws.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface for dev + any wired telemetry; never silently swallow.
    console.error("UI render error caught by ErrorBoundary", {
      error,
      componentStack: info.componentStack,
    });
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback({ error, reset: this.reset });
      }
      return <ErrorBoundaryFallback error={error} reset={this.reset} className={this.props.className} />;
    }
    return this.props.children;
  }
}

function ErrorBoundaryFallback({
  error,
  reset,
  className,
}: {
  error: Error;
  reset: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn("flex min-h-[12rem] w-full items-center justify-center p-6", className)}
    >
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border border-border bg-card p-6 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">
            {t("errorBoundary.title", { defaultValue: "Something went wrong" })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("errorBoundary.description", {
              defaultValue: "This view ran into an unexpected error. You can try again, or reload the page.",
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={reset} size="sm">
            <RotateCcw className="size-4" />
            {t("errorBoundary.retry", { defaultValue: "Try again" })}
          </Button>
          <Button onClick={() => window.location.reload()} variant="outline" size="sm">
            {t("errorBoundary.reload", { defaultValue: "Reload page" })}
          </Button>
        </div>
        {error.message ? (
          <details className="w-full text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              {t("errorBoundary.detailsLabel", { defaultValue: "Technical details" })}
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-left font-mono text-xs text-muted-foreground">
              {error.message}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
