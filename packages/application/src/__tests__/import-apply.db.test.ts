import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import type { OperatorContext } from "../services/auth-service";
import { applyCategoryImport } from "../services/category-import-export-service";
import { applyProductImport } from "../services/catalog-import-export-service";
import { listProductCategories, listProducts } from "../platform-db";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "DB Test Owner",
  organizationId: "org_default",
};
const catalogScope = { scopeKind: "merchant_target" as const, merchantId: "merchant_default" };
const operatingScope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_default",
  storeId: "store_default",
  stockLocationId: "sloc_default",
};

let client: PoolClient;

describe("Import Apply DB Integration", () => {
  beforeAll(async () => {
    client = await connectPlatformClient();
    await ensurePlatformSchema();
  });

  afterAll(async () => {
    client.release();
    await shutdownPlatformDb();
  });

  it("applies category import creating and updating categories", async () => {
    const handle1 = `imp-cat1-${runId}`;
    const handle2 = `imp-cat2-${runId}`;

    const csvCreate = `action,categoryId,name,handle,description,rank,isActive
create,,Import Cat 1,${handle1},Desc 1,10,true
create,,Import Cat 2,${handle2},Desc 2,20,true`;

    const resultCreate = await applyCategoryImport({}, csvCreate, actor, catalogScope);
    
    expect(resultCreate.valid).toBeUndefined(); // apply result doesn't have valid field, preview does
    expect(resultCreate.appliedRows).toBe(2);
    expect(resultCreate.errorRows).toBe(0);

    const categories = await listProductCategories(catalogScope.merchantId, { q: handle1, status: "all", includeProductCounts: false });
    const cat1 = categories.product_categories.find(c => c.handle === handle1);
    const categories2 = await listProductCategories(catalogScope.merchantId, { q: handle2, status: "all", includeProductCounts: false });
    const cat2 = categories2.product_categories.find(c => c.handle === handle2);

    expect(cat1).toBeDefined();
    expect(cat2).toBeDefined();
    expect(cat1?.rank).toBe(10);

    // Update cat 1
    const csvUpdate = `action,categoryId,name,handle,description,rank,isActive
update,${cat1!.id},Import Cat 1 Updated,${handle1},Desc 1,15,false`;

    const resultUpdate = await applyCategoryImport({}, csvUpdate, actor, catalogScope);
    expect(resultUpdate.appliedRows).toBe(1);
    
    const categoriesAfter = await listProductCategories(catalogScope.merchantId, { q: handle1, status: "all", includeProductCounts: false });
    const cat1Updated = categoriesAfter.product_categories.find(c => c.handle === handle1);
    
    expect(cat1Updated?.name).toBe("Import Cat 1 Updated");
    expect(cat1Updated?.rank).toBe(15);
    expect(cat1Updated?.isActive).toBe(false);
  });

  it("applies product import creating a product", async () => {
    const title = `Imported Product ${runId}`;
    const sku = `IMP-PROD-${runId}`;

    const csvCreate = `action,productId,title,status,sku,barcode,price,costPrice,reorderLevel,categoryHandles,imageUrl
create,,${title},published,${sku},,150000,100000,5,,`;

    const resultCreate = await applyProductImport({}, csvCreate, actor, catalogScope, operatingScope);
    
    expect(resultCreate.appliedRows).toBe(1);
    expect(resultCreate.errorRows).toBe(0);

    const products = await listProducts({
      merchantId: catalogScope.merchantId,
      stockLocationId: operatingScope.stockLocationId,
      limit: 100,
      q: title,
    });
    const prod = products.find(p => p.title === title);

    expect(prod).toBeDefined();
    expect(prod?.status).toBe("published");
    expect(prod?.variants[0]?.sku).toBe(sku);
    expect(prod?.variants[0]?.prices[0]?.amount).toBe(150000);
  });
});
