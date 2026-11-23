import type { RuntimeCapabilityTokenV1, PaymentFeeCapabilityTokenV1 } from "@medusa-snus/contracts/runtime-capabilities";

export const runtimeCapabilityRouteManifestV1 = {
  "ordersRead:v2": "src/api/admin/orders/effective/route.ts",
  "ordersRead:v3": "src/api/admin/orders/effective-v3/route.ts",
  "ordersRead:v4": "src/api/admin/orders/effective-v4/route.ts",
  "orderDetail:v1": "src/api/admin/orders/[id]/route.ts",
  "orderDetail:v2": "src/api/admin/orders/[id]/effective/route.ts",
  "orderRecreate:v1": "src/api/orders/[id]/recreate-prefill/route.ts",
  "orderRecreate:v2": "src/api/orders/[id]/effective-recreate-prefill-v2/route.ts",
  "checkoutWrite:v1": "src/api/pos/carts/complete/route.ts",
  "paymentWrite:v1": "src/api/payment-intents/route.ts",
  "dashboardRead:v1": "src/api/dashboard/route.ts",
  "dashboardRead:v2": "src/api/admin/dashboard/creator-sales-v2/route.ts",
} as const satisfies Record<RuntimeCapabilityTokenV1, string>;

export const compiledRuntimeCapabilityRouteTokensV1 = Object.freeze(
  Object.keys(runtimeCapabilityRouteManifestV1) as RuntimeCapabilityTokenV1[],
);

export const paymentFeeCapabilityRouteManifestV1 = {
  "orderRecreate:v3": "src/api/orders/[id]/effective-recreate-prefill-v3/route.ts",
  "dashboardRead:v3": "src/api/admin/dashboard/creator-sales-v3/route.ts",
  "csvRead:v5": "src/api/admin/orders/export-effective-v5/route.ts",
  "ordersRead:v5": "src/api/admin/orders/effective-v5/route.ts",
  "orderDetail:v3": "src/api/admin/orders/[id]/effective-v3/route.ts",
  "paymentFeeWrite:v1": "src/api/pos/carts/complete/route.ts",
} as const satisfies Partial<Record<PaymentFeeCapabilityTokenV1, string>>;
export const compiledPaymentFeeCapabilityRouteTokensV1 = Object.freeze(
  Object.keys(paymentFeeCapabilityRouteManifestV1) as PaymentFeeCapabilityTokenV1[],
);
