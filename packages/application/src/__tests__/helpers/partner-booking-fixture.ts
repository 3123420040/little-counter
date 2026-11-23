import type { PoolClient } from "pg";
import { partnerScopes } from "@medusa-snus/contracts/partner-api";
import { seedPartnerReadFixture } from "./partner-read-fixture";

// Caller owns the transaction. Committed commerce facts remain append-only;
// revoke the integration after the scenario instead of deleting financial rows.
export async function seedPartnerBookingFixture(db: PoolClient, p: string) {
  await seedPartnerReadFixture(db, p);
  await db.query("UPDATE integration.store_grants SET allowed_scopes=$1 WHERE integration_id=$2", [partnerScopes, `${p}_i`]);
  await db.query("INSERT INTO public.price_set(id,merchant_id) VALUES($1,$2)", [`${p}_ps`, `${p}_m`]);
  await db.query("INSERT INTO public.product_variant_price_set(id,variant_id,price_set_id) VALUES($1,$2,$3)", [`${p}_vps`, `${p}_v1`, `${p}_ps`]);
  await db.query("INSERT INTO public.price(id,price_set_id,currency_code,amount,raw_amount) VALUES($1,$2,'vnd',250000,$3)",
    [`${p}_price`, `${p}_ps`, JSON.stringify({ value: "250000", precision: 20 })]);
  await db.query("INSERT INTO inventory.product_settings(variant_id,product_id,merchant_id,cost_price) VALUES($1,$2,$3,100000)",
    [`${p}_v1`, `${p}_product`, `${p}_m`]);
}
