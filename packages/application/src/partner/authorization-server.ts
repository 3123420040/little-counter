import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { PartnerError } from "./errors";
import { readBoundedResponse } from "./bounded-response";

export interface PartnerAsConfig {
  serverUrl: string; realm: string; clientId: string; secretFile: string;
  credentialDirectory: string; environment: "sandbox" | "production"; audience: string;
}
export interface PartnerAsClient {
  id: string; clientId: string; enabled: boolean; serviceAccountsEnabled: boolean;
  clientAuthenticatorType: string; attributes?: Record<string, string>;
}
function readSecretFile(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o007) !== 0) throw new Error("Invalid secret mount");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
const publicKeySchema = z.strictObject({ kty: z.literal("RSA"), n: z.string().regex(/^[A-Za-z0-9_-]+$/), e: z.literal("AQAB") });
export function createPartnerAsAdmin(config: PartnerAsConfig) {
  const url = new URL(config.serverUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(config.environment === "sandbox" && url.protocol === "http:"))
    || !/^[A-Za-z0-9_-]{1,100}$/.test(config.realm)) throw new PartnerError("dependency_unavailable");
  const server = url.origin;
  let bearer: string | undefined;
  let tokenDeadline = 0;
  async function adminToken(checkOwnership: () => void) {
    checkOwnership();
    if (bearer && tokenDeadline > Date.now()) return bearer;
    const secret = z.strictObject({ secret: z.string().min(32).max(512) }).parse(readSecretFile(config.secretFile)).secret;
    const response = await fetch(`${server}/realms/${config.realm}/protocol/openid-connect/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${config.clientId}:${secret}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "client_credentials" }), signal: AbortSignal.timeout(2000), redirect: "error",
    });
    if (!response.ok) throw new PartnerError("dependency_unavailable");
    const token = JSON.parse(await readBoundedResponse(response,16384)) as { access_token?: string; expires_in?: number };
    if (!token.access_token || !Number.isFinite(token.expires_in) || token.expires_in! <= 10) throw new PartnerError("dependency_unavailable");
    bearer = token.access_token; tokenDeadline = Date.now() + Math.min(60000, (token.expires_in! - 10) * 1000);
    return bearer;
  }
  async function request(path: string, method = "GET", body?: unknown, allow404 = false, checkOwnership: () => void = () => undefined): Promise<unknown> {
    try {
      const token = await adminToken(checkOwnership);
      checkOwnership();
      const response = await fetch(`${server}/admin/realms/${config.realm}/${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000), redirect: "error",
      });
      if (allow404 && response.status === 404) return null;
      if (!response.ok) { if (response.status === 401) { bearer = undefined; tokenDeadline = 0; } throw new PartnerError("dependency_unavailable"); }
      const text = await readBoundedResponse(response,1048576);
      if (text.length > 1048576) throw new PartnerError("dependency_unavailable");
      return text ? JSON.parse(text) : null;
    } catch { throw new PartnerError("dependency_unavailable"); }
  }
  async function findClient(clientId: string, checkOwnership: () => void = () => undefined) {
    const result = await request(`clients?clientId=${encodeURIComponent(clientId)}`, "GET", undefined, false, checkOwnership) as PartnerAsClient[];
    if (!Array.isArray(result) || result.length > 1) throw new PartnerError("dependency_unavailable");
    return result[0];
  }
  async function ensureInactiveClient(input: { oauthClientId: string; integrationId: string; operationId: string;
    authMethod: "private_key_jwt" | "client_secret_basic"; credentialReference: string }, checkOwnership: () => void = () => undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.credentialReference)) throw new PartnerError("invalid_request");
    let credential: { secret?: string; publicKey?: string };
    try {
      const source = readSecretFile(resolve(config.credentialDirectory, `${input.credentialReference}.json`));
      if (input.authMethod === "private_key_jwt") {
        const publicJwk = publicKeySchema.parse(z.strictObject({ public_jwk: publicKeySchema }).parse(source).public_jwk);
        if (Buffer.from(publicJwk.n, "base64url").length < 256) throw new Error("RSA key too small");
        credential = { publicKey: createPublicKey({ key: publicJwk, format: "jwk" }).export({ type: "spki", format: "pem" }).toString().replace(/-----[^-]+-----|\s/g, "") };
      } else credential = z.strictObject({ secret: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) }).parse(source);
    } catch { throw new PartnerError("dependency_unavailable"); }
    const representation = {
      clientId: input.oauthClientId, enabled: false, protocol: "openid-connect", publicClient: false,
      clientAuthenticatorType: input.authMethod === "private_key_jwt" ? "client-jwt" : "client-secret",
      secret: credential.secret, serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
      fullScopeAllowed: false, defaultClientScopes: ["partner:read", "catalog:read", "inventory:read", "orders:quote", "orders:write", "orders:read"],
      attributes: { "access.token.lifespan": "300", "use.refresh.tokens": "false", "client_credentials.use_refresh_token": "false",
        "jwt.credential.public.key": credential.publicKey ?? "", "token.endpoint.auth.signing.alg": "RS256",
        "snus.integration_id": input.integrationId, "snus.operation_id": input.operationId },
      protocolMappers: [
        { name: "partner-client", protocol: "openid-connect", protocolMapper: "oidc-hardcoded-claim-mapper",
          config: { "claim.name": "client_id", "claim.value": input.oauthClientId, "jsonType.label": "String", "access.token.claim": "true", "id.token.claim": "false" } },
        { name: "partner-audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper",
          config: { "included.custom.audience": config.audience, "access.token.claim": "true", "id.token.claim": "false" } },
      ],
    };
    const previous = await findClient(input.oauthClientId, checkOwnership);
    if (previous) {
      if (previous.attributes?.["snus.integration_id"] !== input.integrationId
        || previous.attributes?.["snus.operation_id"] !== input.operationId) throw new PartnerError("idempotency_conflict");
      await request(`clients/${encodeURIComponent(previous.id)}`, "PUT", representation, false, checkOwnership);
    } else await request("clients", "POST", representation, false, checkOwnership);
    const created = await findClient(input.oauthClientId, checkOwnership);
    if (!created || created.enabled || !created.serviceAccountsEnabled
      || created.clientAuthenticatorType !== representation.clientAuthenticatorType) throw new PartnerError("dependency_unavailable");
    const account = await request(`clients/${encodeURIComponent(created.id)}/service-account-user`, "GET", undefined, false, checkOwnership) as { id?: string };
    if (!account.id) throw new PartnerError("dependency_unavailable");
    return { asClientId: created.id, subject: account.id, issuer: `${server}/realms/${config.realm}` };
  }
  async function setEnabled(asClientId: string, enabled: boolean, checkOwnership: () => void = () => undefined) {
    const path = `clients/${encodeURIComponent(asClientId)}`;
    const existing = await request(path, "GET", undefined, !enabled, checkOwnership) as PartnerAsClient | null;
    if (!existing && !enabled) return;
    if (!existing) throw new PartnerError("dependency_unavailable");
    await request(path, "PUT", { ...existing, enabled }, false, checkOwnership);
    const verified = await request(path, "GET", undefined, false, checkOwnership) as PartnerAsClient;
    if (verified.enabled !== enabled) throw new PartnerError("dependency_unavailable");
  }
  return { ensureInactiveClient, setEnabled, ready: async () => {
    if (!await findClient(config.clientId)) throw new PartnerError("dependency_unavailable");
  } };
}
