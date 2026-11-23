import { createHash } from "node:crypto";
import {
  BANK_TRANSFER_SETTLEMENT_ACKNOWLEDGMENT_VERSION,
  OrderCommercialComponentsV1Schema,
  OrderCommercialComponentsV2Schema,
  type OrderCommercialComponentsV1,
  type OrderCommercialComponentsV2,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import {
  PaymentChargeBundleValidationErrorV1,
  createPaymentChargeBundleTaskV1,
  createPaymentChargeBundleTaskV2,
} from "./payment-charge-bundle-service";
import {
  PaymentMethodLifecyclePolicyErrorV1,
  selectOrderCreatedChargeLifecycleV1,
  type OrderCreatedChargeConfirmationV1,
} from "./payment-method-lifecycle-policy";
import { isExternalProviderPaymentMethod } from "./payment-service";
import {
  PostgresPaymentChargeBundleRepositoryV1,
  type PostgresPaymentChargeBundleRepositoryOptionsV1,
} from "./postgres-payment-charge-bundle-repository";

export const ORDER_CREATED_PAYMENT_CHARGE_CALLER_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: true,
});

export interface OrderCreatedPaymentChargeCallerInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  orderCreatedAt: string;
  commercialRevisionId: string;
  commercialRevision: 0;
  currencyCode: "VND";
  minorUnitExponent: 0;
  paymentMethod: string;
  amountReceivedMinor: number;
  changeMinor: number;
  components: OrderCommercialComponentsV1;
  localMockProviderSettlement?: {
    paymentIntentId: string;
    providerEventId: string;
  };
  /**
   * Internal-only proof that an authenticated POS operator acknowledged a
   * manual-bank receipt while completing this order.  This is constructed by
   * `completeSale` after it resolves the store policy inside its transaction;
   * remote/customer/provider paths never populate it from their payload.
   */
  manualBankConfirmation?: {
    operatorId: string;
    policyVersion: number;
    acknowledgmentVersion: number;
  };
}

export type OrderCreatedPaymentChargeCallerInputV2 = Omit<OrderCreatedPaymentChargeCallerInputV1, "components"> & {
  components: OrderCommercialComponentsV2;
};

export interface OrderCreatedPaymentChargeCallerDependenciesV1 {
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

export type OrderCreatedPaymentChargeCallerResultV1 =
  | { enabled: false; status: "disabled" }
  | { enabled: true; status: "delegated_provider"; method: "provider" }
  | {
      enabled: true;
      kind: "recorded";
      outcome: "inserted" | "replayed";
      obligationId: string;
      paymentEventId: string;
      amountMinor: number;
      status: "posted" | "pending";
      method: "cash" | "cod" | "manual_bank" | "provider";
    };

export class OrderCreatedPaymentChargeCallerValidationErrorV1 extends Error {
  readonly code = "order_created_payment_charge_caller_invalid";

  constructor(message: string) {
    super(message);
    this.name = "OrderCreatedPaymentChargeCallerValidationErrorV1";
  }
}

function invalid(message: string): never {
  throw new OrderCreatedPaymentChargeCallerValidationErrorV1(message);
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    return invalid(`${field} is invalid`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = token(value, field);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(parsed)) {
    return invalid(`${field} is invalid`);
  }
  return parsed;
}

function minor(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalid(`${field} is invalid`);
  }
  return Number(value);
}

function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalid(`${field} is invalid`);
  }
  return Number(value);
}

