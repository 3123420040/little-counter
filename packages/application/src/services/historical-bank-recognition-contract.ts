import { createHash } from "node:crypto";
import { z } from "zod";
import { OrderCommercialComponentsV1Schema } from "@medusa-snus/contracts";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UuidSchema = z.string().uuid();
const containsControlCharacter = (value: string): boolean => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || codePoint === 0x7f;
});
const InstantSchema = z.string().datetime({ offset: true }).transform((value, context) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    context.addIssue({ code: "custom", message: "must be a canonical UTC instant" });
    return z.NEVER;
  }
  return value;
});
const TokenSchema = z.string().trim().min(1).max(255).refine(
  (value) => value === value.trim() && !containsControlCharacter(value),
  "must be a trimmed control-character-free token",
);
const SignedMinorSchema = z.number().int().safe();
const MinorSchema = z.number().int().safe().positive();

export const HistoricalBankRecognitionDeltaV1Schema = z.object({
  taxMode: z.enum(["inclusive", "exclusive"]),
  merchandiseGrossMinor: SignedMinorSchema,
  discountMinor: SignedMinorSchema,
  merchandiseNetMinor: SignedMinorSchema,
  shippingMinor: SignedMinorSchema,
  merchandiseVatMinor: SignedMinorSchema,
  shippingVatMinor: SignedMinorSchema,
  vatMinor: SignedMinorSchema,
  unclassifiedMinor: SignedMinorSchema,
  totalMinor: MinorSchema,
  baseSnapshotFingerprint: Sha256Schema,
  effectiveSnapshotFingerprint: Sha256Schema,
  contractFingerprint: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.merchandiseNetMinor !== value.merchandiseGrossMinor - value.discountMinor
    || value.vatMinor !== value.merchandiseVatMinor + value.shippingVatMinor
    || value.merchandiseNetMinor + value.shippingMinor + value.unclassifiedMinor
      + (value.taxMode === "exclusive" ? value.vatMinor : 0) !== value.totalMinor) {
    context.addIssue({ code: "custom", message: "signed correction delta does not reconcile" });
  }
});

const HistoricalBankRecognitionInitialItemV1Schema = z.object({
  rowNumber: z.number().int().positive(),
  itemId: UuidSchema,
  decision: z.literal("recognize"),
  closedOrderTimelineSha256: Sha256Schema.optional(),
  reasonCode: TokenSchema,
  recognitionKind: z.literal("initial"),
  merchantId: TokenSchema,
  storeId: TokenSchema,
  orderId: TokenSchema,
  sourcePendingPaymentEventId: UuidSchema,
  sourceObligationId: UuidSchema,
  sourceCommercialRevisionId: UuidSchema,
  targetPaymentEventId: UuidSchema,
  targetSourceType: z.literal("historical_bank_initial_recognition"),
  targetSourceId: TokenSchema,
  targetIdempotencyKey: TokenSchema,
  evidenceFingerprint: Sha256Schema,
  sourcePayloadSha256: Sha256Schema,
  componentBasisFingerprint: Sha256Schema,
  ownerDeclarationReferenceSha256: Sha256Schema,
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  minorUnitExponent: z.number().int().min(0).max(3),
  amountMinor: MinorSchema,
  economicOccurredAt: InstantSchema,
  components: OrderCommercialComponentsV1Schema,
}).strict().superRefine((value, context) => {
  if (value.components.totalMinor !== value.amountMinor) {
    context.addIssue({ code: "custom", message: "initial component total must equal receipt amount" });
  }
});

const HistoricalBankRecognitionCorrectionItemV1Schema = z.object({
  rowNumber: z.number().int().positive(),
  itemId: UuidSchema,
  decision: z.literal("recognize"),
  closedOrderTimelineSha256: Sha256Schema.optional(),
  reasonCode: TokenSchema,
  recognitionKind: z.literal("positive_correction"),
  merchantId: TokenSchema,
  storeId: TokenSchema,
  orderId: TokenSchema,
  sourcePendingPaymentEventId: UuidSchema,
  sourceObligationId: UuidSchema,
  sourceCommercialRevisionId: UuidSchema,
  baseCommercialRevisionId: UuidSchema,
  targetPaymentEventId: UuidSchema,
  targetSourceType: z.literal("historical_bank_correction_recognition"),
  targetSourceId: TokenSchema,
  targetIdempotencyKey: TokenSchema,
  evidenceFingerprint: Sha256Schema,
  sourcePayloadSha256: Sha256Schema,
  componentBasisFingerprint: Sha256Schema,
  ownerDeclarationReferenceSha256: Sha256Schema,
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  minorUnitExponent: z.number().int().min(0).max(3),
  amountMinor: MinorSchema,
  economicOccurredAt: InstantSchema,
  delta: HistoricalBankRecognitionDeltaV1Schema,
}).strict().superRefine((value, context) => {
  if (value.delta.totalMinor !== value.amountMinor) {
    context.addIssue({ code: "custom", message: "correction delta total must equal receipt amount" });
  }
});

