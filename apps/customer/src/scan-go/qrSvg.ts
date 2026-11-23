import QRCode from "qrcode";

/* ═══════════════════════════════════════════════════════════════════
   Synchronous QR → SVG renderer.

   Uses the `qrcode` library's pure encoder (QRCode.create) so there is no
   React dependency and no canvas. The output is a crisp, scalable SVG that
   scans well at any size. Quiet zone is provided by both the margin modules
   here and the white .qr-tile padding in the final-QR screen.
   ═══════════════════════════════════════════════════════════════════ */

export interface BuildQrSvgOptions {
  margin?: number;
  dark?: string;
  light?: string;
  ecc?: "L" | "M" | "Q" | "H";
}

export function buildQrSvg(value: string, options: BuildQrSvgOptions = {}): string {
  const margin = options.margin ?? 4;
  const dark = options.dark ?? "#161210";
  const light = options.light ?? "#ffffff";
  const ecc = options.ecc ?? "M";

  const qr = QRCode.create(value, { errorCorrectionLevel: ecc });
  const size = qr.modules.size;
  const dim = size + margin * 2;
  const unit = 100 / dim;

  let rects = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (qr.modules.get(x, y)) {
        rects += `<rect x="${round2((x + margin) * unit)}" y="${round2((y + margin) * unit)}" width="${round2(unit)}" height="${round2(unit)}" fill="${dark}"/>`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ` +
    `preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" ` +
    `role="img" aria-label="Your stash cart QR" width="100%" height="100%">` +
    `<rect width="100" height="100" fill="${light}"/>` +
    rects +
    `</svg>`
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
