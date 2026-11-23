import { useState } from "react";
import { Button, ConfirmDialog, MutationBanner, Panel, StatusPill } from "@medusa-snus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link, Unlink } from "lucide-react";
import { createTelegramLinkToken, fetchMe, unlinkTelegramIdentity } from "../../api/settings-endpoints";

export default function AccountTelegramScreen() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const [token, setToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const linked = Boolean(data?.profile?.telegramLinked);

  const linkMutation = useMutation({
    mutationFn: createTelegramLinkToken,
    onSuccess: (result) => setToken(result.data),
  });
  const unlinkMutation = useMutation({
    mutationFn: unlinkTelegramIdentity,
    onSuccess: async () => {
      setConfirmUnlink(false);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  return (
    <Panel title="Telegram">
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-text-primary">Trạng thái liên kết</p>
            <p className="text-sm text-text-muted">Telegram không phải tên đăng nhập chính.</p>
          </div>
          <StatusPill tone={linked ? "success" : "neutral"} label={linked ? "Đã liên kết" : "Chưa liên kết"} />
        </div>
        {linkMutation.error ? <MutationBanner tone="error" message={linkMutation.error instanceof Error ? linkMutation.error.message : "Không thể tạo token."} /> : null}
        {unlinkMutation.error ? <MutationBanner tone="error" message={unlinkMutation.error instanceof Error ? unlinkMutation.error.message : "Không thể hủy liên kết."} /> : null}
        {token ? (
          <MutationBanner tone="info" message={`Token liên kết hết hạn lúc ${new Date(token.expiresAt).toLocaleTimeString("vi-VN")}.`} />
        ) : null}
        {token ? (
          <p className="text-sm text-text-secondary">Gửi lên Telegram bot: <span className="font-mono">/link {token.token}</span></p>
        ) : null}
        {token ? (
          <div className="rounded-md border border-border-default bg-surface-subtle p-3 font-mono text-sm text-text-primary break-all">{token.token}</div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => linkMutation.mutate()} disabled={linkMutation.isPending}>
            <Link size={16} />
            Tạo link token
          </Button>
          {token ? (
            <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(token.token)}>
              <Copy size={16} />
              Sao chép
            </Button>
          ) : null}
          {linked ? (
            <Button variant="danger" onClick={() => setConfirmUnlink(true)}>
              <Unlink size={16} />
              Hủy liên kết
            </Button>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirmUnlink}
        title="Hủy liên kết Telegram?"
        message="Tài khoản Telegram hiện tại sẽ không còn thực hiện lệnh operator."
        confirmLabel="Hủy liên kết"
        danger
        pending={unlinkMutation.isPending}
        onConfirm={() => unlinkMutation.mutate()}
        onCancel={() => setConfirmUnlink(false)}
      />
    </Panel>
  );
}
