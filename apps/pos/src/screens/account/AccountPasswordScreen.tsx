import { useState } from "react";
import { Button, MutationBanner, Panel } from "@medusa-snus/ui";
import { useMutation } from "@tanstack/react-query";
import { changeOwnPassword } from "../../api/settings-endpoints";
import { setToken } from "../../api/client";
import { TextField } from "../settings/FormField";

export default function AccountPasswordScreen() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const [success, setSuccess] = useState("");

  const mutation = useMutation({
    mutationFn: changeOwnPassword,
    onSuccess: (res) => {
      setToken(res.data.token);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("Đã đổi mật khẩu.");
    },
  });

  return (
    <Panel title="Đổi mật khẩu">
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setLocalError("");
          setSuccess("");
          if (newPassword !== confirmPassword) {
            setLocalError("Mật khẩu xác nhận không khớp.");
            return;
          }
          mutation.mutate({ currentPassword, newPassword });
        }}
      >
        {success ? <MutationBanner tone="success" message={success} /> : null}
        {localError ? <MutationBanner tone="error" message={localError} /> : null}
        {mutation.error ? (
          <MutationBanner tone="error" message={mutation.error instanceof Error ? mutation.error.message : "Không thể đổi mật khẩu."} />
        ) : null}
        <TextField label="Mật khẩu hiện tại" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required autoComplete="current-password" />
        <TextField label="Mật khẩu mới" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} maxLength={128} required hint="Từ 8 đến 128 ký tự." autoComplete="new-password" />
        <TextField label="Xác nhận mật khẩu mới" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} maxLength={128} required autoComplete="new-password" />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            Đổi mật khẩu
          </Button>
        </div>
      </form>
    </Panel>
  );
}
