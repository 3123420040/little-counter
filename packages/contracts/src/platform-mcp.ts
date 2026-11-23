import { z } from "zod";
import {
  PartnerControlReasonSchema,
  PartnerControlPolicy,
} from "./partner-api/control";

export const platformMcpIssuancePresetV1 = Object.freeze({
  version: "platform-mcp-v1",
  policy: Object.freeze(
    PartnerControlPolicy.parse({
      currency: "VND",
      max_order_total: 10_000_000,
      max_quantity: 100,
      safety_stock: 0,
      delivery_fee: null,
      contact_retention_days: 30,
      read_per_minute: 120,
      read_burst: 20,
      quote_per_minute: 30,
      quote_burst: 5,
      book_per_minute: 10,
      book_burst: 2,
      mutation_concurrency: 2,
    }),
  ),
});

const version = z.number().int().positive().safe();
const label = z.string().trim().min(1).max(128);
const profile = z.enum(["read", "commerce"]).default("read");
const expectedAuthorizationSnapshotSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.enum([
  "partner:read",
  "catalog:read",
  "inventory:read",
  "orders:read",
  "orders:quote",
  "orders:write",
]);
export const PlatformMcpCommandMetadataV1Schema = z
  .object({
    receiptId: z.uuid(),
    merchantId: z.string().min(1).max(128),
    integrationId: z.string().min(1).max(128),
    environment: z.enum(["sandbox", "production"]),
    integrationVersion: version,
    integrationStatus: z.enum(["inactive", "active", "paused", "revoked"]),
    writesEnabled: z.boolean(),
    mcpUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/mcp"
        );
      })
      .nullable(),
    key: z
      .object({
        id: z.string().regex(/^[a-f0-9]{32}$/),
        version,
        status: z.enum(["active", "revoked"]),
        label,
        scopes: z
          .array(scope)
          .min(1)
          .max(6)
          .refine((values) => new Set(values).size === values.length),
        expiresAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PlatformMcpCommandMetadataV1 = z.infer<
  typeof PlatformMcpCommandMetadataV1Schema
>;
const storeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const pageLimit = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(50))
  .default(50);
export const PlatformMcpListQueryV1Schema = z
  .object({
    after: storeId.optional(),
    limit: pageLimit,
    status: z.enum(["inactive", "active", "paused", "revoked"]).optional(),
  })
  .strict();
export const PlatformMcpDetailQueryV1Schema = z
  .object({
    limit: pageLimit,
    keysAfter: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    grantsAfter: storeId.optional(),
    receiptsAfter: z.uuid().optional(),
  })
  .strict();
export const PlatformMcpConnectionSummaryV1Schema = z
  .object({
    integrationId: storeId,
    merchantId: storeId,
    name: z.string().min(1).max(120),
    environment: z.enum(["sandbox", "production"]),
    status: z.enum(["inactive", "active", "paused", "revoked"]),
    writesEnabled: z.boolean(),
    integrationVersion: version,
    merchantStatus: z.enum(["active", "suspended", "closed"]),
    managedByPlatform: z.boolean(),
    hasOauthClients: z.boolean(),
  })
  .strict();
export type PlatformMcpConnectionSummaryV1 = z.infer<
  typeof PlatformMcpConnectionSummaryV1Schema
>;
export const PlatformMcpConnectionListV1Schema = z
  .object({
    data: z.array(PlatformMcpConnectionSummaryV1Schema).max(50),
    nextAfter: storeId.nullable(),
    canRevokeKeys: z.boolean(),
    mcpUrl: PlatformMcpCommandMetadataV1Schema.shape.mcpUrl,
  })
  .strict();
export type PlatformMcpConnectionListV1 = z.infer<
  typeof PlatformMcpConnectionListV1Schema
>;
const metadataKey = PlatformMcpCommandMetadataV1Schema.shape.key.unwrap();
export const PlatformMcpConnectionDetailV1Schema = z
  .object({
    connection: PlatformMcpConnectionSummaryV1Schema,
    canRevokeKeys: z.boolean(),
    mcpUrl: PlatformMcpCommandMetadataV1Schema.shape.mcpUrl,
    authorizationSnapshotSha256: expectedAuthorizationSnapshotSha256.nullable(),
    authorizationWarning: z.literal("mcp_approval_invalid").nullable(),
    maxApprovedProfile: z.enum(["read", "commerce"]).nullable(),
    keys: z
      .object({
        data: z
          .array(
            metadataKey
              .extend({
                createdAt: z.string().datetime(),
                revokedAt: z.string().datetime().nullable(),
              })
              .strict(),
          )
          .max(50),
        nextAfter: z
          .string()
          .regex(/^[a-f0-9]{32}$/)
          .nullable(),
      })
      .strict(),
    grants: z
      .object({
        data: z
          .array(
            z
              .object({
                storeId,
                stockLocationId: storeId,
                status: z.enum(["active", "inactive", "revoked"]),
                scopes: z.array(scope).max(6),
                catalogMode: z.enum(["explicit", "merchant_published"]),
                version,
                assortmentId: storeId,
                storeStatus: z.enum(["active", "suspended", "closed"]),
              })
              .strict(),
          )
          .max(50),
        nextAfter: storeId.nullable(),
      })
      .strict(),
    receipts: z
      .object({
        data: z
          .array(
            z
              .object({
                receiptId: z.uuid(),
                actorId: z.string().min(1).max(256),
                operation: z.enum([
                  "create_connection",
                  "issue_key",
                  "rotate_key",
                  "revoke_key",
                  "set_status",
                ]),
                state: z.enum(["completed", "tombstone"]),
                resultKeyId: z
                  .string()
                  .regex(/^[a-f0-9]{32}$/)
                  .nullable(),
                createdAt: z.string().datetime(),
              })
              .strict(),
          )
          .max(50),
        nextAfter: z.uuid().nullable(),
      })
      .strict(),
  })
  .strict();
export type PlatformMcpConnectionDetailV1 = z.infer<
  typeof PlatformMcpConnectionDetailV1Schema
>;
const storeIds = z
  .array(storeId)
  .min(1)
  .max(20)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Store identities must be unique",
  )
  .transform((ids) => [...ids].sort());

