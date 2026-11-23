import type { PoolClient } from "../db/client";
import { OrderCommercialComponentsV2Schema } from "@medusa-snus/contracts";
import {
  PostgresPaymentChargeBundleRepositoryV1,
  type PostgresPaymentChargeBundleRepositoryOptionsV1,
} from "./postgres-payment-charge-bundle-repository";
import {
  createProviderInitialPostedChargeTaskV1,
  createProviderInitialPostedChargeTaskV2,
  type ProviderInitialPostedChargeInputV1,
  type ProviderSettlementVerificationV1,
} from "./provider-initial-posted-charge-bridge";

export const PROVIDER_INITIAL_POSTED_CHARGE_CALLER_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: true,
});

type ProviderKeyV1 = ProviderInitialPostedChargeInputV1["provider"];

export interface ProviderInitialPostedChargeCallerInputV1 {
  paymentIntentId: string;
  orderId: string;
  provider: ProviderKeyV1;
  providerEventId: string;
}

export interface ProviderInitialPostedChargeCallerDependenciesV1 {
  client: PoolClient;
  config?: { enabled: boolean };
  transactionContext: {
    ownership: "caller";
    orderCreatedInCurrentTransaction: true;
  };
  repositoryOptions: Omit<
    PostgresPaymentChargeBundleRepositoryOptionsV1,
    "transactionOwnership"
  >;
}

export type ProviderInitialPostedChargeCallerResultV1 =
  | { enabled: false; status: "disabled" }
  | {
      enabled: true;
      kind: "recorded";
      outcome: "inserted" | "replayed";
      obligationId: string;
      paymentEventId: string;
      amountMinor: number;
      status: "posted";
      method: "provider";
    };

export class ProviderInitialPostedChargeCallerValidationErrorV1 extends Error {
  readonly code = "provider_initial_posted_charge_caller_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ProviderInitialPostedChargeCallerValidationErrorV1";
  }
}

type LockedSettlementRow = Record<string, unknown>;

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} is invalid`);
  }
  return value;
}

function nullableToken(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredToken(value, field);
}

function canonicalInstant(value: unknown, field: string): string {
  const candidate = value instanceof Date
    ? value.toISOString()
    : requiredToken(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)
    || new Date(candidate).toISOString() !== candidate
  ) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} is invalid`);
  }
  return candidate;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} is invalid`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function exactInteger(value: unknown, field: string): number {
  const text = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" || typeof value === "string"
      ? String(value)
      : "";
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} is invalid`);
  }
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} is invalid`);
  }
  return result;
}

function canonicalDecimal(value: unknown, field: string): string {
  const text = typeof value === "number" || typeof value === "string"
    ? String(value)
    : "";
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} is invalid`);
  }
  const [whole, fraction = ""] = text.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole!;
}

