import { PlatformMcpCommandMetadataV1Schema } from "@medusa-snus/contracts";

export function trustedPlatformMcpUrlForHost(host: string | undefined) {
  if (!host) return null;
  try {
    const url = new URL(`https://${host}/mcp`);
    if (url.host !== host.toLowerCase()) return null;
    const parsed = PlatformMcpCommandMetadataV1Schema.shape.mcpUrl.safeParse(url.toString());
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
