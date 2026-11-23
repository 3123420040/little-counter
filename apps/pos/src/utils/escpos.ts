// ═══════════════════════════════════════════════════════
// ESC/POS Thermal Printer Utility
// Supports: browser window.print() + ESC/POS commands
// ═══════════════════════════════════════════════════════

import { RECEIPT_STORE } from "../config/receipt";

export function printReceiptViaBrowser(receiptHtml: string): void {
  const win = window.open("", "_blank", "width=300,height=600");
  if (!win) return;

  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head><title>Receipt</title>
    <style>
      @page { margin: 0; size: 80mm auto; }
      body { font-family: monospace; font-size: 11px; width: 72mm; margin: 0 auto; padding: 4mm; }
      .center { text-align: center; }
      .line { border-top: 1px dashed #000; margin: 4px 0; }
      .bold { font-weight: bold; }
      .row { display: flex; justify-content: space-between; }
    </style></head>
    <body>${receiptHtml}</body>
    </html>
  `);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); win.close(); }, 300);
}

export function formatReceiptHtml(data: {
  storeName: string; storeAddress: string; orderNumber: string;
  items: Array<{ name: string; qty: number; price: number; total: number }>;
  subtotal: number; discount: number; total: number; change: number;
  paymentMethod: string; date: string;
}): string {
  const itemsHtml = data.items.map(i => `
    <div class="row">
      <span>${i.name} x${i.qty}</span>
      <span>${i.total.toLocaleString("vi-VN")}</span>
    </div>
  `).join("");

  return `
    <div class="center bold">${data.storeName}</div>
    <div class="center">${data.storeAddress}</div>
    <div class="center">${data.orderNumber}</div>
    <div class="line"></div>
    ${itemsHtml}
    <div class="line"></div>
    <div class="row"><span>Tam tinh</span><span>${data.subtotal.toLocaleString("vi-VN")} d</span></div>
    ${data.discount > 0 ? `<div class="row"><span>Giam gia</span><span>-${data.discount.toLocaleString("vi-VN")} d</span></div>` : ""}
    <div class="row bold"><span>TONG</span><span>${data.total.toLocaleString("vi-VN")} d</span></div>
    ${data.change > 0 ? `<div class="row"><span>Tien thoi</span><span>${data.change.toLocaleString("vi-VN")} d</span></div>` : ""}
    <div class="row"><span>Thanh toan</span><span>${data.paymentMethod === "cash" ? "Tien mat" : data.paymentMethod}</span></div>
    <div class="line"></div>
    <div class="center">${data.date}</div>
    <div class="center">Cam on quy khach!</div>
  `;
}

// ESC/POS raw command generation for network/USB printers
export function generateEscPosCommands(data: {
  items: Array<{ name: string; qty: number; price: number }>;
  total: number; orderNumber: string;
  storeName?: string; storeAddress?: string;
}): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  // Initialize printer
  parts.push(new Uint8Array([0x1B, 0x40])); // ESC @

  // Center alignment
  parts.push(new Uint8Array([0x1B, 0x61, 0x01])); // ESC a 1
  parts.push(encoder.encode(`${data.storeName || RECEIPT_STORE.name}\n`));
  parts.push(encoder.encode(`${data.storeAddress || RECEIPT_STORE.address}\n`));
  parts.push(encoder.encode(`${data.orderNumber}\n`));
  parts.push(new Uint8Array([0x1B, 0x61, 0x00])); // ESC a 0 (left)

  parts.push(encoder.encode("------------------------------\n"));

  for (const item of data.items) {
    parts.push(encoder.encode(
      `${item.name}\n  ${item.qty} x ${item.price.toLocaleString("vi-VN")}\n`,
    ));
  }

  parts.push(encoder.encode("------------------------------\n"));
  parts.push(new Uint8Array([0x1B, 0x45, 0x01])); // ESC E 1 (bold)
  parts.push(encoder.encode(`TOTAL: ${data.total.toLocaleString("vi-VN")} VND\n`));
  parts.push(new Uint8Array([0x1B, 0x45, 0x00])); // ESC E 0
  parts.push(encoder.encode("\n\n\n"));
  parts.push(new Uint8Array([0x1D, 0x56, 0x00])); // GS V 0 (cut)

  // Concatenate all parts
  const totalLength = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
