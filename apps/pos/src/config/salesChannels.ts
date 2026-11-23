export const SALES_CHANNELS = [
  { value: "pos_counter", label: "Tại quầy" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "zalo", label: "Zalo" },
  { value: "instagram", label: "Instagram" },
  { value: "telegram", label: "Telegram" },
  { value: "website", label: "Website" },
  { value: "stash_dash", label: "Stash Dash" },
] as const;

export type SalesChannelValue = (typeof SALES_CHANNELS)[number]["value"];

export function salesChannelLabel(value?: string | null): string {
  if (value === "partner_api") return "Partner API";
  return SALES_CHANNELS.find((channel) => channel.value === value)?.label || "Chưa xác định";
}
