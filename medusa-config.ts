import { defineConfig } from "@medusajs/utils";
import { partnerSafeLogger } from "./src/lib/partner-safe-logger";

function requiredSetting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

const adminDisabled = process.env.MEDUSA_ADMIN_DISABLED === "true";

export default defineConfig({
  ...(process.env.PARTNER_API_ENABLED === "true" || process.env.PARTNER_MCP_ENABLED === "true" ? {logger:partnerSafeLogger} : {}),
  projectConfig: {
    databaseUrl: requiredSetting("DATABASE_URL"),
    databaseDriverOptions: {
      connection: {
        ssl: false,
      },
    },
    http: {
      storeCors: process.env.CORS_ORIGINS || "http://localhost:5173",
      adminCors: process.env.CORS_ORIGINS || "http://localhost:5173",
      authCors: process.env.CORS_ORIGINS || "http://localhost:5173",
      jwtSecret: requiredSetting("JWT_SECRET"),
      cookieSecret: requiredSetting("COOKIE_SECRET"),
    },
    workerMode: "shared",
  },
  admin: {
    disable: adminDisabled,
  },
});
