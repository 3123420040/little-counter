import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";

export interface CustomerRecord extends Record<string, unknown> {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  merchant_id: string;
}

export async function findCustomer(client: PoolClient, customerId?: string, merchantId?: string): Promise<CustomerRecord | null> {
  if (!customerId) return null;
  return queryOne<CustomerRecord>(
    client,
    "SELECT id, first_name, last_name, phone, email, merchant_id FROM public.customer WHERE id = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR merchant_id = $2)",
    [customerId, merchantId || null],
  );
}
