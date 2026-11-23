export interface ManualBankConfirmationUiConfigV1 {
  enabled: boolean;
}

export function readManualBankConfirmationUiConfigV1(
  env: Record<string, unknown>,
): ManualBankConfirmationUiConfigV1 {
  return { enabled: env.VITE_MANUAL_BANK_CONFIRMATION_ENABLED === "true" };
}

const viteEnv = typeof import.meta !== "undefined"
  ? ((import.meta as unknown as { env?: Record<string, unknown> }).env || {})
  : {};

/**
 * Manual bank confirmation is a separately gated write capability. It stays
 * absent from the UI unless the candidate image was explicitly built for an
 * approved environment with the flag enabled.
 */
export const MANUAL_BANK_CONFIRMATION_UI_CONFIG_V1 = Object.freeze(
  readManualBankConfirmationUiConfigV1(viteEnv),
);
