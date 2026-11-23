import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./Button";

export type InlineErrorProps = {
  message: string;
  onRetry?: () => void;
  /** If true, adds a note that displayed data may be stale */
  stale?: boolean;
};

/**
 * Inline error banner with optional retry button.
 * Replaces alert() calls throughout the app.
 * Uses role="alert" for screen reader announcement.
 */
export function InlineError({ message, onRetry, stale }: InlineErrorProps) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-status-warning-border bg-status-warning-bg p-3 text-sm"
    >
      <AlertTriangle size={16} className="text-status-warning shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-status-warning font-medium">{message}</p>
        {stale && (
          <p className="text-xs text-text-muted mt-0.5">
            Dữ liệu hiển thị có thể cũ.
          </p>
        )}
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw size={14} className="mr-1" /> Thử lại
        </Button>
      )}
    </div>
  );
}
