import { describe, expect, it } from "vitest";
import { readManualBankConfirmationUiConfigV1 } from "./manualBankConfirmation";

describe("manual-bank UI build selection", () => {
  it("is default-off and enables only the exact reviewed token", () => {
    expect(readManualBankConfirmationUiConfigV1({})).toEqual({ enabled: false });
    expect(readManualBankConfirmationUiConfigV1({ VITE_MANUAL_BANK_CONFIRMATION_ENABLED: "TRUE" }))
      .toEqual({ enabled: false });
    expect(readManualBankConfirmationUiConfigV1({ VITE_MANUAL_BANK_CONFIRMATION_ENABLED: "true" }))
      .toEqual({ enabled: true });
  });
});
