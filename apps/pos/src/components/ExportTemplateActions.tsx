import { useState } from "react";
import { Button } from "@medusa-snus/ui";
import { Download, FileDown } from "lucide-react";
import {
  downloadCsvResource,
  type CsvDownloadKind,
  type CsvDownloadResource,
} from "../api/endpoints";

export interface ExportTemplateActionsProps {
  resource: CsvDownloadResource;
  exportLabel?: string;
  templateLabel?: string;
  onError?: (error: Error) => void;
}

export function ExportTemplateActions({
  resource,
  exportLabel = "Xuất CSV",
  templateLabel = "Tải mẫu CSV",
  onError,
}: ExportTemplateActionsProps) {
  const [pending, setPending] = useState<CsvDownloadKind | null>(null);

  async function download(kind: CsvDownloadKind) {
    setPending(kind);
    try {
      await downloadCsvResource(resource, kind);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Không thể tải tệp CSV."));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="md"
        icon={<Download size={15} aria-hidden="true" />}
        disabled={pending !== null}
        onClick={() => void download("export")}
      >
        {pending === "export" ? "Đang xuất..." : exportLabel}
      </Button>
      <Button
        variant="secondary"
        size="md"
        icon={<FileDown size={15} aria-hidden="true" />}
        disabled={pending !== null}
        onClick={() => void download("template")}
      >
        {pending === "template" ? "Đang tải..." : templateLabel}
      </Button>
    </>
  );
}
