import { useCallback, useEffect, useState } from "react";
import { AGE_ACK_STORAGE_KEY, AGE_ACK_TTL_MS } from "./config";

/* ═══════════════════════════════════════════════════════════════════
   Age-gate acknowledgement helper.

   Lightweight, session-scoped (sessionStorage), short-lived. This is an
   ACKNOWLEDGEMENT, never proof of age. No ID/passport images are ever
   collected. Staff verify age/ID at the counter.
   ═══════════════════════════════════════════════════════════════════ */

function storageKey(merchantSlug: string, storeSlug: string): string {
  return `${AGE_ACK_STORAGE_KEY}:${merchantSlug}:${storeSlug}`;
}

function readAck(merchantSlug: string, storeSlug: string): string | null {
  try {
    // window.sessionStorage so jsdom's storage is used in tests, not Node's
    // global shim; identical in real browsers.
    const iso = window.sessionStorage.getItem(storageKey(merchantSlug, storeSlug));
    if (!iso) return null;
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts) || Date.now() - ts > AGE_ACK_TTL_MS) {
      window.sessionStorage.removeItem(storageKey(merchantSlug, storeSlug));
      return null;
    }
    return iso;
  } catch {
    return null;
  }
}

/** Read the current acknowledgement timestamp (or null) without subscribing. */
export function getAgeAcknowledgedAt(merchantSlug: string, storeSlug: string): string | null {
  return readAck(merchantSlug, storeSlug);
}

export interface AgeGateState {
  acknowledged: boolean;
  ageAcknowledgedAt: string | null;
  acknowledge: () => void;
}

export function useAgeGate(merchantSlug: string, storeSlug: string): AgeGateState {
  const [ackIso, setAckIso] = useState<string | null>(() => readAck(merchantSlug, storeSlug));

  useEffect(() => {
    setAckIso(readAck(merchantSlug, storeSlug));
  }, [merchantSlug, storeSlug]);

  const acknowledge = useCallback(() => {
    const iso = new Date().toISOString();
    try {
      window.sessionStorage.setItem(storageKey(merchantSlug, storeSlug), iso);
    } catch {
      /* sessionStorage may be unavailable (private mode); proceed in-memory. */
    }
    setAckIso(iso);
  }, [merchantSlug, storeSlug]);

  return {
    acknowledged: ackIso !== null,
    ageAcknowledgedAt: ackIso,
    acknowledge,
  };
}
