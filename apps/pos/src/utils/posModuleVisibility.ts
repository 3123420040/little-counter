// Presentation policy only; backend permissions and background processing stay unchanged.
const hiddenModulePaths: Record<string, string> = {
  shifts: "/shifts",
  telegramSales: "/telegram-sales",
  accounting: "/accounting",
  ai: "/ai",
  partnerOperations: "/partner-operations",
};

export function isPosModuleVisible(id: string): boolean {
  return !Object.hasOwn(hiddenModulePaths, id);
}

export function isHiddenPosModulePath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  return Object.values(hiddenModulePaths).some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function hiddenModuleDestination(access: {
  canUsePos: boolean;
  canReadOrders: boolean;
  canReadDashboard: boolean;
  canReadPlatform: boolean;
}): string {
  if (access.canUsePos) return "/pos";
  if (access.canReadOrders) return "/orders";
  if (access.canReadDashboard) return "/dashboard";
  if (access.canReadPlatform) return "/platform/merchants";
  return "/account";
}
