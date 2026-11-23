import { useCallback, useEffect, useRef, useState } from "react";
import { createCart, createCheckoutToken, updateCart } from "./scanGoCartClient";
import { buildCreateInput, useScanGoCart } from "./useScanGoCart";
import { REDEEMABLE_SECONDS } from "./config";
import { CheckoutError, type CheckoutTokenDto } from "./types";

/* ═══════════════════════════════════════════════════════════════════
   Checkout token / final cart QR.

   Ensures a draft cart exists, then issues a short-lived checkout token
   (the final cart QR). Runs the countdown and exposes regenerate. It only
   ever calls the public scan-go cart client — never order/payment/stock.
   ═══════════════════════════════════════════════════════════════════ */

export type CheckoutStatus = "idle" | "generating" | "ready" | "expired" | "error";

export interface UseCheckoutToken {
  status: CheckoutStatus;
  token: CheckoutTokenDto | null;
  secondsLeft: number;
  redeemableSeconds: number;
  offline: boolean;
  generate: () => Promise<void>;
  regenerate: () => Promise<void>;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

export function useCheckoutToken(merchantSlug: string, storeSlug: string): UseCheckoutToken {
  const cart = useScanGoCart(merchantSlug, storeSlug);
  const cartRef = useRef(cart);
  cartRef.current = cart;

  const [token, setToken] = useState<CheckoutTokenDto | null>(null);
  const [status, setStatus] = useState<CheckoutStatus>("idle");
  const [now, setNow] = useState<number>(() => Date.now());
  const [offline, setOffline] = useState<boolean>(() => !isOnline());

  useEffect(() => {
    setToken(null);
    setStatus("idle");
    setNow(Date.now());
  }, [merchantSlug, storeSlug]);

  // Tick the countdown once a second while a live token is showing.
  useEffect(() => {
    if (status !== "ready") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // Track connectivity for the offline state.
  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const secondsLeft =
    token === null
      ? 0
      : Math.max(0, Math.ceil((Date.parse(token.expiresAt) - now) / 1000));

  // Flip to expired exactly once.
  useEffect(() => {
    if (status === "ready" && token !== null && secondsLeft <= 0) {
      setStatus("expired");
    }
  }, [status, token, secondsLeft]);

  const issue = useCallback(async () => {
    const current = cartRef.current;
    if (current.lines.length === 0) return;
    setStatus("generating");
    if (!isOnline()) {
      setOffline(true);
      setStatus("error");
      return;
    }
    try {
      const input = buildCreateInput(current);
      let cartId = current.cartId;
      let editSecret = current.editSecret;
      if (!cartId || !editSecret) {
        const dto = await createCart(input);
        cartId = dto.cartId;
        editSecret = dto.editSecret ?? null;
        if (!editSecret) throw new Error("missing cart edit secret");
        current.setCartCredentials(cartId, editSecret);
      } else {
        try {
          await updateCart(cartId, {
            editSecret,
            lines: input.lines,
            customerNickname: input.customerNickname,
            customerContact: input.customerContact,
            contactType: input.contactType,
          });
        } catch {
          // Draft cart unknown to backend (e.g. expired server-side); recreate.
          const dto = await createCart(input);
          cartId = dto.cartId;
          editSecret = dto.editSecret ?? null;
          if (!editSecret) throw new Error("missing cart edit secret");
          current.setCartCredentials(cartId, editSecret);
        }
      }
      const next = await createCheckoutToken(cartId, editSecret);
      setNow(Date.now());
      setToken(next);
      setStatus("ready");
      current.clearCustomerInfo();
    } catch (err) {
      setStatus("error");
      if (err instanceof CheckoutError && err.code === "regenerate_failed") {
        setStatus("error");
      }
    }
  }, []);

  const generate = useCallback(async () => {
    await issue();
  }, [issue]);

  const regenerate = useCallback(async () => {
    await issue();
  }, [issue]);

  return {
    status,
    token,
    secondsLeft,
    redeemableSeconds: token?.redeemableSeconds ?? REDEEMABLE_SECONDS,
    offline,
    generate,
    regenerate,
  };
}
