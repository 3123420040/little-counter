export {
  resolveTransactionalEmailProvider,
  validateResendProductionConfig,
  getTestEmailProvider,
} from "./email/factory";
export type { EmailProviderName } from "./email/factory";
export * from "./email";

export {
  createSignupRequest,
  resendVerificationEmail,
  verifySignupToken,
  provisionSignupTenant,
  getSignupStatus,
  normalizeEmail,
  validatePassword,
  generateVerificationToken,
  hashVerificationToken,
  safeEqualHash,
  operatorIdFromEmail,
  merchantIdFromEmail,
  storeIdFromEmail,
  stockLocationIdFromEmail,
} from "./services/signup-service";
export type {
  SignupRequestInput,
  SignupRequestResult,
  ProvisionInput,
  ProvisionResult,
  ResendResult,
  VerifyResult,
  SignupStatusResult,
} from "./services/signup-service";
