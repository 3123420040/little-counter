// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, renderTestUi, type TestRender } from "../test/reactTestHarness";
import { PasswordInput } from "./PasswordInput";

vi.mock("lucide-react", async () => {
  const React = await import("react");
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement("span", { "data-icon": name, ...props });
  return { Eye: icon("eye"), EyeOff: icon("eye-off") };
});

let mounted: TestRender | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("PasswordInput", () => {
  it("toggles password visibility without changing the entered value", () => {
    mounted = renderTestUi(<PasswordInput value="temporary-secret" onChange={vi.fn()} />);

    const input = mounted.container.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("temporary-secret");

    click(mounted.container.querySelector('button[aria-label="Hiện mật khẩu"]') as HTMLButtonElement);

    expect(input.type).toBe("text");
    expect(input.value).toBe("temporary-secret");
    expect(mounted.container.querySelector('[data-icon="eye-off"]')).not.toBeNull();

    click(mounted.container.querySelector('button[aria-label="Ẩn mật khẩu"]') as HTMLButtonElement);

    expect(input.type).toBe("password");
    expect(input.value).toBe("temporary-secret");
    expect(mounted.container.querySelector('[data-icon="eye"]')).not.toBeNull();
  });

  it("keeps the visibility control disabled when the password field is disabled", () => {
    mounted = renderTestUi(<PasswordInput value="locked-secret" disabled onChange={vi.fn()} />);

    const input = mounted.container.querySelector("input") as HTMLInputElement;
    const toggle = mounted.container.querySelector("button") as HTMLButtonElement;

    expect(input.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe("Hiện mật khẩu");
  });
});
