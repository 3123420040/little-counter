import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import { Button } from "./Button";

export type MutationBannerTone = "pending" | "success" | "error" | "warning" | "info";

export type MutationBannerProps = {
  tone: MutationBannerTone;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

const TONE_CLASSES: Record<MutationBannerTone, string> = {
  pending: "border-status-info-border bg-status-info-bg text-status-info",
  success: "border-status-success-border bg-status-success-bg text-status-success",
  error: "border-status-danger-border bg-status-danger-bg text-status-danger",
  warning: "border-status-warning-border bg-status-warning-bg text-status-warning",
  info: "border-status-info-border bg-status-info-bg text-status-info",
};

export function MutationBanner({ tone, message, actionLabel, onAction }: MutationBannerProps) {
  const Icon = tone === "pending" ? Loader2 : tone === "success" ? CheckCircle2 : tone === "error" ? AlertTriangle : Info;

  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${TONE_CLASSES[tone]}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={16} className={tone === "pending" ? "mt-0.5 shrink-0 animate-spin" : "mt-0.5 shrink-0"} />
      <span className="min-w-0 flex-1 font-medium">{message}</span>
      {actionLabel && onAction && (
        <Button variant="secondary" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
