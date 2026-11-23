import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  PlatformError: class PlatformError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  },
  createTelegramNotificationRecipient: vi.fn(),
  createTelegramNotificationRule: vi.fn(),
  getMerchantSettingsProfile: vi.fn(),
  getOwnerIntegrations: vi.fn(),
  getOwnerPackagePage: vi.fn(),
  getTelegramNotificationSettings: vi.fn(),
  getStoreSettingsProfile: vi.fn(),
  getStoreSettingsTarget: vi.fn(),
  listSettingsAudit: vi.fn(),
  listStoreSettings: vi.fn(),
  listTeamMembers: vi.fn(),
  requestOwnerPackageUpgrade: vi.fn(),
  sendTelegramNotificationRecipientTest: vi.fn(),
  updateMerchantSettingsProfile: vi.fn(),
  updateStoreSettingsProfile: vi.fn(),
  updateTelegramNotificationRecipient: vi.fn(),
  updateTelegramNotificationRule: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithMerchantTargetAccess: vi.fn(),
  actorWithMerchantTargetMutation: vi.fn(),
  body: vi.fn(),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as getMerchant, PATCH as patchMerchant } from "../../../../src/api/settings/merchant/[merchantId]/route";
import { GET as getStores } from "../../../../src/api/settings/merchant/[merchantId]/stores/route";
import { GET as getStore, PATCH as patchStore } from "../../../../src/api/settings/stores/[storeId]/route";
import { GET as getTeam } from "../../../../src/api/settings/merchant/[merchantId]/team/route";
import { GET as getPackage } from "../../../../src/api/settings/merchant/[merchantId]/package/route";
import { POST as postPackageUpgrade } from "../../../../src/api/settings/merchant/[merchantId]/package/upgrade/route";
import { GET as getIntegrations } from "../../../../src/api/settings/merchant/[merchantId]/integrations/route";
import { GET as getAudit } from "../../../../src/api/settings/merchant/[merchantId]/audit/route";
import { GET as getTelegramNotifications } from "../../../../src/api/settings/merchant/[merchantId]/telegram-notifications/route";
import { POST as postTelegramRecipient } from "../../../../src/api/settings/merchant/[merchantId]/telegram-notifications/recipients/route";
import { PATCH as patchTelegramRecipient } from "../../../../src/api/settings/merchant/[merchantId]/telegram-notifications/recipients/[recipientId]/route";
import { POST as postTelegramRecipientTest } from "../../../../src/api/settings/merchant/[merchantId]/telegram-notifications/recipients/[recipientId]/test/route";
import { POST as postTelegramRule } from "../../../../src/api/settings/merchant/[merchantId]/telegram-notifications/rules/route";
import { PATCH as patchTelegramRule } from "../../../../src/api/settings/merchant/[merchantId]/telegram-notifications/rules/[ruleId]/route";

const actor = { operatorId: "op_owner", role: "owner", displayName: "Owner", organizationId: "org_a" };
const merchantScope = { scopeKind: "merchant_target", merchantId: "merchant_a" };
const response = {
  status: vi.fn(() => response),
  json: vi.fn(),
} as never;

function merchantRequest(body: Record<string, unknown> = {}) {
  return { headers: {}, body, params: { merchantId: "merchant_a" } } as never;
}

function storeRequest(body: Record<string, unknown> = {}) {
  return { headers: {}, body, params: { storeId: "store_a" } } as never;
}

function telegramRecipientRequest(body: Record<string, unknown> = {}) {
  return { headers: {}, body, params: { merchantId: "merchant_a", recipientId: "recipient_a" } } as never;
}

function telegramRuleRequest(body: Record<string, unknown> = {}) {
  return { headers: {}, body, params: { merchantId: "merchant_a", ruleId: "rule_a" } } as never;
}

