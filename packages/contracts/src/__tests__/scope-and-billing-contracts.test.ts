import { describe, expect, it } from "vitest";
import {
  BillingOrderSnapshotSchema,
  CryptoReceiptEvidenceSchema,
  MerchantTargetScopeSchema,
  OperatingScopeSchema,
  ProviderWebhookEventSchema,
  ReportScopeSchema,
  RequestAccessSchema,
  assertMutationScope,
  calculateAnnualProration,
  defaultRolePermissionIds,
  applyAnnualProrationQuoteOnce,
  makeVndAmount,
  packageCatalogEntries,
  permissions,
  providerConfigPurposes,
  paymentBusinessPurposes,
  providerWebhookRouteSkeletons,
  retailCryptoAssets,
  sharedScopeFixtures,
  subscriptionPolicySnapshot,
  vndPackagePrices,
} from "../index";

const plusCatalogSnapshot = {
  catalogVersionId: "pkgcat_plus_1_1_2",
  catalogVersion: "1.1.2-annual-v1",
  packageKey: "plus",
  annualPrice: makeVndAmount(vndPackagePrices.plus),
  includedStores: 3,
  staffLimit: 10,
  researchRunsPerMonth: 100,
  telegramAiDraftsPerMonth: 0,
  featureKeys: ["pos_core", "accounting_core", "sepay_qr_payment", "crypto_payment", "smart_cross_sell", "product_research", "customer_scan_go"],
} as const;

function prorationInput(overrides: Partial<Parameters<typeof calculateAnnualProration>[0]> = {}) {
  return {
    prorationKind: "package_upgrade",
    currentAnnualPrice: makeVndAmount(vndPackagePrices.plus),
    targetAnnualPrice: makeVndAmount(vndPackagePrices.ai_fan),
    currentPeriodStart: "2026-01-01T00:00:00.000Z",
    currentPeriodEnd: "2027-01-01T00:00:00.000Z",
    quoteCreatedAt: "2026-06-20T12:00:00.000Z",
    currentPackageKey: "plus",
    targetPackageKey: "ai_fan",
    catalogSnapshot: { ...plusCatalogSnapshot, effectiveFrom: "2026-01-01T00:00:00.000Z" },
    policySnapshot: subscriptionPolicySnapshot,
    ...overrides,
  } as Parameters<typeof calculateAnnualProration>[0];
}