const HistoricalBankRecognitionNoMutationItemV1Schema = z.object({
  rowNumber: z.number().int().positive(),
  itemId: UuidSchema,
  decision: z.enum(["already_satisfied", "exception"]),
  reasonCode: TokenSchema,
  recognitionKind: z.enum(["initial", "positive_correction"]),
  merchantId: TokenSchema,
  storeId: TokenSchema,
  orderId: TokenSchema,
  sourcePendingPaymentEventId: UuidSchema,
  sourceObligationId: UuidSchema,
  sourceCommercialRevisionId: UuidSchema,
  baseCommercialRevisionId: UuidSchema.optional(),
  sourcePayloadSha256: Sha256Schema,
  componentBasisFingerprint: Sha256Schema,
  ownerDeclarationReferenceSha256: Sha256Schema,
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  minorUnitExponent: z.number().int().min(0).max(3),
  amountMinor: MinorSchema,
  economicOccurredAt: InstantSchema,
}).strict().superRefine((value, context) => {
  if ((value.recognitionKind === "initial") !== (value.baseCommercialRevisionId === undefined)) {
    context.addIssue({ code: "custom", message: "base revision must exist only for a correction" });
  }
});

export const HistoricalBankRecognitionItemV1Schema = z.union([
  HistoricalBankRecognitionInitialItemV1Schema,
  HistoricalBankRecognitionCorrectionItemV1Schema,
  HistoricalBankRecognitionNoMutationItemV1Schema,
]);
export type HistoricalBankRecognitionItemV1 = z.infer<typeof HistoricalBankRecognitionItemV1Schema>;

export function parseHistoricalBankRecognitionItemV1(value: unknown): HistoricalBankRecognitionItemV1 {
  return HistoricalBankRecognitionItemV1Schema.parse(value);
}

export const HistoricalBankRecognitionSelectionV1Schema = z.object({
  mode: z.enum(["all_census_candidates", "explicit_source_allowlist"]),
  targetEnvironment: z.enum(["disposable", "uat", "production"]),
  reasonCode: TokenSchema,
  sourcePendingPaymentEventIds: z.array(UuidSchema).min(1).optional(),
}).strict().superRefine((value, context) => {
  const allowlist = value.sourcePendingPaymentEventIds;
  if (value.mode === "all_census_candidates" && allowlist !== undefined) {
    context.addIssue({ code: "custom", message: "full-census selection must not carry a source allowlist" });
  }
  if (value.mode === "explicit_source_allowlist" && (
    value.targetEnvironment !== "uat"
    || value.reasonCode !== "synthetic_uat_rehearsal"
    || !allowlist
    || new Set(allowlist).size !== allowlist.length
  )) {
    context.addIssue({ code: "custom", message: "explicit source allowlist is UAT synthetic rehearsal only" });
  }
});
export type HistoricalBankRecognitionSelectionV1 = z.infer<typeof HistoricalBankRecognitionSelectionV1Schema>;

export const HistoricalBankSourceDispositionV1Schema = z.object({
  sourceKind: TokenSchema,
  sourceId: TokenSchema,
  sourceSha256: Sha256Schema,
  disposition: z.enum(["canonical", "canonical_mirror", "related_fact", "exception"]),
  reasonCode: TokenSchema,
}).strict();
export type HistoricalBankSourceDispositionV1 = z.infer<typeof HistoricalBankSourceDispositionV1Schema>;

export const HistoricalBankRecognitionManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  toolVersion: z.literal("snus-historical-bank-recognition/v1"),
  runId: UuidSchema,
  sourceDatasetSha256: Sha256Schema,
  ownerDeclarationSha256: Sha256Schema,
  sourceApplicationSha: z.string().regex(/^[a-f0-9]{40}$/),
  cutoffAt: InstantSchema,
  reportAsOf: InstantSchema,
  datePolicy: z.literal("reliable_receipt_else_original_economic_time_v1"),
  selection: HistoricalBankRecognitionSelectionV1Schema,
  targetScopes: z.array(z.object({ merchantId: TokenSchema, storeId: TokenSchema }).strict())
    .superRefine((values, context) => {
      const keys = values.map((value) => `${value.merchantId}\0${value.storeId}`);
      if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "duplicate target scope" });
    }),
  expected: z.object({
    recognizedCount: z.number().int().nonnegative(),
    alreadySatisfiedCount: z.number().int().nonnegative(),
    exceptionCount: z.number().int().nonnegative(),
    moneyByCurrency: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().safe().nonnegative()),
  }).strict(),
  items: z.array(HistoricalBankRecognitionItemV1Schema),
  sourceState: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
  sourceDispositions: z.array(HistoricalBankSourceDispositionV1Schema).default([]),
}).strict().superRefine((value, context) => {
  if (value.sourceState && sha256Canonical(value.sourceState) !== value.sourceDatasetSha256) {
    context.addIssue({ code: "custom", message: "manifest source state fingerprint drift" });
  }
  const dispositionKeys = value.sourceDispositions.map((source) => `${source.sourceKind}\0${source.sourceId}`);
  if (new Set(dispositionKeys).size !== dispositionKeys.length) {
    context.addIssue({ code: "custom", message: "duplicate source disposition" });
  }
  const rows = value.items.map((item) => item.rowNumber);
  const sourceEvents = value.items.map((item) => item.sourcePendingPaymentEventId);
  if (new Set(rows).size !== rows.length || !rows.every((row, index) => row === index + 1)) {
    context.addIssue({ code: "custom", message: "manifest rows must be contiguous and unique" });
  }
  if (new Set(sourceEvents).size !== sourceEvents.length) {
    context.addIssue({ code: "custom", message: "a pending source event may appear only once" });
  }
  const actualScopes = new Set(value.items.map((item) => `${item.merchantId}\0${item.storeId}`));
  const declaredScopes = new Set(value.targetScopes.map((scope) => `${scope.merchantId}\0${scope.storeId}`));
  if (actualScopes.size !== declaredScopes.size || [...actualScopes].some((scope) => !declaredScopes.has(scope))) {
    context.addIssue({ code: "custom", message: "target scopes must exactly match manifest item scopes" });
  }
  if (value.selection.mode === "explicit_source_allowlist") {
    const allowlist = value.selection.sourcePendingPaymentEventIds || [];
    if (allowlist.length !== sourceEvents.length
      || new Set(allowlist).size !== sourceEvents.length
      || sourceEvents.some((sourceEvent) => !allowlist.includes(sourceEvent))) {
      context.addIssue({ code: "custom", message: "explicit allowlist must exactly bind manifest source events" });
    }
  }
  const recognized = value.items.filter((item) => item.decision === "recognize");
  const alreadySatisfied = value.items.filter((item) => item.decision === "already_satisfied");
  const exceptions = value.items.filter((item) => item.decision === "exception");
  const moneyByCurrency: Record<string, number> = {};
  for (const item of recognized) moneyByCurrency[item.currencyCode] = (moneyByCurrency[item.currencyCode] || 0) + item.amountMinor;
  if (recognized.length !== value.expected.recognizedCount
    || alreadySatisfied.length !== value.expected.alreadySatisfiedCount
    || exceptions.length + value.sourceDispositions.filter((source) => source.disposition === "exception").length !== value.expected.exceptionCount
    || canonicalJson(moneyByCurrency) !== canonicalJson(value.expected.moneyByCurrency)) {
    context.addIssue({ code: "custom", message: "manifest expected summary drift" });
  }
});
export type HistoricalBankRecognitionManifestV1 = z.infer<typeof HistoricalBankRecognitionManifestV1Schema>;

export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite historical bank manifest number");
    return Number.isSafeInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("unsupported historical bank manifest value");
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseHistoricalBankRecognitionManifestV1(value: unknown): HistoricalBankRecognitionManifestV1 {
  return HistoricalBankRecognitionManifestV1Schema.parse(value);
}
