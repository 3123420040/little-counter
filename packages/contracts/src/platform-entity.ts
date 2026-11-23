import { z } from "zod";

export const PlatformLifecycleCommandV1Schema = z.object({
  status: z.enum(["active", "suspended"]),
  expectedVersion: z.number().int().positive().safe(),
  reason: z.string().trim().min(1).max(500),
}).strict();
export type PlatformLifecycleCommandV1 = z.infer<typeof PlatformLifecycleCommandV1Schema>;
export const PlatformLifecycleCommandResultV1Schema = z.object({
  entityType: z.enum(["merchant", "store"]), entityId: z.string().min(1),
  status: z.enum(["active", "suspended"]), statusVersion: z.number().int().positive().safe(),
  changed: z.boolean(), statusChangedAt: z.string().datetime().nullable(),
}).strict();
export type PlatformLifecycleCommandResultV1 = z.infer<typeof PlatformLifecycleCommandResultV1Schema>;

export const PlatformEntityStatusSchema = z.enum([
  "active",
  "suspended",
  "closed",
]);
export type PlatformEntityStatus = z.infer<typeof PlatformEntityStatusSchema>;
export type PlatformEntityStatusFilter = PlatformEntityStatus | "all";
export const PlatformMerchantSummaryV1Schema = z
  .object({
    merchantId: z.string().min(1),
    displayName: z.string(),
    packageKey: z.enum(["basic", "plus", "ai_fan"]),
    subscriptionStatus: z.enum(["active", "grace", "expired"]),
    storeCount: z.number().int().nonnegative(),
    ownerCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    status: PlatformEntityStatusSchema,
    statusVersion: z.number().int().positive().safe(),
  })
  .strict();
export const PlatformStoreSummaryV1Schema = z
  .object({
    storeId: z.string().min(1),
    merchantId: z.string().min(1),
    merchantName: z.string(),
    internalName: z.string(),
    isPrimary: z.boolean(),
    stockLocationId: z.string().min(1),
    createdAt: z.string().datetime(),
    status: PlatformEntityStatusSchema,
    statusVersion: z.number().int().positive().safe(),
    merchantStatus: PlatformEntityStatusSchema,
    effectiveStatus: PlatformEntityStatusSchema,
  })
  .strict();
export const PlatformLifecycleAuditPageV1Schema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().min(1),
            actorId: z.string().min(1),
            action: z.string().min(1),
            beforeStatus: PlatformEntityStatusSchema.nullable(),
            afterStatus: PlatformEntityStatusSchema.nullable(),
            reason: z.string().nullable(),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(20),
    offset: z.number().int().min(0).max(100_000),
    limit: z.literal(20),
    hasMore: z.boolean(),
  })
  .strict();
export const PlatformMerchantDetailV1Schema =
  PlatformMerchantSummaryV1Schema.extend({
    stores: z.array(PlatformStoreSummaryV1Schema),
    owners: z.array(
      z
        .object({
          membershipId: z.string().min(1),
          operatorId: z.string().min(1),
          displayName: z.string(),
          scopeType: z.enum(["merchant", "store"]),
          storeId: z.string().nullable(),
          validFrom: z.string().datetime(),
          validTo: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    checkoutPolicy: z
      .object({
        status: z.enum(["ok", "invalid"]),
        enabled: z.boolean(),
        version: z.number().int().nonnegative().safe(),
        source: z.enum(["configured", "default"]),
        updatedAt: z.string().datetime().nullable(),
        updatedBy: z.string().nullable(),
      })
      .strict(),
    lifecycleAudit: PlatformLifecycleAuditPageV1Schema,
  }).strict();
export const PlatformStoreDetailV1Schema = PlatformStoreSummaryV1Schema.extend({
  lifecycleAudit: PlatformLifecycleAuditPageV1Schema,
}).strict();
export type PlatformMerchantSummaryV1 = z.infer<
  typeof PlatformMerchantSummaryV1Schema
>;
export type PlatformStoreSummaryV1 = z.infer<
  typeof PlatformStoreSummaryV1Schema
>;
export type PlatformMerchantDetailV1 = z.infer<
  typeof PlatformMerchantDetailV1Schema
>;
export type PlatformStoreDetailV1 = z.infer<typeof PlatformStoreDetailV1Schema>;
export type PlatformLifecycleAuditPageV1 = z.infer<
  typeof PlatformLifecycleAuditPageV1Schema
>;
