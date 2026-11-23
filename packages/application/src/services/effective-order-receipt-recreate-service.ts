import {
  EffectiveOrderAuditIdentityV1Schema,
  EffectiveOrderReceiptV1Schema,
  EffectiveOrderReceiptV2Schema,
  EffectiveOrderV2Schema,
  EffectiveOrderRecreateCatalogCandidateV1Schema,
  EffectiveOrderRecreatePrefillV1Schema,
  EffectiveOrderV1Schema,
  type EffectiveOrderAuditIdentityV1,
  type EffectiveOrderReceiptV1,
  type EffectiveOrderReceiptV2,
  type EffectiveOrderV2,
  type EffectiveOrderRecreateCatalogCandidateV1,
  type EffectiveOrderRecreatePrefillV1,
  type EffectiveOrderV1,
} from "@medusa-snus/contracts";

export interface EffectiveOrderReceiptStorePresentationV1 {
  storeName: string;
  storeAddress: string;
}

function normalizedIdentity(
  identityInput: EffectiveOrderAuditIdentityV1,
  effectiveOrder: EffectiveOrderV1,
): {
  sourceOrder: EffectiveOrderAuditIdentityV1;
  projection: EffectiveOrderV1;
} {
  const projection = EffectiveOrderV1Schema.parse(effectiveOrder);
  return { sourceOrder: normalizedSourceOrder(identityInput, projection.orderId), projection };
}

function normalizedSourceOrder(identityInput: EffectiveOrderAuditIdentityV1, orderId: string): EffectiveOrderAuditIdentityV1 {
  const sourceOrder = EffectiveOrderAuditIdentityV1Schema.parse(identityInput);
  if (sourceOrder.orderId !== orderId) {
    throw new Error("effective order/source identity mismatch");
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: sourceOrder.storeTimeZone }).format(
      new Date(sourceOrder.createdAt),
    );
  } catch {
    throw new Error("invalid source store timezone");
  }
  return sourceOrder;
}

export function buildEffectiveOrderReceiptV1(
  identityInput: EffectiveOrderAuditIdentityV1,
  effectiveOrder: EffectiveOrderV1,
): EffectiveOrderReceiptV1 {
  const { sourceOrder, projection } = normalizedIdentity(identityInput, effectiveOrder);
  return EffectiveOrderReceiptV1Schema.parse({
    schemaVersion: 1,
    financialMeaning: "effective_order_commercial_snapshot_not_collection",
    sourceOrder,
    currencyCode: projection.currencyCode,
    minorUnitExponent: projection.minorUnitExponent,
    effectiveRevision: projection.effectiveRevision,
    commercialState: projection.commercialState,
    effectiveItems: projection.lines.map((line) => ({
      ...line,
      archivedVariant: line.archivedVariant || false,
      lineTotalMinor: line.quantity * line.unitPriceMinor,
    })),
    components: projection.components,
    effectiveCommercialTotalMinor: projection.components.totalMinor,
    dataQuality: projection.dataQuality,
  });
}

function moneyText(amountMinor: number, currencyCode: string, minorUnitExponent: number): string {
  const divisor = 10 ** minorUnitExponent;
  return `${new Intl.NumberFormat("vi-VN", {
    minimumFractionDigits: minorUnitExponent,
    maximumFractionDigits: minorUnitExponent,
  }).format(amountMinor / divisor)} ${currencyCode}`;
}

export function buildEffectiveOrderReceiptV2(
  identityInput: EffectiveOrderAuditIdentityV1,
  effectiveOrder: EffectiveOrderV2,
): EffectiveOrderReceiptV2 {
  const sourceOrder = EffectiveOrderAuditIdentityV1Schema.parse(identityInput);
  const projection = EffectiveOrderV2Schema.parse(effectiveOrder);
  if (sourceOrder.orderId !== projection.orderId) throw new Error("effective order/source identity mismatch");
  new Intl.DateTimeFormat("en-GB", { timeZone: sourceOrder.storeTimeZone }).format(new Date(sourceOrder.createdAt));
  return EffectiveOrderReceiptV2Schema.parse({
    schemaVersion: 2, componentVersion: projection.componentVersion,
    financialMeaning: "effective_order_commercial_snapshot_not_collection",
    sourceOrder, currencyCode: projection.currencyCode, minorUnitExponent: projection.minorUnitExponent,
    effectiveRevision: projection.effectiveRevision, commercialState: projection.commercialState,
    effectiveItems: projection.lines.map((line) => ({ ...line, archivedVariant: line.archivedVariant || false,
      lineTotalMinor: line.quantity * line.unitPriceMinor })),
    components: projection.components, effectiveCommercialTotalMinor: projection.components.totalMinor,
    dataQuality: projection.dataQuality,
  });
}

