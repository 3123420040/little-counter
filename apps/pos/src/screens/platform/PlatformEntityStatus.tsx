import { StatusPill } from "@medusa-snus/ui";
import type {
  PlatformEntityStatus as Status,
  PlatformEntityStatusFilter as Filter,
} from "../../api/settings-endpoints";
import { SelectField } from "../settings/FormField";

const labels: Record<Status, string> = {
  active: "Đang hoạt động",
  suspended: "Tạm ngưng",
  closed: "Đã đóng",
};
export function PlatformEntityStatus({ status }: { status: Status }) {
  return (
    <StatusPill
      tone={
        status === "active"
          ? "success"
          : status === "suspended"
            ? "warning"
            : "neutral"
      }
      label={labels[status]}
    />
  );
}
export function PlatformEntityStatusFilter({
  value,
  onChange,
}: {
  value: Filter;
  onChange: (value: Filter) => void;
}) {
  return (
    <div className="max-w-xs p-4">
      <SelectField
        label="Trạng thái hoạt động"
        value={value}
        onChange={(event) => onChange(event.target.value as Filter)}
      >
        <option value="all">Tất cả</option>
        {(Object.keys(labels) as Status[]).map((status) => (
          <option key={status} value={status}>
            {labels[status]}
          </option>
        ))}
      </SelectField>
    </div>
  );
}
