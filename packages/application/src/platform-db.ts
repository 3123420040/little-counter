import { shutdownPlatformPool } from "./db/client";

/**
 * ARCHITECTURE NOTE: platform-db.ts is an extraction target.
 *
 * This file is the current PostgreSQL-backed production compatibility surface.
 * Do not add new business features here. Move new behavior into extracted
 * db/repository/service modules and leave this file as a re-export/wrapper while
 * the multi-channel core is being built.
 */

export async function shutdownPlatformDb(): Promise<void> {
  await shutdownPlatformPool();
}

export { ensurePlatformSchema, seedPlatformData } from "./db/schema";
export { PlatformError, sendPlatformError, serializePlatformError } from "./errors/platform-error";
export type { HeadersLike } from "./http/headers";
export { enforceRateLimit } from "./middleware/rate-limit";
export type { RateLimitScope, RateLimitSubject } from "./middleware/rate-limit";
export * from "./contract-seams";

export { authenticateHeaders, authenticateRequestActor, loginOperator, resolveOperatorAccess, toScopeActor } from "./services/auth-service";
export type { OperatorContext } from "./services/auth-service";

export { resolveScopeBootstrap, resolveRequestAccess, resolveOperatingScope, requireOperatingScope, resolveReportScope, resolvePlatformReadScope, hasMerchantAccess, hasPlatformReadAccess, hasStoreAccess, requireActivePlatformMembership } from "./services/access-service";
export type { AccessibleMerchant, AccessibleStore, ScopeActor, ScopeBootstrap } from "./services/access-service";

export { createJournalEntry, getBalanceSheet, getCashFlow, getIncomeStatement, getTaxSummary, getJournalEntryMutationTarget, listAccounts, listJournalEntries, postJournalEntry, reportHtml, reportPdfBuffer, updateJournalEntry, voidJournalEntry } from "./services/accounting-service";
export { acknowledgeAiAlert, approveAiAction, getAiRecommendations, listAiAlerts, listAiReviewQueue, persistReplyDraft, rejectAiAction } from "./services/ai-service";
export { listAudit } from "./services/audit-service";

export { authenticateChannelServiceHeaders, authenticateChannelServiceOnlyHeaders, getChannelMe, requireChannelPermission, resolveChannelActor } from "./services/channel-auth-service";
export type { ChannelActor, ChannelServiceContext } from "./services/channel-auth-service";
export { clearChannelSession, getChannelSession, updateChannelSession } from "./services/channel-session-service";
export type { ChannelSessionInput } from "./services/channel-session-service";

export { createCustomer, deleteCustomer, getCustomer, getCustomerLoyalty, getCustomerMutationTarget, listCustomers, listLoyaltyTiers, mergeCustomers, updateCustomer } from "./services/customer-service";
export { getDashboard } from "./services/dashboard-service";
export {
  DASHBOARD_REPORT_MAX_LOCAL_DAYS,
  DASHBOARD_SNAPSHOT_TIMEOUT_HARD_CAP_MS,
  normalizeDashboardLocalDateRange,
  resolveDashboardStoreWindows,
  withDashboardReadSnapshot,
} from "./services/dashboard-report-foundation";
export type {
  DashboardLocalDateRangeInput,
  DashboardSnapshotReadContext,
  DashboardSnapshotRequest,
  DashboardSnapshotResult,
  NormalizedDashboardLocalDateRange,
} from "./services/dashboard-report-foundation";
export {
  DASHBOARD_COMMERCIAL_TOP_PRODUCT_LIMIT,
  DashboardCommercialDataQualityError,
  readDashboardCommercialSnapshotV1,
} from "./services/dashboard-commercial-slice";
export type {
  DashboardCommercialDataQualityIssue,
  DashboardCommercialDataQualityIssueReason,
} from "./services/dashboard-commercial-slice";
export { getPackageEntitlements, hasFeature, requireFeature } from "./services/feature-entitlement-service";
export type { FeatureKey, PackageKey } from "./services/feature-entitlement-service";

