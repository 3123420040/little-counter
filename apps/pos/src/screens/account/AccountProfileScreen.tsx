import { useEffect, useState } from "react";
import { Button, MutationBanner, Panel, ScreenState, StatusPill } from "@medusa-snus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMe, updateOwnProfile } from "../../api/settings-endpoints";
import { TextField } from "../settings/FormField";

export default function AccountProfileScreen() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneE164, setPhoneE164] = useState("");
  const [message, setMessage] = useState("");

  const resetForm = (source = data) => {
    if (!source) return;
    setDisplayName(source.displayName || "");
    setEmail(source.profile?.email || "");
    setPhoneE164(source.profile?.phoneE164 || "");
  };

  useEffect(() => {
    if (!data) return;
    setDisplayName(data.displayName || "");
    setEmail(data.profile?.email || "");
    setPhoneE164(data.profile?.phoneE164 || "");
  }, [data]);

  const hasChanges = data ? (
    displayName !== (data.displayName || "")
    || email !== (data.profile?.email || "")
    || phoneE164 !== (data.profile?.phoneE164 || "")
  ) : false;
  const accessSummary = data?.stores.length
    ? data.stores.map((store) => store.merchantDisplayName
      ? `${store.merchantDisplayName} · ${store.displayName}`
      : store.displayName).join(", ")
    : "Chưa có cửa hàng được gán";

  const mutation = useMutation({
    mutationFn: updateOwnProfile,
    onSuccess: async () => {
      setMessage("Đã lưu hồ sơ.");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  if (isLoading) return <ScreenState state="loading" title="Đang tải tài khoản" />;
  if (error || !data) return <ScreenState state="error" title="Không thể tải tài khoản" />;

  return (
    <Panel
      title="Hồ sơ"
      action={hasChanges ? <StatusPill tone="warning" label="Có thay đổi chưa lưu" /> : undefined}
    >
      <form
        className="settings-form-grid p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setMessage("");
          mutation.mutate({
            displayName,
            email: email.trim() || null,
            phoneE164: phoneE164.trim() || null,
          });
        }}
      >
        {message ? <div className="md:col-span-2"><MutationBanner tone="success" message={message} /></div> : null}
        {mutation.error ? (
          <div className="md:col-span-2">
            <MutationBanner tone="error" message={mutation.error instanceof Error ? mutation.error.message : "Không thể lưu hồ sơ."} />
          </div>
        ) : null}
        <TextField label="Tên hiển thị" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
        <TextField label="Email liên hệ" value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
        <TextField label="Số điện thoại" value={phoneE164} onChange={(event) => setPhoneE164(event.target.value)} />
        <TextField label="Tên đăng nhập / Username" value={data.operatorId} readOnly />
        <TextField label="Vai trò" value={data.role} readOnly />
        <TextField label="Trạng thái" value={data.security?.globalStatus === "suspended" ? "Tạm khóa" : "Đang hoạt động"} readOnly />
        <TextField label="Quyền truy cập merchant/store" value={accessSummary} readOnly />
        <div className="md:col-span-2 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={!hasChanges || mutation.isPending} onClick={() => {
            setMessage("");
            resetForm();
          }}>
            Đặt lại
          </Button>
          <Button type="submit" variant="primary" disabled={!hasChanges || mutation.isPending}>
            Lưu thay đổi
          </Button>
        </div>
      </form>
    </Panel>
  );
}
