import { describe, expect, it } from "vitest";
import { tokenFromSignupUrl } from "./SignupScreen";

describe("signup link token transport", () => {
  it("reads verification and provisioning capabilities from fragments", () => {
    expect(tokenFromSignupUrl("https://local.test/signup/verify#token=sur_one.secret")).toEqual({
      kind: "verification",
      token: "sur_one.secret",
    });
    expect(tokenFromSignupUrl("https://local.test/signup/verify#provision=sur_one.capability")).toEqual({
      kind: "provisioning",
      token: "sur_one.capability",
    });
  });
});
