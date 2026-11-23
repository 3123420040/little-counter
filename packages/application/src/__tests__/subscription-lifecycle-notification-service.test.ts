import { describe, expect, it } from "vitest";
import {
  buildLifecyclePayloadSummary,
  buildLifecycleNotificationIdempotencyKey,
  mapSubscriptionLifecycleEvent,
  validateLifecycleTemplatePayload,
} from "../services/subscription-lifecycle-notification-service";

const baseEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  merchantId: "merchant_a",
  subscriptionId: "sub_a",
  periodEnd: "2027-06-20T00:00:00.000Z",
  reminderOffsetDays: null,
  payload: { packageKey: "plus" },
} as const;

describe("subscription lifecycle notification mapping", () => {
  it("maps each canonical lifecycle event to state-accurate template copy", () => {
    expect(mapSubscriptionLifecycleEvent({ ...baseEvent, eventType: "subscription.renewal_reminder", reminderOffsetDays: 7 })?.templateKey)
      .toBe("subscription.renewal_reminder");
    expect(mapSubscriptionLifecycleEvent({ ...baseEvent, eventType: "subscription.entered_grace" })?.templateKey)
      .toBe("subscription.entered_grace");
    expect(mapSubscriptionLifecycleEvent({ ...baseEvent, eventType: "subscription.grace_ending" })?.templateKey)
      .toBe("subscription.grace_ending");
    expect(mapSubscriptionLifecycleEvent({ ...baseEvent, eventType: "subscription.expired" })?.templateKey)
      .toBe("subscription.expired");
    expect(mapSubscriptionLifecycleEvent({ ...baseEvent, eventType: "subscription.renewed" })?.templateKey)
      .toBe("subscription.renewal_applied");
    expect(mapSubscriptionLifecycleEvent({ ...baseEvent, eventType: "subscription.upgraded" })?.templateKey)
      .toBe("subscription.upgrade_applied");
  });

  it("never turns an expired lifecycle event into an upgrade-applied notification", () => {
    const mapped = mapSubscriptionLifecycleEvent({
      ...baseEvent,
      eventType: "subscription.expired",
      payload: { packageKey: "plus", fallbackPackageKey: "basic" },
    });

    expect(mapped?.notificationType).toBe("expired_basic_fallback");
    expect(mapped?.templateKey).toBe("subscription.expired");
    expect(mapped?.currentState).toBe("expired");
  });

  it("uses a stable idempotency key that varies by event, period, and template version", () => {
    const mapped = mapSubscriptionLifecycleEvent({ ...baseEvent, eventType: "subscription.renewal_reminder", reminderOffsetDays: 30 });
    expect(mapped).toBeDefined();
    expect(buildLifecycleNotificationIdempotencyKey(baseEvent, mapped!)).toBe(
      "lifecycle:merchant_a:sub_a:2027-06-20T00:00:00.000Z:renewal_reminder:30:subscription.renewal_reminder:1",
    );
  });

  it("rejects invalid or secret-bearing template payload fields", () => {
    expect(() => validateLifecycleTemplatePayload({
      packageKey: "plus",
      renewalDate: "2027-06-20T00:00:00.000Z",
      currentState: "active",
      actionUrl: "http://localhost:8080/settings/merchant/merchant_a/package",
      providerPrivateKey: "must-not-leak",
    })).toThrow(/unsupported/i);
  });

  it("uses the supplied clock for grace payloads", () => {
    const event = {
      ...baseEvent,
      eventType: "subscription.entered_grace",
      payload: { packageKey: "plus", graceEndsAt: "2027-06-27T00:00:00.000Z" },
    };
    const mapped = mapSubscriptionLifecycleEvent(event);
    expect(mapped).toBeDefined();

    const started = buildLifecyclePayloadSummary(event, mapped!, new Date("2027-06-20T00:00:00.000Z"));
    const ending = buildLifecyclePayloadSummary({ ...event, eventType: "subscription.grace_ending" }, mapSubscriptionLifecycleEvent({ ...event, eventType: "subscription.grace_ending" })!, new Date("2027-06-26T00:00:00.000Z"));

    expect(started.daysRemainingInGrace).toBe(7);
    expect(ending.daysRemainingInGrace).toBe(1);
  });
});
