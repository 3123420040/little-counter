// Medusa's stock production HTTP logger serializes the raw URL and headers
// directly to stdout. Suppress that layer when Partner API is enabled; the
// partner boundary emits the allowlisted access record, including denies.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { logger } = require("@medusajs/framework/logger") as { logger: import("@medusajs/types").Logger };
export const partnerSafeLogger = new Proxy(logger, {
  get(target, property) {
    if(property === "shouldLog") return (level:string) => level!=="http" && target.shouldLog(level);
    const value=Reflect.get(target,property);
    return typeof value==="function" ? value.bind(target) : value;
  },
});