function vndMinor(value: unknown, field: string): number {
  const canonical = canonicalDecimal(value, field);
  if (canonical.includes(".")) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} is not whole VND`);
  }
  return exactInteger(canonical, field);
}

function assertEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(`${field} drift`);
  }
}

function commercialTaxMode(value: unknown): "inclusive" | "exclusive" {
  if (value === "inclusive" || value === "exclusive") return value;
  throw new ProviderInitialPostedChargeCallerValidationErrorV1(
    "commercial tax mode is invalid",
  );
}

function mapLockedRow(
  row: LockedSettlementRow,
  input: ProviderInitialPostedChargeCallerInputV1,
): ProviderInitialPostedChargeInputV1 {
  const paymentIntentId = requiredToken(row.intent_id, "intent id");
  const orderId = requiredToken(row.order_id, "order id");
  const provider = requiredToken(row.intent_provider, "intent provider");
  const providerEventId = requiredToken(row.provider_event_id, "provider event id");
  assertEqual(paymentIntentId, input.paymentIntentId, "payment intent identity");
  assertEqual(orderId, input.orderId, "order identity");
  assertEqual(provider, input.provider, "provider identity");
  assertEqual(providerEventId, input.providerEventId, "provider event identity");
  if (provider !== "sepay_va" && provider !== "nowpayments") {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1("provider is unsupported");
  }

  const merchantId = requiredToken(row.intent_merchant_id, "intent merchant");
  const storeId = requiredToken(row.intent_store_id, "intent store");
  for (const [field, value, expected] of [
    ["intent status", row.intent_status, "paid"],
    ["intent business purpose", row.intent_business_purpose, "retail_order"],
    ["intent provider config purpose", row.intent_provider_config_purpose, "merchant_retail"],
    ["provider event provider", row.provider_event_provider, provider],
    ["provider event intent", row.provider_event_intent_id, paymentIntentId],
    ["provider event merchant", row.provider_event_merchant_id, merchantId],
    ["provider event store", row.provider_event_store_id, storeId],
    ["provider event status", row.provider_event_status, "received"],
    ["order merchant", row.order_merchant_id, merchantId],
    ["order store", row.order_store_id, storeId],
    ["revision source", row.revision_source_type, "original_order"],
    ["revision commercial state", row.revision_commercial_state, "active"],
    ["revision data quality", row.revision_data_quality, "complete"],
    ["revision currency", row.revision_currency_code, "VND"],
  ] as const) assertEqual(value, expected, field);
  if (
    row.intent_completed_order_id !== null
    || row.provider_event_error !== null
    || row.provider_event_order_id !== null
    || row.provider_event_payment_entry_id !== null
  ) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "provider settlement lifecycle is not at the initial order boundary",
    );
  }

  const providerConfigId = requiredToken(
    row.intent_provider_config_id,
    "intent provider config id",
  );
  const intentAmountMinor = vndMinor(row.intent_amount, "intent amount");
  assertEqual(String(row.intent_currency_code).toLowerCase(), "vnd", "intent currency");
  const commercialRevision = exactInteger(row.revision, "commercial revision");
  if (commercialRevision !== 0) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "initial provider charge requires original commercial revision",
    );
  }
  const minorUnitExponent = exactInteger(
    row.revision_minor_unit_exponent,
    "commercial minor unit exponent",
  );
  if (minorUnitExponent !== 0) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "initial provider charge requires VND exponent zero",
    );
  }
  const componentVersion = exactInteger(row.component_version ?? 1, "component version");
  if (componentVersion !== 1 && componentVersion !== 2) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1("component version is unsupported");
  }
  const paymentFeeMinor = exactInteger(componentVersion === 2 ? row.payment_fee_minor : row.payment_fee_minor ?? 0, "payment fee");
  const paymentFeeVatMinor = exactInteger(componentVersion === 2 ? row.payment_fee_vat_minor : row.payment_fee_vat_minor ?? 0, "payment fee VAT");
  if (componentVersion === 1 && (paymentFeeMinor !== 0 || paymentFeeVatMinor !== 0)) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1("V1 component version cannot contain a payment fee");
  }
  const components = {
    taxMode: commercialTaxMode(row.tax_mode),
    merchandiseGrossMinor: exactInteger(row.merchandise_gross_minor, "merchandise gross"),
    discountMinor: exactInteger(row.discount_minor, "discount"),
    merchandiseNetMinor: exactInteger(row.merchandise_net_minor, "merchandise net"),
    shippingMinor: exactInteger(row.shipping_minor, "shipping"),
    merchandiseVatMinor: exactInteger(row.merchandise_vat_minor, "merchandise VAT"),
    shippingVatMinor: exactInteger(row.shipping_vat_minor, "shipping VAT"),
    vatMinor: exactInteger(row.vat_minor, "VAT"),
    unclassifiedMinor: exactInteger(row.unclassified_minor, "unclassified"),
    totalMinor: exactInteger(row.total_minor, "commercial total"),
    ...(componentVersion === 2 ? { paymentFeeMinor, paymentFeeVatMinor } : {}),
  };
  if (components.totalMinor !== intentAmountMinor) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "locked commercial total differs from intent amount",
    );
  }

  const intentMetadata = recordValue(row.intent_metadata, "intent metadata");
  const providerMetadata = recordValue(intentMetadata.provider, "intent provider metadata");
  assertEqual(
    providerMetadata.providerConfigPurpose,
    "merchant_retail",
    "intent metadata provider config purpose",
  );
  assertEqual(
    providerMetadata.providerConfigId,
    providerConfigId,
    "intent metadata provider config id",
  );
  const eventPayload = recordValue(row.provider_event_payload, "provider event payload");
  const normalized = recordValue(eventPayload._normalized, "normalized provider event");
  const verification = recordValue(
    eventPayload._verification,
    "provider event verification",
  ) as unknown as ProviderSettlementVerificationV1;
  const settlementOccurredAt = canonicalInstant(
    normalized.providerOccurredAt ?? row.provider_event_created_at,
    "provider occurrence",
  );
  const providerAmount = provider === "nowpayments"
    ? canonicalDecimal(normalized.grossQuantity, "provider gross quantity")
    : canonicalDecimal(row.provider_event_amount, "provider amount");
  const providerCurrencyCode = requiredToken(
    row.provider_event_currency_code,
    "provider currency",
  );
  const expectedProviderAmount = provider === "nowpayments"
    ? canonicalDecimal(providerMetadata.expectedProviderAmount, "expected provider amount")
    : String(intentAmountMinor);
  const expectedProviderCurrencyCode = provider === "nowpayments"
    ? requiredToken(providerMetadata.expectedProviderCurrency, "expected provider currency")
    : "vnd";
  if (
    providerAmount !== expectedProviderAmount
    || providerCurrencyCode.toLowerCase() !== expectedProviderCurrencyCode.toLowerCase()
  ) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "locked provider amount or currency differs from intent evidence",
    );
  }
  assertEqual(
    verification.providerConfigPurpose,
    "merchant_retail",
    "provider verification config purpose",
  );
  assertEqual(
    verification.providerConfigId,
    providerConfigId,
    "provider verification config id",
  );

  return {
    merchantId,
    storeId,
    paymentIntentId,
    orderId,
    orderCreatedInCurrentTransaction: true,
    commercialRevisionId: requiredToken(row.revision_id, "commercial revision id"),
    commercialRevision,
    currencyCode: "VND",
    minorUnitExponent,
    components,
    intentAmountMinor,
    provider,
    providerConfigPurpose: "merchant_retail",
    providerConfigId,
    providerEventId,
    referenceCode: requiredToken(row.intent_reference_code, "intent reference code"),
    providerAmount,
    providerCurrencyCode,
    expectedProviderAmount,
    expectedProviderCurrencyCode,
    direction: normalized.direction === null || normalized.direction === undefined
      ? undefined
      : requiredToken(normalized.direction, "provider direction") as "in" | "out" | "unknown",
    providerTransactionId: nullableToken(
      normalized.providerTransactionId,
      "provider transaction id",
    ),
    providerTransactionHash: nullableToken(
      normalized.providerTransactionHash,
      "provider transaction hash",
    ),
    providerNetwork: nullableToken(normalized.providerNetwork, "provider network"),
    providerPayCurrency: nullableToken(
      normalized.providerPayCurrency,
      "provider pay currency",
    ),
    settlementOccurredAt,
    verification,
  };
}

async function readLockedState(
  client: PoolClient,
  input: ProviderInitialPostedChargeCallerInputV1,
): Promise<LockedSettlementRow> {
  const result = await client.query<LockedSettlementRow>(`
    /* provider_initial_posted_charge_locked_state */
    WITH locked_intent AS MATERIALIZED (
      SELECT *
      FROM app.payment_intents
      WHERE id = $1
      FOR UPDATE
    ),
    locked_provider_event AS MATERIALIZED (
      SELECT *
      FROM app.payment_provider_events
      WHERE provider = $3 AND provider_event_id = $4
      FOR UPDATE
    ),
    locked_order AS MATERIALIZED (
      SELECT id, merchant_id, store_id
      FROM public."order"
      WHERE id = $2
      FOR UPDATE
    ),
    locked_revision AS MATERIALIZED (
      SELECT *
      FROM app.order_commercial_revisions
      WHERE order_id = $2 AND revision = 0 AND source_type = 'original_order'
      FOR UPDATE
    ),
    original_components AS MATERIALIZED (
      SELECT components.*
      FROM app.order_commercial_revision_components components
      WHERE components.revision_id IN (SELECT id FROM locked_revision)
      -- Components are immutable; the parent revision supplies serialization
      -- without requiring UPDATE privilege on the component snapshot.
    )
    SELECT
      intent.id AS intent_id,
      intent.provider AS intent_provider,
      intent.status AS intent_status,
      intent.merchant_id AS intent_merchant_id,
      intent.store_id AS intent_store_id,
      intent.amount AS intent_amount,
      intent.currency_code AS intent_currency_code,
      intent.reference_code AS intent_reference_code,
      intent.business_purpose AS intent_business_purpose,
      intent.provider_config_purpose AS intent_provider_config_purpose,
      intent.provider_config_id AS intent_provider_config_id,
      intent.completed_order_id AS intent_completed_order_id,
      intent.metadata AS intent_metadata,
      provider_event.provider AS provider_event_provider,
      provider_event.provider_event_id AS provider_event_id,
      provider_event.payment_intent_id AS provider_event_intent_id,
      provider_event.merchant_id AS provider_event_merchant_id,
      provider_event.store_id AS provider_event_store_id,
      provider_event.status AS provider_event_status,
      provider_event.error AS provider_event_error,
      provider_event.order_id AS provider_event_order_id,
      provider_event.payment_entry_id AS provider_event_payment_entry_id,
      provider_event.received_at AS provider_event_created_at,
      provider_event.amount AS provider_event_amount,
      provider_event.currency_code AS provider_event_currency_code,
      provider_event.payload AS provider_event_payload,
      order_row.id AS order_id,
      order_row.merchant_id AS order_merchant_id,
      order_row.store_id AS order_store_id,
      revision.id AS revision_id,
      revision.revision,
      revision.source_type AS revision_source_type,
      revision.commercial_state AS revision_commercial_state,
      revision.data_quality AS revision_data_quality,
      revision.currency_code AS revision_currency_code,
      revision.minor_unit_exponent AS revision_minor_unit_exponent,
      components.tax_mode,
      components.merchandise_gross_minor,
      components.discount_minor,
      components.merchandise_net_minor,
      components.shipping_minor,
      components.merchandise_vat_minor,
      components.shipping_vat_minor,
      components.vat_minor,
      components.unclassified_minor,
      components.total_minor,
      COALESCE((to_jsonb(components)->>'component_version')::int, 1) AS component_version,
      to_jsonb(components)->>'payment_fee_minor' AS payment_fee_minor,
      to_jsonb(components)->>'payment_fee_vat_minor' AS payment_fee_vat_minor
    FROM locked_intent intent
    JOIN locked_provider_event provider_event
      ON provider_event.payment_intent_id = intent.id
    JOIN locked_order order_row
      ON order_row.id = $2
    JOIN locked_revision revision
      ON revision.order_id = order_row.id
     AND revision.merchant_id = intent.merchant_id
     AND revision.store_id = intent.store_id
    JOIN original_components components
      ON components.revision_id = revision.id
  `, [input.paymentIntentId, input.orderId, input.provider, input.providerEventId]);
  if (result.rows.length !== 1) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "locked provider settlement state is unavailable",
    );
  }
  return result.rows[0]!;
}

export async function recordProviderInitialPostedChargeFromLockedStateV1(
  dependencies: ProviderInitialPostedChargeCallerDependenciesV1,
  input: ProviderInitialPostedChargeCallerInputV1,
): Promise<ProviderInitialPostedChargeCallerResultV1> {
  const config = dependencies?.config ?? PROVIDER_INITIAL_POSTED_CHARGE_CALLER_DEFAULT_CONFIG_V1;
  if (config.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  if (
    !dependencies.client
    || dependencies.transactionContext?.ownership !== "caller"
    || dependencies.transactionContext.orderCreatedInCurrentTransaction !== true
  ) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "provider charge caller requires caller-owned transaction context",
    );
  }
  const lockedRow = await readLockedState(dependencies.client, input);
  const lockedInput = mapLockedRow(lockedRow, input);
  const repository = new PostgresPaymentChargeBundleRepositoryV1(
    dependencies.client,
    { ...dependencies.repositoryOptions, transactionOwnership: "caller" },
  );
  const bridgeDependencies = {
    config: { enabled: true },
    repository: repository as PostgresPaymentChargeBundleRepositoryV1 & {
      readonly transactionOwnership: "caller";
    },
  };
  const task = exactInteger(lockedRow.component_version ?? 1, "component version") === 2
    ? createProviderInitialPostedChargeTaskV2(bridgeDependencies,
      { ...lockedInput, components: OrderCommercialComponentsV2Schema.parse(lockedInput.components) })
    : createProviderInitialPostedChargeTaskV1(bridgeDependencies, lockedInput);
  if (!task.enabled) {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "provider initial charge bridge is unavailable",
    );
  }
  const result = await task.execute();
  if (result.status !== "posted" || result.method !== "provider") {
    throw new ProviderInitialPostedChargeCallerValidationErrorV1(
      "provider initial charge result drift",
    );
  }
  return {
    enabled: true,
    ...result,
    status: "posted",
    method: "provider",
  };
}
