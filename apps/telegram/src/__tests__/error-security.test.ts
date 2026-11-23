import { describe, expect, it } from "vitest";
import { BackendApiError } from "../backend-client";
import { userMessageForError } from "../error-messages";

describe("Telegram user-facing error sanitization", () => {
  it("does not expose unexpected runtime errors", () => {
    const secret = "postgresql://admin:private-password@db.internal/prod";
    expect(userMessageForError(new Error(secret))).toBe("Da co loi xay ra.");
    expect(userMessageForError(new Error(secret))).not.toContain(secret);
  });

  it("does not relay backend 5xx diagnostics", () => {
    const secret = "provider token=private-token SQL=SELECT password_hash";
    const message = userMessageForError(new BackendApiError(502, "provider_request_failed", secret));
    expect(message).toBe("He thong tam thoi khong the xu ly yeu cau.");
    expect(message).not.toContain(secret);
  });

  it("preserves the public API contract for safe 4xx errors", () => {
    expect(userMessageForError(new BackendApiError(409, "validation_error", "So luong khong hop le")))
      .toBe("So luong khong hop le");
  });
});
