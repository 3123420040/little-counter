import { BackendApiError } from "./backend-client";

const VIETNAMESE_MESSAGES: Record<string, string> = {
  channel_identity_unmapped: "Tai khoan Telegram nay chua duoc lien ket voi nhan vien noi bo.",
  forbidden: "Ban khong co quyen thuc hien thao tac nay.",
  unauthorized: "Kenh Telegram chua duoc xac thuc.",
  service_token_not_configured: "He thong chua cau hinh token cho Telegram.",
  idempotency_conflict: "Yeu cau bi trung ma xu ly nhung noi dung khac nhau.",
  insufficient_stock: "Ton kho khong du de tao don.",
  resource_not_found: "Khong tim thay du lieu yeu cau.",
};

export function userMessageForError(error: unknown): string {
  if (error instanceof BackendApiError) {
    if (VIETNAMESE_MESSAGES[error.code]) return VIETNAMESE_MESSAGES[error.code];
    return error.status < 500 ? error.message : "He thong tam thoi khong the xu ly yeu cau.";
  }
  return "Da co loi xay ra.";
}
