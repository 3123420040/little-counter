import type { RequestListener } from "node:http";
import type { Pool } from "pg";
import { PlatformMcpReplicaReadinessV1Schema, PLATFORM_MCP_READINESS_PATH } from "./platform-mcp-readiness";

export { PLATFORM_MCP_READINESS_PATH };
type Database = Pick<Pool, "query">;

/** Private launcher health boundary; MCP key readiness has no OAuth/AS dependency. */
export function createPartnerProductionReadinessHandler(input: { apiPool: Database; corePools: readonly Database[];
  redis: { ping(): Promise<string> }; jwksUrl: string; buildMcpReadiness(): Promise<unknown> }): RequestListener {
  let checking = false;
  return async (req, res) => {
    if (req.method !== "GET" || (req.url !== "/ready" && req.url !== PLATFORM_MCP_READINESS_PATH)) {
      res.writeHead(404).end(); return;
    }
    if (checking) { res.writeHead(503).end(); return; }
    checking = true;
    try {
      const role = await input.apiPool.query(`SELECT NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
        AND pg_has_role(current_user,'snus_partner_api','MEMBER') allowed FROM pg_roles WHERE rolname=current_user`);
      if (!role.rows[0]?.allowed || await input.redis.ping() !== "PONG") throw Error("Dependencies unavailable");
      for (const dependency of input.corePools) {
        const result = await dependency.query(`SELECT NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)
          allowed FROM pg_roles WHERE rolname=current_user`);
        if (!result.rows[0]?.allowed) throw Error("Unsafe core dependency");
      }
      const app = await fetch("http://127.0.0.1:9000/health", { signal: AbortSignal.timeout(1500), redirect: "error" });
      await app.body?.cancel();
      if (!app.ok) throw Error("Dependencies unavailable");
      if (req.url === PLATFORM_MCP_READINESS_PATH) {
        const body = PlatformMcpReplicaReadinessV1Schema.parse(await input.buildMcpReadiness());
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
        return;
      }
      const keys = await fetch(input.jwksUrl, { signal: AbortSignal.timeout(2000), redirect: "error" });
      if (!keys.ok || !(keys.headers.get("content-type") ?? "").includes("json")) {
        await keys.body?.cancel(); throw Error("Dependencies unavailable");
      }
      const jwks = await keys.json() as { keys?: Array<{ kty?: string; use?: string; kid?: string; n?: string; e?: string }> };
      if (!Array.isArray(jwks.keys) || !jwks.keys.some(key => key.kty === "RSA" && key.use === "sig" && key.kid && key.n && key.e)) {
        throw Error("No usable signing key");
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end('{"ready":true}');
    } catch { res.writeHead(503).end(); }
    finally { checking = false; }
  };
}
