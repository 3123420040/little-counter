import { Lock } from "lucide-react";
import { ScreenState } from "../components/ScreenState";

export function FeatureUnavailable() {
  return (
    <div className="sd-stage">
      <ScreenState
        icon={<Lock className="h-7 w-7" strokeWidth={2.5} />}
        title="Scan & Go isn't on here"
        body="This shop hasn't turned on self-scan yet. Ask staff at the counter and they'll sort you out."
      />
    </div>
  );
}
