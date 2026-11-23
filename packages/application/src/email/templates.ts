// ═══════════════════════════════════════════════════════
// Template registry for transactional email
// ═══════════════════════════════════════════════════════

import { transactionalEmailIdentity } from "./identity";

export type EmailTemplateKey =
  | "signup.email_verification"
  | "signup.verification_resent"
  | "signup.provisioned"
  | "subscription.renewal_reminder"
  | "subscription.entered_grace"
  | "subscription.grace_ending"
  | "subscription.expired"
  | "subscription.renewal_applied"
  | "subscription.upgrade_applied";

export interface TemplateRenderContext {
  [key: string]: string | number | boolean | undefined;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export type TemplateRenderer = (ctx: TemplateRenderContext) => RenderedEmail;

const APP_NAME = "Little Counter";
function supportText(): string {
  const { replyTo } = transactionalEmailIdentity();
  return replyTo ? `Hỗ trợ: ${replyTo}` : "";
}

function htmlWrap(body: string): string {
  const { replyTo } = transactionalEmailIdentity();
  const footer = replyTo ? `<div class="ft">Hỗ trợ: <a href="mailto:${encodeURI(replyTo)}">${replyTo}</a></div>` : "";
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${APP_NAME}</title>
  <style>
    body{margin:0;padding:0;background:#f5f5f5;font-family:system-ui,sans-serif;color:#1a1a1a;}
    .w{max-width:520px;margin:32px auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:32px;}
    .hd{font-size:18px;font-weight:700;margin-bottom:24px;color:#1a1a1a;}
    .btn{display:inline-block;padding:12px 24px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;margin:16px 0;}
    .code{font-family:monospace;font-size:24px;letter-spacing:4px;font-weight:700;padding:12px 0;}
    .ft{margin-top:24px;font-size:12px;color:#666;border-top:1px solid #e5e5e5;padding-top:16px;}
    a{color:#1a1a1a;}
  </style>
</head>
<body>
  <div class="w">${body}${footer}</div>
</body>
</html>`;
}

const TEMPLATES: Record<EmailTemplateKey, TemplateRenderer> = {
  "signup.email_verification": (ctx) => {
    const verifyUrl = String(ctx.verifyUrl || "");
    const appUrl = String(ctx.appUrl || "");
    return {
      subject: `${APP_NAME} — Xác nhận địa chỉ email`,
      text: [
        `Chào mừng bạn đến với ${APP_NAME}!`,
        "",
        "Vui lòng xác nhận địa chỉ email của bạn bằng cách nhấn vào đường dẫn sau:",
        verifyUrl,
        "",
        "Đường dẫn này sẽ hết hạn sau 24 giờ.",
        "Nếu bạn không đăng ký tài khoản, hãy bỏ qua email này.",
        "",
        supportText(),
        appUrl,
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd">Xác nhận địa chỉ email</div>
        <p>Chào mừng bạn đến với <strong>${APP_NAME}</strong>!</p>
        <p>Vui lòng xác nhận địa chỉ email của bạn để hoàn tất đăng ký.</p>
        <a class="btn" href="${verifyUrl}">Xác nhận email</a>
        <p style="font-size:12px;color:#666;">Đường dẫn hết hạn sau 24 giờ.<br/>
        Nếu bạn không đăng ký, hãy bỏ qua email này.</p>

      `),
    };
  },

  "signup.verification_resent": (ctx) => {
    const verifyUrl = String(ctx.verifyUrl || "");
    return {
      subject: `${APP_NAME} — Gửi lại mã xác nhận`,
      text: [
        `Đây là đường dẫn xác nhận email mới của bạn:`,
        verifyUrl,
        "",
        "Đường dẫn này hết hạn sau 24 giờ.",
        supportText(),
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd">Xác nhận email (gửi lại)</div>
        <p>Đây là đường dẫn xác nhận mới của bạn:</p>
        <a class="btn" href="${verifyUrl}">Xác nhận email</a>
        <p style="font-size:12px;color:#666;">Hết hạn sau 24 giờ.</p>

      `),
    };
  },

  "signup.provisioned": (ctx) => {
    const merchantName = String(ctx.merchantName || "");
    const storeName = String(ctx.storeName || "");
    const loginUrl = String(ctx.loginUrl || "");
    return {
      subject: `${APP_NAME} — Tài khoản đã được tạo`,
      text: [
        `Tài khoản của bạn đã sẵn sàng!`,
        "",
        `Merchant: ${merchantName}`,
        `Cửa hàng đầu tiên: ${storeName}`,
        `Gói: Basic (miễn phí)`,
        "",
        "Đăng nhập ngay:",
        loginUrl,
        "",
        supportText(),
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd">Chào mừng đến với ${APP_NAME}!</div>
        <p>Tài khoản của bạn đã được tạo thành công.</p>
        <p><strong>Merchant:</strong> ${merchantName}<br/>
           <strong>Cửa hàng:</strong> ${storeName}<br/>
           <strong>Gói:</strong> Basic (miễn phí)</p>
        <a class="btn" href="${loginUrl}">Đăng nhập ngay</a>

      `),
    };
  },

  "subscription.renewal_reminder": (ctx) => {
    const daysLeft = Number(ctx.daysLeft || 0);
    const packageKey = String(ctx.packageKey || "plus");
    const renewUrl = String(ctx.renewUrl || "");
    const periodEnd = String(ctx.periodEnd || "");
    return {
      subject: `${APP_NAME} — Gói ${packageKey} hết hạn trong ${daysLeft} ngày`,
      text: [
        `Gói ${packageKey} của bạn sẽ hết hạn vào ${periodEnd}.`,
        "",
        "Gia hạn để tiếp tục sử dụng đầy đủ tính năng:",
        renewUrl,
        "",
        supportText(),
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd">Nhắc nhở gia hạn</div>
        <p>Gói <strong>${packageKey}</strong> của bạn sẽ hết hạn vào <strong>${periodEnd}</strong>.</p>
        <p>Gia hạn ngay để tiếp tục sử dụng đầy đủ tính năng:</p>
        <a class="btn" href="${renewUrl}">Gia hạn</a>

      `),
    };
  },

  "subscription.entered_grace": (ctx) => {
    const graceEndsAt = String(ctx.graceEndsAt || "");
    const renewUrl = String(ctx.renewUrl || "");
    return {
      subject: `${APP_NAME} — Gói hết hạn, đang trong thời gian ân hạn`,
      text: [
        `Gói của bạn đã hết hạn. Bạn còn ${ctx.daysLeft || 7} ngày ân hạn đến ${graceEndsAt}.`,
        "",
        "Gia hạn ngay để không mất quyền truy cập:",
        renewUrl,
        "",
        supportText(),
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd" style="color:#b45309;">Đang trong thời gian ân hạn</div>
        <p>Gói của bạn đã hết hạn. Bạn còn <strong>${ctx.daysLeft || 7} ngày</strong> ân hạn đến <strong>${graceEndsAt}</strong>.</p>
        <p>Gia hạn ngay để tiếp tục sử dụng đầy đủ tính năng:</p>
        <a class="btn" href="${renewUrl}">Gia hạn ngay</a>

      `),
    };
  },

  "subscription.grace_ending": (ctx) => {
    const graceEndsAt = String(ctx.graceEndsAt || "");
    const renewUrl = String(ctx.renewUrl || "");
    return {
      subject: `${APP_NAME} — Thời gian ân hạn sắp kết thúc`,
      text: [
        `Thời gian ân hạn cho gói ${ctx.packageKey || ""} sẽ kết thúc vào ${graceEndsAt}.`,
        "Sau thời điểm này, tài khoản sẽ chuyển về Basic với các giới hạn tương ứng.",
        "",
        "Gia hạn để tiếp tục dùng các tính năng hiện có:",
        renewUrl,
        "",
        supportText(),
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd" style="color:#b45309;">Thời gian ân hạn sắp kết thúc</div>
        <p>Thời gian ân hạn cho gói <strong>${ctx.packageKey || ""}</strong> sẽ kết thúc vào <strong>${graceEndsAt}</strong>.</p>
        <p>Sau thời điểm này, tài khoản sẽ chuyển về Basic với các giới hạn tương ứng.</p>
        <a class="btn" href="${renewUrl}">Gia hạn</a>

      `),
    };
  },

  "subscription.expired": (ctx) => {
    const renewUrl = String(ctx.renewUrl || "");
    return {
      subject: `${APP_NAME} — Gói đã hết hạn, chuyển sang Basic`,
      text: [
        `Thời gian ân hạn đã kết thúc. Tài khoản của bạn đã chuyển về gói Basic.`,
        "",
        "Nâng cấp hoặc gia hạn để khôi phục tính năng đầy đủ:",
        renewUrl,
        "",
        supportText(),
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd" style="color:#dc2626;">Gói đã hết hạn</div>
        <p>Thời gian ân hạn đã kết thúc. Tài khoản chuyển về <strong>Basic</strong>.</p>
        <p>Nâng cấp hoặc gia hạn để khôi phục tính năng:</p>
        <a class="btn" href="${renewUrl}">Gia hạn / Nâng cấp</a>

      `),
    };
  },

  "subscription.renewal_applied": (ctx) => {
    const packageKey = String(ctx.packageKey || "");
    const renewalDate = String(ctx.renewalDate || "");
    const actionUrl = String(ctx.actionUrl || "");
    return {
      subject: `${APP_NAME} — Gia hạn gói ${packageKey} đã được áp dụng`,
      text: [
        `Gia hạn gói ${packageKey} đã được áp dụng.`,
        `Ngày gia hạn tiếp theo: ${renewalDate}.`,
        "",
        "Xem trạng thái gói:",
        actionUrl,
        "",
        supportText(),
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd">Gia hạn đã được áp dụng</div>
        <p>Gia hạn gói <strong>${packageKey}</strong> đã được áp dụng.</p>
        <p><strong>Ngày gia hạn tiếp theo:</strong> ${renewalDate}</p>
        <a class="btn" href="${actionUrl}">Xem trạng thái gói</a>

      `),
    };
  },

  "subscription.upgrade_applied": (ctx) => {
    const packageKey = String(ctx.packageKey || "");
    const actionUrl = String(ctx.actionUrl || "");
    return {
      subject: `${APP_NAME} — Gói ${packageKey} đã được áp dụng`,
      text: [
        `Gói ${packageKey} đã được áp dụng cho tài khoản của bạn.`,
        "",
        "Xem trạng thái gói và các tính năng hiện có:",
        actionUrl,
        "",
        supportText(),
      ].join("\n"),
      html: htmlWrap(`
        <div class="hd">Gói đã được áp dụng</div>
        <p>Gói <strong>${packageKey}</strong> đã được áp dụng cho tài khoản của bạn.</p>
        <a class="btn" href="${actionUrl}">Xem trạng thái gói</a>

      `),
    };
  },
};

export function renderTemplate(templateKey: EmailTemplateKey, ctx: TemplateRenderContext): RenderedEmail {
  const renderer = TEMPLATES[templateKey];
  if (!renderer) {
    throw new Error(`Unknown email template: ${templateKey}`);
  }
  return renderer(ctx);
}

export function listTemplates(): EmailTemplateKey[] {
  return Object.keys(TEMPLATES) as EmailTemplateKey[];
}
