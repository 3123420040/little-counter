import { randomBytes } from "node:crypto";

process.env.JWT_SECRET ||= randomBytes(32).toString("hex");

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

function ensureBrowserStorage(name: "localStorage" | "sessionStorage"): void {
  const target = globalThis as unknown as { window?: Window & Record<string, unknown> };
  if (!target.window) return;
  const current = target.window[name] as Storage | undefined;
  if (current && typeof current.clear === "function" && typeof current.getItem === "function") return;
  Object.defineProperty(target.window, name, {
    configurable: true,
    value: createMemoryStorage(),
  });
}

ensureBrowserStorage("localStorage");
ensureBrowserStorage("sessionStorage");
