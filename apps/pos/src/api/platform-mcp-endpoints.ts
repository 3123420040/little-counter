import { api, ApiError } from "./client";
import {
  PlatformMcpConnectionListV1Schema,
  PlatformMcpConnectionDetailV1Schema,
  PlatformMcpCommandResultV1Schema,
  PlatformMcpCreateConnectionV1Schema,
  PlatformMcpIssueKeyV1Schema,
  PlatformMcpRotateKeyV1Schema,
  PlatformMcpRevokeKeyV1Schema,
  PlatformMcpChangeStatusV1Schema,
  type PlatformMcpCreateConnectionV1,
  type PlatformMcpIssueKeyV1,
  type PlatformMcpRotateKeyV1,
  type PlatformMcpRevokeKeyV1,
  type PlatformMcpChangeStatusV1,
} from "@medusa-snus/contracts";

export type PlatformMcpCommand =
  | { action: "create"; input: PlatformMcpCreateConnectionV1 }
  | { action: "issue"; integrationId: string; input: PlatformMcpIssueKeyV1 }
  | {
      action: "rotate";
      integrationId: string;
      keyId: string;
      input: PlatformMcpRotateKeyV1;
    }
  | {
      action: "revoke";
      integrationId: string;
      keyId: string;
      input: PlatformMcpRevokeKeyV1;
    }
  | {
      action: "status";
      integrationId: string;
      input: PlatformMcpChangeStatusV1;
    };
const prefix = (merchantId: string) =>
  `/api/platform/admin/merchants/${encodeURIComponent(merchantId)}/mcp-connections`;
const incompatible = () =>
  new ApiError(
    "Chưa xác nhận được kết quả MCP. Kiểm tra lại cùng yêu cầu.",
    502,
    "platform_mcp_contract_unavailable",
  );
export async function fetchPlatformMcpConnections(
  merchantId: string,
  after?: string,
) {
  const parsed = PlatformMcpConnectionListV1Schema.safeParse(
    await api.get<unknown>(
      `${prefix(merchantId)}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
    ),
  );
  if (
    !parsed.success ||
    parsed.data.data.some((row) => row.merchantId !== merchantId)
  )
    throw incompatible();
  return parsed.data;
}
export async function fetchPlatformMcpConnection(
  merchantId: string,
  integrationId: string,
  pages: {
    keysAfter?: string;
    grantsAfter?: string;
    receiptsAfter?: string;
  } = {},
) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(pages))
    if (value) qs.set(key, value);
  const parsed = PlatformMcpConnectionDetailV1Schema.safeParse(
    await api.get<unknown>(
      `${prefix(merchantId)}/${encodeURIComponent(integrationId)}${qs.size ? `?${qs}` : ""}`,
    ),
  );
  if (
    !parsed.success ||
    parsed.data.connection.merchantId !== merchantId ||
    parsed.data.connection.integrationId !== integrationId
  )
    throw incompatible();
  return parsed.data;
}
export async function executePlatformMcpCommand(
  merchantId: string,
  command: PlatformMcpCommand,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  let path = prefix(merchantId),
    input: unknown;
  switch (command.action) {
    case "create":
      input = PlatformMcpCreateConnectionV1Schema.parse(command.input);
      break;
    case "issue":
      input = PlatformMcpIssueKeyV1Schema.parse(command.input);
      path += `/${encodeURIComponent(command.integrationId)}/keys`;
      break;
    case "rotate":
      input = PlatformMcpRotateKeyV1Schema.parse(command.input);
      path += `/${encodeURIComponent(command.integrationId)}/keys/${encodeURIComponent(command.keyId)}/rotate`;
      break;
    case "revoke":
      input = PlatformMcpRevokeKeyV1Schema.parse(command.input);
      path += `/${encodeURIComponent(command.integrationId)}/keys/${encodeURIComponent(command.keyId)}/revoke`;
      break;
    case "status":
      input = PlatformMcpChangeStatusV1Schema.parse(command.input);
      path += `/${encodeURIComponent(command.integrationId)}/status`;
      break;
  }
  const parsed = PlatformMcpCommandResultV1Schema.safeParse(
    await api.post<unknown>(path, input, idempotencyKey, {}, signal),
  );
  if (!parsed.success) throw incompatible();
  const result = parsed.data;
  if (
    (result.requestState === "completed" &&
      result.data.merchantId !== merchantId) ||
    (command.action !== "create" &&
      result.data.integrationId !== command.integrationId) ||
    (!result.replayed &&
      ["create", "issue", "rotate"].includes(command.action) !==
        (result.secretStatus === "available_once")) ||
    (command.action === "rotate" &&
      result.secretStatus === "available_once" &&
      result.rotation?.previousKeyId !== command.keyId) ||
    (command.action === "revoke" &&
      result.requestState === "completed" &&
      result.data.key?.id !== command.keyId)
  )
    throw incompatible();
  return result;
}
