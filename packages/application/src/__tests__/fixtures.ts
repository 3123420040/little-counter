import type { StoreProduct, StoreCustomer, LoyaltyTier, AccountSummary, LoyaltyRecord } from "../index.js";

function makeProducts(): StoreProduct[] {
  return [
    {
      id: "prod_mint",
      title: "Mint Medium Pouch",
      status: "published",
      variants: [
        { id: "var_mint_20", sku: "MINT-MED-20", barcode: "8936000000001", price: 250000, costPrice: 175000, inventoryItemId: "iitem_mint", stockLevel: 10, reorderLevel: 5 },
      ],
    },
    {
      id: "prod_citrus",
      title: "Citrus Low Pouch",
      status: "published",
      variants: [
        { id: "var_citrus_20", sku: "CITRUS-LOW-20", barcode: "8936000000002", price: 230000, costPrice: 160000, inventoryItemId: "iitem_citrus", stockLevel: 15, reorderLevel: 5 },
      ],
    },
    {
      id: "prod_berry",
      title: "Berry Strong Pouch",
      status: "published",
      variants: [
        { id: "var_berry_20", sku: "BERRY-STRONG-20", barcode: "8936000000003", price: 280000, costPrice: 195000, inventoryItemId: "iitem_berry", stockLevel: 2, reorderLevel: 5 },
      ],
    },
    {
      id: "prod_mint_slim",
      title: "Mint Slim Pack",
      status: "published",
      variants: [
        { id: "var_mint_slim", sku: "MINT-SLIM-20", barcode: "8936000000004", price: 180000, costPrice: 125000, inventoryItemId: "iitem_mint_slim", stockLevel: 15, reorderLevel: 5 },
      ],
    },
  ];
}

function makeCustomers(): StoreCustomer[] {
  return [
    { id: "cus_1", phone: "0900000000", firstName: "A", lastName: "Nguyen Van" },
    { id: "cus_2", phone: "0911111111", firstName: "B", lastName: "Tran Thi" },
  ];
}

function makeLoyaltyTiers(): LoyaltyTier[] {
  return [
    { name: "bronze", pointsThreshold: 0, discountPercent: 0 },
    { name: "silver", pointsThreshold: 100, discountPercent: 2 },
    { name: "gold", pointsThreshold: 500, discountPercent: 5 },
    { name: "platinum", pointsThreshold: 1000, discountPercent: 10 },
  ];
}

function makeChartOfAccounts(): AccountSummary[] {
  return [
    { code: "1111", name: "Tiền mặt", type: "asset", balance: 0 },
    { code: "1311", name: "Phải thu khách hàng", type: "asset", balance: 0 },
    { code: "1561", name: "Hàng hóa", type: "asset", balance: 0 },
    { code: "3311", name: "Phải trả người bán", type: "liability", balance: 0 },
    { code: "4111", name: "Vốn chủ sở hữu", type: "equity", balance: 0 },
    { code: "5111", name: "Doanh thu bán hàng", type: "revenue", balance: 0 },
    { code: "6321", name: "Giá vốn hàng bán", type: "expense", balance: 0 },
  ];
}

function makeLoyaltyRecords(): LoyaltyRecord[] {
  return [
    {
      id: "lr_seed_1", customerId: "cus_1", sourceEventId: "evt_seed_1",
      orderId: "ord_seed_1", pointsEarned: 90, pointsRedeemed: 0,
      tierAtTime: "bronze", description: "Initial points",
    },
  ];
}

export function seedState(state: ReturnType<typeof import("../index.js").createEmptyApplicationState>) {
  state.products.push(...makeProducts());
  state.customers.push(...makeCustomers());
  state.loyaltyTiers.push(...makeLoyaltyTiers());
  state.accounts.push(...makeChartOfAccounts());
  state.loyaltyRecords.push(...makeLoyaltyRecords());

  // Seed customer profiles
  state.customerProfiles.push({
    customerId: "cus_1", phone: "0900000000", name: "Nguyen Van A",
    totalSpent: 900000, orderCount: 3, loyaltyPoints: 90,
    tier: "bronze", nextTierPoints: 10,
    firstPurchaseAt: "2026-01-01T00:00:00Z", lastPurchaseAt: "2026-06-05T00:00:00Z",
  });
  state.customerProfiles.push({
    customerId: "cus_2", phone: "0911111111", name: "Tran Thi B",
    totalSpent: 5000000, orderCount: 10, loyaltyPoints: 500,
    tier: "gold", nextTierPoints: 500,
    firstPurchaseAt: "2026-02-01T00:00:00Z", lastPurchaseAt: "2026-06-08T00:00:00Z",
  });
}
