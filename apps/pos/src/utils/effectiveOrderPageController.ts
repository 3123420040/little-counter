import type { EffectiveOrderPageStateV2 } from "./effectiveOrderPageState";
import {
  createEffectiveOrderPageStateV2,
  reduceEffectiveOrderPageStateV2,
} from "./effectiveOrderPageState";
import {
  createEffectiveOrderPageQueryTaskV2,
  type EffectiveOrderPageQueryAdapterDependenciesV2,
  type EffectiveOrderPageQueryInputV2,
  type EffectiveOrderPageQueryTaskV2,
} from "./effectiveOrderPageQueryAdapter";

export const EFFECTIVE_ORDER_PAGE_CONTROLLER_DEFAULT_CONFIG_V2 = Object.freeze({
  enabled: false,
});

export type EffectiveOrderPageControllerErrorCodeV2 =
  | "busy"
  | "not_ready"
  | "not_retryable"
  | "refresh_not_required"
  | "request_id_unavailable"
  | "request_id_reused";

export class EffectiveOrderPageControllerErrorV2 extends Error {
  constructor(
    readonly code: EffectiveOrderPageControllerErrorCodeV2,
    message: string,
  ) {
    super(message);
    this.name = "EffectiveOrderPageControllerErrorV2";
  }
}

export interface EffectiveOrderPageControllerDependenciesV2 {
  transport: EffectiveOrderPageQueryAdapterDependenciesV2["transport"];
  nextRequestId?: () => string;
  config?: {
    enabled: boolean;
  };
}

export type EffectiveOrderPageControllerFirstInputV2 = Omit<
  EffectiveOrderPageQueryInputV2,
  "requestId" | "mode" | "cursor"
>;

interface QueryContextV2 {
  scope: EffectiveOrderPageControllerFirstInputV2["scope"];
  filters: EffectiveOrderPageControllerFirstInputV2["filters"];
  limit?: number;
}

export interface EffectiveOrderPageControllerV2 {
  getState(): EffectiveOrderPageStateV2;
  loadFirst(input: EffectiveOrderPageControllerFirstInputV2): Promise<EffectiveOrderPageStateV2>;
  loadNext(nowEpochSeconds: number): Promise<EffectiveOrderPageStateV2>;
  retryNext(nowEpochSeconds: number): Promise<EffectiveOrderPageStateV2>;
  refreshFromStart(nowEpochSeconds: number): Promise<EffectiveOrderPageStateV2>;
  disable(): EffectiveOrderPageStateV2;
}

function cloneState(state: EffectiveOrderPageStateV2): EffectiveOrderPageStateV2 {
  return structuredClone(state);
}

function cloneContext(input: EffectiveOrderPageControllerFirstInputV2): QueryContextV2 {
  return {
    scope: {
      ...input.scope,
      storeIds: [...input.scope.storeIds],
    },
    filters: {
      ...(input.filters.search === undefined ? {} : { search: input.filters.search }),
      statusMode: input.filters.statusMode,
      storeWindows: input.filters.storeWindows.map((window) => ({ ...window })),
    },
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

export function createEffectiveOrderPageControllerV2(
  dependencies: EffectiveOrderPageControllerDependenciesV2,
): EffectiveOrderPageControllerV2 {
  const enabled = dependencies.config?.enabled === true;
  if (enabled && typeof dependencies.nextRequestId !== "function") {
    throw new EffectiveOrderPageControllerErrorV2(
      "request_id_unavailable",
      "Effective-order controller request ID generator is unavailable",
    );
  }

  let capabilityEnabled = enabled;
  let state = createEffectiveOrderPageStateV2({ enabled });
  let context: QueryContextV2 | null = null;
  const usedRequestIds = new Set<string>();

  function issueRequestId(): string {
    const requestId = dependencies.nextRequestId?.();
    if (typeof requestId !== "string" || !requestId || requestId.trim() !== requestId) {
      throw new EffectiveOrderPageControllerErrorV2(
        "request_id_unavailable",
        "Effective-order controller request ID is invalid",
      );
    }
    if (usedRequestIds.has(requestId)) {
      throw new EffectiveOrderPageControllerErrorV2(
        "request_id_reused",
        "Effective-order controller request ID was reused",
      );
    }
    usedRequestIds.add(requestId);
    return requestId;
  }

  function createTask(input: EffectiveOrderPageQueryInputV2): EffectiveOrderPageQueryTaskV2 {
    return createEffectiveOrderPageQueryTaskV2({
      config: { enabled: true },
      transport: dependencies.transport,
    }, input);
  }

  async function runTask(task: EffectiveOrderPageQueryTaskV2): Promise<EffectiveOrderPageStateV2> {
    if (!task.enabled) {
      state = reduceEffectiveOrderPageStateV2(state, task.initialEvent);
      return cloneState(state);
    }
    state = reduceEffectiveOrderPageStateV2(state, task.initialEvent);
    const settled = await task.execute();
    state = reduceEffectiveOrderPageStateV2(state, settled);
    return cloneState(state);
  }

  function nextTask(nowEpochSeconds: number): EffectiveOrderPageQueryTaskV2 {
    if (state.activeRequest) {
      throw new EffectiveOrderPageControllerErrorV2(
        "busy",
        "An effective-order page request is already active",
      );
    }
    if (!context || !state.hasMore || !state.nextCursor || state.rows.length === 0) {
      throw new EffectiveOrderPageControllerErrorV2(
        "not_ready",
        "The effective-order controller has no next page",
      );
    }
    return createTask({
      requestId: issueRequestId(),
      mode: "next",
      scope: context.scope,
      filters: context.filters,
      ...(context.limit === undefined ? {} : { limit: context.limit }),
      cursor: state.nextCursor,
      nowEpochSeconds,
    });
  }

  async function loadFirst(
    input: EffectiveOrderPageControllerFirstInputV2,
  ): Promise<EffectiveOrderPageStateV2> {
    if (!capabilityEnabled) return cloneState(state);
    const task = createTask({
      ...input,
      requestId: issueRequestId(),
      mode: "first",
    });
    context = cloneContext(input);
    return runTask(task);
  }

  return {
    getState: () => cloneState(state),
    loadFirst,

    async loadNext(nowEpochSeconds) {
      if (!capabilityEnabled) return cloneState(state);
      if (state.status !== "ready") {
        throw new EffectiveOrderPageControllerErrorV2(
          state.activeRequest ? "busy" : "not_ready",
          "The effective-order controller is not ready for the next page",
        );
      }
      return runTask(nextTask(nowEpochSeconds));
    },

    async retryNext(nowEpochSeconds) {
      if (!capabilityEnabled) return cloneState(state);
      if (state.status !== "error" || state.rows.length === 0 || !state.hasMore) {
        throw new EffectiveOrderPageControllerErrorV2(
          "not_retryable",
          "The effective-order controller has no partial next page to retry",
        );
      }
      return runTask(nextTask(nowEpochSeconds));
    },

    async refreshFromStart(nowEpochSeconds) {
      if (!capabilityEnabled) return cloneState(state);
      if (state.status !== "refresh_required" || !context) {
        throw new EffectiveOrderPageControllerErrorV2(
          "refresh_not_required",
          "The effective-order controller does not require a first-page refresh",
        );
      }
      return loadFirst({
        scope: context.scope,
        filters: context.filters,
        ...(context.limit === undefined ? {} : { limit: context.limit }),
        nowEpochSeconds,
      });
    },

    disable() {
      capabilityEnabled = false;
      state = reduceEffectiveOrderPageStateV2(state, { type: "capability_disabled" });
      context = null;
      return cloneState(state);
    },
  };
}
