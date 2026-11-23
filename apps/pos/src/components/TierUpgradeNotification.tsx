import { Trophy, X } from "lucide-react";
import { useEffect, useState } from "react";

interface TierUpgradeNotificationProps {
  oldTier: string;
  newTier: string;
  points: number;
  onClose: () => void;
}

const TIER_LABELS: Record<string, string> = {
  bronze: "Đồng",
  silver: "Bạc",
  gold: "Vàng",
  platinum: "Bạch kim",
};

export function TierUpgradeNotification({ oldTier, newTier, points, onClose }: TierUpgradeNotificationProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(true);
    const t = setTimeout(() => { setVisible(false); setTimeout(onClose, 300); }, 5000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div
      className={[
        "fixed right-4 top-20 z-[var(--z-toast)] transition-all duration-300",
        visible ? "translate-x-0 opacity-100" : "translate-x-full opacity-0",
      ].join(" ")}
    >
      <div className="flex w-80 items-start gap-3 rounded-xl border border-status-success-border bg-status-success-bg p-4 shadow-lg">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-status-success text-white">
          <Trophy size={20} />
        </div>
        <div className="flex-1 text-sm">
          <p className="font-bold text-status-success">Thăng hạng!</p>
          <p className="text-text-secondary mt-0.5">
            {TIER_LABELS[oldTier] || oldTier} → {TIER_LABELS[newTier] || newTier}
          </p>
          <p className="text-xs text-text-muted mt-0.5">{points.toLocaleString("vi-VN")} điểm tích lũy</p>
        </div>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
