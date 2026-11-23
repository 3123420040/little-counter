export { readPrivateFile } from "../packages/application/src/utils/private-file";

export const partnerProcessModes = [
  "api",
  "staff",
  "reconciler",
  "retention",
  "observer",
  "alerts",
] as const;
export type PartnerProcessMode = (typeof partnerProcessModes)[number];
const common = ["PARTNER_ENVIRONMENT", "PARTNER_PRIVATE_BIND_HOST"];
const isProductionHostname = (value: string) => /^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(value)
  && !/localhost|sandbox|example\./.test(value);
const mutationBudgets = [
  "PARTNER_QUOTE_MERCHANT_PER_MINUTE",
  "PARTNER_QUOTE_MERCHANT_BURST",
  "PARTNER_QUOTE_GLOBAL_PER_MINUTE",
  "PARTNER_QUOTE_GLOBAL_BURST",
  "PARTNER_BOOK_MERCHANT_PER_MINUTE",
  "PARTNER_BOOK_MERCHANT_BURST",
  "PARTNER_BOOK_GLOBAL_PER_MINUTE",
  "PARTNER_BOOK_GLOBAL_BURST",
  "PARTNER_MUTATION_MERCHANT_CONCURRENCY",
  "PARTNER_MUTATION_GLOBAL_CONCURRENCY",
];
const api = [
  "PARTNER_ROLLOUT_PROFILE",
  ...mutationBudgets,
  "PARTNER_API_ENABLED",
  "PARTNER_MCP_ENABLED",
  "PARTNER_MUTATIONS_ENABLED",
  "PARTNER_BOOKING_ENABLED",
  "PARTNER_DELIVERY_ENABLED",
  "PARTNER_DATABASE_URL",
  "PARTNER_REDIS_URL",
  "PARTNER_PUBLIC_HOST",
  "PARTNER_OAUTH_ISSUER",
  "PARTNER_OAUTH_AUDIENCE",
  "PARTNER_OAUTH_JWKS_URL",
  "PARTNER_DB_POOL_MAX",
  "PARTNER_READ_MERCHANT_PER_MINUTE",
  "PARTNER_READ_MERCHANT_BURST",
  "PARTNER_READ_GLOBAL_PER_MINUTE",
  "PARTNER_READ_GLOBAL_BURST",
  "PARTNER_MCP_ALLOWED_ORIGINS",
  "PARTNER_MCP_TRUSTED_PROXY_IPS",
  "PARTNER_MCP_PREAUTH_IP_PER_MINUTE",
  "PARTNER_MCP_PREAUTH_IP_BURST",
  "PARTNER_MCP_PREAUTH_GLOBAL_PER_MINUTE",
  "PARTNER_MCP_PREAUTH_GLOBAL_BURST",
  "PARTNER_MCP_CONTROL_PER_MINUTE",
  "PARTNER_MCP_CONTROL_BURST",
  "PARTNER_FINGERPRINT_KEYS_FILE",
];
const core = [
  "DATABASE_URL",
  "REPORT_DATABASE_URL",
  "JWT_SECRET",
  "COOKIE_SECRET",
  "ORDER_CURSOR_CURRENT_KEY_ID",
  "ORDER_CURSOR_CURRENT_KEY",
  "ORDER_CURSOR_PREVIOUS_KEY_ID",
  "ORDER_CURSOR_PREVIOUS_KEY",
  "CORS_ORIGINS",
  "PUBLIC_URL",
  "STORE_NAME",
  "STORE_ADDRESS",
  "DB_POOL_MAX",
  "REPORT_DB_POOL_MAX",
];
export const processKeys: Record<PartnerProcessMode, string[]> = {
  api: [...common, ...core, ...api],
  staff: [
    ...common,
    "PARTNER_PUBLIC_HOST",
    "PLATFORM_MCP_CONFORMANCE_SHA256",
    "PARTNER_OAUTH_ISSUER",
    "PARTNER_CONTROL_DATABASE_URL",
    "PARTNER_CONTACT_DATABASE_URL",
    "PARTNER_CONTACT_KEYS_FILE",
    "PARTNER_AUDIT_DATABASE_URL",
    "PARTNER_OPERATIONS_DATABASE_URL",
  ],
  reconciler: [
    ...common,
    "PARTNER_RECONCILER_DATABASE_URL",
    "PARTNER_RECONCILER_AS_CONFIG_FILE",
    "PARTNER_RECONCILER_INTERVAL_MS",
    "PARTNER_RECONCILER_HEALTH_PORT",
  ],
  retention: [
    ...common,
    "PARTNER_MAINTENANCE_DATABASE_URL",
    "PARTNER_RETENTION_INTERVAL_MS",
    "PARTNER_RETENTION_BATCH_SIZE",
    "PARTNER_RETENTION_HEALTH_PORT",
  ],
  observer: [
    ...common,
    "PARTNER_OBSERVER_DATABASE_URL",
    "PARTNER_OBSERVER_PORT",
    "PARTNER_OBSERVER_INTERVAL_MS",
    "PARTNER_OBSERVER_HEALTH_FILES",
  ],
  alerts: [
    ...common,
    "PARTNER_ALERT_DATABASE_URL",
    "PARTNER_ALERT_DELIVERY_MODE",
    "PARTNER_ALERT_WEBHOOK_URL",
    "PARTNER_ALERT_TOKEN_FILE",
    "PARTNER_ALERT_STATE_DIRECTORY",
    "PARTNER_ALERT_PRIMARY_OWNER",
    "PARTNER_ALERT_BACKUP_OWNER",
    "PARTNER_ALERT_INTERVAL_MS",
    "PARTNER_ALERT_REMINDER_SECONDS",
    "PARTNER_ALERT_HEALTH_PORT",
  ],
};
export const loginRoles: Record<string, string> = {
  PARTNER_DATABASE_URL: "snus_partner_prod_api",
  PARTNER_CONTROL_DATABASE_URL: "snus_partner_prod_control",
  PARTNER_CONTACT_DATABASE_URL: "snus_partner_prod_contacts",
  PARTNER_AUDIT_DATABASE_URL: "snus_partner_prod_audit",
  PARTNER_OPERATIONS_DATABASE_URL: "snus_partner_prod_operations",
  PARTNER_RECONCILER_DATABASE_URL: "snus_partner_prod_reconciler",
  PARTNER_MAINTENANCE_DATABASE_URL: "snus_partner_prod_maintenance",
  PARTNER_OBSERVER_DATABASE_URL: "snus_partner_prod_observer",
  PARTNER_ALERT_DATABASE_URL: "snus_partner_prod_alerts",
};

