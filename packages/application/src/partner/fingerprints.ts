import { createHmac, timingSafeEqual } from "node:crypto";
import type { PartnerContext } from "./registry";
import { PartnerError } from "./errors";

export interface PartnerKeyring { current: string; keys: Readonly<Record<string, string>> }
export function canonicalPartnerJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPartnerJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalPartnerJson(item)}`).join(",")}}`;
}
export function partnerFingerprint(keyring: PartnerKeyring, value: unknown, version = keyring.current): string {
  const key = keyring.keys[version];
  if (!key || Buffer.from(key, "base64url").length < 32) throw new PartnerError("dependency_unavailable");
  return createHmac("sha256", Buffer.from(key, "base64url")).update(canonicalPartnerJson(value)).digest("hex");
}
function cursorScope(ctx: PartnerContext, filter: unknown) {
  return { v: 1, integration: ctx.integrationId, store: ctx.storeId, grant: ctx.grantVersion,
    storeGrant: ctx.storeGrantVersion, assortment: ctx.assortmentVersion, catalogMode: ctx.catalogMode, filter };
}
export function encodePartnerCursor(keyring: PartnerKeyring, ctx: PartnerContext, filter: unknown, sort: string[]) {
  const body = Buffer.from(JSON.stringify({ ...cursorScope(ctx, filter), sort, exp: Date.now() + 900_000, kid: keyring.current })).toString("base64url");
  return `${body}.${partnerFingerprint(keyring, body)}`;
}
export function decodePartnerCursor(keyring: PartnerKeyring, ctx: PartnerContext, filter: unknown, cursor: string): string[] {
  try {
    if (cursor.length > 2048) throw new Error();
    const [body, signature, extra] = cursor.split(".");
    if (extra || !/^[a-f0-9]{64}$/.test(signature) || !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error();
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    if (typeof parsed.kid !== "string" || !keyring.keys[parsed.kid]) throw new Error();
    const expected = partnerFingerprint(keyring, body, parsed.kid);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) throw new Error();
    const { sort, exp, kid, ...scope } = parsed;
    if (typeof exp !== "number" || exp <= Date.now() || exp > Date.now() + 900_000
      || canonicalPartnerJson(scope) !== canonicalPartnerJson(cursorScope(ctx, filter))
      || !Array.isArray(sort) || sort.some((key) => typeof key !== "string" || key.length > 128)) throw new Error();
    return sort as string[];
  } catch { throw new PartnerError("invalid_cursor"); }
}
