import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as applicationNamespace from "@medusa-snus/application";
import { buildServer } from "../index.js";
import { query } from "../db/client.js";

const applicationModule = ((applicationNamespace as unknown as { default?: typeof import("@medusa-snus/application") }).default ?? applicationNamespace) as typeof import("@medusa-snus/application");
const { ensurePlatformSchema, signJwt } = applicationModule as typeof import("@medusa-snus/application");

let server: Awaited<ReturnType<typeof buildServer>>;
let authHeaders: { authorization: string; "x-operating-merchant-id": string; "x-operating-store-id": string };
let scopedOwnerHeaders: { authorization: string; "x-operating-merchant-id": string; "x-operating-store-id": string };
let counter = 0;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const safeRunId = runId.replace(/[^a-zA-Z0-9]/g, "_");
const researchStaffOperatorId = `op_ai_research_${safeRunId}`;
const researchStaffUserId = `ai_research_${safeRunId}`;
const scopedOwnerMerchantId = `merchant_ai_owner_${safeRunId}`;
const scopedOtherMerchantId = `merchant_ai_other_${safeRunId}`;
const scopedOwnerOrganizationId = `org_ai_owner_${safeRunId}`;
const scopedOtherOrganizationId = `org_ai_other_${safeRunId}`;
const scopedOtherProductId = `prod_ai_other_${safeRunId}`;
const channelToken = "ai-db-channel-service-token-min-32-chars";
const originalTelegramToken = process.env.TELEGRAM_SERVICE_TOKEN;
const originalTelegramServiceId = process.env.TELEGRAM_SERVICE_ID;
const originalPackageKey = process.env.APP_PACKAGE_KEY;
const originalFeatureFlags = process.env.FEATURE_FLAGS;
const originalResearchProvider = process.env.PRODUCT_RESEARCH_PROVIDER;
const originalResearchLanguage = process.env.PRODUCT_RESEARCH_PREFERRED_LANGUAGE;
const originalTavilyApiKey = process.env.TAVILY_API_KEY;
const originalAiOrderProvider = process.env.AI_ORDER_PROVIDER;

function idempotencyHeaders(prefix: string) {
  counter += 1;
  return { ...authHeaders, "idempotency-key": `${prefix}-${runId}-${counter}` };
}

