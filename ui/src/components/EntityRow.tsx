import { type ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

interface EntityRowProps {
  leading?: ReactNode;
  identifier?: string;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  selected?: boolean;
  to?: string;
  onClick?: () => void;
  className?: string;
  reserveSubtitleSpace?: boolean;
}

export function EntityRow({
  leading,
  identifier,
  title,
  subtitle,
  trailing,
  selected,
  to,
  onClick,
  className,
  reserveSubtitleSpace,
}: EntityRowProps) {
  const isClickable = !!(to || onClick);
  const classes = cn(
    "flex items-center gap-3 px-4 py-2 text-sm border-b border-border last:border-b-0 transition-colors",
    isClickable && "cursor-pointer hover:bg-accent/50",
    selected && "bg-accent/30",
    className
  );

  const content = (
    <>
      {leading && <div className="flex items-center gap-2 shrink-0">{leading}</div>}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {identifier && (
            <span className="text-xs text-muted-foreground font-mono shrink-0 relative top-[1px]">
              {identifier}
            </span>
          )}
          <span className="truncate">{title}</span>
        </div>
        {(subtitle || reserveSubtitleSpace) && (
          <p
            className={cn("text-xs text-muted-foreground truncate mt-0.5 min-h-4", !subtitle && "invisible")}
            aria-hidden={!subtitle}
          >
            {subtitle}
          </p>
        )}
      </div>
      {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={cn("no-underline text-inherit", classes)} onClick={onClick}>
        {content}
      </Link>
    );
  }

  // onClick-only rows are interactive but render as a plain div, so make them
  // keyboard-operable: focusable, button-roled, and Enter/Space activate.
  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        className={cn(
          classes,
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        {content}
      </div>
    );
  }

  return <div className={classes}>{content}</div>;
}
