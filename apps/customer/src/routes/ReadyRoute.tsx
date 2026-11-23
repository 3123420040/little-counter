import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useScanGoCart } from "../scan-go/useScanGoCart";
import { useCheckoutToken } from "../scan-go/useCheckoutToken";
import { useAgeGate } from "../scan-go/useAgeGate";
import { useScanGoFeature } from "../scan-go/featureGate";
import { cartPath } from "../scan-go/config";
import { AgeGate } from "../components/AgeGate";
import { FinalQrCard } from "../components/FinalQrCard";
import { FeatureUnavailable } from "./FeatureUnavailable";

export function ReadyRoute() {
  const { merchantSlug = "", storeSlug = "" } = useParams();
  const navigate = useNavigate();
  const { enabled } = useScanGoFeature();
  const cart = useScanGoCart(merchantSlug, storeSlug);
  const checkout = useCheckoutToken(merchantSlug, storeSlug);
  const age = useAgeGate(merchantSlug, storeSlug);
  const started = useRef(false);
  const { generate } = checkout;

  useEffect(() => {
    started.current = false;
  }, [merchantSlug, storeSlug]);

  useEffect(() => {
    if (!enabled || !age.acknowledged) return;
    if (cart.totalQuantity === 0) {
      navigate(cartPath(merchantSlug, storeSlug), { replace: true });
      return;
    }
    if (!started.current) {
      started.current = true;
      void generate();
    }
  }, [enabled, age.acknowledged, cart.totalQuantity, navigate, merchantSlug, storeSlug, generate]);

  if (!enabled) return <FeatureUnavailable />;
  if (!age.acknowledged) return <AgeGate onAcknowledge={age.acknowledge} />;
  if (cart.totalQuantity === 0) return null; // redirecting to cart

  const status =
    checkout.status === "idle" || checkout.status === "generating" ? "generating" : checkout.status;

  return (
    <div className="sd-stage sd-no-bounce">
      <FinalQrCard
        status={status}
        token={checkout.token}
        secondsLeft={checkout.secondsLeft}
        nickname={cart.customerNickname.trim() || null}
        itemCount={cart.totalQuantity}
        totalVnd={cart.totalVnd}
        offline={checkout.offline}
        onRegenerate={() => void checkout.regenerate()}
        onEdit={() => navigate(cartPath(merchantSlug, storeSlug))}
      />
    </div>
  );
}
