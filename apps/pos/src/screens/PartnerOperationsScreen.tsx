import { useEffect, useRef, useState } from "react";
import { Button } from "@medusa-snus/ui";
import { api, getClientScopeSnapshot, SCOPE_CHANGED_EVENT } from "../api/client";
import { usePermission } from "../hooks/usePermissions";

interface Result {
  telemetry?: Record<string, number>;
  commerce?: {orders:number;booked_value_vnd_minor:string};
  outbox?: {oldest_pending_seconds:number};
  alerts?: Array<{alert_key:string;code:string;detail:Record<string,unknown>}>;
  rows?: Array<{event_key:string;observed_at:string;attributes:Record<string,string|number|boolean>}>;
  next_after_event_key?:string|null;
  by_credential?:Array<{integration_id:string;credential_id:string|null;requests:number;server_errors:number;replays:number;p95_ms:number}>;
  credentials_truncated?:boolean;
}
const labels:Record<string,string>={requests:"Yêu cầu",unauthorized:"Không xác thực (401)",forbidden:"Không đủ quyền (403)",throttled:"Giới hạn tần suất (429)",server_errors:"Lỗi máy chủ",denied:"Bị từ chối",replays:"Replay",
  conflicts:"Xung đột",stock_rejections:"Thiếu tồn kho",books:"Book thành công",p50_ms:"p50 (ms)",p95_ms:"p95 (ms)",p99_ms:"p99 (ms)",requests_per_second:"Yêu cầu / giây"};
const alertLabels:Record<string,string>={partner_5xx_rate:"Tỷ lệ lỗi máy chủ vượt 2%",partner_auth_denials:"Nhiều yêu cầu bị từ chối",
  partner_booking_latency:"Đặt đơn chậm hơn 2 giây",partner_internal_failure:"Có lỗi nội bộ cần kiểm tra audit",outbox_lag:"Sự kiện chưa được xử lý quá 60 giây",
  telemetry_dropped:"Có bản ghi theo dõi bị mất",telemetry_storage_failed:"Không lưu được dữ liệu theo dõi",telemetry_export_failed:"Không chuyển được dữ liệu theo dõi",
  telemetry_queue_pressure:"Hàng đợi theo dõi gần đầy",telemetry_health_unavailable:"Chưa nhận được tình trạng dịch vụ theo dõi",telemetry_records_rejected:"Có bản ghi theo dõi không hợp lệ bị từ chối",telemetry_ingest_failed:"Không ghi được log vận hành; dữ liệu có thể chưa đầy đủ"};
