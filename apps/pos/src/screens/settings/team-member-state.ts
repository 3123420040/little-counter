import type { TeamMemberDto, TeamMemberEffectiveStatus } from "../../api/settings-endpoints";

export const TEAM_MEMBER_STATUS_TONE = {
  active: "success",
  disabled: "danger",
  pending: "warning",
  revoked: "danger",
  scheduled: "info",
  expired: "neutral",
  suspended: "danger",
} as const satisfies Record<TeamMemberEffectiveStatus, "neutral" | "success" | "warning" | "danger" | "info">;

export const TEAM_MEMBER_STATUS_LABEL = {
  active: "Đang hoạt động",
  disabled: "Tạm khóa",
  pending: "Chờ duyệt",
  revoked: "Đã thu hồi",
  scheduled: "Chưa đến hiệu lực",
  expired: "Đã hết hiệu lực",
  suspended: "Tạm khóa toàn hệ thống",
} as const satisfies Record<TeamMemberEffectiveStatus, string>;

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasCurrentTeamMemberValidity(member: TeamMemberDto, now = new Date()): boolean {
  const nowMs = now.getTime();
  const from = timestamp(member.validFrom);
  const to = timestamp(member.validTo);
  if (!Number.isFinite(nowMs) || from === null || from > nowMs) return false;
  return member.validTo === null || (to !== null && to > nowMs);
}

export function canDisableTeamMembership(member: TeamMemberDto, now = new Date()): boolean {
  return member.membershipStatus === "active"
    && member.status === "active"
    && member.globalStatus === "active"
    && hasCurrentTeamMemberValidity(member, now);
}

export function canEnableTeamMembership(member: TeamMemberDto, now = new Date()): boolean {
  return member.membershipStatus === "disabled"
    && member.status === "disabled"
    && member.globalStatus === "active"
    && hasCurrentTeamMemberValidity(member, now);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short" }).format(new Date(value));
}

export function teamMemberAuthorityDetail(member: TeamMemberDto, now = new Date()): string | null {
  if (member.membershipStatus === "revoked") return "Quyền truy cập đã bị thu hồi";
  if (member.globalStatus === "suspended") return "Tài khoản bị tạm khóa toàn hệ thống";
  const from = timestamp(member.validFrom);
  const to = timestamp(member.validTo);
  if (from !== null && from > now.getTime()) return `Hiệu lực từ ${formatDate(member.validFrom)}`;
  if (member.validTo && to !== null && to <= now.getTime()) return `Hết hiệu lực ${formatDate(member.validTo)}`;
  if (member.membershipStatus === "pending") return "Quyền truy cập chưa được kích hoạt";
  if (member.membershipStatus === "disabled") return "Quyền truy cập đang bị khóa";
  if (member.validTo) return `Hiệu lực đến ${formatDate(member.validTo)}`;
  return null;
}
