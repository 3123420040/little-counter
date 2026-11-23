import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, PageHeader, Panel, ScreenState, StatusPill } from "@medusa-snus/ui";
import { fetchMerchantProfile, updateMerchantProfile, type MerchantProfileDto } from "../../api/settings-endpoints";
import { TextField } from "./FormField";
import { useSettingsOwner } from "./useSettingsOwner";

type FormState = {
  internalName: string; publicName: string; receiptName: string; messageName: string;
  email: string; phone: string; website: string; street: string; ward: string; district: string; city: string; googleMapsUrl: string;
};

const blank: FormState = { internalName: "", publicName: "", receiptName: "", messageName: "", email: "", phone: "", website: "", street: "", ward: "", district: "", city: "", googleMapsUrl: "" };

function toForm(data?: MerchantProfileDto): FormState {
  return data ? {
    internalName: data.internalName || "", publicName: data.publicName || "", receiptName: data.receiptName || "", messageName: data.messageName || "",
    email: data.email || "", phone: data.phone || "", website: data.website || "", street: data.address?.street || "", ward: data.address?.ward || "",
    district: data.address?.district || "", city: data.address?.city || "", googleMapsUrl: data.address?.googleMapsUrl || "",
  } : blank;
}

function validate(form: FormState) {
  const errors: Partial<Record<keyof FormState, string>> = {};
  if (!form.internalName.trim()) errors.internalName = "Tên nội bộ là bắt buộc.";
  if (!form.publicName.trim()) errors.publicName = "Tên hiển thị là bắt buộc.";
  if (!form.receiptName.trim()) errors.receiptName = "Tên trên hóa đơn là bắt buộc.";
  if (!form.messageName.trim()) errors.messageName = "Tên trong tin nhắn là bắt buộc.";
  if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) errors.email = "Email không hợp lệ.";
  if (form.website && !/^https?:\/\//.test(form.website)) errors.website = "Website phải bắt đầu bằng http:// hoặc https://.";
  if (form.googleMapsUrl && !/^https?:\/\//.test(form.googleMapsUrl)) errors.googleMapsUrl = "Link bản đồ phải bắt đầu bằng http:// hoặc https://.";
  return errors;
}

export default function MerchantProfileScreen() {
  const { merchantId, isOwner } = useSettingsOwner();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(blank);
  const [touched, setTouched] = useState(false);
  const query = useQuery({ queryKey: ["merchantProfile", merchantId], queryFn: () => fetchMerchantProfile(merchantId!), enabled: !!merchantId && isOwner });
  useEffect(() => { if (query.data?.data && !touched) setForm(toForm(query.data.data)); }, [query.data, touched]);
  const original = useMemo(() => toForm(query.data?.data), [query.data]);
  const dirty = JSON.stringify(form) !== JSON.stringify(original);
  const errors = validate(form);
  const mutation = useMutation({
    mutationFn: () => updateMerchantProfile(merchantId!, { internalName: form.internalName, publicName: form.publicName, receiptName: form.receiptName, messageName: form.messageName, email: form.email, phone: form.phone, website: form.website, address: { street: form.street, ward: form.ward, district: form.district, city: form.city, country: "VN", googleMapsUrl: form.googleMapsUrl } }),
    onSuccess: () => { setTouched(false); queryClient.invalidateQueries({ queryKey: ["merchantProfile", merchantId] }); },
  });
  const set = (key: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement>) => { setTouched(true); setForm((cur) => ({ ...cur, [key]: event.target.value })); };
  if (!isOwner) return <div className="p-4"><PageHeader title="Thương hiệu" /><ScreenState state="error" title="Không có quyền" body="Chỉ chủ doanh nghiệp được sửa thông tin thương hiệu." /></div>;
  if (query.isLoading) return <div className="p-4"><PageHeader title="Thương hiệu" /><ScreenState state="loading" title="Đang tải hồ sơ thương hiệu..." /></div>;
  if (query.error) return <div className="p-4"><PageHeader title="Thương hiệu" /><ScreenState state="error" title="Không thể tải hồ sơ" actionLabel="Thử lại" onAction={() => query.refetch()} /></div>;
  return <div className="space-y-4 p-4"><PageHeader title="Thương hiệu" subtitle="Tên nội bộ, tên khách thấy, thông tin liên hệ và bản xem trước hóa đơn/tin nhắn." status={dirty ? <StatusPill tone="warning" label="Có thay đổi chưa lưu" /> : <StatusPill tone="success" label="Đã đồng bộ" />} actions={<><Button variant="secondary" disabled={!dirty || mutation.isPending} onClick={() => { setForm(original); setTouched(false); }}>Hoàn tác</Button><Button variant="primary" disabled={!dirty || Object.keys(errors).length > 0 || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "Đang lưu..." : "Lưu thay đổi"}</Button></>} />
    {mutation.error && <ScreenState state="error" title="Không thể lưu hồ sơ" body="Kiểm tra dữ liệu hoặc thử lại." />}
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]"><Panel title="Thông tin thương hiệu"><div className="settings-form-grid p-4"><TextField label="Tên nội bộ" required value={form.internalName} onChange={set("internalName")} error={errors.internalName} /><TextField label="Tên công khai" required value={form.publicName} onChange={set("publicName")} error={errors.publicName} /><TextField label="Tên trên hóa đơn" required value={form.receiptName} onChange={set("receiptName")} error={errors.receiptName} /><TextField label="Tên trong tin nhắn" required value={form.messageName} onChange={set("messageName")} error={errors.messageName} /><TextField label="Email" value={form.email} onChange={set("email")} error={errors.email} /><TextField label="Điện thoại" value={form.phone} onChange={set("phone")} /><TextField label="Website" value={form.website} onChange={set("website")} error={errors.website} /><TextField label="Link Google Maps" value={form.googleMapsUrl} onChange={set("googleMapsUrl")} error={errors.googleMapsUrl} /><TextField label="Địa chỉ" value={form.street} onChange={set("street")} /><TextField label="Phường/Xã" value={form.ward} onChange={set("ward")} /><TextField label="Quận/Huyện" value={form.district} onChange={set("district")} /><TextField label="Tỉnh/Thành" value={form.city} onChange={set("city")} /></div></Panel><Panel title="Xem trước"><div className="space-y-3 p-4 text-sm"><div className="rounded-lg border border-border-default bg-surface-subtle p-3"><p className="font-semibold text-text-primary break-words">{form.receiptName || "Tên trên hóa đơn"}</p><p className="mt-1 text-text-muted break-words">{[form.street, form.ward, form.district, form.city].filter(Boolean).join(", ") || "Địa chỉ cửa hàng"}</p><p className="mt-1 text-text-muted">{form.phone || "Số điện thoại"}</p></div><div className="rounded-lg border border-border-default bg-surface-subtle p-3"><p className="text-text-secondary break-words">Xin chào, đây là {form.messageName || "tên trong tin nhắn"}. Cảm ơn anh/chị đã mua hàng.</p></div></div></Panel></div>
  </div>;
}
