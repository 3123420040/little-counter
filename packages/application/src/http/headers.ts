export type HeadersLike = Record<string, string | string[] | undefined>;

export function headerValue(headers: HeadersLike, name: string): string {
  const found = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(found)) return found[0] || "";
  return found || "";
}
