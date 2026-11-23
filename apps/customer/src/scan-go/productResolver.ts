import { productPublicDtoSchema, ProductResolveError, type ProductPublicDto } from "./types";
import { mockProductBySlug } from "./mockData";
import { scanGoLive } from "./config";

/* ═══════════════════════════════════════════════════════════════════
   PRODUCT RESOLVER ADAPTER.

   Resolves a shelf QR (product identity only) to a public product DTO.
   - Mock (default): reads the isolated mock catalog.
   - Live: GET /api/public/scan-go/products/:merchantSlug/:storeSlug/:qrSlug
     Enable the live catalog with VITE_SCAN_GO_LIVE=1.

   The QR is identity only. No action semantics live in the payload; the
   public browser context decides this is the Scan & Go product journey.
   ═══════════════════════════════════════════════════════════════════ */

export interface ResolveProductInput {
  merchantSlug: string;
  storeSlug: string;
  qrSlug: string;
}

export async function resolveProduct(input: ResolveProductInput): Promise<ProductPublicDto> {
  if (scanGoLive()) {
    return resolveProductLive(input);
  }
  return resolveProductMock(input);
}

async function resolveProductMock({
  merchantSlug,
  storeSlug,
  qrSlug,
}: ResolveProductInput): Promise<ProductPublicDto> {
  await delay(160);
  const found = mockProductBySlug(qrSlug);
  if (!found) {
    throw new ProductResolveError("product_not_found", "We couldn't match this tag to a product.");
  }
  const parsed = productPublicDtoSchema.safeParse({ ...found, merchantSlug, storeSlug });
  if (!parsed.success) {
    throw new ProductResolveError("product_not_found", "This tag could not be read.");
  }
  // Known product returns even when coarse availability is "unavailable" so the
  // UI can show a clear off-the-shelf state instead of a raw error.
  return parsed.data;
}

async function resolveProductLive({
  merchantSlug,
  storeSlug,
  qrSlug,
}: ResolveProductInput): Promise<ProductPublicDto> {
  try {
    const res = await fetch(
      `/api/public/scan-go/products/${encodeURIComponent(merchantSlug)}/${encodeURIComponent(storeSlug)}/${encodeURIComponent(qrSlug)}`,
      { headers: { accept: "application/json" } },
    );
    if (res.status === 404) {
      throw new ProductResolveError("product_not_found", "We couldn't match this tag to a product.");
    }
    if (!res.ok) {
      throw new ProductResolveError("network_error", "Couldn't reach the shop. Try again.");
    }
    const json = (await res.json()) as { data?: unknown };
    const parsed = productPublicDtoSchema.safeParse(json.data);
    if (!parsed.success) {
      throw new ProductResolveError("product_not_found", "This tag could not be read.");
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof ProductResolveError) throw err;
    throw new ProductResolveError("network_error", "Couldn't reach the shop. Try again.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
