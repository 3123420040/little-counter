import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export interface TestRender {
  container: HTMLDivElement;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
}

export function renderTestUi(node: ReactNode): TestRender {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender(next) {
      act(() => root.render(next));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export function click(element: HTMLElement): void {
  act(() => element.click());
}

export function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

/** Let microtasks/timers (mock resolver delays, state ticks) flush. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replace window.localStorage/sessionStorage with a clean in-memory Web
 * Storage shim. The jsdom storage in some Node versions lacks `.clear`, so
 * tests install this fresh each run. Identical surface to the real API.
 */
export function installMemoryStorage(): void {
  const make = () => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    };
  };
  Object.defineProperty(window, "localStorage", { value: make(), configurable: true, writable: true });
  Object.defineProperty(window, "sessionStorage", { value: make(), configurable: true, writable: true });
}
