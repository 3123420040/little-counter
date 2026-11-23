import type { ReactNode } from "react";

/** Minimal, designed (not raw) states for loading / error / empty / unavailable. */
export function ScreenState({
  icon,
  title,
  body,
  action,
  tone = "neutral",
  animate = true,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  tone?: "neutral" | "ember";
  animate?: boolean;
}) {
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center gap-4 px-7 py-16 text-center ${
        animate ? "sd-rise" : ""
      }`}
    >
      {icon ? (
        <div
          className={`grid h-16 w-16 place-items-center rounded-full ${
            tone === "ember" ? "bg-dash-tint text-dash-deep" : "bg-paper-deep text-ink-soft"
          }`}
        >
          {icon}
        </div>
      ) : null}
      <h2 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h2>
      {body ? <p className="max-w-[28ch] text-[15px] leading-relaxed text-ink-muted">{body}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** Skeleton shimmer for the initial product load. */
export function ProductSkeleton() {
  return (
    <div className="sd-rise flex flex-1 flex-col">
      <div className="sd-pad pt-2">
        <div className="h-4 w-24 rounded-pill bg-paper-deep" />
      </div>
      <div className="sd-pad mt-4">
        <div className="sd-tin opacity-60" style={{ background: "rgb(var(--paper-deep-rgb))" }} />
      </div>
      <div className="sd-pad mt-6 space-y-3">
        <div className="h-12 w-2/3 rounded-md bg-paper-deep" />
        <div className="h-4 w-1/2 rounded-pill bg-paper-deep" />
        <div className="h-4 w-4/5 rounded-pill bg-paper-deep" />
      </div>
    </div>
  );
}
