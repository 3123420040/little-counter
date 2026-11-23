import {
  EffectiveOrderSurfaceV2Schema,
  EffectiveOrderV1Schema,
  EffectiveOrderV2Schema,
  EffectiveOrderSurfaceV3Schema,
  type EffectiveOrderV2,
  type EffectiveOrderSurfaceV3,
  type EffectiveOrderSurfaceV2,
  type EffectiveOrderV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import {
  readEffectiveOrderV1,
  readEffectiveOrdersV1,
  readEffectiveOrderV2,
  type EffectiveOrderProjectionBatchRequest,
  type EffectiveOrderProjectionScalarRequest,
} from "./effective-order-projection-service";

export interface EffectiveOrderSurfaceBatchRequest extends EffectiveOrderProjectionBatchRequest {
  surfaceKind: "detail" | "list";
}

export interface EffectiveOrderSurfaceScalarRequest extends EffectiveOrderProjectionScalarRequest {
  surfaceKind: "detail" | "list";
}

export function buildEffectiveOrderSurfaceV2(
  surfaceKind: "detail" | "list",
  input: EffectiveOrderV1,
): EffectiveOrderSurfaceV2 {
  const effectiveOrder = EffectiveOrderV1Schema.parse(input);
  return EffectiveOrderSurfaceV2Schema.parse({ schemaVersion: 2, ...surfaceFields(surfaceKind, effectiveOrder) });
}

export function buildEffectiveOrderSurfaceV3(surfaceKind: "detail" | "list", input: EffectiveOrderV2): EffectiveOrderSurfaceV3 {
  const effectiveOrder = EffectiveOrderV2Schema.parse(input);
  return EffectiveOrderSurfaceV3Schema.parse({ schemaVersion: 3, componentVersion: effectiveOrder.componentVersion,
    ...surfaceFields(surfaceKind, effectiveOrder) });
}

function surfaceFields(surfaceKind: "detail" | "list", effectiveOrder: EffectiveOrderV1 | EffectiveOrderV2) {
  const effectiveItems = effectiveOrder.lines.map((line) => ({
    ...line,
    archivedVariant: line.archivedVariant || false,
    lineTotalMinor: line.quantity * line.unitPriceMinor,
  }));
  const activeQuantity = effectiveItems.reduce((total, line) => {
    const next = total + line.quantity;
    if (!Number.isSafeInteger(next)) throw new RangeError("effective item quantity overflow");
    return next;
  }, 0);

  return {
    surfaceKind,
    orderId: effectiveOrder.orderId,
    currencyCode: effectiveOrder.currencyCode,
    minorUnitExponent: effectiveOrder.minorUnitExponent,
    effectiveRevision: effectiveOrder.effectiveRevision,
    commercialState: effectiveOrder.commercialState,
    effectiveItems,
    components: effectiveOrder.components,
    effectiveCommercialTotalMinor: effectiveOrder.components.totalMinor,
    currentOrderGrossValueMinor: effectiveOrder.currentOrderGrossValueMinor,
    effectiveItemQuantity: effectiveOrder.commercialState === "cancelled" ? 0 : activeQuantity,
    dataQuality: effectiveOrder.dataQuality,
  };
}

export async function readEffectiveOrderSurfaceV3(client: PoolClient, input: EffectiveOrderSurfaceScalarRequest): Promise<EffectiveOrderSurfaceV3> {
  return buildEffectiveOrderSurfaceV3(input.surfaceKind, await readEffectiveOrderV2(client, input));
}

export async function readEffectiveOrderSurfacesV2(
  client: PoolClient,
  input: EffectiveOrderSurfaceBatchRequest,
): Promise<EffectiveOrderSurfaceV2[]> {
  const projections = await readEffectiveOrdersV1(client, input);
  return projections.map((projection) =>
    buildEffectiveOrderSurfaceV2(input.surfaceKind, projection));
}

export async function readEffectiveOrderSurfaceV2(
  client: PoolClient,
  input: EffectiveOrderSurfaceScalarRequest,
): Promise<EffectiveOrderSurfaceV2> {
  const projection = await readEffectiveOrderV1(client, input);
  return buildEffectiveOrderSurfaceV2(input.surfaceKind, projection);
}
