import type { PoolClient } from "pg";
import { seedPartnerReadFixture } from "./partner-read-fixture";

export async function seedCatalogOracle(db: PoolClient, prefix: string) {
  await seedPartnerReadFixture(db, prefix);
  await db.query(`
    UPDATE public.product SET deleted_at=now() WHERE id=$1||'_product';
  `, [prefix]);
  await db.query("DELETE FROM integration.assortment_items WHERE assortment_id=$1", [`${prefix}_a`]);
  await db.query(`INSERT INTO integration.policies
    (id,version,merchant_id,currency,max_order_total,max_quantity,safety_stock,contact_retention_days,
     read_per_minute,quote_per_minute,book_per_minute,read_burst,quote_burst,book_burst,mutation_concurrency)
    VALUES($1||'_zero',1,$1||'_m','VND',10000000,100,0,30,120,30,10,20,5,2,2)`, [prefix]);
  await db.query("UPDATE integration.integrations SET policy_id=$1||'_zero' WHERE id=$1||'_i'", [prefix]);
  await db.query(`INSERT INTO public.product(id,title,handle,status,merchant_id,updated_at)
    SELECT $1||'_p'||lpad(n::text,4,'0'),'Product '||lpad(n::text,4,'0'),$1||'_p'||lpad(n::text,4,'0'),
      CASE WHEN n<=205 THEN 'published' ELSE 'draft' END,$1||'_m','2026-10-18T00:00:00Z'
    FROM generate_series(1,210) n`, [prefix]);
  await db.query(`INSERT INTO public.product_variant(id,title,sku,barcode,product_id,manage_inventory,allow_backorder)
    SELECT $1||'_ov'||lpad(n::text,4,'0'),'Variant '||n,
      CASE WHEN n=205 THEN 'TEST-SAMPLE-GREEN-APPLE-6-MG' ELSE $1||'-SKU-'||n END,
      $1||'-BAR-'||n,$1||'_p'||lpad((CASE WHEN n=211 THEN 1 ELSE n END)::text,4,'0'),true,false
    FROM generate_series(1,211) n`, [prefix]);
  await db.query(`INSERT INTO public.inventory_item(id,title)
    SELECT $1||'_oi'||n,'Oracle item '||n FROM generate_series(1,211) n`, [prefix]);
  await db.query(`INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id,required_quantity)
    SELECT $1||'_om'||n,$1||'_ov'||lpad(n::text,4,'0'),$1||'_oi'||n,1 FROM generate_series(1,211) n`, [prefix]);
  await db.query(`INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity)
    SELECT $1||'_ol'||n,$1||'_oi'||n,$1||'_l1',CASE n WHEN 1 THEN 10 WHEN 2 THEN 1 WHEN 3 THEN 5 WHEN 205 THEN 6 ELSE 0 END,0,0
    FROM generate_series(1,211) n`, [prefix]);
  await db.query(`INSERT INTO public.product_category(id,name,handle,merchant_id,mpath)
    VALUES($1||'_oc','Oracle category',$1||'_oc',$1||'_m',$1||'_oc.')`, [prefix]);
  await db.query(`INSERT INTO public.product_category_product(product_id,product_category_id)
    SELECT $1||'_p'||lpad(n::text,4,'0'),$1||'_oc' FROM generate_series(1,210) n WHERE n NOT BETWEEN 199 AND 205`, [prefix]);
  await db.query(`INSERT INTO integration.assortment_items(assortment_id,variant_id)
    SELECT $1||'_a',$1||'_ov'||lpad(n::text,4,'0') FROM generate_series(1,200) n`, [prefix]);
}
