import type { DashboardPartialFinancialHttpBodyV1 } from "@medusa-snus/contracts";
import type { DashboardPartialFinancialPresentationResultV1 } from "./dashboardPartialFinancialPresentation";

type ReadyPresentationV1 = Extract<
  DashboardPartialFinancialPresentationResultV1,
  { enabled: true }
>;

interface SelectionStateV1 {
  selectionKey: string;
}

export type DashboardPartialFinancialStateV1 =
  | { status: "disabled" }
  | ({ status: "idle" } & SelectionStateV1)
  | ({ status: "loading"; requestId: string } & SelectionStateV1)
  | ({
      status: "ready";
      requestId: string;
      context: DashboardPartialFinancialHttpBodyV1["context"];
      presentation: ReadyPresentationV1;
    } & SelectionStateV1)
  | ({
      status: "failed";
      requestId: string;
      message: "Không thể tải tổng quan tài chính";
    } & SelectionStateV1);

export type DashboardPartialFinancialStateEventV1 =
  | { type: "capability_disabled" }
  | { type: "selection_changed"; selectionKey: string }
  | { type: "request_started"; selectionKey: string; requestId: string }
  | {
      type: "request_succeeded";
      selectionKey: string;
      requestId: string;
      context: DashboardPartialFinancialHttpBodyV1["context"];
      presentation: ReadyPresentationV1;
    }
  | {
      type: "request_failed";
      selectionKey: string;
      requestId: string;
      message: "Không thể tải tổng quan tài chính";
    };

export class DashboardPartialFinancialStateErrorV1 extends Error {
  readonly code = "dashboard_partial_financial_state_invalid";

  constructor(message: string) {
    super(message);
    this.name = "DashboardPartialFinancialStateErrorV1";
  }
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new DashboardPartialFinancialStateErrorV1(`${field} is invalid`);
  }
  return value;
}

export function createDashboardPartialFinancialInitialStateV1(
  enabled: boolean,
  selectionKey?: string,
): DashboardPartialFinancialStateV1 {
  if (enabled !== true) return { status: "disabled" };
  return {
    status: "idle",
    selectionKey: requiredToken(selectionKey, "selectionKey"),
  };
}

export function reduceDashboardPartialFinancialStateV1(
  state: DashboardPartialFinancialStateV1,
  event: DashboardPartialFinancialStateEventV1,
): DashboardPartialFinancialStateV1 {
  if (event.type === "capability_disabled") return { status: "disabled" };
  if (state.status === "disabled") return state;
  const selectionKey = requiredToken(event.selectionKey, "selectionKey");
  if (event.type === "selection_changed") {
    if (state.selectionKey === selectionKey) return state;
    return { status: "idle", selectionKey };
  }
  if (state.selectionKey !== selectionKey) return state;
  const requestId = requiredToken(event.requestId, "requestId");
  if (event.type === "request_started") {
    return { status: "loading", selectionKey, requestId };
  }
  if (state.status !== "loading" || state.requestId !== requestId) return state;
  if (event.type === "request_failed") {
    return {
      status: "failed",
      selectionKey,
      requestId,
      message: "Không thể tải tổng quan tài chính",
    };
  }
  return {
    status: "ready",
    selectionKey,
    requestId,
    context: structuredClone(event.context),
    presentation: structuredClone(event.presentation),
  };
}