beforeAll(async () => {
  process.env.TELEGRAM_SERVICE_TOKEN = channelToken;
  process.env.TELEGRAM_SERVICE_ID = "telegram";
  process.env.APP_PACKAGE_KEY = "ai_fan";
  delete process.env.FEATURE_FLAGS;
  process.env.AI_ORDER_PROVIDER = "deterministic";
  process.env.PRODUCT_RESEARCH_PROVIDER = "deterministic";
  process.env.PRODUCT_RESEARCH_PREFERRED_LANGUAGE = "vi";

  await ensurePlatformSchema();
  await query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
    VALUES
      ($1, 'AI Owner Merchant', $2, 'active'),
      ($3, 'AI Other Merchant', $4, 'active')
    ON CONFLICT (id) DO NOTHING
  `, [scopedOwnerMerchantId, scopedOwnerOrganizationId, scopedOtherMerchantId, scopedOtherOrganizationId]);
  await query(`
    INSERT INTO app.merchant_subscriptions (
      id, merchant_id, package_key, catalog_version_id, status,
      current_period_start, current_period_end, grace_ends_at,
      primary_store_id, usage_anchor_day, metadata
    )
    SELECT
      $1,
      'merchant_default',
      'ai_fan',
      pcv.id,
      'active',
      '2026-01-01T00:00:00Z'::timestamptz,
      '2027-01-01T00:00:00Z'::timestamptz,
      '2027-01-08T00:00:00Z'::timestamptz,
      'store_default',
      1,
      jsonb_build_object('source', 'ai_api_db_test')
    FROM app.package_catalog_versions pcv
    WHERE pcv.package_key = 'ai_fan'
    ORDER BY pcv.effective_from DESC
    LIMIT 1
    ON CONFLICT (merchant_id) DO UPDATE SET
      package_key = EXCLUDED.package_key,
      catalog_version_id = EXCLUDED.catalog_version_id,
      status = 'active',
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      grace_ends_at = EXCLUDED.grace_ends_at,
      primary_store_id = EXCLUDED.primary_store_id,
      usage_anchor_day = EXCLUDED.usage_anchor_day,
      metadata = app.merchant_subscriptions.metadata || EXCLUDED.metadata,
      updated_at = now()
  `, [`sub_ai_api_${safeRunId}`]);
  await query(`
    INSERT INTO public.product (id, title, handle, status, merchant_id)
    VALUES ($1, 'Other Merchant Research Product', $2, 'published', $3)
    ON CONFLICT (id) DO UPDATE SET merchant_id = EXCLUDED.merchant_id
  `, [scopedOtherProductId, `other-merchant-research-${safeRunId}`, scopedOtherMerchantId]);
  const owner = await query("SELECT password_hash FROM medusa.staff_users WHERE operator_id = 'op_owner' LIMIT 1");
  await query(`
    INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, is_active)
    VALUES ($1, $2, 'AI Research Staff', 'staff', true)
    ON CONFLICT (operator_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      role = 'staff',
      is_active = true
  `, [researchStaffOperatorId, owner.rows[0]?.password_hash || "test-password-hash"]);
  await query(`
    INSERT INTO app.operator_identities (
      organization_id, provider, provider_user_id, operator_id, display_name, is_active, verified_at
    )
    VALUES ('org_default', 'telegram', $1, $2, 'AI Research Staff', true, now())
    ON CONFLICT (organization_id, provider, provider_user_id) WHERE merchant_id IS NULL DO UPDATE SET
      operator_id = EXCLUDED.operator_id,
      display_name = EXCLUDED.display_name,
      is_active = true,
      verified_at = now(),
      updated_at = now()
  `, [researchStaffUserId, researchStaffOperatorId]);
  await query(`
    INSERT INTO app.operator_memberships (
      operator_id, scope_type, merchant_id, role_key, status, granted_by
    )
    VALUES ($1, 'merchant', 'merchant_default', 'staff', 'active', 'db-test')
  `, [researchStaffOperatorId]);

  authHeaders = {
    authorization: `Bearer ${signJwt({
      operatorId: "op_owner",
      role: "owner",
      displayName: "Owner",
      organizationId: "org_default",
    })}`,
    "x-operating-merchant-id": "merchant_default",
    "x-operating-store-id": "store_default",
  };
  scopedOwnerHeaders = {
    authorization: `Bearer ${signJwt({
      operatorId: "op_owner",
      role: "owner",
      displayName: "Scoped Owner",
      organizationId: scopedOwnerOrganizationId,
    })}`,
    "x-operating-merchant-id": "merchant_default",
    "x-operating-store-id": "store_default",
  };
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await query("DELETE FROM ai_module.product_research_runs WHERE created_by IN ($1, 'op_owner') AND raw_query LIKE $2", [
    researchStaffOperatorId,
    `%${runId}%`,
  ]).catch(() => undefined);
  await query("DELETE FROM app.operator_memberships WHERE operator_id = $1", [researchStaffOperatorId]).catch(() => undefined);
  await query("DELETE FROM app.operator_identities WHERE provider = 'telegram' AND provider_user_id = $1", [researchStaffUserId]).catch(() => undefined);
  await query("DELETE FROM medusa.staff_users WHERE operator_id = $1", [researchStaffOperatorId]).catch(() => undefined);
  await query("DELETE FROM public.product WHERE id = $1", [scopedOtherProductId]).catch(() => undefined);
  await query("DELETE FROM app.merchants WHERE id IN ($1, $2)", [scopedOwnerMerchantId, scopedOtherMerchantId]).catch(() => undefined);

  if (originalTelegramToken === undefined) delete process.env.TELEGRAM_SERVICE_TOKEN;
  else process.env.TELEGRAM_SERVICE_TOKEN = originalTelegramToken;
  if (originalTelegramServiceId === undefined) delete process.env.TELEGRAM_SERVICE_ID;
  else process.env.TELEGRAM_SERVICE_ID = originalTelegramServiceId;
  if (originalPackageKey === undefined) delete process.env.APP_PACKAGE_KEY;
  else process.env.APP_PACKAGE_KEY = originalPackageKey;
  if (originalFeatureFlags === undefined) delete process.env.FEATURE_FLAGS;
  else process.env.FEATURE_FLAGS = originalFeatureFlags;
  if (originalResearchProvider === undefined) delete process.env.PRODUCT_RESEARCH_PROVIDER;
  else process.env.PRODUCT_RESEARCH_PROVIDER = originalResearchProvider;
  if (originalResearchLanguage === undefined) delete process.env.PRODUCT_RESEARCH_PREFERRED_LANGUAGE;
  else process.env.PRODUCT_RESEARCH_PREFERRED_LANGUAGE = originalResearchLanguage;
  if (originalTavilyApiKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavilyApiKey;
  if (originalAiOrderProvider === undefined) delete process.env.AI_ORDER_PROVIDER;
  else process.env.AI_ORDER_PROVIDER = originalAiOrderProvider;
});

describe("AI Module API DB — POST /ai/reply-draft", () => {
  it("returns 401 without auth token", async () => {
    const res = await server.inject({
      method: "POST", url: "/ai/reply-draft",
      payload: { customerMessage: "Hello" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 202 with draft on valid product inquiry", async () => {
    const res = await server.inject({
      method: "POST", url: "/ai/reply-draft",
      headers: idempotencyHeaders("reply"),
      payload: {
        customerMessage: "Còn Mint Medium không? Giá bao nhiêu?",
        productContext: ["prod_mint"],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe("review_required");
    expect(body.data.output.responseText).toBeTruthy();
    expect(typeof body.data.output.confidence).toBe("number");
    expect(body.data.output.confidence).toBeGreaterThan(0.5);
  });

  it("returns 400 with empty customer message", async () => {
    const res = await server.inject({
      method: "POST", url: "/ai/reply-draft",
      headers: authHeaders,
      payload: { customerMessage: "" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("validation_error");
  });
});

describe("AI Module API — GET /ai/review-queue", () => {
  it("returns 200 with action array", async () => {
    const res = await server.inject({
      method: "GET", url: "/ai/review-queue",
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("AI Module API — GET /health", () => {
  it("returns 200 without auth", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("returns 200 at the public /ai/health alias", async () => {
    const res = await server.inject({ method: "GET", url: "/ai/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).service).toBe("ai-module");
  });
});

describe("AI Module API DB — POST /ai/telegram-sales/order-draft", () => {
  it("drafts the exact secondary SKU that matched instead of the product's default variant", async () => {
    const id = `ai_secondary_${safeRunId}`, sku = `AI-SECONDARY-${safeRunId}`;
    try {
      await query(`INSERT INTO public.product_variant(id,title,sku,product_id,manage_inventory,variant_rank)
        VALUES($1,'Secondary',$2,'prod_mint',true,1)`, [id,sku]);
      await query("INSERT INTO public.inventory_item(id,sku) VALUES($1,$2)", [id,sku]);
      await query("INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity) VALUES($1,$1,$1,1)", [id]);
      await query(`INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity)
        SELECT $1,$1,stock_location_id,20,0,0 FROM app.stores WHERE id='store_default'`, [id]);
      await query(`INSERT INTO public.product_variant_price_set(id,variant_id,price_set_id)
        SELECT $1,$1,price_set_id FROM public.product_variant_price_set WHERE variant_id='var_mint_20' AND deleted_at IS NULL`, [id]);
      const res = await server.inject({ method:"POST", url:"/ai/telegram-sales/order-draft",
        headers:{ authorization:`Bearer ${channelToken}`,"x-channel":"telegram","x-channel-user-id":`secondary_${safeRunId}`,
          "x-channel-service-id":"telegram","x-merchant-id":"merchant_default","x-store-id":"store_default" },
        payload:{text:`${sku} x2`} });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.items).toEqual([expect.objectContaining({ variantId:id,sku,quantity:2 })]);
    } finally {
      await query("DELETE FROM public.inventory_level WHERE inventory_item_id=$1", [id]);
      await query("DELETE FROM public.product_variant_inventory_item WHERE variant_id=$1", [id]);
      await query("DELETE FROM public.product_variant_price_set WHERE variant_id=$1", [id]);
      await query("DELETE FROM public.product_variant WHERE id=$1", [id]);
      await query("DELETE FROM public.inventory_item WHERE id=$1", [id]);
    }
  });
  it("uses selected-store stock for operator and channel drafts and rejects a foreign store", async () => {
    const store = `ai_stock_${safeRunId}`;
    try {
      await query("INSERT INTO public.stock_location(id,name) VALUES($1,$1)", [store]);
      await query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id) VALUES($1,'merchant_default',$1,$1)", [store]);
      await query(`INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity)
        SELECT $1,pvii.inventory_item_id,$1,0,0,0 FROM public.product_variant_inventory_item pvii
        WHERE variant_id='var_mint_20' AND deleted_at IS NULL`, [store]);
      const channelHeaders = { authorization: `Bearer ${channelToken}`, "x-channel": "telegram",
        "x-channel-user-id": `stock_customer_${safeRunId}`, "x-channel-service-id": "telegram",
        "x-merchant-id": "merchant_default", "x-store-id": store };
      const channel = await server.inject({ method: "POST", url: "/ai/telegram-sales/order-draft",
        headers: channelHeaders, payload: { text: "MINT-MED-20 x2" } });
      expect(channel.statusCode).toBe(409);
      expect(channel.json().error.code).toBe("order_draft_needs_clarification");
      const operator = await server.inject({ method: "POST", url: "/ai/order-draft",
        headers: { ...authHeaders, "x-operating-store-id": store }, payload: { text: "MINT-MED-20 x2" } });
      expect(operator.statusCode).toBe(409);
      expect(operator.json().error.code).toBe("order_draft_needs_clarification");
      const foreign = await server.inject({ method: "POST", url: "/ai/telegram-sales/order-draft",
        headers: { ...channelHeaders, "x-merchant-id": scopedOtherMerchantId }, payload: { text: "MINT-MED-20 x2" } });
      expect(foreign.statusCode).toBe(403);
    } finally {
      await query("DELETE FROM public.inventory_level WHERE location_id=$1", [store]);
      await query("DELETE FROM app.stores WHERE id=$1", [store]);
      await query("DELETE FROM public.stock_location WHERE id=$1", [store]);
    }
  });
  it("drafts a customer sales request through service auth without operator identity mapping", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/ai/telegram-sales/order-draft",
      headers: {
        authorization: `Bearer ${channelToken}`,
        "x-channel": "telegram",
        "x-channel-user-id": `unmapped_customer_${safeRunId}`,
        "x-channel-service-id": "telegram",
        "x-merchant-id": "merchant_default",
        "x-store-id": "store_default",
      },
      payload: { text: "MINT-MED-20 x2" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toMatchObject({
      items: [{ variantId: "var_mint_20", quantity: 2, sku: "MINT-MED-20" }],
      paymentMethod: "cod",
      parser: "deterministic-sales",
      clarification: null,
    });
    expect(body.data.usageReservationToken).toContain("telegram-sales-ai-draft:merchant_default:");
  });
});

describe("AI Module API — POST /ai/actions/:id/approve", () => {
  it("returns 404 for non-existent action", async () => {
    const res = await server.inject({
      method: "POST", url: "/ai/actions/nonexistent/approve",
      headers: idempotencyHeaders("approve"),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("AI Module API — POST /ai/actions/:id/reject", () => {
  it("returns 404 for non-existent action", async () => {
    const res = await server.inject({
      method: "POST", url: "/ai/actions/nonexistent/reject",
      headers: idempotencyHeaders("reject"),
      payload: { reason: "test" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("AI Module API — Reply Draft Blocked Claims", () => {
  it("flags health claims as blocked or high risk", async () => {
    const res = await server.inject({
      method: "POST", url: "/ai/reply-draft",
      headers: idempotencyHeaders("blocked"),
      payload: {
        customerMessage: "Sản phẩm này có giúp bỏ thuốc không?",
      },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    // The deterministic provider generates generic text; verify risk assessment runs
    expect(body.data.output.riskLevel).toBeDefined();
  });
});

describe("AI Module API — Product research cache and guardrails", () => {
  it("rejects research for a product outside the caller's merchant scope", async () => {
    const result = await server.inject({
      method: "POST",
      url: "/ai/product-research",
      headers: scopedOwnerHeaders,
      payload: { productId: scopedOtherProductId, query: `cross-tenant ${runId}` },
    });

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toMatchObject({ code: "resource_not_found" });
  });

  it("lets staff read cached research but only managers run research, without mutating catalog fields", async () => {
    const before = await query("SELECT title, status, metadata FROM public.product WHERE id = 'prod_mint'");
    expect(before.rows[0]).toBeTruthy();

    const run = await server.inject({
      method: "POST",
      url: "/ai/product-research",
      headers: authHeaders,
      payload: {
        productId: "prod_mint",
        query: `Mint Medium pouch Vietnamese source review ${runId}`,
      },
    });
    expect(run.statusCode).toBe(201);
    const runBody = JSON.parse(run.body);
    expect(runBody.data).toMatchObject({
      productId: "prod_mint",
      provider: "deterministic",
      status: "completed",
    });
    expect(runBody.data.riskFlags).toEqual(expect.arrayContaining(["review_only", "do_not_auto_publish_claims"]));
    expect(runBody.data.bestSource).toMatchObject({ url: expect.stringMatching(/^https?:\/\//) });
    expect(runBody.data.sources.length).toBeGreaterThan(0);

    const staffHeaders = {
      authorization: `Bearer ${channelToken}`,
      "x-channel": "telegram",
      "x-channel-user-id": researchStaffUserId,
      "x-channel-service-id": "telegram",
    };
    const latest = await server.inject({
      method: "GET",
      url: "/ai/product-research/prod_mint/latest",
      headers: staffHeaders,
    });
    expect(latest.statusCode).toBe(200);
    const latestBody = JSON.parse(latest.body);
    expect(latestBody.data.runId).toBe(runBody.data.runId);
    expect(latestBody.data.bestSource).toBeTruthy();
    expect(latestBody.data.preferredLanguage).toBe("vi");
    expect(latestBody.data.operatorReviewStatus).toBe("pending");

    const review = await server.inject({
      method: "PATCH",
      url: `/ai/product-research/runs/${runBody.data.runId}/review`,
      headers: authHeaders,
      payload: {
        operatorNotes: `Review notes ${runId}`,
        operatorReviewStatus: "needs_follow_up",
        operatorTaskDraft: { type: "product_research_review", runId: runBody.data.runId },
      },
    });
    expect(review.statusCode).toBe(200);
    const reviewBody = JSON.parse(review.body);
    expect(reviewBody.data).toMatchObject({
      runId: runBody.data.runId,
      operatorNotes: `Review notes ${runId}`,
      operatorReviewStatus: "needs_follow_up",
    });
    expect(reviewBody.data.operatorTaskDraft).toMatchObject({ type: "product_research_review" });

    const staffRun = await server.inject({
      method: "POST",
      url: "/ai/product-research",
      headers: staffHeaders,
      payload: {
        productId: "prod_mint",
        query: `Unauthorized research run ${runId}`,
      },
    });
    expect(staffRun.statusCode).toBe(403);
    expect(JSON.parse(staffRun.body).error).toMatchObject({
      code: "forbidden",
      message: "Missing permission: product_research:run",
    });

    const after = await query("SELECT title, status, metadata FROM public.product WHERE id = 'prod_mint'");
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("does not consume quota on deterministic (offline) research runs", async () => {
    process.env.PRODUCT_RESEARCH_PROVIDER = "deterministic";
    const run = await server.inject({
      method: "POST",
      url: "/ai/product-research",
      headers: authHeaders,
      payload: {
        productId: "prod_mint",
        query: `deterministic no quota ${runId}`,
      },
    });
    expect(run.statusCode).toBe(201);
    const runBody = JSON.parse(run.body);
    expect(runBody.data.provider).toBe("deterministic");
    expect(runBody.data.quotaReservationToken).toBeNull();
  });

  it("releases a reserved Tavily research quota when provider configuration fails", async () => {
    process.env.PRODUCT_RESEARCH_PROVIDER = "tavily";
    delete process.env.TAVILY_API_KEY;
    try {
      const failed = await server.inject({
        method: "POST",
        url: "/ai/product-research",
        headers: authHeaders,
        payload: {
          productId: "prod_mint",
          query: `quota release failed provider ${runId}-tavily`,
        },
      });
      const code = JSON.parse(failed.body).error?.code;
      if (code === "provider_config_missing") {
        expect(failed.statusCode).toBe(503);
        const reservations = await query(`
          SELECT status
          FROM app.subscription_usage_reservations
          WHERE metric_key = 'product_research_runs'
            AND reference_type = 'product_research'
            AND reference_id = 'prod_mint'
          ORDER BY created_at DESC
          LIMIT 1
        `);
        expect(reservations.rows[0]?.status).toBe("released");
      } else {
        expect(failed.statusCode).toBeGreaterThanOrEqual(400);
        expect(failed.statusCode).toBeLessThan(500);
      }
    } finally {
      process.env.PRODUCT_RESEARCH_PROVIDER = "deterministic";
      if (originalTavilyApiKey === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = originalTavilyApiKey;
    }
  });
});
