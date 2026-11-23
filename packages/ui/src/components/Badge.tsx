import { StatusPill, type StatusTone } from "./StatusPill";

export type BadgeProps = {
  /** Badge variant drives color + default label */
  variant: "risk" | "eligibility" | "stock" | "tier";
  /** The raw value (e.g., "low", "eligible", "available", "gold") */
  value: string;
};

const badgeMap = {
  risk: {
    items: {
      low:     { label: "Thấp",     tone: "success" as StatusTone },
      medium:  { label: "Trung bình", tone: "warning" as StatusTone },
      high:    { label: "Cao",      tone: "danger" as StatusTone },
      blocked: { label: "Bị chặn",  tone: "danger" as StatusTone },
    },
  },
  stock: {
    items: {
      available:     { label: "Còn hàng",    tone: "success" as StatusTone },
      low_stock:     { label: "Sắp hết",     tone: "warning" as StatusTone },
      out_of_stock:  { label: "Hết hàng",    tone: "danger" as StatusTone },
      discontinued:  { label: "Ngừng bán",   tone: "neutral" as StatusTone },
    },
  },
  tier: {
    items: {
      bronze:   { label: "Đồng",   tone: "neutral" as StatusTone },
      silver:   { label: "Bạc",    tone: "info" as StatusTone },
      gold:     { label: "Vàng",   tone: "warning" as StatusTone },
      platinum: { label: "Bạch kim", tone: "success" as StatusTone },
    },
  },
  eligibility: {
    items: {
      unknown:         { label: "Chưa XĐ",  tone: "neutral" as StatusTone },
      pending:         { label: "Đang chờ", tone: "warning" as StatusTone },
      eligible:        { label: "Đủ ĐK",   tone: "success" as StatusTone },
      not_eligible:    { label: "Không Đủ", tone: "danger" as StatusTone },
      review_required: { label: "Cần duyệt", tone: "info" as StatusTone },
      expired:         { label: "Hết hạn",  tone: "warning" as StatusTone },
    },
  },
};

/**
 * Semantic badges that map domain values to StatusPills with correct tones and labels.
 *
 * @example
 * <Badge variant="risk" value="low" />          → green "Thấp"
 * <Badge variant="stock" value="available" />   → green "Còn hàng"
 * <Badge variant="tier" value="gold" />         → warning "Vàng"
 */
export function Badge({ variant, value }: BadgeProps) {
  const config = badgeMap[variant];
  const item = (config.items as Record<string, { label: string; tone: StatusTone }>)[value]
    ?? { label: value, tone: "neutral" as StatusTone };
  return <StatusPill label={item.label} tone={item.tone} />;
}
