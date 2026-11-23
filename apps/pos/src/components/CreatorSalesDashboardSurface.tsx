import type { ComponentProps } from "react";
import type { CreatorSalesDashboardV2, CreatorSalesDashboardV3 } from "@medusa-snus/contracts";
import { buildCreatorSalesDashboardPresentation } from "../utils/creatorSalesDashboardPresentation";
import { DashboardOverviewSurface } from "./DashboardOverviewSurface";
import { OrderCreatorFilter } from "./OrderCreatorFilter";

export function CreatorSalesDashboardSurface({ dashboard, creatorOperatorIds, onCreatorOperatorIds, ...props }: {
  dashboard: CreatorSalesDashboardV2 | CreatorSalesDashboardV3 | null;
  creatorOperatorIds: readonly string[];
  onCreatorOperatorIds: (ids: string[]) => void;
} & Omit<ComponentProps<typeof DashboardOverviewSurface>, "presentation" | "filters" | "selfOnly" | "stale">) {
  return <DashboardOverviewSurface {...props}
    presentation={dashboard ? buildCreatorSalesDashboardPresentation(dashboard) : null}
    selfOnly={dashboard?.audience === "self"}
    stale={Boolean(props.error && dashboard)}
    filters={<OrderCreatorFilter options={dashboard?.creatorOptions || []} pending={!dashboard}
      selectedIds={creatorOperatorIds} selfOnly={dashboard?.audience === "self"} onChange={onCreatorOperatorIds} />}
  />;
}