function requiredPresentationText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function buildEffectiveOrderReceiptTextV1(
  receiptInput: EffectiveOrderReceiptV1,
  presentation: EffectiveOrderReceiptStorePresentationV1,
): string {
  return receiptText(EffectiveOrderReceiptV1Schema.parse(receiptInput), presentation);
}

export function buildEffectiveOrderReceiptTextV2(
  receiptInput: EffectiveOrderReceiptV2,
  presentation: EffectiveOrderReceiptStorePresentationV1,
): string {
  return receiptText(EffectiveOrderReceiptV2Schema.parse(receiptInput), presentation);
}

function receiptText(receipt: EffectiveOrderReceiptV1 | EffectiveOrderReceiptV2, presentation: EffectiveOrderReceiptStorePresentationV1): string {
  const storeName = requiredPresentationText(presentation.storeName, "storeName");
  const storeAddress = presentation.storeAddress?.trim();
  const createdAt = new Intl.DateTimeFormat("en-GB", {
    timeZone: receipt.sourceOrder.storeTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(receipt.sourceOrder.createdAt));
  const money = (value: number) =>
    moneyText(value, receipt.currencyCode, receipt.minorUnitExponent);
  const lines = [
    storeName,
    ...(storeAddress ? [storeAddress] : []),
    `Receipt: ${receipt.sourceOrder.orderNumber}`,
    `Date: ${createdAt} (${receipt.sourceOrder.storeTimeZone})`,
    `Effective revision: ${receipt.effectiveRevision}`,
    `Commercial state: ${receipt.commercialState.toUpperCase()}`,
    "",
    "Effective items:",
    ...receipt.effectiveItems.map((line) =>
      `- ${line.titleSnapshot} x${line.quantity} @ ${money(line.unitPriceMinor)} = ${money(line.lineTotalMinor)}`),
    "",
    `Merchandise gross: ${money(receipt.components.merchandiseGrossMinor)}`,
    `Discount: ${money(receipt.components.discountMinor)}`,
    `Shipping: ${money(receipt.components.shippingMinor)}`,
    ...(receipt.schemaVersion === 2 && receipt.componentVersion === 2
      ? [`Payment surcharge: ${money(receipt.components.paymentFeeMinor)}`] : []),
    `VAT: ${money(receipt.components.vatMinor)}`,
    `Other charged components: ${money(receipt.components.unclassifiedMinor)}`,
    `Order commercial total (VAT/fees included): ${money(receipt.effectiveCommercialTotalMinor)}`,
    "Not a payment collection statement",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildEffectiveOrderRecreatePrefillV1(
  identityInput: EffectiveOrderAuditIdentityV1,
  effectiveOrder: EffectiveOrderV1,
  catalogCandidatesInput: readonly EffectiveOrderRecreateCatalogCandidateV1[],
): EffectiveOrderRecreatePrefillV1 {
  const { sourceOrder, projection } = normalizedIdentity(identityInput, effectiveOrder);
  return mapRecreateCatalog(sourceOrder, projection, catalogCandidatesInput);
}

export function buildEffectiveOrderRecreatePrefillFromV2(
  identityInput: EffectiveOrderAuditIdentityV1,
  effectiveOrder: EffectiveOrderV2,
  catalogCandidatesInput: readonly EffectiveOrderRecreateCatalogCandidateV1[],
): EffectiveOrderRecreatePrefillV1 {
  const projection = EffectiveOrderV2Schema.parse(effectiveOrder);
  return mapRecreateCatalog(normalizedSourceOrder(identityInput, projection.orderId), projection, catalogCandidatesInput);
}

function mapRecreateCatalog(
  sourceOrder: EffectiveOrderAuditIdentityV1,
  projection: Pick<EffectiveOrderV1, "lines" | "commercialState" | "effectiveRevision" | "currencyCode" | "minorUnitExponent" | "dataQuality">,
  catalogCandidatesInput: readonly EffectiveOrderRecreateCatalogCandidateV1[],
): EffectiveOrderRecreatePrefillV1 {
  const catalogCandidates = catalogCandidatesInput.map((candidate) =>
    EffectiveOrderRecreateCatalogCandidateV1Schema.parse(candidate));
  const currentByVariant = new Map<string, EffectiveOrderRecreateCatalogCandidateV1>();
  for (const candidate of catalogCandidates) {
    if (currentByVariant.has(candidate.variantId)) {
      throw new Error(`duplicate recreate catalog candidate: ${candidate.variantId}`);
    }
    currentByVariant.set(candidate.variantId, candidate);
  }

  const items: EffectiveOrderRecreatePrefillV1["items"] = projection.lines.map((line) => {
    const source = {
      sourceLineId: line.lineId,
      sourceProductId: line.productId,
      sourceVariantId: line.variantId,
      skuSnapshot: line.skuSnapshot,
      titleSnapshot: line.titleSnapshot,
      requestedQuantity: line.quantity,
      effectiveUnitPriceMinor: line.unitPriceMinor,
    };
    let candidate: EffectiveOrderRecreateCatalogCandidateV1 | undefined;
    const reasons: Array<
      | "missing_variant_identity"
      | "source_variant_archived"
      | "variant_not_found"
      | "product_identity_mismatch"
      | "current_variant_archived"
      | "variant_unpublished"
      | "insufficient_stock"
    > = [];

    if (!line.productId || !line.variantId) {
      reasons.push("missing_variant_identity");
    } else if (line.archivedVariant) {
      reasons.push("source_variant_archived");
      candidate = currentByVariant.get(line.variantId);
    } else {
      candidate = currentByVariant.get(line.variantId);
      if (!candidate) {
        reasons.push("variant_not_found");
      } else {
        if (candidate.productId !== line.productId) reasons.push("product_identity_mismatch");
        if (candidate.archived) reasons.push("current_variant_archived");
        if (!candidate.published) reasons.push("variant_unpublished");
        if (candidate.stockAvailableQuantity < line.quantity) reasons.push("insufficient_stock");
      }
    }

    if (!candidate || reasons.length > 0) {
      return {
        ...source,
        mapping: {
          status: "unavailable" as const,
          reasons,
          currentProductId: candidate?.productId || null,
          currentVariantId: candidate?.variantId || null,
          currentTitle: candidate?.currentTitle || null,
          currentSku: candidate?.currentSku || null,
          currentUnitPriceMinor: candidate?.currentUnitPriceMinor ?? null,
          stockAvailableQuantity: candidate?.stockAvailableQuantity ?? null,
        },
      };
    }

    return {
      ...source,
      mapping: {
        status: "available" as const,
        productId: candidate.productId,
        variantId: candidate.variantId,
        currentTitle: candidate.currentTitle,
        currentSku: candidate.currentSku,
        stockAvailableQuantity: candidate.stockAvailableQuantity,
        currentUnitPriceMinor: candidate.currentUnitPriceMinor,
        cartUnitPriceMinor: candidate.currentUnitPriceMinor,
        priceChanged: candidate.currentUnitPriceMinor !== line.unitPriceMinor,
      },
    };
  });
  const availableCount = items.filter((item) => item.mapping.status === "available").length;
  const unavailableCount = items.length - availableCount;
  const warningCount = items.filter((item) =>
    item.mapping.status === "unavailable" || item.mapping.priceChanged).length;

  return EffectiveOrderRecreatePrefillV1Schema.parse({
    schemaVersion: 1,
    sourceOrder,
    sourceCommercialState: projection.commercialState,
    effectiveRevision: projection.effectiveRevision,
    currencyCode: projection.currencyCode,
    minorUnitExponent: projection.minorUnitExponent,
    cartCommercialSemantics: "new_sale_current_catalog_pricing_explicit",
    cartReadiness: unavailableCount === 0 ? "ready" : "blocked_unavailable_items",
    items,
    availableCount,
    unavailableCount,
    warningCount,
    dataQuality: projection.dataQuality,
  });
}
