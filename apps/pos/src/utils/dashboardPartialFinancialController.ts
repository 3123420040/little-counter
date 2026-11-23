import {
  createDashboardPartialFinancialQueryTaskV1,
  type DashboardPartialFinancialQueryTaskDependenciesV1,
  type DashboardPartialFinancialQueryTaskInputV1,
  type DashboardPartialFinancialQueryTaskV1,
} from "./dashboardPartialFinancialQueryTask";
import type { DashboardPartialFinancialStateEventV1 } from "./dashboardPartialFinancialState";

export const DASHBOARD_PARTIAL_FINANCIAL_CONTROLLER_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
});

type CreateQueryTaskV1 = (
  dependencies: DashboardPartialFinancialQueryTaskDependenciesV1,
  input: DashboardPartialFinancialQueryTaskInputV1,
) => DashboardPartialFinancialQueryTaskV1;

export interface DashboardPartialFinancialLoadControllerDependenciesV1 {
  transport: DashboardPartialFinancialQueryTaskDependenciesV1["transport"];
  present?: DashboardPartialFinancialQueryTaskDependenciesV1["present"];
  createTask?: CreateQueryTaskV1;
  config?: {
    enabled: boolean;
  };
}

type StartedEventV1 = Extract<
  DashboardPartialFinancialStateEventV1,
  { type: "request_started" }
>;
type SettledEventV1 = Extract<
  DashboardPartialFinancialStateEventV1,
  { type: "request_succeeded" | "request_failed" }
>;

export type DashboardPartialFinancialLoadControllerV1 =
  | { enabled: false; status: "disabled" }
  | {
      enabled: true;
      selectionKey: string;
      initialEvent: StartedEventV1;
      execute: () => Promise<SettledEventV1>;
    };

function failedEvent(selectionKey: string, requestId: string): SettledEventV1 {
  return {
    type: "request_failed",
    selectionKey,
    requestId,
    message: "Không thể tải tổng quan tài chính",
  };
}

export function createDashboardPartialFinancialLoadControllerV1(
  dependencies: DashboardPartialFinancialLoadControllerDependenciesV1,
  input: DashboardPartialFinancialQueryTaskInputV1,
): DashboardPartialFinancialLoadControllerV1 {
  if (dependencies.config?.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  const createTask = dependencies.createTask ?? createDashboardPartialFinancialQueryTaskV1;
  const task = createTask({
    transport: dependencies.transport,
    ...(dependencies.present ? { present: dependencies.present } : {}),
    config: { enabled: true },
  }, input);
  if (!task.enabled) return { enabled: false, status: "disabled" };
  const selectionKey = task.requestKey;
  const requestId = input.requestId;

  return {
    enabled: true,
    selectionKey,
    initialEvent: {
      type: "request_started",
      selectionKey,
      requestId,
    },
    execute: async () => {
      try {
        const result = await task.execute();
        if (result.requestId !== requestId || result.kind === "failed") {
          return failedEvent(selectionKey, requestId);
        }
        return {
          type: "request_succeeded",
          selectionKey,
          requestId,
          context: result.context,
          presentation: result.presentation,
        };
      } catch {
        return failedEvent(selectionKey, requestId);
      }
    },
  };
}
