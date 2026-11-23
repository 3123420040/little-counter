import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { Button } from "./Button";

export type ScreenStateProps = {
  state: "loading" | "empty" | "error";
  title: string;
  body?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
};

export function ScreenState({ state, title, body, actionLabel, onAction }: ScreenStateProps) {
  const Icon = state === "loading" ? Loader2 : state === "error" ? AlertTriangle : Inbox;

  return (
    <div
      role={state === "error" ? "alert" : state === "loading" ? "status" : undefined}
      aria-busy={state === "loading" ? "true" : undefined}
      className="flex min-h-[140px] flex-col items-center justify-center rounded-lg border border-border-default bg-surface-panel p-6 text-center"
    >
      <Icon
        size={28}
        className={[
          "mb-3",
          state === "loading" ? "animate-spin text-action-primary" : "",
          state === "error" ? "text-status-danger" : "",
          state === "empty" ? "text-text-muted" : "",
        ].filter(Boolean).join(" ")}
      />
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      {body && <div className="mt-1 max-w-md text-sm text-text-muted">{body}</div>}
      {actionLabel && onAction && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