describe("Scope and provider contracts", () => {
  it("exposes typed write permissions with explicit role defaults", () => {
    expect(permissions).toMatchObject({
      catalogWrite: "catalog:write",
      customerWrite: "customer:write",
      loyaltyWrite: "loyalty:write",
      accountingWrite: "accounting:write",
      orderWrite: "order:write",
      inventoryWrite: "inventory:write",
      ordersExport: "orders:export",
      scanGoRedeem: "scan_go:redeem",
      visionScanUse: "vision_scan:use",
      visionScanRead: "vision_scan:read",
      visionCatalogWrite: "vision_catalog:write",
      visionDebugImageEnable: "vision_debug_image:enable",
      profileRead: "profile:read",
      teamRead: "team:read",
      teamWrite: "team:write",
      platformOperatorResetPassword: "platform_operator:reset_password",
      platformImpersonationStart: "platform_impersonation:start",
      shiftOpen: "shift:open",
      shiftClose: "shift:close",
      shiftRead: "shift:read",
      shiftCashAdjust: "shift:cash_adjust",
      shiftReview: "shift:review",
      shiftManage: "shift:manage",
      shiftReport: "shift:report",
    });
    expect(defaultRolePermissionIds.accountant).toEqual(expect.arrayContaining([
      permissions.accountingRead,
      permissions.accountingWrite,
      permissions.reportsRead,
      permissions.ordersExport,
      permissions.profileRead,
      permissions.profileWrite,
      permissions.profilePasswordWrite,
      permissions.profileTelegramWrite,
    ]));
    for (const role of ["staff", "manager", "accountant", "owner"] as const) {
      expect(defaultRolePermissionIds[role]).toEqual(expect.arrayContaining([
        permissions.customerRead, permissions.customerWrite, permissions.categoryRead,
      ]));
    }
    expect(defaultRolePermissionIds.accountant).not.toContain(permissions.catalogWrite);
    expect(defaultRolePermissionIds.accountant).not.toContain(permissions.teamRead);
    expect(defaultRolePermissionIds.accountant).toContain(permissions.profileRead);
    expect(defaultRolePermissionIds.staff).not.toContain(permissions.ordersExport);
    expect(defaultRolePermissionIds.staff).toContain(permissions.customerWrite);
    expect(defaultRolePermissionIds.staff).toContain(permissions.scanGoRedeem);
    expect(defaultRolePermissionIds.staff).toContain(permissions.visionScanUse);
    expect(defaultRolePermissionIds.staff).toContain(permissions.profileRead);
    expect(defaultRolePermissionIds.staff).toEqual(expect.arrayContaining([
      permissions.shiftOpen,
      permissions.shiftClose,
      permissions.shiftRead,
      permissions.shiftCashAdjust,
    ]));
    expect(defaultRolePermissionIds.staff).not.toContain(permissions.shiftReview);
    expect(defaultRolePermissionIds.staff).not.toContain(permissions.shiftManage);
    expect(defaultRolePermissionIds.staff).not.toContain(permissions.shiftReport);
    expect(defaultRolePermissionIds.staff).not.toContain(permissions.teamRead);
    expect(defaultRolePermissionIds.staff).not.toContain(permissions.visionCatalogWrite);
    expect(defaultRolePermissionIds.staff).not.toContain(permissions.visionDebugImageEnable);
    expect(defaultRolePermissionIds.manager).toEqual(expect.arrayContaining([
      permissions.catalogWrite,
      permissions.customerWrite,
      permissions.loyaltyWrite,
      permissions.orderWrite,
      permissions.inventoryWrite,
      permissions.ordersExport,
      permissions.scanGoRedeem,
      permissions.visionScanUse,
      permissions.visionScanRead,
      permissions.visionCatalogWrite,
      permissions.teamRead,
      permissions.teamWrite,
      permissions.teamResetPassword,
      permissions.shiftOpen,
      permissions.shiftClose,
      permissions.shiftRead,
      permissions.shiftCashAdjust,
      permissions.shiftReview,
      permissions.shiftManage,
      permissions.shiftReport,
    ]));
    expect(defaultRolePermissionIds.manager).not.toContain(permissions.visionDebugImageEnable);
    expect(defaultRolePermissionIds.owner).toEqual(expect.arrayContaining([
      permissions.ordersExport,
      permissions.scanGoRedeem,
      permissions.visionScanUse,
      permissions.visionScanRead,
      permissions.visionCatalogWrite,
      permissions.visionDebugImageEnable,
      permissions.teamRead,
      permissions.teamWrite,
      permissions.teamResetPassword,
      permissions.shiftOpen,
      permissions.shiftClose,
      permissions.shiftRead,
      permissions.shiftCashAdjust,
      permissions.shiftReview,
      permissions.shiftManage,
      permissions.shiftReport,
    ]));
    expect(defaultRolePermissionIds.accountant).not.toContain(permissions.shiftRead);
    expect(defaultRolePermissionIds.accountant).not.toContain(permissions.shiftManage);
    expect(defaultRolePermissionIds.owner).not.toContain(permissions.platformImpersonationStart);
  });

  it("keeps operating, report and platform read scopes distinct", () => {
    expect(OperatingScopeSchema.parse(sharedScopeFixtures.operatingScopes.defaultStore)).toMatchObject({
      scopeKind: "operating",
      merchantId: "merchant_default",
      storeId: "store_default",
      stockLocationId: "sloc_default",
    });
    expect(MerchantTargetScopeSchema.parse(sharedScopeFixtures.merchantTargetScopes.defaultMerchant)).toEqual({
      scopeKind: "merchant_target",
      merchantId: "merchant_default",
    });
    expect(ReportScopeSchema.parse(sharedScopeFixtures.reportScopes.defaultMerchantAllStores).storeIds).toHaveLength(2);
    expect(() => assertMutationScope(sharedScopeFixtures.reportScopes.defaultMerchantAllStores)).toThrow("Mutations require OperatingScope");
    expect(() => assertMutationScope(sharedScopeFixtures.platformReadScopes.allMerchants)).toThrow("Mutations require OperatingScope");
  });

  it("defines shared fixtures for two merchants, three stores and legacy org_default rows", () => {
    expect(sharedScopeFixtures.merchants.map((merchant) => merchant.merchantId)).toEqual(["merchant_default", "merchant_second"]);
    expect(sharedScopeFixtures.stores).toHaveLength(3);
    expect(sharedScopeFixtures.legacyRows.organization.organizationId).toBe("org_default");
    expect(sharedScopeFixtures.legacyRows.stockLocation.stockLocationId).toBe("sloc_default");
  });

  it("freezes explicit access, package prices, provider purposes and route skeletons", () => {
    expect(RequestAccessSchema.parse({
      actorId: "op_owner",
      isPlatformAdmin: false,
      memberships: [{
        membershipId: "mem_owner",
        operatorId: "op_owner",
        scopeType: "merchant",
        merchantId: "merchant_default",
        storeId: null,
        roleKey: "owner",
        status: "active",
        permissionIds: ["inventory:read", "orders:read", "subscription:read"],
      }],
      permissionIds: ["inventory:read", "orders:read", "subscription:read"],
    }).legacyOrganizationId).toBe("org_default");
    expect(RequestAccessSchema.parse({
      actorId: "op_owner",
      isPlatformAdmin: false,
      memberships: [{
        membershipId: "mem_revoked",
        operatorId: "op_owner",
        scopeType: "merchant",
        merchantId: "merchant_default",
        storeId: null,
        roleKey: "owner",
        status: "revoked",
        permissionIds: [],
      }],
      permissionIds: [],
    }).memberships[0].status).toBe("revoked");

    expect(packageCatalogEntries.map((entry) => [entry.packageKey, entry.annualPrice.amountVnd])).toEqual([
      ["basic", "0"],
      ["plus", "3588000"],
      ["ai_fan", "7188000"],
    ]);
    expect(packageCatalogEntries.find((entry) => entry.packageKey === "basic")?.featureKeys).not.toContain("vision_pos_input");
    expect(packageCatalogEntries.find((entry) => entry.packageKey === "plus")?.featureKeys).not.toContain("vision_pos_input");
    expect(packageCatalogEntries.find((entry) => entry.packageKey === "ai_fan")?.featureKeys).toEqual(expect.arrayContaining([
      "vision_pos_input",
      "vision_pos_single_capture",
      "vision_correction_report",
    ]));
    expect(packageCatalogEntries.find((entry) => entry.packageKey === "ai_fan")?.featureKeys).not.toContain("vision_pos_bulk_capture");
    expect(packageCatalogEntries.find((entry) => entry.packageKey === "ai_fan")?.featureKeys).not.toContain("vision_debug_image_storage");
    expect(providerConfigPurposes).toEqual(["platform_billing", "merchant_retail"]);
    expect(paymentBusinessPurposes).toEqual(["platform_subscription", "retail_order"]);
    expect(retailCryptoAssets).toEqual(["USDTTRC20", "USDCMATIC"]);
    expect(providerWebhookRouteSkeletons).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeId: "retail-sepay-webhook", businessPurpose: "retail_order", providerConfigPurpose: "merchant_retail" }),
      expect.objectContaining({ routeId: "platform-nowpayments-billing-webhook", businessPurpose: "platform_subscription", providerConfigPurpose: "platform_billing" }),
    ]));
  });

  it("validates billing snapshots, provider webhook provenance and crypto evidence DTOs", () => {
    const billing = BillingOrderSnapshotSchema.parse({
      billingOrderId: "bill_1",
      merchantId: "merchant_default",
      purpose: "upgrade",
      status: "waiting_payment",
      businessPurpose: "platform_subscription",
      providerConfigPurpose: "platform_billing",
      currentPackageKey: "plus",
      targetPackageKey: "ai_fan",
      amount: makeVndAmount("1805000"),
      periodStart: "2024-02-29T00:00:00.000Z",
      periodEnd: "2025-02-28T00:00:00.000Z",
      catalogSnapshot: { ...plusCatalogSnapshot, effectiveFrom: "2024-02-29T00:00:00.000Z" },
      policySnapshot: subscriptionPolicySnapshot,
      idempotencyKey: "upgrade:merchant_default:2024-08-29",
    });
    expect(billing.providerConfigPurpose).toBe("platform_billing");

    expect(() => BillingOrderSnapshotSchema.parse({ ...billing, providerConfigPurpose: "merchant_retail" })).toThrow();

    const webhook = ProviderWebhookEventSchema.parse({
      provider: "nowpayments",
      providerEventId: "np_evt_1",
      businessPurpose: "platform_subscription",
      providerConfigPurpose: "platform_billing",
      providerConfigProvenance: {
        provider: "nowpayments",
        purpose: "platform_billing",
        scope: { scopeType: "platform", merchantId: null, storeId: null },
        configId: "cfg_platform_np",
        liveMode: false,
      },
      status: "provider_paid",
      amount: makeVndAmount("1805000"),
      occurredAt: "2026-06-20T00:00:00.000Z",
      payload: {},
    });
    expect(webhook.providerConfigProvenance.purpose).toBe("platform_billing");

    expect(CryptoReceiptEvidenceSchema.parse({
      evidenceId: "crypto_ev_1",
      businessPurpose: "retail_order",
      merchantId: "merchant_default",
      storeId: "store_default",
      paymentIntentId: "pi_1",
      providerEventId: "np_evt_2",
      asset: "USDTTRC20",
      transactionHash: "0xabc123",
      destinationWalletRef: "wallet_merchant_default",
      grossQuantity: "12.500000",
      providerFeeQuantity: "0.062500",
      netQuantity: "12.437500",
      grossVndValue: 312500,
      feeVndValue: 1563,
      valuationRateSource: "provider_quote",
      valuationTimestamp: "2026-06-20T00:00:00.000Z",
    }).asset).toBe("USDTTRC20");
  });
});

