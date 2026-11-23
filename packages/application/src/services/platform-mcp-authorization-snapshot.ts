import { createHash } from "node:crypto";
import { z } from "zod";
import { PartnerControlPolicy, partnerScopes } from "@medusa-snus/contracts/partner-api";
import { canonicalPartnerJson } from "../partner/fingerprints";

const id = z.string().min(1).max(128);
const version = z.number().int().positive().safe();
const scopes = z.array(z.enum(partnerScopes)).max(6).refine(values => new Set(values).size === values.length);
const approval = z.object({
  workflowVersion: z.literal("platform-mcp-v1"), maxApprovedProfile: z.enum(["read", "commerce"]),
  approvedScopes: scopes, approvedStoreIds: z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length),
  presetVersion: z.literal("platform-mcp-v1"), policyId: id, policyVersion: version,
  policySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const PlatformMcpAuthorizationSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1), environment: z.enum(["sandbox", "production"]), merchantId: id, integrationId: id,
  integration: z.object({ status: z.enum(["inactive", "active", "paused", "revoked"]), writesEnabled: z.boolean(),
    version, policyId: id, policyVersion: version, policy: PartnerControlPolicy }).strict(),
  grants: z.array(z.object({
    storeId: id, stockLocationId: id, status: z.enum(["active", "inactive", "revoked"]), allowedScopes: scopes,
    mcpCatalogMode: z.enum(["explicit", "merchant_published"]), grantVersion: version, assortmentId: id,
    assortmentStatus: z.enum(["active", "inactive"]), assortmentVersion: version,
  }).strict()).refine(grants => new Set(grants.map(grant => grant.storeId)).size === grants.length),
  approval: approval.nullable(),
}).strict();
export type PlatformMcpAuthorizationSnapshotV1 = z.infer<typeof PlatformMcpAuthorizationSnapshotV1Schema>;

export function hashPlatformMcpPolicyV1(input: unknown): string {
  return createHash("sha256").update(canonicalPartnerJson(PartnerControlPolicy.parse(input))).digest("hex");
}

/** A resource CAS proof, never an authority credential; loader must include every grant page. */
export function hashPlatformMcpAuthorizationSnapshotV1(input: unknown): string {
  const value = PlatformMcpAuthorizationSnapshotV1Schema.parse(input);
  value.grants.sort((a, b) => a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0);
  for (const grant of value.grants) grant.allowedScopes.sort();
  if (value.approval) { value.approval.approvedScopes.sort(); value.approval.approvedStoreIds.sort(); }
  return createHash("sha256").update(canonicalPartnerJson(value)).digest("hex");
}
