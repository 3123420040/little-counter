import { z } from "zod";

const name = z.string().trim().min(2).max(120).regex(/^[^\p{Cc}]+$/u);

export const createPlatformMerchantSchema = z.object({
  displayName: name,
  storeName: name,
  ownerOperatorId: z.string().trim().min(1).max(160).regex(/^[^\p{Cc}]+$/u),
  timezone: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Chọn múi giờ IANA hợp lệ."),
}).strict();

export type CreatePlatformMerchantInput = z.infer<typeof createPlatformMerchantSchema>;

export interface CreatedPlatformMerchant {
  merchantId: string;
  displayName: string;
  storeId: string;
  storeName: string;
  stockLocationId: string;
  ownerOperatorId: string;
  timezone: string;
  packageKey: "basic";
}