export { createProductExportCsv, createProductImportTemplateCsv, previewProductImport, applyProductImport } from "./services/catalog-import-export-service";
export { createCategoryExportCsv, createCategoryImportTemplateCsv, previewCategoryImport, applyCategoryImport } from "./services/category-import-export-service";
export { createInventoryAdjustmentExportCsv, createInventoryAdjustmentImportTemplateCsv, previewInventoryImport, applyInventoryImport } from "./services/inventory-import-export-service";
export { createPurchaseOrderDetailExportCsv, createPurchaseOrderExportCsv, createPurchaseOrderImportTemplateCsv, createPurchaseOrderRecommendationCsv, previewPurchaseOrderImport, applyPurchaseOrderImport } from "./services/purchase-order-import-export-service";
export type { ImportPreviewResult, ImportPreviewRow, ImportApplyResult, ImportApplyRow } from "./services/import-types";
export { publicOperationErrorMessage, safeErrorCode, safeErrorMetadata } from "./utils/safe-error";

export { adjustStock, cancelPurchaseOrder, closeShortPurchaseOrder, createPurchaseOrder, createStockMovementHistoryExportCsv, getPurchaseOrderDetail, listInventoryItems, listPurchaseOrderCatalog, listPurchaseOrders, listStockMovements, receivePurchaseOrder, sendPurchaseOrder } from "./services/inventory-service";
export type { PurchaseOrderCatalogQuery } from "./services/inventory-service";
export { assertMerchantMutationTarget, assertOperatingMutationTarget } from "./services/mutation-scope-service";
export { cancelOrder, completeSale, createOrderExportCsv, createRemoteOrder, getOrder, getOrderMutationTarget, listOrders, prepareOrderRecreatePrefill, previewOrderShippingFee, quoteOrderCancellation, refundOrder, updateOrder, updateOrderCustomer, updateOrderShippingFee } from "./services/order-service";
export type { CancelOrderInput, OrderRecreatePrefill, OrderRecreatePrefillItem, RefundOrderInput, RemoteOrderInput, SaleInput, UpdateOrderInput, UpdateOrderShippingInput } from "./services/order-service";
export { previewSalePaymentFee } from "./services/order-service";
export { checkoutPaymentFeeResponseV1 } from "./services/checkout-payment-fee-presentation";
export { applyOrderCorrection, getOrderCorrections, previewOrderCorrection } from "./services/order-correction-service";
export type { OrderCorrectionInput } from "./services/order-correction-service";
export { readOrderCorrectionFinancialContextV1 } from "./services/order-correction-context-service";
export { orderCorrectionFinancialPreviewV1, orderCorrectionFinancialResponseV1 } from "./services/order-correction-payment-fee-presentation";
export * from "./services/correction-commercial-revision-service";
export * from "./services/postgres-correction-commercial-revision-repository";
export * from "./services/postgres-positive-correction-charge-repository";
export * from "./services/manual-bank-confirmation-service";
export * from "./services/manual-bank-correction-confirmation-service";
export * from "./services/postgres-manual-bank-correction-confirmation-repository";
export * from "./services/customer-refund-payable-service";
export * from "./services/cancellation-commercial-revision-service";
export * from "./services/order-cancellation-quote-service";
export * from "./services/dashboard-payment-flow-slice";
export * from "./platform-order-read-exports";
export { getCrossSellRecommendations, recordCrossSellAcceptance } from "./services/recommendation-service";
export { processExactOutboxEvent, processOutboxEvent } from "./services/outbox-processor-service";

export { cancelPaymentIntent, createPaymentIntent, getPaymentIntent, recoverPaymentIntentCreationReceiptV1, closePaymentIntentCreationReceiptV1, handleProviderPaymentEvent, listPaymentIntents, settleMockPaymentIntent } from "./services/payment-intent-service";
export { paymentIntentFinancialViewV1, paymentIntentFinancialResponseV1 } from "./services/payment-intent-financial-projection";
export { verifyNowPaymentsWebhook, verifySepayWebhook } from "./services/payment-provider-service";
export { assertNotReadOnlyImpersonation, requireActorPermission, requireMerchantTargetScope, requireMutationScope, requireOperatingReadScope, requireReadableReportScope, requirePlatformReadScope, requireScopedActorPermission } from "./services/permission-service";
export {
  closeShift,
  forceCloseShift,
  getCurrentShift,
  getMyShiftReport,
  getShiftPolicy,
  getShiftReport,
  listMyShifts,
  listShifts,
  previewCloseShift,
  receiveShiftHandover,
  recordShiftCashMovement,
  recordShiftStockCount,
  reviewShift,
  startShift,
  updateShiftPolicy,
} from "./services/shift-service";
export type { ShiftListFilters, UpdateShiftPolicyInput } from "./services/shift-service";

