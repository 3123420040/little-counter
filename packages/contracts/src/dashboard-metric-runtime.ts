import { z } from "zod";
import {
  DASHBOARD_VISIBLE_FACTOR_IDS_V1,
  DashboardMetricRegistryFactorV1Schema,
  DashboardPartialFinancialHttpBodyV1Schema,
} from "./order-financial-correctness";

export const DashboardMetricRuntimeDependencyV1Schema = z.enum([
  "report_context",
  "accounting_snapshot",
  "commercial_snapshot",
  "commercial_daily_series",
  "commercial_collection_daily_series",
  "merchant_ai_review_snapshot",
  "merchant_catalog_snapshot",
  "merchant_customer_snapshot",
  "payment_method_snapshot",
  "selected_store_inventory_snapshot",
  "unattached",
]);
export type DashboardMetricRuntimeDependencyV1 = z.infer<
  typeof DashboardMetricRuntimeDependencyV1Schema
>;

export const DashboardMetricRuntimeRegistryFactorV2Schema = z.object({
  ...DashboardMetricRegistryFactorV1Schema.shape,
  implementationState: z.union([
    DashboardMetricRegistryFactorV1Schema.shape.implementationState,
    z.literal("runtime_bound"),
  ]),
  activationStatus: z.literal("runtime_bound"),
  runtimeDependency: DashboardMetricRuntimeDependencyV1Schema,
}).strict().superRefine((value, ctx) => {
  for (const field of [
    "targetMetricIds",
    "unavailableTargetMetricIds",
    "targetSources",
    "timeBasis",
    "activationDependencies",
  ] as const) {
    const items = value[field];
    const sorted = [...items].sort();
    if (
      new Set(items).size !== items.length
      || items.some((item, index) => item !== sorted[index])
    ) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} must be unique and sorted`,
      });
    }
  }
  const overlap = value.targetMetricIds.filter((metricId) => (
    value.unavailableTargetMetricIds.includes(metricId)
  ));
  if (overlap.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["unavailableTargetMetricIds"],
      message: "available and unavailable dashboard target metrics must be disjoint",
    });
  }
  if (
    value.implementationState === "blocked_dependency"
    && value.activationDependencies.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["activationDependencies"],
      message: "blocked dashboard factor requires an explicit dependency",
    });
  }
  if (
    value.runtimeDependency === "unattached"
    && value.implementationState === "runtime_bound"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["implementationState"],
      message: "unattached dashboard factor cannot be implementation-bound",
    });
  }
  if (
    value.runtimeDependency !== "unattached"
    && value.implementationState !== "runtime_bound"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["implementationState"],
      message: "attached dashboard factor requires runtime-bound implementation state",
    });
  }
});
export type DashboardMetricRuntimeRegistryFactorV2 = z.infer<
  typeof DashboardMetricRuntimeRegistryFactorV2Schema
>;

export const DashboardMetricRuntimeRegistryV2Schema = z.object({
  schemaVersion: z.literal(2),
  registryStatus: z.literal("runtime_bound_partial_v1"),
  factors: z.array(DashboardMetricRuntimeRegistryFactorV2Schema).length(
    DASHBOARD_VISIBLE_FACTOR_IDS_V1.length,
  ),
}).strict().superRefine((value, ctx) => {
  const factorIds = value.factors.map((factor) => factor.factorId);
  if (
    factorIds.length !== DASHBOARD_VISIBLE_FACTOR_IDS_V1.length
    || factorIds.some((factorId, index) => (
      factorId !== DASHBOARD_VISIBLE_FACTOR_IDS_V1[index]
    ))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["factors"],
      message: "runtime dashboard registry must cover the exact visible factor order",
    });
  }
});
export type DashboardMetricRuntimeRegistryV2 = z.infer<
  typeof DashboardMetricRuntimeRegistryV2Schema
>;

export const DashboardMetricRuntimeFactorV1Schema =
  DashboardMetricRuntimeRegistryFactorV2Schema.safeExtend({
    runtimeStatus: z.enum(["available", "unavailable"]),
    runtimeDataQualityStatus: z.enum(["complete", "partial", "unavailable"]),
    runtimeReason: z.string().min(1),
  }).superRefine((value, ctx) => {
    if (
      value.runtimeDependency === "unattached"
      && value.runtimeStatus !== "unavailable"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeStatus"],
        message: "unattached dashboard factor cannot be available",
      });
    }
    if (
      value.runtimeStatus === "available"
      && value.runtimeDataQualityStatus === "unavailable"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeDataQualityStatus"],
        message: "available dashboard factor cannot have unavailable data quality",
      });
    }
    if (
      value.runtimeStatus === "unavailable"
      && value.runtimeDataQualityStatus !== "unavailable"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeDataQualityStatus"],
        message: "unavailable dashboard factor requires unavailable data quality",
      });
    }
  });
export type DashboardMetricRuntimeFactorV1 = z.infer<
  typeof DashboardMetricRuntimeFactorV1Schema
>;

export const DashboardMetricRuntimeBindingV1Schema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal("dashboard.metric-runtime-binding.v1"),
  registrySchemaVersion: z.literal(2),
  registryStatus: z.literal("runtime_bound_partial_v1"),
  reportAsOf: z.iso.datetime({ offset: true }),
  availableCount: z.number().int().safe().nonnegative(),
  unavailableCount: z.number().int().safe().nonnegative(),
  factors: z.array(DashboardMetricRuntimeFactorV1Schema).length(
    DASHBOARD_VISIBLE_FACTOR_IDS_V1.length,
  ),
}).strict().superRefine((value, ctx) => {
  const factorIds = value.factors.map((factor) => factor.factorId);
  if (
    factorIds.length !== DASHBOARD_VISIBLE_FACTOR_IDS_V1.length
    || factorIds.some((factorId, index) => (
      factorId !== DASHBOARD_VISIBLE_FACTOR_IDS_V1[index]
    ))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["factors"],
      message: "runtime factor binding must cover the exact visible factor order",
    });
  }
  const availableCount = value.factors.filter(
    (factor) => factor.runtimeStatus === "available",
  ).length;
  const unavailableCount = value.factors.length - availableCount;
  if (
    value.availableCount !== availableCount
    || value.unavailableCount !== unavailableCount
  ) {
    ctx.addIssue({
      code: "custom",
      message: "runtime factor availability summary mismatch",
    });
  }
});
export type DashboardMetricRuntimeBindingV1 = z.infer<
  typeof DashboardMetricRuntimeBindingV1Schema
>;

export const DashboardPartialFinancialRuntimeHttpBodyV1Schema =
  DashboardPartialFinancialHttpBodyV1Schema.extend({
    factorBinding: DashboardMetricRuntimeBindingV1Schema,
  }).superRefine((value, ctx) => {
    if (value.factorBinding.reportAsOf !== value.context.reportAsOf) {
      ctx.addIssue({
        code: "custom",
        path: ["factorBinding", "reportAsOf"],
        message: "dashboard factor binding must use the canonical reportAsOf",
      });
    }
  });
export type DashboardPartialFinancialRuntimeHttpBodyV1 = z.infer<
  typeof DashboardPartialFinancialRuntimeHttpBodyV1Schema
>;
