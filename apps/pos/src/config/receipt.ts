export const RECEIPT_STORE = {
  name: import.meta.env.VITE_STORE_NAME?.trim() || "Store",
  address: import.meta.env.VITE_STORE_ADDRESS?.trim() || "",
} as const;
