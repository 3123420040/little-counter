// ═══════════════════════════════════════════════════════
// Transactional email package entrypoint
// ═══════════════════════════════════════════════════════

export type {
  TransactionalEmailProvider,
  TransactionalEmailMessage,
  DeliveryResult,
  EmailProvider,
} from "./provider";

export {
  MailpitProvider,
  MAILPIT_DEFAULTS,
} from "./mailpit-adapter";

export {
  ResendProvider,
  SesStubProvider,
  RESEND_FROM,
  RESEND_REPLY_TO,
  RESEND_API_BASE,
} from "./resend-adapter";

export {
  TestEmailProvider,
  LogEmailProvider,
  type SentMessage,
} from "./test-adapter";

export {
  resolveTransactionalEmailProvider,
  validateResendProductionConfig,
  getTestEmailProvider,
  type EmailProviderName,
} from "./factory";

export {
  renderTemplate,
  listTemplates,
  type EmailTemplateKey,
  type TemplateRenderContext,
  type RenderedEmail,
} from "./templates";
