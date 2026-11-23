import type { PlatformMembershipDto } from "../../api/settings-endpoints";

export const PLATFORM_MEMBERSHIP_STATUS_LABEL = {
  active: "Đang hiệu lực",
  disabled: "Tạm khóa",
  pending: "Chờ duyệt",
  revoked: "Đã thu hồi",
  scheduled: "Chưa đến hiệu lực",
  expired: "Đã hết hiệu lực",
} as const satisfies Record<PlatformMembershipDto["effectiveStatus"], string>;

export const PLATFORM_MEMBERSHIP_STATUS_TONE = {
  active: "success",
  disabled: "danger",
  pending: "warning",
  revoked: "danger",
  scheduled: "info",
  expired: "neutral",
} as const satisfies Record<PlatformMembershipDto["effectiveStatus"], "neutral" | "success" | "warning" | "danger" | "info">;

export function localMembershipDateTimeValue(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function membershipDateTimeToIso(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid membership timestamp");
  return parsed.toISOString();
}

export function platformMembershipValidityErrors(validFrom: string, validTo: string): { validFrom?: string; validTo?: string } {
  const from = validFrom ? new Date(validFrom).getTime() : Number.NaN;
  const to = validTo ? new Date(validTo).getTime() : null;
  return {
    validFrom: !validFrom ? "Chọn thời điểm bắt đầu hiệu lực." : !Number.isFinite(from) ? "Thời điểm bắt đầu không hợp lệ." : undefined,
    validTo: validTo && !Number.isFinite(to) ? "Thời điểm kết thúc không hợp lệ." : to !== null && Number.isFinite(from) && to <= from ? "Thời điểm kết thúc phải sau thời điểm bắt đầu." : undefined,
  };
}

export function platformMembershipRevokeReasonError(reason: string): string | undefined {
  const normalized = reason.trim();
  if (normalized.length < 4) return "Nhập lý do ít nhất 4 ký tự.";
  if (normalized.length > 500) return "Lý do không được vượt quá 500 ký tự.";
  return undefined;
}

export function platformMembershipValidityLabel(membership: PlatformMembershipDto): string {
  const format = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  return membership.validTo ? `${format(membership.validFrom)} đến ${format(membership.validTo)}` : `${format(membership.validFrom)} đến khi thu hồi`;
}
