import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Loader2, Mail, ShieldCheck, Store } from "lucide-react";
import { api, ApiError } from "../api/client";
import { PasswordInput } from "../components/PasswordInput";

interface SignupRequestResponse {
  data: { requestId: string; email?: string; status?: string; verificationUrl?: string; message?: string };
}

interface VerifyResponse {
  data: {
    requestId: string;
    email: string;
    status: "verified";
    provisioningToken: string;
    provisioningExpiresAt: string;
  };
}

interface ProvisionResponse {
  data: { merchantId: string; storeId: string; operatorId: string; loginUrl: string; requestId: string };
}

type Step = "credentials" | "verify" | "tenant" | "complete";

function idempotencyKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type SignupLinkToken = { kind: "verification" | "provisioning"; token: string };

export function tokenFromSignupUrl(rawUrl: string): SignupLinkToken | null {
  const url = new URL(rawUrl);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const provisioning = fragment.get("provision");
  if (provisioning) return { kind: "provisioning", token: provisioning };
  const verification = fragment.get("token") || url.searchParams.get("token");
  return verification ? { kind: "verification", token: verification } : null;
}

export default function SignupScreen() {
  const [linkToken] = useState<SignupLinkToken | null>(() => tokenFromSignupUrl(window.location.href));
  const linkHandled = useRef(false);
  const [step, setStep] = useState<Step>(linkToken?.kind === "provisioning" ? "tenant" : linkToken ? "verify" : "credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(linkToken?.token || "");
  const [merchantName, setMerchantName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [timezone, setTimezone] = useState("Asia/Ho_Chi_Minh");
  const [operatorId, setOperatorId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const verifyRequestKey = useRef(idempotencyKey("signup-verify"));
  const provisionRequestKey = useRef(idempotencyKey("signup-provision"));

  const progress = useMemo(() => ({ credentials: 1, verify: 2, tenant: 3, complete: 4 }[step]), [step]);

  useEffect(() => {
    if (!linkToken || linkHandled.current) return;
    linkHandled.current = true;
    window.history.replaceState(window.history.state, "", window.location.pathname);
    if (linkToken.kind === "provisioning") {
      setToken(linkToken.token);
      setStep("tenant");
      return;
    }
    void verifyToken(linkToken.token);
  }, [linkToken]);

  function explain(err: unknown) {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : "Có lỗi xảy ra. Vui lòng thử lại.";
  }

  async function requestSignup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    if (!email.trim() || password.length < 10) {
      setError("Nhập email hợp lệ và mật khẩu tối thiểu 10 ký tự.");
      return;
    }
    setLoading(true);
    try {
      const result = await api.post<SignupRequestResponse>("/api/public/request", { email, password }, idempotencyKey("signup-request"));
      if (result.data.verificationUrl) setToken(tokenFromSignupUrl(result.data.verificationUrl)?.token || "");
      setStep("verify");
      setMessage(result.data.message || "Đã gửi email xác nhận. Mở Mailpit ở local hoặc kiểm tra hộp thư.");
    } catch (err) {
      setError(explain(err));
    } finally {
      setLoading(false);
    }
  }

  async function resendVerification() {
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const result = await api.post<SignupRequestResponse>("/api/public/resend", { email }, idempotencyKey("signup-resend"));
      if (result.data.verificationUrl) setToken(tokenFromSignupUrl(result.data.verificationUrl)?.token || "");
      verifyRequestKey.current = idempotencyKey("signup-verify");
      setMessage("Đã gửi lại email xác nhận.");
    } catch (err) {
      setError(explain(err));
    } finally {
      setLoading(false);
    }
  }

  async function verifyToken(rawToken = token) {
    setError("");
    setMessage("");
    if (!rawToken.trim()) {
      setError("Nhập token hoặc mở đường dẫn xác nhận từ email.");
      return;
    }
    setLoading(true);
    try {
      const result = await api.post<VerifyResponse>("/api/public/verify", { token: rawToken }, verifyRequestKey.current);
      setEmail(result.data.email);
      setToken(result.data.provisioningToken);
      provisionRequestKey.current = idempotencyKey("signup-provision");
      setStep("tenant");
      setMessage("Email đã xác nhận. Tạo merchant và cửa hàng đầu tiên.");
    } catch (err) {
      setError(explain(err));
    } finally {
      setLoading(false);
    }
  }

  async function provision(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    if (!merchantName.trim() || !storeName.trim()) {
      setError("Nhập tên merchant và cửa hàng.");
      return;
    }
    setLoading(true);
    try {
      const result = await api.post<ProvisionResponse>(
        "/api/public/provision",
        { token, merchantName, storeName, timezone },
        provisionRequestKey.current,
      );
      setOperatorId(result.data.operatorId);
      setToken("");
      setStep("complete");
      setMessage("Tài khoản Basic đã sẵn sàng. Đăng nhập bằng tên đăng nhập bên dưới.");
    } catch (err) {
      setError(explain(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface-page px-4 py-8 text-text-primary">
      <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[360px_1fr]">
        <aside className="rounded-xl border border-border-default bg-surface-panel p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border-default bg-surface-page">
            <ShieldCheck size={24} />
          </div>
          <h1 className="mt-4 text-2xl font-bold">Tạo merchant Basic</h1>
          <p className="mt-2 text-sm leading-6 text-text-secondary">
            Xác nhận email trước, sau đó hệ thống tạo merchant, cửa hàng chính, stock location, owner và gói Basic trong một giao dịch.
          </p>
          <div className="mt-6 space-y-3 text-sm">
            {["Email + mật khẩu", "Xác nhận email", "Merchant + cửa hàng", "Hoàn tất"].map((label, idx) => (
              <div key={label} className="flex items-center gap-3">
                <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs ${progress > idx ? "bg-action-primary text-text-inverse" : "bg-surface-page text-text-muted"}`}>
                  {idx + 1}
                </span>
                <span className={progress > idx ? "font-medium" : "text-text-secondary"}>{label}</span>
              </div>
            ))}
          </div>
          <Link className="mt-6 inline-block text-sm font-medium text-action-primary" to="/login">Đã có tài khoản? Đăng nhập</Link>
        </aside>

        <main className="rounded-xl border border-border-default bg-surface-panel p-6 shadow-sm">
          {error && <div role="alert" className="mb-4 rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{error}</div>}
          {message && <div className="mb-4 rounded-md border border-border-default bg-surface-page px-3 py-2 text-sm text-text-secondary">{message}</div>}

          {step === "credentials" && (
            <form onSubmit={requestSignup} className="max-w-md space-y-4">
              <div className="flex items-center gap-2 text-lg font-semibold"><Mail size={20} /> Thông tin đăng nhập</div>
              <label className="block text-sm">Email
                <input className="mt-1 h-[var(--input-height)] w-full rounded-md border border-border-default bg-surface-panel px-3" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="email" />
              </label>
              <label className="block text-sm">Mật khẩu
                <PasswordInput
                  className="mt-1"
                  inputClassName="h-[var(--input-height)] w-full rounded-md border border-border-default bg-surface-panel px-3"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <p className="text-xs text-text-muted">Mật khẩu tối thiểu 10 ký tự. Public signup mặc định tắt ở production.</p>
              <button className="flex h-[var(--button-height-lg)] w-full items-center justify-center gap-2 rounded-md bg-action-primary text-text-inverse disabled:opacity-50" disabled={loading} type="submit">
                {loading && <Loader2 size={16} className="animate-spin" />} Gửi email xác nhận
              </button>
            </form>
          )}

          {step === "verify" && (
            <div className="max-w-lg space-y-4">
              <div className="flex items-center gap-2 text-lg font-semibold"><Mail size={20} /> Kiểm tra email</div>
              <p className="text-sm leading-6 text-text-secondary">Local: mở Mailpit tại <code>http://localhost:8025</code>, lấy link xác nhận và mở trong trình duyệt.</p>
              <label className="block text-sm">Verification token hoặc link token
                <textarea className="mt-1 min-h-24 w-full rounded-md border border-border-default bg-surface-panel px-3 py-2 font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} />
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button className="rounded-md bg-action-primary px-4 py-2 text-text-inverse disabled:opacity-50" disabled={loading} type="button" onClick={() => verifyToken()}>
                  {loading ? "Đang xác nhận..." : "Xác nhận email"}
                </button>
                <button className="rounded-md border border-border-default px-4 py-2 disabled:opacity-50" disabled={loading || !email} type="button" onClick={resendVerification}>Gửi lại</button>
              </div>
            </div>
          )}

          {step === "tenant" && (
            <form onSubmit={provision} className="max-w-md space-y-4">
              <div className="flex items-center gap-2 text-lg font-semibold"><Store size={20} /> Merchant đầu tiên</div>
              <label className="block text-sm">Tên merchant
                <input className="mt-1 h-[var(--input-height)] w-full rounded-md border border-border-default bg-surface-panel px-3" value={merchantName} onChange={(e) => setMerchantName(e.target.value)} autoFocus />
              </label>
              <label className="block text-sm">Tên cửa hàng chính
                <input className="mt-1 h-[var(--input-height)] w-full rounded-md border border-border-default bg-surface-panel px-3" value={storeName} onChange={(e) => setStoreName(e.target.value)} />
              </label>
              <label className="block text-sm">Timezone
                <input className="mt-1 h-[var(--input-height)] w-full rounded-md border border-border-default bg-surface-panel px-3" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </label>
              <button className="flex h-[var(--button-height-lg)] w-full items-center justify-center gap-2 rounded-md bg-action-primary text-text-inverse disabled:opacity-50" disabled={loading} type="submit">
                {loading && <Loader2 size={16} className="animate-spin" />} Tạo merchant Basic
              </button>
            </form>
          )}

          {step === "complete" && (
            <div className="max-w-lg space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-status-success"><CheckCircle2 size={22} /> Hoàn tất</div>
              <div className="rounded-lg border border-border-default bg-surface-page p-4 text-sm">
                <p className="text-text-secondary">Tên đăng nhập owner</p>
                <p className="mt-1 font-mono text-lg font-semibold">{operatorId}</p>
                <p className="mt-3 text-text-secondary">Đăng nhập bằng tên đăng nhập này và mật khẩu đã tạo.</p>
              </div>
              <div className="rounded-lg border border-border-default p-4 text-sm">
                <p className="font-medium">Checklist không bắt buộc</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-text-secondary">
                  <li>Hoàn thiện hồ sơ merchant và cửa hàng.</li>
                  <li>Mời tối đa 3 staff trên gói Basic.</li>
                  <li>Cấu hình tích hợp thanh toán khi nâng cấp Plus/AI Fan.</li>
                </ul>
              </div>
              <Link className="inline-flex rounded-md bg-action-primary px-4 py-2 text-text-inverse" to="/login">Đăng nhập</Link>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
