/** Verified non-staff actor for shared commerce transactions. No operator id,
 * role or shift can be supplied by a partner request. */
export type PartnerCredential =
  | { authMethod: "oauth_client"; credentialId: string; clientId: string; registryClientId: string; keyId: null }
  | { authMethod: "mcp_key"; credentialId: string; clientId: null; registryClientId: null; keyId: string };
export type PartnerBusinessActor = PartnerCredential & {
  actorType: "partner";
  partnerId: string; integrationId: string;
  merchantId: string; storeId: string; organizationId: string;
  requestId: string; traceId: string; spanId?: string; grantVersion: number; storeGrantVersion: number;
};
export function isPartnerBusinessActor(actor: object): actor is PartnerBusinessActor {
  return "actorType" in actor && actor.actorType === "partner";
}
export function businessActorId(actor: PartnerBusinessActor | { operatorId: string }): string {
  return isPartnerBusinessActor(actor) ? actor.credentialId : actor.operatorId;
}
export function partnerActorMetadata(actor: PartnerBusinessActor) {
  return { actorType: "partner", actorId: actor.credentialId, channel: "partner_api", partnerId: actor.partnerId, integrationId: actor.integrationId,
    authMethod: actor.authMethod, credentialId: actor.credentialId, keyId: actor.keyId,
    transport: actor.authMethod === "mcp_key" ? "mcp_http" : "rest",
    clientId: actor.clientId, registryClientId: actor.registryClientId, merchantId: actor.merchantId,
    storeId: actor.storeId, grantVersion: actor.grantVersion, storeGrantVersion: actor.storeGrantVersion,
    requestId: actor.requestId, originRequestId: actor.requestId, traceId: actor.traceId, spanId: actor.spanId ?? null };
}