export { createProduct, getProductMutationTarget, updateProduct } from "./services/product-management-service";
export { createProductCategory, deleteProductCategory, getProductCategory, getProductCategoryMutationTarget, listProductCategories, updateProductCategory } from "./services/product-category-service";
export type { ProductCategoryRecord } from "./services/product-category-service";
export { getProduct, listAdminProducts, listProducts } from "./services/product-service";
export type { ProductView } from "./services/product-service";
export { handleProductImageAutofillRequested, requestProductImageAutofill } from "./services/product-image-autofill-service";
export { ensureProductQrIdentity, extractProductQrSlug, getProductTagViewModel, resolveProductScan } from "./services/product-qr-service";
export { createScanGoCart, createScanGoCheckoutToken, extractScanGoToken, redeemScanGoCartForStaff, resolvePublicScanGoProduct, resolveScanGoCartForStaff, updateScanGoCart } from "./services/scan-go-service";

export { changeOwnOperatorPassword, completeRequiredOperatorPasswordChange, consumeOwnTelegramLinkToken, createOwnTelegramLinkToken, logoutAllOperatorSessions, unlinkOwnTelegramIdentity, updateOwnOperatorProfile, validateOperatorPassword } from "./services/operator-account-service";
export { createTeamOperator, disableTeamMembership, enableTeamMembership, listTeamOperatorAudit, resetTeamOperatorPassword, updateTeamMembership, updateTeamOperatorProfile } from "./services/operator-team-service";
export { grantPlatformOperatorPermission, listPlatformOperators, PLATFORM_OWNER_GRANTS, resetPlatformOperatorPassword, revokePlatformOperatorPermission, setPlatformOperatorSuspension } from "./services/platform-operator-service";
export { endReadOnlyImpersonation, startReadOnlyImpersonation } from "./services/impersonation-service";
export { assertOperatorCanUseChannel, assertOperatorSecurityAllowsRequest, bumpOperatorSessionVersion, ensureOperatorSecurityState, loadOperatorSecurityState, tokenIssuedBeforeForceLogout } from "./services/operator-security-service";
export type { OperatorSecurityState } from "./services/operator-security-service";

export { getReceiptPdfBuffer, getReceiptText, sendReceiptEmail } from "./services/receipt-service";
export type { ReceiptEmailInput } from "./services/receipt-service";
export { getSyncBootstrap } from "./services/sync-service";
export { commitUsage, releaseUsage, reserveUsage } from "./services/subscription-usage-service";
export { deliverSubscriptionLifecycleNotifications, queueSubscriptionLifecycleNotifications, runSubscriptionLifecycleNotificationPipeline } from "./services/subscription-lifecycle-notification-service";

export { getTelegramBotConfigReadModel, markTelegramBotHeartbeat, resolveTelegramWebhookConfig, upsertTelegramBotConfig } from "./services/telegram-bot-config-service";
export { claimTelegramNotifications, markTelegramNotificationFailed, markTelegramNotificationSent } from "./services/telegram-notification-service";
export { createTelegramNotificationRecipient, createTelegramNotificationRule, getTelegramNotificationSettings, sendTelegramNotificationRecipientTest, updateTelegramNotificationRecipient, updateTelegramNotificationRule } from "./services/telegram-notification-settings-service";
export { clearTelegramSalesSession, getTelegramSalesSession, updateTelegramSalesSession } from "./services/telegram-sales-session-service";
export { checkoutTelegramSalesDraft, confirmTelegramSalesDraft, createTelegramSalesDraft, getTelegramSalesDraft, listTelegramSalesCatalog, listTelegramSalesCustomerDrafts, listTelegramSalesDrafts, quoteTelegramSalesCart, rejectTelegramSalesDraft } from "./services/telegram-sales-service";

export * from "./services/vision-catalog-service";
export * from "./services/vision-scan-service";
export * from "./services/vision-image-validation";
export * from "./platform-public-signup-exports";
export * from "./services/platform-admin-service";