describe("Annual proration contracts", () => {
  it("uses calendar-year boundaries across a leap-year subscription period", () => {
    const quote = calculateAnnualProration(prorationInput({
      currentPeriodStart: "2024-02-29T00:00:00.000Z",
      currentPeriodEnd: "2025-02-28T00:00:00.000Z",
      quoteCreatedAt: "2024-08-29T00:00:00.000Z",
    }));
    expect(quote.rawAmountVnd).toBe("1804932");
    expect(quote.amount.amountVnd).toBe("1805000");
  });

  it("charges the minimum rounded thousand when a paid upgrade is near expiry", () => {
    const quote = calculateAnnualProration(prorationInput({
      quoteCreatedAt: "2026-12-31T23:59:59.999Z",
    }));
    expect(quote.rawAmountVnd).toBe("1");
    expect(quote.amount.amountVnd).toBe("1000");
  });

  it("returns zero when no remaining service time exists", () => {
    const quote = calculateAnnualProration(prorationInput({
      quoteCreatedAt: "2027-01-01T00:00:00.000Z",
    }));
    expect(quote.remainingMilliseconds).toBe("0");
    expect(quote.amount.amountVnd).toBe("0");
  });

  it("rounds store add-on proration up to VND 1,000 without floating point money", () => {
    expect(() => makeVndAmount(12.34)).toThrow("safe integer");
    const quote = calculateAnnualProration(prorationInput({
      prorationKind: "store_addon",
      currentAnnualPrice: makeVndAmount(0),
      targetAnnualPrice: makeVndAmount(vndPackagePrices.extra_store),
      currentPackageKey: null,
      targetPackageKey: null,
      quoteCreatedAt: "2026-06-20T12:00:00.000Z",
    }));
    expect(quote.rawAmountVnd).toBe("633058");
    expect(quote.amount.amountVnd).toBe("634000");
  });

  it("makes duplicate proration application idempotent", () => {
    const quote = calculateAnnualProration(prorationInput());
    const first = applyAnnualProrationQuoteOnce({
      billingOrderId: "bill_upgrade_1",
      quote,
      appliedBillingOrderIds: [],
    });
    const duplicate = applyAnnualProrationQuoteOnce({
      billingOrderId: "bill_upgrade_1",
      quote,
      appliedBillingOrderIds: first.appliedBillingOrderIds,
    });
    expect(first).toMatchObject({ applied: true, reason: "applied", amount: quote.amount });
    expect(duplicate).toMatchObject({ applied: false, reason: "duplicate_application", amount: makeVndAmount(0) });
    expect(duplicate.appliedBillingOrderIds).toEqual(["bill_upgrade_1"]);
  });
});