function canonicalInstant(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return invalid("order creation time is invalid");
  }
  try {
    if (new Date(value).toISOString() !== value) {
      return invalid("order creation time is invalid");
    }
  } catch {
    return invalid("order creation time is invalid");
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function paymentMethod(value: string): "cash" | "cod" | "manual_bank" | "provider" {
  if (value === "cash" || value === "cod") return value;
  if (value === "bank_transfer") return "manual_bank";
  if (value === "mock") return "provider";
  if (isExternalProviderPaymentMethod(value)) return "provider";
  return invalid("payment method is unsupported");
}

function normalizeInput(input: OrderCreatedPaymentChargeCallerInputV1 | OrderCreatedPaymentChargeCallerInputV2, componentVersion: 1 | 2) {
  const merchantId = token(input?.merchantId, "merchant id");
  const storeId = token(input?.storeId, "store id");
  const orderId = token(input?.orderId, "order id");
  const sourceOccurredAt = canonicalInstant(input?.orderCreatedAt);
  if (
    input.currencyCode !== "VND"
    || input.minorUnitExponent !== 0
    || input.commercialRevision !== 0
  ) {
    invalid("initial order charge requires original whole-minor VND revision");
  }
  const commercialRevisionId = uuid(input.commercialRevisionId, "commercial revision id");
  const parsedComponents = (componentVersion === 2 ? OrderCommercialComponentsV2Schema : OrderCommercialComponentsV1Schema).safeParse(input.components);
  if (!parsedComponents.success || parsedComponents.data.totalMinor < 1) {
    invalid("commercial components are invalid");
  }
  const method = paymentMethod(token(input.paymentMethod, "payment method"));
  const localMockProviderSettlement = input.localMockProviderSettlement === undefined
    ? undefined
    : {
        paymentIntentId: token(
          input.localMockProviderSettlement.paymentIntentId,
          "mock payment intent id",
        ),
        providerEventId: token(
          input.localMockProviderSettlement.providerEventId,
          "mock provider event id",
        ),
      };
  const manualBankConfirmation = input.manualBankConfirmation === undefined
    ? undefined
    : {
        operatorId: token(input.manualBankConfirmation.operatorId, "manual bank operator id"),
        policyVersion: version(input.manualBankConfirmation.policyVersion, "manual bank policy version"),
        acknowledgmentVersion: version(
          input.manualBankConfirmation.acknowledgmentVersion,
          "manual bank acknowledgment version",
        ),
      };
  if (
    manualBankConfirmation
    && (
      method !== "manual_bank"
      || manualBankConfirmation.acknowledgmentVersion
        !== BANK_TRANSFER_SETTLEMENT_ACKNOWLEDGMENT_VERSION
    )
  ) {
    invalid("manual bank confirmation is invalid for the payment method");
  }
  if (
    localMockProviderSettlement
    && input.paymentMethod !== "mock"
    && !isExternalProviderPaymentMethod(input.paymentMethod)
  ) {
    invalid("local mock provider evidence is invalid for the payment method");
  }
  const amountReceivedMinor = minor(input.amountReceivedMinor, "amount received");
  const changeMinor = minor(input.changeMinor, "change");
  if (method !== "cash" && (amountReceivedMinor !== 0 || changeMinor !== 0)) {
    invalid("non-cash tender amount or change is invalid");
  }
  if (
    method === "cash"
    && (
      amountReceivedMinor < parsedComponents.data.totalMinor
      || amountReceivedMinor - parsedComponents.data.totalMinor !== changeMinor
    )
  ) {
    invalid("cash tender does not reconcile to the charged amount");
  }
  return {
    merchantId,
    storeId,
    orderId,
    sourceId: `order:${orderId}:created`,
    sourceOccurredAt,
    commercialRevisionId,
    method,
    amountReceivedMinor,
    changeMinor,
    components: parsedComponents.data,
    localMockProviderSettlement,
    manualBankConfirmation,
  };
}

function cashConfirmation(
  context: ReturnType<typeof normalizeInput>,
): OrderCreatedChargeConfirmationV1 {
  const sourceReference = `order:${context.orderId}:cash-tender`;
  const evidenceFingerprint = sha256({
    schemaVersion: 1,
    evidenceType: "cash_receipt",
    merchantId: context.merchantId,
    storeId: context.storeId,
    orderId: context.orderId,
    sourceId: context.sourceId,
    sourceOccurredAt: context.sourceOccurredAt,
    amountReceivedMinor: context.amountReceivedMinor,
    changeMinor: context.changeMinor,
    chargeAmountMinor: context.components.totalMinor,
  });
  return {
    kind: "cash_tender_confirmed",
    evidenceFingerprint,
    sourceSystem: "order_service",
    sourceReference,
    confirmedAt: context.sourceOccurredAt,
    amountReceivedMinor: context.amountReceivedMinor,
    changeMinor: context.changeMinor,
  };
}

function localMockProviderConfirmation(
  context: ReturnType<typeof normalizeInput>,
): OrderCreatedChargeConfirmationV1 {
  const settlement = context.localMockProviderSettlement;
  if (!settlement) invalid("local mock provider evidence is required");
  const sourceReference = [
    "local-mock",
    settlement.paymentIntentId,
    settlement.providerEventId,
  ].join(":");
  return {
    kind: "provider_success",
    evidenceFingerprint: sha256({
      schemaVersion: 1,
      evidenceType: "local_mock_payment_intent_settled",
      merchantId: context.merchantId,
      storeId: context.storeId,
      orderId: context.orderId,
      paymentIntentId: settlement.paymentIntentId,
      providerEventId: settlement.providerEventId,
      chargeAmountMinor: context.components.totalMinor,
      sourceOccurredAt: context.sourceOccurredAt,
    }),
    sourceSystem: "local_mock_payment_intent",
    sourceReference,
    confirmedAt: context.sourceOccurredAt,
  };
}

function manualBankConfirmation(
  context: ReturnType<typeof normalizeInput>,
): OrderCreatedChargeConfirmationV1 {
  const confirmation = context.manualBankConfirmation;
  if (!confirmation) invalid("manual bank confirmation is required");
  const sourceReference = [
    "pos-checkout",
    context.orderId,
    confirmation.operatorId,
    String(confirmation.policyVersion),
    String(confirmation.acknowledgmentVersion),
  ].join(":");
  return {
    kind: "manual_bank_verified",
    evidenceFingerprint: sha256({
      schemaVersion: 1,
      evidenceType: "manual_verified",
      source: "pos_checkout_confirm_on_booking",
      merchantId: context.merchantId,
      storeId: context.storeId,
      orderId: context.orderId,
      sourceId: context.sourceId,
      sourceOccurredAt: context.sourceOccurredAt,
      operatorId: confirmation.operatorId,
      policyVersion: confirmation.policyVersion,
      acknowledgmentVersion: confirmation.acknowledgmentVersion,
      chargeAmountMinor: context.components.totalMinor,
      currencyCode: "VND",
    }),
    sourceSystem: "pos_checkout",
    sourceReference,
    confirmedAt: context.sourceOccurredAt,
  };
}

async function recordOrderCreatedPaymentCharge(
  dependencies: OrderCreatedPaymentChargeCallerDependenciesV1,
  input: OrderCreatedPaymentChargeCallerInputV1 | OrderCreatedPaymentChargeCallerInputV2,
  version: 1 | 2,
): Promise<OrderCreatedPaymentChargeCallerResultV1> {
  const config = dependencies?.config ?? ORDER_CREATED_PAYMENT_CHARGE_CALLER_DEFAULT_CONFIG_V1;
  if (config.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  if (
    !dependencies.client
    || dependencies.transactionContext?.ownership !== "caller"
    || dependencies.transactionContext.orderCreatedInCurrentTransaction !== true
  ) {
    invalid("payment caller requires caller-owned order transaction context");
  }
  const context = normalizeInput(input, version);
  if (context.method === "provider" && !context.localMockProviderSettlement) {
    return { enabled: true, status: "delegated_provider", method: "provider" };
  }

  let decision;
  try {
    decision = selectOrderCreatedChargeLifecycleV1({
      merchantId: context.merchantId,
      storeId: context.storeId,
      orderId: context.orderId,
      currencyCode: "VND",
      minorUnitExponent: 0,
      chargeAmountMinor: context.components.totalMinor,
      sourceType: "order_created",
      sourceId: context.sourceId,
      sourceOccurredAt: context.sourceOccurredAt,
      method: context.method,
      ...(context.method === "cash"
        ? { confirmation: cashConfirmation(context) }
        : context.method === "provider"
          ? { confirmation: localMockProviderConfirmation(context) }
          : context.method === "manual_bank" && context.manualBankConfirmation
            ? { confirmation: manualBankConfirmation(context) }
          : {}),
    }, { enabled: true });
  } catch (error) {
    if (error instanceof PaymentMethodLifecyclePolicyErrorV1) invalid(error.message);
    throw error;
  }
  if (!decision.enabled || decision.status === "blocked") {
    invalid("order-created payment lifecycle is unavailable");
  }

  const repository = new PostgresPaymentChargeBundleRepositoryV1(
    dependencies.client,
    { ...dependencies.repositoryOptions, transactionOwnership: "caller" },
  );
  let task;
  try {
    const chargeInput = {
      merchantId: context.merchantId,
      storeId: context.storeId,
      orderId: context.orderId,
      commercialRevisionId: context.commercialRevisionId,
      commercialRevision: 0,
      currencyCode: "VND",
      minorUnitExponent: 0,
      method: decision.method,
      status: decision.status,
      components: context.components,
      ...(decision.evidence ? { evidence: decision.evidence } : {}),
      idempotencyKey: `payment:${context.orderId}:initial:${decision.method}`,
      sourceType: "order_created",
      sourceId: context.sourceId,
      sourceOccurredAt: context.sourceOccurredAt,
    };
    task = version === 2
      ? createPaymentChargeBundleTaskV2({ config: { enabled: true }, repository },
        { ...chargeInput, components: OrderCommercialComponentsV2Schema.parse(context.components) })
      : createPaymentChargeBundleTaskV1({ config: { enabled: true }, repository }, chargeInput);
  } catch (error) {
    if (error instanceof PaymentChargeBundleValidationErrorV1) invalid(error.message);
    throw error;
  }
  if (!task.enabled) invalid("payment charge bundle task is unavailable");
  const result = await task.execute();
  if (
    result.method !== decision.method
    || result.status !== decision.status
    || result.amountMinor !== context.components.totalMinor
  ) {
    invalid("persisted payment charge result drift");
  }
  return { enabled: true, ...result } as OrderCreatedPaymentChargeCallerResultV1;
}

export function recordOrderCreatedPaymentChargeV1(
  dependencies: OrderCreatedPaymentChargeCallerDependenciesV1, input: OrderCreatedPaymentChargeCallerInputV1,
): Promise<OrderCreatedPaymentChargeCallerResultV1> {
  return recordOrderCreatedPaymentCharge(dependencies, input, 1);
}

export function recordOrderCreatedPaymentChargeV2(
  dependencies: OrderCreatedPaymentChargeCallerDependenciesV1, input: OrderCreatedPaymentChargeCallerInputV2,
): Promise<OrderCreatedPaymentChargeCallerResultV1> {
  return recordOrderCreatedPaymentCharge(dependencies, input, 2);
}
