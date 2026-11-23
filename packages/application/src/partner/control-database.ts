import { Pool, type PoolClient } from "pg";
import type { PartnerEnvironment } from "@medusa-snus/contracts/partner-api";
import { PlatformError } from "../errors/platform-error";
import { partnerDatabaseTimeouts, withPartnerTransaction } from "./transaction";
const fail = (code: string, status: number): never => { throw new PlatformError(code, code.replaceAll("_", " "), status); };

let pool: Pool | undefined;
let inflight = 0;
export async function shutdownControlDatabase() {
  if (inflight) throw new Error("Cannot close control database while commands are active");
  const closing = pool; pool = undefined;
  await closing?.end();
}
export async function withControlDatabase<T>(write: boolean | "fresh-read", work: (db: PoolClient, environment: PartnerEnvironment, issuer: string | undefined) => Promise<T>) {
  const environment = process.env.PARTNER_ENVIRONMENT === "sandbox" ? "sandbox"
    : process.env.PARTNER_ENVIRONMENT === "production" ? "production" : undefined;
  const issuer = process.env.PARTNER_OAUTH_ISSUER;
  if ((environment !== "sandbox" && environment !== "production") || !process.env.PARTNER_CONTROL_DATABASE_URL) fail("dependency_unavailable", 503);
  if (inflight >= 2) fail("dependency_unavailable", 503);
  if (!pool) {
    pool = new Pool({ connectionString: process.env.PARTNER_CONTROL_DATABASE_URL, max: 2, connectionTimeoutMillis: 1000,
      ...partnerDatabaseTimeouts });
    pool.on("error", () => undefined);
  }
  inflight++;
  try {
    return await withPartnerTransaction(pool, async db => {
      const role = await db.query(`SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
        AND pg_has_role(current_user,'snus_partner_control','MEMBER') AS allowed FROM pg_roles WHERE rolname=current_user`);
      if (!role.rows[0]?.allowed) fail("dependency_unavailable", 503);
      return work(db, environment!, issuer!);
    }, { begin: write === true ? "BEGIN" : write === "fresh-read" ? "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"
      : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" });
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    return fail("dependency_unavailable", 503);
  } finally { inflight--; }
}
