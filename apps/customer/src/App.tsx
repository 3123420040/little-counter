import { Routes, Route } from "react-router-dom";
import { ProductQrRoute } from "./routes/ProductQrRoute";
import { CartRoute } from "./routes/CartRoute";
import { ReadyRoute } from "./routes/ReadyRoute";
import { EntryRoute } from "./routes/EntryRoute";
import { FeatureUnavailable } from "./routes/FeatureUnavailable";

export default function App() {
  return (
    <Routes>
      {/* Public customer Scan & Go. The shelf QR encodes a product identity URL. */}
      <Route path="/s/:merchantSlug/:storeSlug/p/:qrSlug" element={<ProductQrRoute />} />
      <Route path="/s/:merchantSlug/:storeSlug/cart" element={<CartRoute />} />
      <Route path="/s/:merchantSlug/:storeSlug/ready" element={<ReadyRoute />} />
      <Route path="/s/:merchantSlug/:storeSlug" element={<EntryRoute />} />
      <Route path="*" element={<FeatureUnavailable />} />
    </Routes>
  );
}
