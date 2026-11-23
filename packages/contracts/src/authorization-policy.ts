import { z } from "zod";
import { membershipScopeTypes, permissionIds } from "./index";

const IdSchema = z.string().min(1);

export const AuthorizationTargetV1Schema = z.discriminatedUnion("scopeType", [
  z.object({ scopeType: z.literal("platform") }).strict(),
  z.object({
    scopeType: z.literal("merchant"),
    merchantId: IdSchema,
  }).strict(),
  z.object({
    scopeType: z.literal("store"),
    merchantId: IdSchema,
    storeId: IdSchema,
  }).strict(),
]);
export type AuthorizationTargetV1 = z.infer<typeof AuthorizationTargetV1Schema>;

export const ScopeCoupledAuthorizationDecisionV1Schema = z.object({
  allowed: z.boolean(),
  permissionId: z.enum(permissionIds),
  target: AuthorizationTargetV1Schema,
  proof: z.object({
    sourceType: z.enum(["membership", "explicit_grant"]),
    sourceId: IdSchema,
    scopeType: z.enum(membershipScopeTypes),
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.allowed !== Boolean(value.proof)) {
    context.addIssue({
      code: "custom",
      path: ["proof"],
      message: "allowed decisions require exactly one proof; denied decisions require none",
    });
  }
});
export type ScopeCoupledAuthorizationDecisionV1 = z.infer<
  typeof ScopeCoupledAuthorizationDecisionV1Schema
>;
