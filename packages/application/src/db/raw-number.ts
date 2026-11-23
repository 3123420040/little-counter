export function rawNumber(value: number): Record<string, string | number> {
  return { value: String(value), precision: 20 };
}
