import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateChannelServiceHeaders, requireChannelPermission, type ChannelActor } from "../services/channel-auth-service.js";
import { PlatformError } from "../errors/platform-error.js";

const originalTelegramToken = process.env.TELEGRAM_SERVICE_TOKEN;
const originalChannelToken = process.env.CHANNEL_SERVICE_TOKEN;
const originalServiceId = process.env.TELEGRAM_SERVICE_ID;

describe("channel auth service", () => {
  beforeEach(() => {
    process.env.TELEGRAM_SERVICE_TOKEN = "test-service-token-32-characters";
    delete process.env.CHANNEL_SERVICE_TOKEN;
    process.env.TELEGRAM_SERVICE_ID = "telegram-test";
  });

  afterEach(() => {
    if (originalTelegramToken === undefined) delete process.env.TELEGRAM_SERVICE_TOKEN;
    else process.env.TELEGRAM_SERVICE_TOKEN = originalTelegramToken;

    if (originalChannelToken === undefined) delete process.env.CHANNEL_SERVICE_TOKEN;
    else process.env.CHANNEL_SERVICE_TOKEN = originalChannelToken;

    if (originalServiceId === undefined) delete process.env.TELEGRAM_SERVICE_ID;
    else process.env.TELEGRAM_SERVICE_ID = originalServiceId;
  });

  it("resolves valid service token and channel headers", () => {
    const context = authenticateChannelServiceHeaders({
      authorization: "Bearer test-service-token-32-characters",
      "x-channel": "telegram",
      "x-channel-user-id": "123456789",
      "x-request-id": "req_channel_1",
    });

    expect(context).toEqual({
      channel: "telegram",
      channelUserId: "123456789",
      serviceIdentity: "telegram-test",
      requestId: "req_channel_1",
    });
  });

  it("fails closed when service token is not configured", () => {
    delete process.env.TELEGRAM_SERVICE_TOKEN;

    expect(() => authenticateChannelServiceHeaders({
      authorization: "Bearer test-service-token-32-characters",
      "x-channel": "telegram",
      "x-channel-user-id": "123456789",
    })).toThrowError(PlatformError);
  });

  it("rejects invalid service token", () => {
    expect(() => authenticateChannelServiceHeaders({
      authorization: "Bearer wrong",
      "x-channel": "telegram",
      "x-channel-user-id": "123456789",
    })).toThrow("Invalid channel service token");
  });

  it("rejects unsupported channel", () => {
    expect(() => authenticateChannelServiceHeaders({
      authorization: "Bearer test-service-token-32-characters",
      "x-channel": "web_pos",
      "x-channel-user-id": "123456789",
    })).toThrow("Unsupported channel");
  });

  it("requires explicit permission beyond role", () => {
    const actor: ChannelActor = {
      operatorId: "op_manager",
      role: "manager",
      displayName: "Manager",
      organizationId: "org_default",
      channel: "telegram",
      channelUserId: "123456789",
      serviceIdentity: "telegram-test",
      requestId: "req_channel_1",
      permissions: ["remote_order:create"],
    };

    requireChannelPermission(actor, "remote_order:create");
    expect(() => requireChannelPermission(actor, "order:refund")).toThrow("Missing permission: order:refund");
  });
});
