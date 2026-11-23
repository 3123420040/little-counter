import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function current(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/** Live prefers-reduced-motion flag. Components gate nonessential motion on this. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(current);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const handler = () => setReduced(mq.matches);
    handler();
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);
  return reduced;
}