describe("owner settings routes use scoped permission guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.body.mockImplementation((req) => req.body);
    routeUtils.actorWithMerchantTargetAccess.mockResolvedValue({ actor, scope: merchantScope });
    routeUtils.actorWithMerchantTargetMutation.mockResolvedValue({ actor, scope: merchantScope });
    application.getStoreSettingsTarget.mockResolvedValue({ storeId: "store_a", merchantId: "merchant_a" });
    application.getMerchantSettingsProfile.mockResolvedValue({ data: { merchantId: "merchant_a" } });
    application.updateMerchantSettingsProfile.mockResolvedValue({ data: { merchantId: "merchant_a" } });
    application.listStoreSettings.mockResolvedValue({ data: [] });
    application.getStoreSettingsProfile.mockResolvedValue({ data: { storeId: "store_a" } });
    application.updateStoreSettingsProfile.mockResolvedValue({ data: { storeId: "store_a" } });
    application.listTeamMembers.mockResolvedValue({ data: [] });
    application.getOwnerPackagePage.mockResolvedValue({ data: {} });
    application.requestOwnerPackageUpgrade.mockResolvedValue({ data: { billingOrderId: "bo_1" } });
    application.getOwnerIntegrations.mockResolvedValue({ data: [] });
    application.getTelegramNotificationSettings.mockResolvedValue({ data: { recipients: [], rules: [] } });
    application.createTelegramNotificationRecipient.mockResolvedValue({ data: { id: "recipient_a" } });
    application.updateTelegramNotificationRecipient.mockResolvedValue({ data: { id: "recipient_a" } });
    application.sendTelegramNotificationRecipientTest.mockResolvedValue({ data: { queued: true, recipientId: "recipient_a" } });
    application.createTelegramNotificationRule.mockResolvedValue({ data: { id: "rule_a" } });
    application.updateTelegramNotificationRule.mockResolvedValue({ data: { id: "rule_a" } });
    application.listSettingsAudit.mockResolvedValue({ data: [] });
  });

  it("guards merchant profile read/update with settings permissions and merchant target", async () => {
    await getMerchant(merchantRequest(), response);
    await patchMerchant(merchantRequest({ publicName: "A" }), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.settingsRead, "merchant_a");
    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.settingsWrite, "merchant_a");
    expect(application.updateMerchantSettingsProfile).toHaveBeenCalledWith("merchant_a", { publicName: "A" }, actor, merchantScope);
  });

  it("guards store profile by resolving the store merchant before update mutation", async () => {
    await getStore(storeRequest(), response);
    await patchStore(storeRequest({ publicName: "Store A" }), response);

    expect(application.getStoreSettingsTarget).toHaveBeenCalledWith("store_a");
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.settingsRead, "merchant_a");
    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.settingsWrite, "merchant_a");
    expect(application.updateStoreSettingsProfile).toHaveBeenCalledWith("store_a", { publicName: "Store A" }, actor, merchantScope);
  });

  it("denies a cross-merchant store update before the service mutation is called", async () => {
    application.getStoreSettingsTarget.mockResolvedValue({ storeId: "store_b", merchantId: "merchant_b" });
    routeUtils.actorWithMerchantTargetMutation.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "forbidden" }));

    await expect(patchStore(storeRequest({ publicName: "Nope" }), response)).rejects.toMatchObject({ code: "forbidden" });

    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.settingsWrite, "merchant_b");
    expect(application.updateStoreSettingsProfile).not.toHaveBeenCalled();
  });

  it("denies a cross-merchant profile update before the service mutation is called", async () => {
    routeUtils.actorWithMerchantTargetMutation.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "forbidden" }));

    await expect(patchMerchant({ ...merchantRequest({ publicName: "Nope" }), params: { merchantId: "merchant_b" } } as never, response))
      .rejects.toMatchObject({ code: "forbidden" });

    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.settingsWrite, "merchant_b");
    expect(application.updateMerchantSettingsProfile).not.toHaveBeenCalled();
  });

  it("uses explicit read permissions for owner settings supporting pages", async () => {
    await getStores(merchantRequest(), response);
    await getTeam(merchantRequest(), response);
    await getPackage(merchantRequest(), response);
    await getIntegrations(merchantRequest(), response);
    await getAudit(merchantRequest(), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.settingsRead, "merchant_a");
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.subscriptionRead, "merchant_a");
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.integrationConfigRead, "merchant_a");
  });

  it("requires integration read permission and merchant target before the integration service", async () => {
    await getIntegrations(merchantRequest(), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.integrationConfigRead, "merchant_a");
    expect(application.getOwnerIntegrations).toHaveBeenCalledWith("merchant_a", merchantScope);

    vi.clearAllMocks();
    routeUtils.actorWithMerchantTargetAccess.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "forbidden" }));
    await expect(getIntegrations({ ...merchantRequest(), params: { merchantId: "merchant_b" } } as never, response))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(application.getOwnerIntegrations).not.toHaveBeenCalled();
  });

  it("guards Telegram notification settings with merchant settings permissions", async () => {
    await getTelegramNotifications(merchantRequest(), response);
    await postTelegramRecipient(merchantRequest({ telegramUserId: "123", displayName: "Owner", recipientKind: "owner" }), response);
    await patchTelegramRecipient(telegramRecipientRequest({ status: "disabled" }), response);
    await postTelegramRecipientTest(telegramRecipientRequest(), response);
    await postTelegramRule(merchantRequest({ recipientId: "recipient_a", name: "Telegram orders", eventScope: "orders" }), response);
    await patchTelegramRule(telegramRuleRequest({ enabled: false }), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.settingsRead, "merchant_a");
    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.settingsWrite, "merchant_a");
    expect(application.getTelegramNotificationSettings).toHaveBeenCalledWith("merchant_a", merchantScope);
    expect(application.createTelegramNotificationRecipient).toHaveBeenCalledWith(
      "merchant_a",
      { telegramUserId: "123", displayName: "Owner", recipientKind: "owner" },
      actor,
      merchantScope,
    );
    expect(application.updateTelegramNotificationRecipient).toHaveBeenCalledWith(
      "merchant_a",
      "recipient_a",
      { status: "disabled" },
      actor,
      merchantScope,
    );
    expect(application.sendTelegramNotificationRecipientTest).toHaveBeenCalledWith("merchant_a", "recipient_a", actor, merchantScope);
    expect(application.createTelegramNotificationRule).toHaveBeenCalledWith(
      "merchant_a",
      { recipientId: "recipient_a", name: "Telegram orders", eventScope: "orders" },
      actor,
      merchantScope,
    );
    expect(application.updateTelegramNotificationRule).toHaveBeenCalledWith(
      "merchant_a",
      "rule_a",
      { enabled: false },
      actor,
      merchantScope,
    );
  });

  it("denies Telegram notification mutations before calling the settings service", async () => {
    routeUtils.actorWithMerchantTargetMutation.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "forbidden" }));

    await expect(postTelegramRecipient(merchantRequest({ telegramUserId: "123" }), response)).rejects.toMatchObject({ code: "forbidden" });

    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.settingsWrite, "merchant_a");
    expect(application.createTelegramNotificationRecipient).not.toHaveBeenCalled();
  });

  it.each(["accountant", "staff", "platform read-only"])("denies %s package mutation before creating a billing order", async () => {
    routeUtils.actorWithMerchantTargetMutation.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "forbidden" }));

    await expect(postPackageUpgrade(merchantRequest({ targetPackageKey: "plus" }), response)).rejects.toMatchObject({ code: "forbidden" });

    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.subscriptionBill, "merchant_a", "checkout");
    expect(application.requestOwnerPackageUpgrade).not.toHaveBeenCalled();
  });

  it("validates the package target only after permission and scope authorization", async () => {
    await expect(postPackageUpgrade(merchantRequest(), response)).rejects.toMatchObject({
      code: "invalid_target_package",
      statusCode: 400,
    });

    expect(routeUtils.actorWithMerchantTargetMutation).toHaveBeenCalledWith(expect.anything(), permissions.subscriptionBill, "merchant_a", "checkout");
    expect(application.requestOwnerPackageUpgrade).not.toHaveBeenCalled();
  });
});