export default function PartnerOperationsScreen() {
  const canRead=usePermission("partner:logs_read"),canSecurity=usePermission("partner:security_read");
  const [mode,setMode]=useState("overview"),[integration,setIntegration]=useState("");
  const [data,setData]=useState<Result|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(false);
  const [range,setRange]=useState({from:new Date(Date.now()-3600000).toISOString(),to:new Date().toISOString()});
  const generation=useRef(0);
  function clear(){generation.current++;setData(null);setError("");setLoading(false);}
  useEffect(()=>{clear();window.addEventListener(SCOPE_CHANGED_EVENT,clear);return()=>{generation.current++;window.removeEventListener(SCOPE_CHANGED_EVENT,clear);};},[canRead,canSecurity,mode,integration]);
  async function load(after?:string){
    const current=++generation.current,merchant=getClientScopeSnapshot().operatingMerchantId;
    if(!merchant){setError("Chọn merchant trước khi xem.");return;}
    const dates=after?range:{from:new Date(Date.now()-3600000).toISOString(),to:new Date().toISOString()};
    if(!after)setRange(dates);setData(null);setLoading(true);setError("");
    const query=new URLSearchParams({...dates,mode,limit:"50",...(integration?{integration_id:integration}:{}),...(after?{after_event_key:after}:{})});
    try{
      const response=await api.get<{data:Result}>(`/api/platform/admin/merchants/${encodeURIComponent(merchant)}/partner-operations?${query}`);
      if(current===generation.current&&merchant===getClientScopeSnapshot().operatingMerchantId)setData(response.data);
    }catch{if(current===generation.current)setError("Không thể tải dữ liệu. Kiểm tra quyền, phạm vi và dịch vụ quan sát.");}
    finally{if(current===generation.current)setLoading(false);}
  }
  if(!canRead)return <p className="p-6">Bạn không có quyền xem vận hành đối tác.</p>;
  return <main className="space-y-4 p-6" aria-label="Vận hành đối tác">
    <h1 className="text-xl font-semibold">Vận hành đối tác</h1>
    <p className="text-sm text-text-secondary">Dữ liệu một giờ gần nhất trong merchant đang chọn. Mỗi lần xem được ghi audit.</p>
    <div className="flex flex-wrap gap-3">
      <label>Integration <input aria-label="Integration" className="border p-2" value={integration} onChange={event=>setIntegration(event.target.value)} placeholder="Tất cả trong merchant" /></label>
      <label>Chế độ <select aria-label="Chế độ" className="border p-2" value={mode} onChange={event=>setMode(event.target.value)}>
        <option value="overview">Dashboard</option><option value="access">Access log</option>{canSecurity&&<option value="security">Security log</option>}
      </select></label>
      <Button disabled={loading} onClick={()=>{void load();}}>{loading?"Đang tải…":"Xem dữ liệu"}</Button>
    </div>
    {error&&<p role="alert">{error}</p>}
    {data?.telemetry&&<dl className="grid grid-cols-2 gap-3 md:grid-cols-4">{Object.entries(data.telemetry).map(([key,value])=><div key={key} className="rounded border p-3"><dt>{labels[key]??key}</dt><dd className="text-xl">{Number(value).toLocaleString("vi-VN",{maximumFractionDigits:1})}</dd></div>)}</dl>}
    {data?.commerce&&<p>{data.commerce.orders} đơn · Giá trị đơn hiện hành: {Number(data.commerce.booked_value_vnd_minor).toLocaleString("vi-VN")} VND. Đây là giá trị thương mại của đơn.</p>}
    {data?.outbox&&<p>Outbox chờ lâu nhất: {Math.round(data.outbox.oldest_pending_seconds)} giây</p>}
    {data?.by_credential&&<section aria-label="Theo integration và credential" className="overflow-auto"><h2 className="font-semibold">Theo integration và credential</h2>
      <table className="w-full min-w-[760px] whitespace-nowrap text-left text-sm"><thead><tr><th>Integration</th><th>Client / Key ID</th><th>Yêu cầu</th><th>Lỗi 5xx</th><th>Replay</th><th>p95 (ms)</th></tr></thead>
        <tbody>{data.by_credential.map(row=><tr key={`${row.integration_id}:${row.credential_id}`}><td>{row.integration_id}</td><td>{row.credential_id??"Không có định danh xác thực"}</td><td>{row.requests}</td><td>{row.server_errors}</td><td>{row.replays}</td><td>{Math.round(row.p95_ms)}</td></tr>)}</tbody></table>
      {data.credentials_truncated&&<p>Hiển thị 100 nhóm nhiều yêu cầu nhất; chọn integration để thu hẹp.</p>}</section>}
    {data?.alerts&&<section aria-label="Cảnh báo"><h2 className="font-semibold">Cảnh báo đang mở ({data.alerts.length})</h2>
      <ul>{data.alerts.map(alert=><li key={alert.alert_key} className="my-2 rounded border p-3">{alertLabels[alert.code]??alert.code}
        {typeof alert.detail.count==="number"&&<span> · {alert.detail.count} lần</span>}
        {typeof alert.detail.oldest_pending_seconds==="number"&&<span> · {Math.round(alert.detail.oldest_pending_seconds)} giây</span>}
      </li>)}</ul></section>}
    {data?.rows&&<div className="overflow-auto"><table className="w-full min-w-[760px] whitespace-nowrap text-left text-sm"><thead><tr><th>Thời gian</th><th>Request</th><th>Thao tác</th><th>Kết quả</th><th>Thời gian (ms)</th></tr></thead>
      <tbody>{data.rows.map(row=><tr key={row.event_key}><td>{new Date(row.observed_at).toLocaleString("vi-VN")}</td><td>{row.attributes.request_id}</td><td>{row.attributes.tool_name??row.attributes.route}</td><td>{row.attributes.status} {row.attributes.error_code}</td><td>{row.attributes.duration_ms}</td></tr>)}</tbody></table>
      {!data.rows.length&&<p>Không có bản ghi trong khoảng thời gian này.</p>}
      {data.next_after_event_key&&<Button onClick={()=>{void load(data.next_after_event_key!);}}>Trang tiếp</Button>}</div>}
  </main>;
}
