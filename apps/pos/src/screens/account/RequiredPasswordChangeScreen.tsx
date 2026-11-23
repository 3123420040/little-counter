import { useState } from "react";
import { Button, MutationBanner, Panel } from "@medusa-snus/ui";
import { Loader2, LogOut } from "lucide-react";
import { TextField } from "../settings/FormField";
import { useAuth } from "../../hooks/useAuth";

export default function RequiredPasswordChangeScreen() {
  const { completeRequiredPasswordChange, logout } = useAuth();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }
    setSubmitting(true);
    try {
      await completeRequiredPasswordChange(newPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thể cập nhật mật khẩu.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-page p-4">
      <main className="w-full max-w-md">
        <Panel title="Cập nhật mật khẩu">
          <form className="space-y-4 p-4" onSubmit={handleSubmit}>
            <MutationBanner
              tone="warning"
              message="Tài khoản cần đổi mật khẩu trước khi tiếp tục sử dụng POS."
            />
            <TextField
              label="Mật khẩu mới"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={8}
              maxLength={128}
              required
              hint="Từ 8 đến 128 ký tự."
              autoComplete="new-password"
            />
            <TextField
              label="Xác nhận mật khẩu mới"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              minLength={8}
              maxLength={128}
              required
              error={error || undefined}
              autoComplete="new-password"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={logout}>
                <LogOut size={16} />
                Đăng xuất
              </Button>
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
                Cập nhật mật khẩu
              </Button>
            </div>
          </form>
        </Panel>
      </main>
    </div>
  );
}
