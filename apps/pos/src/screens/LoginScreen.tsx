import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { Shield, Loader2 } from "lucide-react";
import { useI18n } from "../i18n";
import { PasswordInput } from "../components/PasswordInput";

export default function LoginScreen() {
  const { t } = useI18n();
  const { login } = useAuth();
  const [operatorId, setOperatorId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const isOnline = typeof navigator === "undefined" ? true : navigator.onLine;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!operatorId.trim() || !password.trim()) {
      setError(t("auth.invalidCredentials"));
      return;
    }
    setLoading(true);
    try {
      await login(operatorId.trim(), password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("auth.invalidCredentials");
      const display =
        msg.toLowerCase().includes("invalid") ||
        msg.toLowerCase().includes("credential") ||
        msg.includes("401")
          ? t("auth.invalidCredentials")
          : !isOnline
          ? "Thiết bị đang offline. Cần mạng để đăng nhập phiên mới."
          : msg;
      setError(display);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-page p-4">
      <div className="w-full max-w-sm animate-fade-in space-y-6">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl border-2 border-border-default bg-surface-panel text-text-muted">
            <Shield size={28} />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold text-text-primary">Little Counter</h1>
            <p className="mt-1 text-sm text-text-muted">Hệ thống vận hành</p>
          </div>
        </div>

        <div className="rounded-lg border border-border-default bg-surface-panel p-3 text-xs text-text-secondary">
          <div className="flex items-center justify-between">
            <span>Thiết bị</span>
            <span className="font-medium text-text-primary">Quầy bán hàng</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>Kết nối</span>
            <span className={isOnline ? "font-medium text-status-success" : "font-medium text-status-warning"}>
              {isOnline ? "Online" : "Offline"}
            </span>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-text-muted">{t("auth.operatorId")}</label>
            <input
              aria-label={t("auth.operatorId")}
              type="text"
              placeholder="op_owner"
              value={operatorId}
              onChange={(e) => setOperatorId(e.target.value)}
              className="h-[var(--input-height)] w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                         placeholder:text-text-muted focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
              autoFocus
              autoComplete="username"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-text-muted">{t("auth.password")}</label>
            <PasswordInput
              aria-label={t("auth.password")}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              inputClassName="h-[var(--input-height)] w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm
                         placeholder:text-text-muted focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
              autoComplete="current-password"
            />
          </div>

          {/* Error */}
          {error && (
            <div
              role="alert"
              className="rounded-md bg-status-danger-bg border border-status-danger-border px-3 py-2 text-xs text-status-danger"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex h-[var(--button-height-lg)] w-full items-center justify-center gap-2 rounded-md
                       bg-action-primary text-sm font-medium text-text-inverse
                       transition-colors hover:bg-action-primary-hover
                       disabled:opacity-50 disabled:cursor-not-allowed
                       focus-visible:outline-2 focus-visible:outline-action-primary focus-visible:outline-offset-2"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {t("auth.loggingIn")}
              </>
            ) : (
              t("auth.login")
            )}
          </button>
        </form>

        <p className="text-center text-xs text-text-muted">
          {t("auth.forgotPassword")}
        </p>
      </div>
    </div>
  );
}
