import { describe, expect, it, vi } from "vitest";
import {
  resolveTraceIdentityHeaders,
  traceIdentityHeaders,
} from "../../../../src/api/middlewares";

describe("candidate trace identity headers", () => {
  it("preserves a safe correlation ID and binds exact release identity", () => {
    expect(resolveTraceIdentityHeaders("client-request:42", {
      BUILD_RELEASE_ID: "test-release-a1b2c3d4e5f6",
      BUILD_SOURCE_COMMIT: "a".repeat(40),
    })).toEqual({
      "x-correlation-id": "client-request:42",
      "x-release-id": "test-release-a1b2c3d4e5f6",
      "x-source-commit": "a".repeat(40),
    });
  });

  it("replaces unsafe correlation input and omits unsafe build identity", () => {
    expect(resolveTraceIdentityHeaders("bad\r\nheader", {
      BUILD_RELEASE_ID: "unsafe value",
      BUILD_SOURCE_COMMIT: "HEAD",
    }, () => "00000000-0000-4000-8000-000000000000")).toEqual({
      "x-correlation-id": "00000000-0000-4000-8000-000000000000",
    });
  });

  it("sets the resolved headers before continuing the request", () => {
    const setHeader = vi.fn();
    const next = vi.fn();
    traceIdentityHeaders({ headers: {} }, { setHeader }, next);
    expect(setHeader).toHaveBeenCalledWith("x-correlation-id", expect.stringMatching(CORRELATION_ID));
    expect(next).toHaveBeenCalledOnce();
  });
});

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