export function validateProcessConfig(
  mode: PartnerProcessMode,
  input: unknown,
): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Invalid process config");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      !processKeys[mode].includes(key) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      /[\r\n]/.test(value) ||
      value.length > 8192
    )
      throw Error(`Unsupported ${mode} configuration key/type: ${key}`);
    result[key] = value;
  }
  if (result.PARTNER_ENVIRONMENT !== "production")
    throw Error("Partner environment must be production");
  for (const key of processKeys[mode].filter((key) =>
    key.endsWith("DATABASE_URL"),
  )) {
    if (!result[key]) throw Error(`${mode} requires ${key}`);
    const url = new URL(result[key]);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.password ||
      url.hostname !== "postgres" ||
      (url.port && url.port !== "5432") ||
      url.hash ||
      !/^\/[A-Za-z][A-Za-z0-9_]*$/.test(url.pathname) ||
      (loginRoles[key] && decodeURIComponent(url.username) !== loginRoles[key])
    )
      throw Error(`Invalid restricted role for ${key}`);
  }
  const bounded = (key: string, min: number, max: number) => {
    if (
      !Number.isInteger(Number(result[key])) ||
      Number(result[key]) < min ||
      Number(result[key]) > max
    )
      throw Error(`Invalid bounded process setting: ${key}`);
  };
  const exact: Record<string, string> = {
    PARTNER_PRIVATE_BIND_HOST: "0.0.0.0",
    PARTNER_FINGERPRINT_KEYS_FILE: "/run/partner/fingerprints.json",
    PARTNER_CONTACT_KEYS_FILE: "/run/partner/contacts.json",
    PARTNER_RECONCILER_AS_CONFIG_FILE: "/run/partner/as.json",
    PARTNER_ALERT_STATE_DIRECTORY: "/var/lib/partner/alerts",
    PARTNER_RECONCILER_HEALTH_PORT: "58222",
    PARTNER_RETENTION_HEALTH_PORT: "58322",
    PARTNER_OBSERVER_PORT: "58641",
    PARTNER_ALERT_HEALTH_PORT: "58642",
  };
  for (const [key, value] of Object.entries(exact))
    if (processKeys[mode].includes(key) && result[key] !== value)
      throw Error(`Production mount/address mismatch: ${key}`);
  for (const key of processKeys[mode].filter((key) =>
    key.endsWith("INTERVAL_MS"),
  ))
    bounded(key, 1000, 60000);
  if (mode === "retention") bounded("PARTNER_RETENTION_BATCH_SIZE", 1, 500);
  if (mode === "alerts") {
    bounded("PARTNER_ALERT_REMINDER_SECONDS", 60, 86400);
    for (const key of [
      "PARTNER_ALERT_PRIMARY_OWNER",
      "PARTNER_ALERT_BACKUP_OWNER",
    ])
      if (!result[key]?.trim()) throw Error("Alert owners are required");
    validateAlertDeliveryMode(result);
    if ((result.PARTNER_ALERT_DELIVERY_MODE ?? "https-webhook") === "https-webhook" &&
      result.PARTNER_ALERT_TOKEN_FILE !== "/run/partner/token")
      throw Error("Production alert token must use the private mount");
  }
  if (mode === "observer") {
    const expected = [
      "/var/lib/partner/api-a/health.json",
      "/var/lib/partner/api-b/health.json",
      "/var/lib/partner/worker/health.json",
    ];
    if (
      JSON.stringify(
        JSON.parse(result.PARTNER_OBSERVER_HEALTH_FILES ?? "null"),
      ) !== JSON.stringify(expected)
    )
      throw Error("Observer must cover both replicas and retained worker");
  }
  if (mode === "api") {
    for (const name of ["PARTNER_API_ENABLED", "PARTNER_MCP_ENABLED"])
      if (!["false", "true"].includes(result[name]))
        throw Error(`${name} must be explicit`);
    const profile = result.PARTNER_ROLLOUT_PROFILE ?? "read-only";
    if (!["read-only", "full-scope"].includes(profile))
      throw Error("Unknown production rollout profile");
    const writes = profile === "full-scope" ? "true" : "false";
    if (
      result.PARTNER_MUTATIONS_ENABLED !== writes ||
      result.PARTNER_BOOKING_ENABLED !== writes ||
      result.PARTNER_DELIVERY_ENABLED !== "false"
    )
      throw Error(
        "Production profile must match read-only/full-scope mutation and booking flags; delivery requires separate conformance",
      );
    for (const name of mutationBudgets) {
      if (profile === "full-scope" || result[name] !== undefined)
        bounded(name, 1, name.endsWith("CONCURRENCY") ? 20 : 120000);
    }
    if (profile === "full-scope") {
      if (
        Number(result.PARTNER_MUTATION_MERCHANT_CONCURRENCY) >
          Number(result.PARTNER_MUTATION_GLOBAL_CONCURRENCY) ||
        Number(result.PARTNER_MUTATION_GLOBAL_CONCURRENCY) >
          2 * Number(result.PARTNER_DB_POOL_MAX)
      )
        throw Error("Mutation concurrency must fit the two-replica pool budget");
      for (const operation of ["QUOTE", "BOOK"])
        for (const suffix of ["PER_MINUTE", "BURST"])
          if (
            Number(result[`PARTNER_${operation}_MERCHANT_${suffix}`]) >
            Number(result[`PARTNER_${operation}_GLOBAL_${suffix}`])
          )
            throw Error("Merchant mutation quotas must fit global quotas");
    }
    for (const name of api.filter((key) =>
      /PER_MINUTE|BURST|POOL_MAX/.test(key) && !mutationBudgets.includes(key),
    )) {
      if (
        !Number.isInteger(Number(result[name])) ||
        Number(result[name]) < 1 ||
        Number(result[name]) > (name === "PARTNER_DB_POOL_MAX" ? 20 : 120000)
      )
        throw Error(`Missing finite budget ${name}`);
    }
    for (const name of [
      "DATABASE_URL",
      "REPORT_DATABASE_URL",
      "JWT_SECRET",
      "COOKIE_SECRET",
      "ORDER_CURSOR_CURRENT_KEY",
      "PARTNER_REDIS_URL",
      "PARTNER_FINGERPRINT_KEYS_FILE",
      "PARTNER_PUBLIC_HOST",
      "PARTNER_OAUTH_ISSUER",
      "PARTNER_OAUTH_AUDIENCE",
      "PARTNER_OAUTH_JWKS_URL",
      "PARTNER_MCP_TRUSTED_PROXY_IPS",
    ])
      if (!result[name]) throw Error(`Missing API configuration ${name}`);
    for (const name of ["DB_POOL_MAX", "REPORT_DB_POOL_MAX"])
      bounded(name, 1, 20);
    for (const name of [
      "JWT_SECRET",
      "COOKIE_SECRET",
      "ORDER_CURSOR_CURRENT_KEY",
    ])
      if (result[name].length < 32) throw Error(`Secret too short: ${name}`);
    const redis = new URL(result.PARTNER_REDIS_URL);
    if (
      !["redis:", "rediss:"].includes(redis.protocol) ||
      !redis.password ||
      redis.hostname !== "partner-redis"
    )
      throw Error("Redis must be authenticated shared partner-redis");
    for (const name of ["PARTNER_OAUTH_ISSUER", "PARTNER_OAUTH_JWKS_URL"]) {
      const url = new URL(result[name]);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.port
      )
        throw Error("Production OAuth requires canonical HTTPS");
    }
    if (
      result.PARTNER_OAUTH_JWKS_URL !==
      `${result.PARTNER_OAUTH_ISSUER}/protocol/openid-connect/certs`
    )
      throw Error("JWKS and issuer must share the exact realm");
    if (result.PARTNER_MCP_ALLOWED_ORIGINS !== "")
      throw Error("Initial server-to-server pilot has no browser origins");
  }
  if (mode === "staff" && result.PARTNER_PUBLIC_HOST !== undefined && !isProductionHostname(result.PARTNER_PUBLIC_HOST)) {
    throw Error("Staff MCP URL requires an approved production hostname");
  }
  if (mode === "staff" && result.PLATFORM_MCP_CONFORMANCE_SHA256 !== undefined
    && (!result.PARTNER_PUBLIC_HOST || !/^[a-f0-9]{64}$/.test(result.PLATFORM_MCP_CONFORMANCE_SHA256))) {
    throw Error("Staff MCP conformance requires an approved hostname and pinned digest");
  }
  return result;
}

export function validateAlertDeliveryMode(config: Record<string, string>): void {
  const mode = config.PARTNER_ALERT_DELIVERY_MODE ?? "https-webhook";
  if (mode === "local-inbox") {
    if (config.PARTNER_ALERT_TOKEN_FILE !== undefined)
      throw Error("Local alert inbox must not configure webhook credentials");
    if (config.PARTNER_ALERT_WEBHOOK_URL !== "file:///var/lib/partner/alerts/inbox")
      throw Error("Local alert inbox requires the exact private data mount");
    return;
  }
  const destination = new URL(config.PARTNER_ALERT_WEBHOOK_URL);
  if (mode !== "https-webhook" || destination.protocol !== "https:" ||
    destination.username || destination.password || destination.hash)
    throw Error("Alert destination must use HTTPS");
}
