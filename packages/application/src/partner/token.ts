import type { PartnerEnvironment, PartnerScope } from "@medusa-snus/contracts/partner-api";
import { partnerScopes } from "@medusa-snus/contracts/partner-api";
import { PartnerError } from "./errors";

export interface PartnerTokenProfile {
  issuer: string;
  audience: string;
  jwksUrl: string;
  environment: PartnerEnvironment;
}
export interface VerifiedPartnerToken {
  issuer: string;
  clientId: string;
  subject: string;
  scopes: readonly PartnerScope[];
  expiresAt: number;
}
export function createPartnerTokenVerifier(profile: PartnerTokenProfile) {
  for (const value of [profile.issuer, profile.jwksUrl]) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(profile.environment === "sandbox" && url.protocol === "http:"))) {
      throw new Error("Invalid fixed partner OAuth URL");
    }
  }
  if (!profile.audience) throw new Error("Partner audience is required");
  const library = import("jose").then(module => ({ ...module, jwks: module.createRemoteJWKSet(new URL(profile.jwksUrl), {
    timeoutDuration: 1500, cooldownDuration: 30_000, cacheMaxAge: 300_000,
  }) }));
  return async (authorization: unknown): Promise<VerifiedPartnerToken> => {
    if (typeof authorization !== "string" || authorization.length > 8192 || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) {
      throw new PartnerError("invalid_token");
    }
    const {jwtVerify,errors,jwks} = await library;
    try {
      const { payload, protectedHeader } = await jwtVerify(authorization.slice(7), jwks, {
        algorithms: ["RS256"], issuer: profile.issuer, audience: profile.audience,
        clockTolerance: 30, maxTokenAge: 300,
        requiredClaims: ["exp", "iat", "sub", "client_id", "scope", "typ"],
      });
      const now = Date.now() / 1000;
      if (payload.typ !== "Bearer" || protectedHeader.typ !== "JWT"
        || typeof payload.client_id !== "string" || !payload.client_id || payload.client_id.length > 256
        || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256
        || typeof payload.scope !== "string" || payload.scope.length > 1024
        || typeof payload.iat !== "number" || typeof payload.exp !== "number"
        || payload.exp - payload.iat > 300 || payload.exp <= payload.iat || payload.iat > now + 30) {
        throw new PartnerError("invalid_token");
      }
      const scopes = payload.scope.split(" ").filter((s): s is PartnerScope => partnerScopes.includes(s as PartnerScope));
      return Object.freeze({ issuer: profile.issuer, clientId: payload.client_id, subject: payload.sub,
        scopes: Object.freeze([...new Set(scopes)]), expiresAt: payload.exp });
    } catch (error) {
      if (error instanceof PartnerError) throw error;
      if (error instanceof errors.JWKSTimeout || error instanceof TypeError) throw new PartnerError("dependency_unavailable");
      throw new PartnerError("invalid_token");
    }
  };
}