export const PlatformMcpCreateConnectionV1Schema = z
  .object({
    name: z.string().trim().min(1).max(120),
    label: label.optional(),
    storeIds,
    profile,
    reason: PartnerControlReasonSchema,
  })
  .strict();
export const PlatformMcpIssueKeyV1Schema = z
  .object({
    label: label.optional(),
    profile,
    expectedIntegrationVersion: version,
    expectedAuthorizationSnapshotSha256,
    reason: PartnerControlReasonSchema,
  })
  .strict();
export const PlatformMcpRotateKeyV1Schema = z
  .object({
    expectedIntegrationVersion: version,
    expectedKeyVersion: version,
    expectedAuthorizationSnapshotSha256,
    reason: z.literal("credential_rotation"),
  })
  .strict();
export const PlatformMcpRevokeKeyV1Schema = z
  .object({
    expectedKeyVersion: version,
    reason: PartnerControlReasonSchema,
  })
  .strict();
export const PlatformMcpChangeStatusV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("paused"),
      expectedIntegrationVersion: version,
      reason: PartnerControlReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("active"),
      profile,
      expectedIntegrationVersion: version,
      expectedAuthorizationSnapshotSha256,
      reason: PartnerControlReasonSchema,
    })
    .strict(),
]);
export type PlatformMcpCreateConnectionV1 = z.infer<
  typeof PlatformMcpCreateConnectionV1Schema
>;
export type PlatformMcpIssueKeyV1 = z.infer<typeof PlatformMcpIssueKeyV1Schema>;
export type PlatformMcpRotateKeyV1 = z.infer<
  typeof PlatformMcpRotateKeyV1Schema
>;
export type PlatformMcpRevokeKeyV1 = z.infer<
  typeof PlatformMcpRevokeKeyV1Schema
>;
export type PlatformMcpChangeStatusV1 = z.infer<
  typeof PlatformMcpChangeStatusV1Schema
>;

export const PlatformMcpRotationV1Schema = z
  .object({
    previousKeyId: z.string().regex(/^[a-f0-9]{32}$/),
    previousKeyVersion: version,
    previousKeyExpiresAt: z.string().datetime(),
  })
  .strict();
export type PlatformMcpRotationV1 = z.infer<typeof PlatformMcpRotationV1Schema>;
export const PlatformMcpCommandResultV1Schema = z
  .union([
    z
      .object({
        data: PlatformMcpCommandMetadataV1Schema,
        replayed: z.literal(false),
        requestState: z.literal("completed"),
        secretStatus: z.literal("available_once"),
        revealedKey: z
          .string()
          .regex(/^snus_mcp_(test|live)_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/),
        rotation: PlatformMcpRotationV1Schema.optional(),
      })
      .strict(),
    z
      .object({
        data: PlatformMcpCommandMetadataV1Schema,
        replayed: z.literal(false),
        requestState: z.literal("completed"),
        secretStatus: z.literal("not_applicable"),
      })
      .strict(),
    z
      .object({
        data: PlatformMcpCommandMetadataV1Schema,
        replayed: z.literal(true),
        requestState: z.literal("completed"),
        secretStatus: z.literal("unavailable_on_replay"),
      })
      .strict(),
    z
      .object({
        data: z
          .object({
            receiptId: z.uuid(),
            integrationId: storeId,
            keyId: z
              .string()
              .regex(/^[a-f0-9]{32}$/)
              .nullable(),
          })
          .strict(),
        replayed: z.literal(true),
        requestState: z.literal("expired"),
        secretStatus: z.literal("unavailable_on_replay"),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.secretStatus !== "available_once") return;
    const match = /^snus_mcp_(test|live)_([a-f0-9]{32})\./.exec(
      value.revealedKey,
    );
    if (
      !value.data.key ||
      value.data.key.status !== "active" ||
      !value.data.mcpUrl ||
      match?.[1] !==
        (value.data.environment === "production" ? "live" : "test") ||
      match?.[2] !== value.data.key.id ||
      value.rotation?.previousKeyId === value.data.key.id
    ) {
      ctx.addIssue({
        code: "custom",
        message: "One-time credential does not match its committed metadata",
      });
    }
  });
export type PlatformMcpCommandResultV1 = z.infer<
  typeof PlatformMcpCommandResultV1Schema
>;
