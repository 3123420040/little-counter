export { platformMcpIssuancePresetV1 } from "@medusa-snus/contracts";
const read = Object.freeze(["partner:read", "catalog:read", "inventory:read", "orders:read"] as const);
export const platformMcpProfileScopesV1 = Object.freeze({
  read, commerce: Object.freeze([...read, "orders:quote", "orders:write"] as const),
});
