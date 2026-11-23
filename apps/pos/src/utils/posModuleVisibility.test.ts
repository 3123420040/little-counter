import { describe, expect, it } from "vitest";
import { hiddenModuleDestination, isHiddenPosModulePath, isPosModuleVisible } from "./posModuleVisibility";

describe("merchant module visibility defaults", () => {
  it.each([
    ["shifts", "/shifts"],
    ["telegramSales", "/telegram-sales"],
    ["accounting", "/accounting"],
    ["ai", "/ai"],
    ["partnerOperations", "/partner-operations"],
  ])("hides %s and its nested routes without granting or revoking API permissions", (id, path) => {
    expect(isPosModuleVisible(id)).toBe(false);
    expect(isHiddenPosModulePath(path)).toBe(true);
    expect(isHiddenPosModulePath(`${path}/history`)).toBe(true);
    expect(isHiddenPosModulePath(`${path}?view=all`)).toBe(true);
    expect(isHiddenPosModulePath(`${path}-other`)).toBe(false);
  });

  it.each(["pos", "products", "inventory", "orders", "customers", "dashboard", "vision", "settings", "platform", "account"])(
    "keeps the distinct %s module visible",
    (id) => expect(isPosModuleVisible(id)).toBe(true),
  );

  it.each(["/vision", "/platform/integrations", "/settings/telegram-notifications", "/account/telegram", "/products/item/research"])(
    "does not hide %s by matching a loosely related feature name",
    (path) => expect(isHiddenPosModulePath(path)).toBe(false),
  );

  it("chooses a permitted destination for active, history-only, platform-only and account-only sessions", () => {
    const none = { canUsePos: false, canReadOrders: false, canReadDashboard: false, canReadPlatform: false };
    expect(hiddenModuleDestination({ ...none, canUsePos: true })).toBe("/pos");
    expect(hiddenModuleDestination({ ...none, canReadOrders: true })).toBe("/orders");
    expect(hiddenModuleDestination({ ...none, canReadDashboard: true })).toBe("/dashboard");
    expect(hiddenModuleDestination({ ...none, canReadPlatform: true })).toBe("/platform/merchants");
    expect(hiddenModuleDestination(none)).toBe("/account");
  });
});
