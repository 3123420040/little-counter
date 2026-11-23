import { z } from "zod";

export const RUNTIME_COMPATIBILITY_FAMILY_V1 = "snus-runtime-v1" as const;
export const PAYMENT_FEE_WRITE_HTTP_HEADER_V1 = "x-order-financial-contract" as const;
export const PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 = "orders.payment-fee.v1" as const;
export type PaymentFeeHttpContractV1 = "legacy" | typeof PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1;

export const runtimeCapabilityVersionsV1 = {
  ordersRead: ["v2", "v3", "v4"],
  orderDetail: ["v1", "v2"],
  orderRecreate: ["v1", "v2"],
  checkoutWrite: ["v1"],
  paymentWrite: ["v1"],
  dashboardRead: ["v1", "v2"],
} as const;

export type RuntimeCapabilityNameV1 = keyof typeof runtimeCapabilityVersionsV1;
export type RuntimeCapabilityVersionV1 =
  (typeof runtimeCapabilityVersionsV1)[RuntimeCapabilityNameV1][number];
export type RuntimeCapabilityTokenV1 = {
  [Capability in RuntimeCapabilityNameV1]:
    `${Capability}:${(typeof runtimeCapabilityVersionsV1)[Capability][number]}`;
}[RuntimeCapabilityNameV1];

export const runtimeCapabilityNamesV1 = Object.freeze(
  Object.keys(runtimeCapabilityVersionsV1) as RuntimeCapabilityNameV1[],
);

export const runtimeCapabilityTokensV1 = Object.freeze(
  runtimeCapabilityNamesV1.flatMap((capability) => (
    runtimeCapabilityVersionsV1[capability].map(
      (version) => `${capability}:${version}` as RuntimeCapabilityTokenV1,
    )
  )),
);

const RuntimeCapabilityVersionSchemasV1 = {
  ordersRead: z.enum(runtimeCapabilityVersionsV1.ordersRead),
  orderDetail: z.enum(runtimeCapabilityVersionsV1.orderDetail),
  orderRecreate: z.enum(runtimeCapabilityVersionsV1.orderRecreate),
  checkoutWrite: z.enum(runtimeCapabilityVersionsV1.checkoutWrite),
  paymentWrite: z.enum(runtimeCapabilityVersionsV1.paymentWrite),
  dashboardRead: z.enum(runtimeCapabilityVersionsV1.dashboardRead),
};

export const RuntimeCapabilitySetV1Schema = z.object({
  ordersRead: z.array(RuntimeCapabilityVersionSchemasV1.ordersRead),
  orderDetail: z.array(RuntimeCapabilityVersionSchemasV1.orderDetail),
  orderRecreate: z.array(RuntimeCapabilityVersionSchemasV1.orderRecreate),
  checkoutWrite: z.array(RuntimeCapabilityVersionSchemasV1.checkoutWrite),
  paymentWrite: z.array(RuntimeCapabilityVersionSchemasV1.paymentWrite),
  dashboardRead: z.array(RuntimeCapabilityVersionSchemasV1.dashboardRead),
}).strict().superRefine((value, context) => {
  for (const capability of runtimeCapabilityNamesV1) {
    const versions = value[capability];
    const canonical = runtimeCapabilityVersionsV1[capability];
    const positions = versions.map((version) => canonical.indexOf(version as never));
    if (
      new Set(versions).size !== versions.length
      || positions.some((position, index) => index > 0 && position <= positions[index - 1]!)
    ) {
      context.addIssue({
        code: "custom",
        path: [capability],
        message: `${capability} versions must be unique and in canonical order`,
      });
    }
  }
});
export type RuntimeCapabilitySetV1 = z.infer<typeof RuntimeCapabilitySetV1Schema>;

export const RuntimeBuildInfoV1Schema = z.object({
  service: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  releaseId: z.string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/)
    .refine((value) => value !== "unknown" && value !== "local"),
  compatibilityFamily: z.literal(RUNTIME_COMPATIBILITY_FAMILY_V1),
  capabilities: RuntimeCapabilitySetV1Schema,
}).strict();
export type RuntimeBuildInfoV1 = z.infer<typeof RuntimeBuildInfoV1Schema>;

export function emptyRuntimeCapabilitySetV1(): RuntimeCapabilitySetV1 {
  return {
    ordersRead: [],
    orderDetail: [],
    orderRecreate: [],
    checkoutWrite: [],
    paymentWrite: [],
    dashboardRead: [],
  };
}

export const paymentFeeCapabilityVersionsV1 = {
  ordersRead: ["v5"], orderDetail: ["v3"], orderRecreate: ["v3"],
  csvRead: ["v5"], dashboardRead: ["v3"], paymentFeeWrite: ["v1"],
} as const;
export type PaymentFeeCapabilityNameV1 = keyof typeof paymentFeeCapabilityVersionsV1;
export type PaymentFeeCapabilityTokenV1 = {
  [Capability in PaymentFeeCapabilityNameV1]: `${Capability}:${(typeof paymentFeeCapabilityVersionsV1)[Capability][number]}`;
}[PaymentFeeCapabilityNameV1];
export const paymentFeeCapabilityNamesV1 = Object.freeze(Object.keys(paymentFeeCapabilityVersionsV1) as PaymentFeeCapabilityNameV1[]);
export const paymentFeeCapabilityTokensV1 = Object.freeze(paymentFeeCapabilityNamesV1.flatMap((name) =>
  paymentFeeCapabilityVersionsV1[name].map((version) => `${name}:${version}` as PaymentFeeCapabilityTokenV1)));
export const PaymentFeeCapabilitySetV1Schema = z.object({
  ordersRead: z.array(z.literal("v5")).max(1),
  orderDetail: z.array(z.literal("v3")).max(1),
  orderRecreate: z.array(z.literal("v3")).max(1),
  csvRead: z.array(z.literal("v5")).max(1),
  dashboardRead: z.array(z.literal("v3")).max(1),
  paymentFeeWrite: z.array(z.literal("v1")).max(1),
}).strict();
export type PaymentFeeCapabilitySetV1 = z.infer<typeof PaymentFeeCapabilitySetV1Schema>;
export function emptyPaymentFeeCapabilitySetV1(): PaymentFeeCapabilitySetV1 {
  return { ordersRead: [], orderDetail: [], orderRecreate: [], csvRead: [], dashboardRead: [], paymentFeeWrite: [] };
}
export const RuntimeBuildInfoV2Schema = RuntimeBuildInfoV1Schema.extend({
  schemaVersion: z.literal(2),
  paymentFeeCapabilities: PaymentFeeCapabilitySetV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.paymentFeeCapabilities.paymentFeeWrite.includes("v1") && (
    paymentFeeCapabilityNamesV1.some((name) => value.paymentFeeCapabilities[name].length === 0)
    || !value.capabilities.checkoutWrite.includes("v1") || !value.capabilities.paymentWrite.includes("v1")
  )) ctx.addIssue({ code: "custom", message: "Fee writes require all fee-aware reads and checkout/payment readiness" });
});
export type RuntimeBuildInfoV2 = z.infer<typeof RuntimeBuildInfoV2Schema>;
