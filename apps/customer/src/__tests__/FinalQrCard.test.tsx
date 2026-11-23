// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderTestUi, type TestRender } from "../test/reactTestHarness";
import { FinalQrCard } from "../components/FinalQrCard";
import type { CheckoutTokenDto } from "../scan-go/types";

function token(): CheckoutTokenDto {
  const value = `sgt_${crypto.randomUUID()}`;
  return {
    cartId: "sgc_test",
    token: value,
    qrPayload: `https://shop.example/s/default/main/redeem?t=${value}`,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    redeemableSeconds: 1800,
  };
}

describe("FinalQrCard", () => {
  it("ready: shows the QR tile, countdown, and VND total (no USD)", () => {
    const mounted: TestRender = renderTestUi(
      <FinalQrCard
        status="ready"
        token={token()}
        secondsLeft={120}
        itemCount={2}
        totalVnd={500000}
        onRegenerate={() => {}}
        onEdit={() => {}}
      />,
    );
    const text = mounted.container.textContent ?? "";
    expect(mounted.container.querySelector('[data-testid="qr-tile"] svg')).not.toBeNull();
    expect(text).toContain("Show this to staff");
    expect(text).toContain("Expires in");
    expect(text).toContain("2:00");
    expect(text).toContain("500,000₫");
    expect(text).not.toContain("USD");
    expect(text).not.toContain("$");
    mounted.unmount();
  });

  it("shows the nickname when provided", () => {
    const mounted = renderTestUi(
      <FinalQrCard
        status="ready"
        token={token()}
        secondsLeft={60}
        nickname="Tommy"
        itemCount={1}
        totalVnd={250000}
        onRegenerate={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Tommy");
    mounted.unmount();
  });

  it("expired: offers a regenerate action", () => {
    const mounted = renderTestUi(
      <FinalQrCard
        status="expired"
        token={null}
        secondsLeft={0}
        itemCount={1}
        totalVnd={250000}
        onRegenerate={() => {}}
        onEdit={() => {}}
      />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("expired");
    expect(text).toContain("Make a fresh QR");
    expect(mounted.container.querySelector('[data-testid="qr-tile"]')).toBeNull();
    mounted.unmount();
  });

  it("generating: shows a loading state", () => {
    const mounted = renderTestUi(
      <FinalQrCard
        status="generating"
        token={null}
        secondsLeft={0}
        itemCount={1}
        totalVnd={250000}
        onRegenerate={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Making your QR");
    mounted.unmount();
  });
});
