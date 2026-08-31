// src/trading/hooks/useTradeEngineStore.ts

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSharedTradeEngine } from "../engine/TradeEngineRuntime";
import type { TradeDirection, TradeObject } from "../engine/TradeTypes";
import { getSharedExecutionGateway } from "../execution/ExecutionGateway";
import type { ExecutionMode } from "../execution/router/ExecutionModeRuntime";
import type { TradeExecutionSnapshot } from "../services/execution/TradeExecutionTypes";
import { calculateQuickOrderEstimate } from "../../components/chart/right-panel/workspaces/trading/OrderCalculator";
import { getSharedPositionProtectionEngine } from "../position/PositionProtectionEngine";
import {
  getPositionLevelIntent,
  setPositionLevelIntent,
  subscribePositionLevelIntents,
} from "../position/PositionLevelIntentStore";
import {
  convertPositionToExtendedProtection,
  fetchAutoTradeStatus,
  requestOvernightProtectedPositionAction,
  updateOvernightProtectedOrderPrice,
  type AutoTradeStatus,
} from "../../services/api";
import type {
  CurrentPositionState,
  CurrentPositionStats,
  JournalTradeState,
  OpenOrderState,
  QuickOrderState,
  TradePlanState,
  TradePlanStats,
} from "../../components/chart/right-panel/workspaces/trading/TradingTypes";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value: unknown): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

function nullableNumber(value: unknown): number | null {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

type PositionStage = "flat" | "working" | "live";
type PositionProtectionOwner = "alpaca" | "server" | null;

type ManagedOrderPreview = {
  position: CurrentPositionState;
  status: string;
  protectionOwner: Exclude<PositionProtectionOwner, null>;
  trailEnabled?: boolean;
};

function positiveNumber(value: unknown): number {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : 0;
}

function phaseDisplayStatus(phase: string): string {
  switch (phase) {
    case "queued":
      return "QUEUED";
    case "entry_submitted":
      return "ACCEPTED";
    case "entry_cancel_requested":
      return "CANCELING";
    case "active_synthetic":
      return "ACTIVE";
    case "exit_submitted":
      return "EXITING";
    default:
      return phase ? phase.replaceAll("_", " ").toUpperCase() : "WORKING";
  }
}

function sharesFromAutoPayload(payload: Record<string, unknown>, entry: number): number {
  const directShares = Math.floor(
    positiveNumber(
      payload.filled_qty ?? payload.qty ?? payload.fixed_shares,
    ),
  );

  if (directShares > 0) return directShares;

  const tradeAmount = positiveNumber(payload.trade_amount);
  return entry > 0 && tradeAmount > 0
    ? Math.max(0, Math.floor(tradeAmount / entry))
    : 0;
}

function buildAutoManagedOrder(
  status: AutoTradeStatus | null,
  symbol: string,
): ManagedOrderPreview | null {
  if (!status || !symbol || symbol === "—") return null;

  const runner = status.runner_states?.[symbol];
  if (runner && typeof runner === "object") {
    const payload = runner as Record<string, unknown>;
    const strategyId = String(payload.strategy_id ?? "");
    const entry = positiveNumber(payload.entry_price);
    const stop = positiveNumber(payload.stop_price);
    const target = positiveNumber(payload.target_price);

    if (
      ["overnight_protected_order", "overnite_hail_mary"].includes(strategyId) &&
      entry > 0 &&
      stop > 0 &&
      target > 0
    ) {
      return {
        position: {
          symbol,
          side: "long",
          shares: sharesFromAutoPayload(payload, entry),
          entry,
          stop,
          target,
        },
        status: phaseDisplayStatus(String(payload.phase ?? "working")),
        protectionOwner: "server",
        trailEnabled: Boolean(payload.trail_enabled),
      };
    }
  }

  const plans = status.queued_manual_plans ?? status.manual_trade_plans ?? [];
  for (const item of plans) {
    const record = item && typeof item === "object"
      ? (item as Record<string, unknown>)
      : {};
    const rawPayload = record.payload;
    const payload = rawPayload && typeof rawPayload === "object"
      ? (rawPayload as Record<string, unknown>)
      : record;
    const planSymbol = String(record.symbol ?? payload.symbol ?? "")
      .trim()
      .toUpperCase();
    const strategyId = String(
      record.strategy_id ?? payload.strategy_id ?? "",
    );

    if (
      planSymbol !== symbol ||
      !["overnight_protected_order", "overnite_hail_mary"].includes(strategyId)
    ) {
      continue;
    }

    const entry = positiveNumber(payload.entry_price);
    const stop = positiveNumber(payload.stop_price);
    const target = positiveNumber(payload.target_price);
    if (entry <= 0 || stop <= 0 || target <= 0) continue;

    return {
      position: {
        symbol,
        side: "long",
        shares: sharesFromAutoPayload(payload, entry),
        entry,
        stop,
        target,
      },
      status: "QUEUED",
      protectionOwner: "server",
      trailEnabled: false,
    };
  }

  return null;
}

function collectAlpacaOrderIds(order: unknown): string[] {
  if (!order || typeof order !== "object") return [];

  const record = order as Record<string, unknown>;
  const ids = new Set<string>();

  for (const candidate of [record.id, record.order_id, record.orderId]) {
    const value = String(candidate ?? "").trim();
    if (value) ids.add(value);
  }

  const legs = Array.isArray(record.legs) ? record.legs : [];

  for (const leg of legs) {
    for (const id of collectAlpacaOrderIds(leg)) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

function mergeOrderIds(
  existing: string[] | undefined,
  order: unknown,
): string[] {
  return Array.from(
    new Set([
      ...(existing ?? []),
      ...collectAlpacaOrderIds(order),
    ]),
  );
}

function resolveBracketLegOrderId(
  orders: unknown[],
  symbol: string,
  level: "stop" | "target",
): string | null {
  const safeSymbol = String(symbol ?? "").trim().toUpperCase();
  const terminal = new Set([
    "filled",
    "canceled",
    "cancelled",
    "expired",
    "replaced",
    "rejected",
    "done_for_day",
  ]);
  let resolved: string | null = null;

  const visit = (value: unknown, inheritedSymbol = "", nested = false) => {
    if (resolved || !value || typeof value !== "object") return;
    const order = value as Record<string, unknown>;
    const orderSymbol = String(order.symbol ?? inheritedSymbol).trim().toUpperCase();
    const status = String(order.status ?? "").trim().toLowerCase();
    const type = String(order.type ?? "").trim().toLowerCase();
    const id = String(order.id ?? order.order_id ?? "").trim();
    const stopPrice = Number(order.stop_price ?? 0);
    const limitPrice = Number(order.limit_price ?? 0);
    const active = !status || !terminal.has(status);

    if (
      nested &&
      active &&
      id &&
      orderSymbol === safeSymbol &&
      ((level === "stop" &&
        (stopPrice > 0 || type === "stop" || type === "stop_limit")) ||
        (level === "target" &&
          limitPrice > 0 &&
          type === "limit" &&
          !(stopPrice > 0)))
    ) {
      resolved = id;
      return;
    }

    const legs = Array.isArray(order.legs) ? order.legs : [];
    for (const leg of legs) {
      visit(leg, orderSymbol, true);
      if (resolved) return;
    }
  };

  for (const order of orders) {
    visit(order);
    if (resolved) break;
  }

  return resolved;
}

function getAlpacaOrderStatus(order: unknown): string {
  if (!order || typeof order !== "object") return "";

  const record = order as Record<string, unknown>;

  return String(record.status ?? "")
    .trim()
    .toLowerCase();
}

function statusAfterSuccessfulSubmit(
  order: unknown,
): "accepted" | "partially_filled" | "filled" | "rejected" {
  const status = getAlpacaOrderStatus(order);

  if (status === "partially_filled") return "partially_filled";
  if (status === "filled") return "filled";
  if (status === "rejected") return "rejected";

  // Alpaca commonly returns new, accepted, pending_new, held, or accepted_for_bidding
  // after a successful POST. All of those mean the broker has the order.
  return "accepted";
}

function emptyPosition(symbol: string): CurrentPositionState {
  return {
    symbol,
    side: "long",
    shares: 0,
    entry: 0,
    target: 0,
    stop: 0,
  };
}

function tradeToPlan(
  trade: TradeObject | null,
  symbol: string,
): TradePlanState {
  return {
    symbol,
    side: trade?.direction ?? "long",
    entry: safeNumber(trade?.entry),
    target: safeNumber(trade?.targets[0]?.price),
    stop: safeNumber(trade?.stop),
    shares: safeNumber(trade?.shares ?? trade?.metrics.estimatedShares ?? 100),
  };
}

function calculateTradePlanStats(
  plan: TradePlanState,
  currentPrice: number,
): TradePlanStats {
  const activeEntry = plan.entry > 0 ? plan.entry : currentPrice;

  const riskPerShare =
    plan.side === "long"
      ? Math.max(0, activeEntry - plan.stop)
      : Math.max(0, plan.stop - activeEntry);

  const rewardPerShare =
    plan.side === "long"
      ? Math.max(0, plan.target - activeEntry)
      : Math.max(0, activeEntry - plan.target);

  const totalRisk = riskPerShare * plan.shares;
  const totalReward = rewardPerShare * plan.shares;
  const rMultiple = totalRisk > 0 ? totalReward / totalRisk : 0;

  return {
    activeEntry: safeNumber(activeEntry),
    riskPerShare: safeNumber(riskPerShare),
    rewardPerShare: safeNumber(rewardPerShare),
    totalRisk: safeNumber(totalRisk),
    totalReward: safeNumber(totalReward),
    rMultiple: safeNumber(rMultiple),
  };
}

function calculateCurrentPositionStats(
  position: CurrentPositionState,
  currentPrice: number,
): CurrentPositionStats {
  const activeEntry = position.entry > 0 ? position.entry : currentPrice;

  const pnlPerShare =
    position.side === "long"
      ? currentPrice - activeEntry
      : activeEntry - currentPrice;

  const unrealizedPnl = pnlPerShare * position.shares;

  const riskPerShare =
    position.side === "long"
      ? Math.max(0, activeEntry - position.stop)
      : Math.max(0, position.stop - activeEntry);

  const currentR = riskPerShare > 0 ? pnlPerShare / riskPerShare : 0;

  const targetDistance =
    position.side === "long"
      ? position.target - activeEntry
      : activeEntry - position.target;

  const currentDistance =
    position.side === "long"
      ? currentPrice - activeEntry
      : activeEntry - currentPrice;

  const progressToTarget =
    targetDistance > 0
      ? clamp((currentDistance / targetDistance) * 100, 0, 100)
      : 0;

  return {
    activeEntry: safeNumber(activeEntry),
    pnlPerShare: safeNumber(pnlPerShare),
    unrealizedPnl: safeNumber(unrealizedPnl),
    riskPerShare: safeNumber(riskPerShare),
    currentR: safeNumber(currentR),
    progressToTarget: safeNumber(progressToTarget),
  };
}

function findPositionForSymbol(
  positions: CurrentPositionState[],
  symbol: string,
): CurrentPositionState {
  const safeSymbol = symbol.trim().toUpperCase();

  return (
    positions.find((position) => position.symbol === safeSymbol) ??
    emptyPosition(safeSymbol)
  );
}

export function useTradeEngineStore(symbol: string, currentPrice: number) {
  const safeSymbol = (symbol || "—").trim().toUpperCase();
  const tradeEngine = getSharedTradeEngine();
  const executionService = getSharedExecutionGateway();
  const protectionEngine = getSharedPositionProtectionEngine();

  const [selectedTrade, setSelectedTrade] = useState<TradeObject | null>(() =>
    tradeEngine.getSelectedTrade(),
  );

  const [tradePlanDraft, setTradePlanDraft] = useState<TradePlanState>(() =>
    tradeToPlan(tradeEngine.getSelectedTrade(), safeSymbol),
  );

  const [executionSnapshot, setExecutionSnapshot] =
    useState<TradeExecutionSnapshot>(() => executionService.getSnapshot());
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() =>
    executionService.getMode(),
  );

  const [quickOrder, setQuickOrder] = useState<QuickOrderState>({
    symbol: safeSymbol,
    side: "buy",
    sizingMode: "dollars",
    shares: 100,
    dollars: 1000,
    orderType: "market",
    limitPrice: 0,
    stopPrice: 0,
    extendedHours: false,
    bracketEnabled: true,
    bracketTarget: 0,
    bracketStop: 0,
  });

  const [positionDraft, setPositionDraft] = useState<CurrentPositionState>(() =>
    emptyPosition(safeSymbol),
  );
  const [positionLevelIntentRevision, setPositionLevelIntentRevision] =
    useState(0);

  const [autoTradeStatus, setAutoTradeStatus] =
    useState<AutoTradeStatus | null>(null);
  const [extendedProtectionLoading, setExtendedProtectionLoading] =
    useState(false);

  const [journalTrades] = useState<JournalTradeState[]>([]);

  useEffect(() => {
    const applyTradeToStore = (nextTrade: TradeObject | null) => {
      setSelectedTrade(nextTrade);

      if (!nextTrade) {
        setTradePlanDraft((current) => ({
          ...current,
          symbol: safeSymbol,
        }));
        return;
      }

      if (nextTrade.symbol.trim().toUpperCase() !== safeSymbol) {
        return;
      }

      setTradePlanDraft((current) => ({
        ...current,
        symbol: safeSymbol,
        side: nextTrade.direction,
        entry:
          nextTrade.entry != null
            ? safeNumber(nextTrade.entry)
            : current.entry,
        stop:
          nextTrade.stop != null
            ? safeNumber(nextTrade.stop)
            : current.stop,
        target:
          nextTrade.targets[0]?.price != null
            ? safeNumber(nextTrade.targets[0]?.price)
            : current.target,
        shares:
          nextTrade.shares != null
            ? safeNumber(nextTrade.shares)
            : current.shares,
      }));
    };

    applyTradeToStore(tradeEngine.getSelectedTrade());

    return tradeEngine.events.subscribe((event) => {
      if (
        event.type === "trade-created" ||
        event.type === "trade-updated" ||
        event.type === "trade-selected" ||
        event.type === "trade-status-changed"
      ) {
        applyTradeToStore(event.trade ?? null);
        return;
      }

      if (event.type === "trade-deleted") {
        const selected = tradeEngine.getSelectedTrade();
        applyTradeToStore(selected);
        return;
      }

      if (event.type === "registry-reset") {
        applyTradeToStore(null);
      }
    });
  }, [safeSymbol, tradeEngine]);

  useEffect(() => {
    const unsubscribe = executionService.subscribe((snapshot) => {
      setExecutionSnapshot(snapshot);
      setExecutionMode(executionService.getMode());
    });
    executionService.startPolling(8000);

    return () => {
      unsubscribe();
    };
  }, [executionService]);

  useEffect(() =>
    subscribePositionLevelIntents(() => {
      setPositionLevelIntentRevision((revision) => revision + 1);
    }),
  []);

  useEffect(() => {
    let active = true;

    const refreshAutoTradeStatus = async () => {
      try {
        const nextStatus = await fetchAutoTradeStatus();
        if (active) setAutoTradeStatus(nextStatus);
      } catch {
        // Keep the last known worker state during a temporary API failure.
      }
    };

    void refreshAutoTradeStatus();
    const timer = window.setInterval(
      () => void refreshAutoTradeStatus(),
      5000,
    );

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setQuickOrder((current) => ({
      ...current,
      symbol: safeSymbol,
    }));

    setPositionDraft((current) => ({
      ...current,
      symbol: safeSymbol,
    }));

    setTradePlanDraft((current) => ({
      ...current,
      symbol: safeSymbol,
    }));
  }, [safeSymbol]);

  const tradePlan = tradePlanDraft;

  const openOrders = useMemo<OpenOrderState[]>(
    () =>
      executionSnapshot.openOrders.filter(
        (order) => order.symbol === safeSymbol || safeSymbol === "—",
      ),
    [executionSnapshot.openOrders, safeSymbol],
  );

  const livePosition = useMemo(
    () => findPositionForSymbol(executionSnapshot.positions, safeSymbol),
    [executionSnapshot.positions, safeSymbol],
  );

  const autoManagedOrder = useMemo(
    () => buildAutoManagedOrder(autoTradeStatus, safeSymbol),
    [autoTradeStatus, safeSymbol],
  );

  const brokerWorkingOrder = useMemo(() => {
    if (openOrders.length === 0) return null;

    const linkedOrderIds = new Set(selectedTrade?.links.alpacaOrderIds ?? []);
    const linked = openOrders.find((order) => linkedOrderIds.has(order.id));
    if (linked) return linked;

    const protectedOrder = openOrders.find(
      (order) =>
        order.type === "bracket" ||
        (order.stopPrice ?? 0) > 0 ||
        (order.targetPrice ?? 0) > 0,
    );

    return protectedOrder ?? openOrders[0] ?? null;
  }, [openOrders, selectedTrade?.links.alpacaOrderIds]);

  const brokerManagedOrder = useMemo<ManagedOrderPreview | null>(() => {
    if (!brokerWorkingOrder) return null;

    const fallbackEntry =
      positiveNumber(selectedTrade?.entry) ||
      positiveNumber(tradePlan.entry) ||
      positiveNumber(currentPrice);
    const entry = positiveNumber(brokerWorkingOrder.limitPrice) || fallbackEntry;
    const stop =
      positiveNumber(brokerWorkingOrder.stopPrice) ||
      positiveNumber(selectedTrade?.stop) ||
      positiveNumber(tradePlan.stop);
    const target =
      positiveNumber(brokerWorkingOrder.targetPrice) ||
      positiveNumber(selectedTrade?.targets[0]?.price) ||
      positiveNumber(tradePlan.target);
    const shares =
      positiveNumber(brokerWorkingOrder.shares) ||
      positiveNumber(selectedTrade?.shares) ||
      positiveNumber(tradePlan.shares);

    return {
      position: {
        symbol: safeSymbol,
        side: brokerWorkingOrder.side === "sell" ? "short" : "long",
        shares,
        entry,
        stop,
        target,
      },
      status: String(brokerWorkingOrder.status || "working").toUpperCase(),
      protectionOwner: "alpaca",
    };
  }, [
    brokerWorkingOrder,
    currentPrice,
    safeSymbol,
    selectedTrade?.entry,
    selectedTrade?.shares,
    selectedTrade?.stop,
    selectedTrade?.targets,
    tradePlan.entry,
    tradePlan.shares,
    tradePlan.stop,
    tradePlan.target,
  ]);

  const workingManagedOrder = autoManagedOrder ?? brokerManagedOrder;

  const positionProtection = useMemo(() => {
    if (livePosition.shares <= 0) return null;

    const managedStop =
      autoManagedOrder?.position.stop ?? positionDraft.stop;
    const managedTarget =
      autoManagedOrder?.position.target ?? positionDraft.target;

    return protectionEngine.buildProtection(
      {
        ...livePosition,
        stop: managedStop,
        target: managedTarget,
      },
      executionSnapshot.openOrders,
    );
  }, [
    autoManagedOrder?.position.stop,
    autoManagedOrder?.position.target,
    executionSnapshot.openOrders,
    livePosition,
    positionDraft.stop,
    positionDraft.target,
    protectionEngine,
  ]);

  const currentPosition = useMemo<CurrentPositionState>(() => {
    // Chart drags are broker replacement operations. Alpaca can briefly publish
    // the old child-leg price while the replacement is propagating, so the
    // most recently accepted chart level wins during that short window.
    // Reading the revision makes this memo react immediately to a chart move.
    void positionLevelIntentRevision;
    const intendedStop = getPositionLevelIntent(safeSymbol, "stop");
    const intendedTarget = getPositionLevelIntent(safeSymbol, "target");

    const applyLevelIntent = (
      position: CurrentPositionState,
    ): CurrentPositionState => ({
      ...position,
      stop: intendedStop ?? position.stop,
      target: intendedTarget ?? position.target,
    });

    if (livePosition.shares > 0 && positionProtection) {
      return applyLevelIntent(positionProtection.position);
    }

    if (livePosition.shares > 0) {
      return applyLevelIntent({
        ...livePosition,
        stop: autoManagedOrder?.position.stop ?? positionDraft.stop,
        target: autoManagedOrder?.position.target ?? positionDraft.target,
      });
    }

    if (workingManagedOrder) {
      return applyLevelIntent(workingManagedOrder.position);
    }

    return applyLevelIntent({
      ...positionDraft,
      symbol: safeSymbol,
    });
  }, [
    autoManagedOrder?.position.stop,
    autoManagedOrder?.position.target,
    livePosition,
    positionDraft,
    positionLevelIntentRevision,
    positionProtection,
    safeSymbol,
    workingManagedOrder,
  ]);

  const positionStage = useMemo<PositionStage>(() => {
    if (livePosition.shares > 0) return "live";
    if (workingManagedOrder && workingManagedOrder.position.shares > 0) {
      return "working";
    }
    return "flat";
  }, [livePosition.shares, workingManagedOrder]);

  const positionProtectionOwner = useMemo<PositionProtectionOwner>(() => {
    if (autoManagedOrder) return "server";
    if (positionStage === "working") {
      return workingManagedOrder?.protectionOwner ?? null;
    }
    if (positionStage === "live" && positionProtection) return "alpaca";
    return null;
  }, [
    autoManagedOrder,
    positionProtection,
    positionStage,
    workingManagedOrder?.protectionOwner,
  ]);

  const workingOrderStatus =
    positionStage === "working" ? workingManagedOrder?.status ?? "WORKING" : null;

  const serverTrailEnabled = Boolean(
    positionProtectionOwner === "server" && autoManagedOrder?.trailEnabled,
  );

  const updateTradePlan = useCallback(
    (patch: Partial<TradePlanState>) => {
      setTradePlanDraft((currentPlan) => {
        const nextPlan: TradePlanState = {
          ...currentPlan,
          ...patch,
          symbol: safeSymbol,
        };

        let trade = tradeEngine.getSelectedTrade();

        if (!trade) {
          trade = tradeEngine.createTrade({
            symbol: safeSymbol,
            direction: nextPlan.side as TradeDirection,
            source: "manual",
            mode: executionMode,
            status: "draft",
            entry: nullableNumber(nextPlan.entry),
            stop: nullableNumber(nextPlan.stop),
            target: nullableNumber(nextPlan.target),
            sizingMode: "shares",
            shares: nullableNumber(nextPlan.shares) ?? 100,
          });
        } else {
          const tradePatch: Parameters<typeof tradeEngine.updateTrade>[1] = {};

          if (patch.side !== undefined) {
            tradePatch.direction = nextPlan.side as TradeDirection;
          }

          if (patch.entry !== undefined) {
            tradePatch.entry = nullableNumber(nextPlan.entry);
          }

          if (patch.stop !== undefined) {
            tradePatch.stop = nullableNumber(nextPlan.stop);
          }

          if (patch.shares !== undefined) {
            tradePatch.sizingMode = "shares";
            tradePatch.shares = nullableNumber(nextPlan.shares);
          }

          if (Object.keys(tradePatch).length > 0) {
            tradeEngine.updateTrade(trade.id, tradePatch);
          }

          if (patch.target !== undefined) {
            tradeEngine.updateTarget(
              trade.id,
              nullableNumber(nextPlan.target),
            );
          }
        }

        return nextPlan;
      });
    },
    [executionMode, safeSymbol, tradeEngine],
  );

  const updateQuickOrder = useCallback(
    (patch: Partial<QuickOrderState>) => {
      setQuickOrder((current) => ({
        ...current,
        ...patch,
        symbol: safeSymbol,
      }));
    },
    [safeSymbol],
  );

  const updateCurrentPosition = useCallback(
    (patch: Partial<CurrentPositionState>) => {
      setPositionDraft((current) => ({
        ...current,
        ...patch,
        symbol: safeSymbol,
      }));

      const commitLiveLevel = async (
        level: "stop" | "target",
        price: number,
        orderId: string,
      ): Promise<void> => {
        const updatedOrder = await executionService.modifyOrder(
          orderId,
          level === "stop"
            ? { stop_price: price }
            : { limit_price: price },
        );

        if (!updatedOrder) {
          executionService.queueRefresh();
          return;
        }

        setPositionLevelIntent(safeSymbol, level, price);

        const selected = tradeEngine.getSelectedTrade();
        const activeTrade =
          selected &&
          selected.symbol.trim().toUpperCase() === safeSymbol &&
          !["closed", "cancelled", "rejected"].includes(selected.status)
            ? selected
            : tradeEngine
                .getTrades()
                .filter(
                  (trade) =>
                    trade.symbol.trim().toUpperCase() === safeSymbol &&
                    !["closed", "cancelled", "rejected"].includes(
                      trade.status,
                    ),
                )
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
              null;

        if (activeTrade) {
          if (level === "stop") {
            tradeEngine.updateStop(activeTrade.id, price);
          } else {
            tradeEngine.updateTarget(activeTrade.id, price);
          }

          const latestTrade =
            tradeEngine.getTrade(activeTrade.id) ?? activeTrade;

          tradeEngine.updateTrade(activeTrade.id, {
            status: "managing",
            links: {
              ...latestTrade.links,
              alpacaOrderIds: Array.from(
                new Set([
                  ...(latestTrade.links.alpacaOrderIds ?? []),
                  orderId,
                ]),
              ),
            },
          });

          if (tradeEngine.getSelectedTradeId() !== activeTrade.id) {
            tradeEngine.selectTrade(activeTrade.id);
          }
        }

        executionService.queueRefresh();
      };

      if (
        patch.stop !== undefined &&
        patch.stop > 0 &&
        positionProtection?.stopOrderId
      ) {
        void commitLiveLevel(
          "stop",
          patch.stop,
          positionProtection.stopOrderId,
        );
      }

      if (
        patch.target !== undefined &&
        patch.target > 0 &&
        positionProtection?.targetOrderId
      ) {
        void commitLiveLevel(
          "target",
          patch.target,
          positionProtection.targetOrderId,
        );
      }
    },
    [
      executionService,
      positionProtection,
      safeSymbol,
      tradeEngine,
    ],
  );

  const syncPlanToOrder = useCallback(() => {
    setQuickOrder((current) => ({
      ...current,
      symbol: safeSymbol,
      side: tradePlan.side === "long" ? "buy" : "sell",
      sizingMode: "shares",
      shares: tradePlan.shares,
      bracketEnabled: true,
      bracketTarget: tradePlan.target,
      bracketStop: tradePlan.stop,
      limitPrice: tradePlan.entry,
      orderType: tradePlan.entry > 0 ? "limit" : "market",
    }));
  }, [safeSymbol, tradePlan]);

  const syncPlanToPosition = useCallback(() => {
    setPositionDraft({
      symbol: safeSymbol,
      side: tradePlan.side,
      shares: tradePlan.shares,
      entry: tradePlan.entry,
      target: tradePlan.target,
      stop: tradePlan.stop,
    });
  }, [safeSymbol, tradePlan]);

  const editLiveStop = useCallback(
    async (nextStop: number) => {
      if (!Number.isFinite(nextStop) || nextStop <= 0) return;

      if (positionProtectionOwner === "server") {
        const nextStatus = await updateOvernightProtectedOrderPrice(
          safeSymbol,
          "stop",
          nextStop,
        );
        setAutoTradeStatus(nextStatus);
        setPositionDraft((current) => ({ ...current, stop: nextStop }));
        setPositionLevelIntent(safeSymbol, "stop", nextStop);
        executionService.queueRefresh();
        return;
      }

      const stopOrderId =
        resolveBracketLegOrderId(
          [
            ...executionSnapshot.rawOpenOrders,
            ...executionSnapshot.rawClosedOrders,
          ],
          safeSymbol,
          "stop",
        ) ?? positionProtection?.stopOrderId;

      if (!stopOrderId) return;

      const updatedOrder = await executionService.modifyOrder(stopOrderId, {
        stop_price: nextStop,
      });
      if (!updatedOrder) {
        executionService.queueRefresh();
        return;
      }

      setPositionDraft((current) => ({ ...current, stop: nextStop }));
      setPositionLevelIntent(safeSymbol, "stop", nextStop);
      const selected = tradeEngine.getSelectedTrade();
      if (
        selected &&
        selected.symbol.trim().toUpperCase() === safeSymbol &&
        !["closed", "cancelled", "rejected"].includes(selected.status)
      ) {
        tradeEngine.updateStop(selected.id, nextStop);
      }
      executionService.queueRefresh();
    },
    [
      executionService,
      executionSnapshot.rawClosedOrders,
      executionSnapshot.rawOpenOrders,
      positionProtection?.stopOrderId,
      positionProtectionOwner,
      safeSymbol,
      tradeEngine,
    ],
  );

  const moveStopToBreakEven = useCallback(async () => {
    const breakEvenPrice =
      currentPosition.entry > 0 ? currentPosition.entry : currentPrice;
    if (breakEvenPrice <= 0) return;
    await editLiveStop(breakEvenPrice);
  }, [currentPosition.entry, currentPrice, editLiveStop]);

  const toggleTrailingStop = useCallback(async () => {
    if (positionProtectionOwner !== "server" || positionStage !== "live") return;

    try {
      const nextStatus = await requestOvernightProtectedPositionAction(
        safeSymbol,
        { action: serverTrailEnabled ? "trail_stop" : "trail_start" },
      );
      setAutoTradeStatus(nextStatus);
      executionService.queueRefresh();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Could not update the protected trailing stop.",
      );
    }
  }, [
    executionService,
    positionProtectionOwner,
    positionStage,
    safeSymbol,
    serverTrailEnabled,
  ]);

  const convertToExtendedProtection = useCallback(async () => {
    if (executionMode === "practice") {
      window.alert("Convert to EXT is only available for Alpaca paper/live positions.");
      return;
    }
    if (positionStage !== "live" || currentPosition.shares <= 0) {
      window.alert(`No live ${safeSymbol} position is available to convert.`);
      return;
    }
    if (positionProtectionOwner === "server") return;
    if (currentPosition.side !== "long") {
      window.alert("Convert to EXT currently supports long positions only.");
      return;
    }
    if (currentPosition.stop <= 0 || currentPosition.target <= 0) {
      window.alert("A valid stop and target are required before converting to EXT protection.");
      return;
    }

    setExtendedProtectionLoading(true);
    try {
      const nextStatus = await convertPositionToExtendedProtection(
        safeSymbol,
        {
          stop_price: currentPosition.stop,
          target_price: currentPosition.target,
          mode: executionMode === "live" ? "live" : "paper",
        },
      );
      setAutoTradeStatus(nextStatus);
      setPositionDraft((current) => ({
        ...current,
        symbol: safeSymbol,
        shares: currentPosition.shares,
        entry: currentPosition.entry,
        stop: currentPosition.stop,
        target: currentPosition.target,
        side: currentPosition.side,
      }));
      executionService.queueRefresh(true);
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : `Could not convert ${safeSymbol} to EXT protection.`,
      );
    } finally {
      setExtendedProtectionLoading(false);
    }
  }, [
    currentPosition,
    executionMode,
    executionService,
    positionProtectionOwner,
    positionStage,
    safeSymbol,
  ]);

  const submitQuickOrder = useCallback(
    async (estimatedShares: number) => {
      if (estimatedShares <= 0) return;

      const estimate = calculateQuickOrderEstimate(
        {
          ...quickOrder,
          symbol: safeSymbol,
          shares:
            quickOrder.sizingMode === "shares"
              ? estimatedShares
              : quickOrder.shares,
        },
        currentPrice,
      );

      await executionService.submitQuickOrder(
        {
          ...quickOrder,
          symbol: safeSymbol,
        },
        {
          ...estimate,
          estimatedShares,
        },
      );
    },
    [currentPrice, executionService, quickOrder, safeSymbol],
  );

  const submitTradePlan = useCallback(async () => {
    const shares = Math.max(0, Math.floor(Number(tradePlan.shares) || 0));

    if (shares <= 0) {
      return;
    }

    let trade = tradeEngine.getSelectedTrade();

    if (!trade || trade.symbol !== safeSymbol) {
      trade = tradeEngine.createTrade({
        symbol: safeSymbol,
        direction: tradePlan.side as TradeDirection,
        source: "manual",
        mode: executionMode,
        status: "draft",
        entry: nullableNumber(tradePlan.entry),
        stop: nullableNumber(tradePlan.stop),
        target: nullableNumber(tradePlan.target),
        sizingMode: "shares",
        shares,
      });
    }

    const plannedOrder: QuickOrderState = {
      symbol: safeSymbol,
      side: tradePlan.side === "long" ? "buy" : "sell",
      sizingMode: "shares",
      shares,
      dollars: 0,
      orderType: tradePlan.entry > 0 ? "limit" : "market",
      limitPrice: tradePlan.entry,
      stopPrice: 0,
      extendedHours: false,
      bracketEnabled: tradePlan.target > 0 || tradePlan.stop > 0,
      bracketTarget: tradePlan.target,
      bracketStop: tradePlan.stop,
    };

    const estimate = calculateQuickOrderEstimate(plannedOrder, currentPrice);

    // Mark the trade submitted before the execution service queues its first
    // Alpaca refresh. Otherwise a fast refresh can promote the trade to
    // accepted, and this function can accidentally downgrade it back to
    // submitted after the API call returns.
    tradeEngine.updateTrade(trade.id, {
      status: "submitted",
      shares,
      sizingMode: "shares",
    });

    tradeEngine.selectTrade(trade.id);

    const result = await executionService.submitQuickOrder(plannedOrder, {
      ...estimate,
      estimatedShares: shares,
    });

    if (!result.ok) {
      tradeEngine.updateStatus(trade.id, "rejected");
      return;
    }

    const alpacaOrderIds = collectAlpacaOrderIds(result.order);
    const latestTrade = tradeEngine.getTrade(trade.id) ?? trade;

    const submittedStatus = statusAfterSuccessfulSubmit(result.order);

    tradeEngine.updateTrade(trade.id, {
      // The POST already succeeded and returned an Alpaca order. Publish the
      // broker-acknowledged lifecycle immediately instead of waiting for the
      // next polling refresh.
      status:
        ["accepted", "partially_filled", "filled", "managing"].includes(
          latestTrade.status,
        )
          ? latestTrade.status
          : submittedStatus,
      shares,
      sizingMode: "shares",
      links: {
        ...latestTrade.links,
        alpacaOrderIds: Array.from(
          new Set([
            ...(latestTrade.links.alpacaOrderIds ?? []),
            ...alpacaOrderIds,
          ]),
        ),
      },
    });

    tradeEngine.selectTrade(trade.id);
    executionService.queueRefresh();
  }, [
    currentPrice,
    executionMode,
    executionService,
    safeSymbol,
    tradeEngine,
    tradePlan,
  ]);

  const cancelOpenOrder = useCallback(
    async (orderId: string) => {
      const cancelled = await executionService.cancelOrder(orderId);

      if (!cancelled) {
        executionService.queueRefresh();
        return;
      }

      const hasLivePosition = livePosition.shares > 0;
      const selectedTrade = tradeEngine.getSelectedTrade();

      const linkedTrade =
        tradeEngine
          .getTrades()
          .find((trade) =>
            (trade.links.alpacaOrderIds ?? []).includes(orderId),
          ) ?? null;

      const symbolTrade =
        tradeEngine
          .getTrades()
          .filter(
            (trade) =>
              trade.symbol.trim().toUpperCase() === safeSymbol &&
              ["submitted", "accepted", "partially_filled"].includes(
                trade.status,
              ),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;

      const trade =
        linkedTrade ??
        (selectedTrade &&
        selectedTrade.symbol.trim().toUpperCase() === safeSymbol
          ? selectedTrade
          : null) ??
        symbolTrade;

      if (
        trade &&
        !hasLivePosition &&
        ["submitted", "accepted", "partially_filled"].includes(trade.status)
      ) {
        // Canceling the parent bracket order cancels the working entry and its
        // child legs together. Clear all linked Alpaca IDs so a stale child ID
        // cannot keep the trade looking active until the next refresh.
        tradeEngine.updateTrade(trade.id, {
          status: "cancelled",
          links: {
            ...trade.links,
            alpacaOrderIds: [],
          },
        });

        // Always emit a selected-trade event so the Plan Trade card receives
        // the cancelled status immediately, even when this trade was already
        // selected.
        tradeEngine.selectTrade(trade.id);
      }

      executionService.queueRefresh();
    },
    [
      executionService,
      livePosition.shares,
      safeSymbol,
      tradeEngine,
    ],
  );

  const fillOpenOrder = useCallback((_orderId: string) => {
    // Real fills come from Alpaca after the execution service refreshes.
  }, []);

  const refreshTradingData = useCallback(() => {
    executionService.queueRefresh(true);
  }, [executionService]);

  const switchTradingMode = useCallback(
    async (mode: "paper" | "live") => {
      if (mode === executionService.getMode()) return;

      await executionService.switchMode(mode);
      setExecutionMode(mode);
      await executionService.refreshAll(true);
    },
    [executionService],
  );

  const recordExitOrder = useCallback(
    (order: unknown) => {
      const trade = tradeEngine.getSelectedTrade();

      if (!trade || trade.symbol.trim().toUpperCase() !== safeSymbol) {
        executionService.queueRefresh();
        return;
      }

      tradeEngine.updateTrade(trade.id, {
        status: "managing",
        links: {
          ...trade.links,
          alpacaOrderIds: mergeOrderIds(
            trade.links.alpacaOrderIds,
            order,
          ),
        },
      });

      executionService.queueRefresh();
    },
    [executionService, safeSymbol, tradeEngine],
  );

  const closePosition = useCallback(async () => {
    if (positionProtectionOwner === "server" && positionStage === "live") {
      try {
        const nextStatus = await requestOvernightProtectedPositionAction(
          safeSymbol,
          { action: "close_all" },
        );
        setAutoTradeStatus(nextStatus);
        executionService.queueRefresh();
      } catch (error) {
        window.alert(
          error instanceof Error
            ? error.message
            : `Could not close the protected ${safeSymbol} position.`,
        );
      }
      return;
    }

    const result = await executionService.closePosition(safeSymbol, {
      extendedHours: false,
    });

    if (result.ok) {
      recordExitOrder(result.order);
    } else if (result.error) {
      window.alert(result.error);
    }
  }, [
    executionService,
    positionProtectionOwner,
    positionStage,
    recordExitOrder,
    safeSymbol,
  ]);

  const closePositionPercent = useCallback(
    async (percent: number) => {
      const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
      if (safePercent <= 0) return;

      if (positionProtectionOwner === "server" && positionStage === "live") {
        try {
          const nextStatus = await requestOvernightProtectedPositionAction(
            safeSymbol,
            safePercent >= 100
              ? { action: "close_all" }
              : { action: "scale_out", percent: safePercent },
          );
          setAutoTradeStatus(nextStatus);
          executionService.queueRefresh();
        } catch (error) {
          window.alert(
            error instanceof Error
              ? error.message
              : `Could not scale out of the protected ${safeSymbol} position.`,
          );
        }
        return;
      }

      const result = await executionService.closePositionPercent(
        safeSymbol,
        safePercent,
        {
          extendedHours: false,
        },
      );

      if (result.ok) {
        recordExitOrder(result.order);
      } else if (result.error) {
        window.alert(result.error);
      }
    },
    [
      executionService,
      positionProtectionOwner,
      positionStage,
      recordExitOrder,
      safeSymbol,
    ],
  );

  const closePositionShares = useCallback(
    async (shares: number) => {
      const result = await executionService.closePositionShares(
        safeSymbol,
        shares,
        {
          extendedHours: false,
        },
      );

      if (result.ok) {
        recordExitOrder(result.order);
      } else if (result.error) {
        window.alert(result.error);
      }
    },
    [
      executionService,
      recordExitOrder,
      safeSymbol,
    ],
  );

  const flattenAllPositions = useCallback(async () => {
    const protectedSymbols = new Set<string>();
    const protectedActions: Promise<AutoTradeStatus>[] = [];

    for (const [symbol, rawState] of Object.entries(
      autoTradeStatus?.runner_states ?? {},
    )) {
      if (!rawState || typeof rawState !== "object") continue;
      const state = rawState as Record<string, unknown>;
      const strategyId = String(state.strategy_id ?? "");
      const phase = String(state.phase ?? "");
      if (
        !["overnight_protected_order", "overnite_hail_mary"].includes(
          strategyId,
        ) ||
        !["active_synthetic", "exit_submitted"].includes(phase)
      ) {
        continue;
      }

      const normalizedSymbol = symbol.trim().toUpperCase();
      if (!normalizedSymbol) continue;
      protectedSymbols.add(normalizedSymbol);

      // If the protection worker already has an exit working, do not submit a
      // second broker close. Otherwise hand the flatten request to the worker.
      if (phase === "active_synthetic") {
        protectedActions.push(
          requestOvernightProtectedPositionAction(normalizedSymbol, {
            action: "close_all",
          }),
        );
      }
    }

    if (protectedActions.length > 0) {
      try {
        const statuses = await Promise.all(protectedActions);
        const lastStatus = statuses[statuses.length - 1];
        if (lastStatus) setAutoTradeStatus(lastStatus);
      } catch (error) {
        window.alert(
          error instanceof Error
            ? error.message
            : "One or more protected positions could not be queued for flattening.",
        );
      }
    }

    const genericPositions = executionSnapshot.positions.filter(
      (position) =>
        position.shares > 0 &&
        !protectedSymbols.has(position.symbol.trim().toUpperCase()),
    );

    for (const position of genericPositions) {
      const result = await executionService.closePositionShares(
        position.symbol,
        position.shares,
        { extendedHours: false },
      );
      if (!result.ok && result.error) {
        window.alert(result.error);
      }
    }

    executionService.queueRefresh();
  }, [
    autoTradeStatus?.runner_states,
    executionService,
    executionSnapshot.positions,
  ]);

  const tradePlanStats = useMemo(
    () => calculateTradePlanStats(tradePlan, currentPrice),
    [tradePlan, currentPrice],
  );

  const currentPositionStats = useMemo(
    () => calculateCurrentPositionStats(currentPosition, currentPrice),
    [currentPosition, currentPrice],
  );

  return useMemo(
    () => ({
      account: executionSnapshot.account,
      executionMode,
      switchTradingMode,

      tradePlan: { ...tradePlan, symbol: safeSymbol },
      tradePlanStats,
      updateTradePlan,
      syncPlanToOrder,
      syncPlanToPosition,
      submitTradePlan,

      quickOrder: { ...quickOrder, symbol: safeSymbol },
      updateQuickOrder,
      submitQuickOrder,

      currentPosition: { ...currentPosition, symbol: safeSymbol },
      currentPositionStats,
      positionProtection,
      positionStage,
      positionProtectionOwner,
      workingOrderStatus,
      serverTrailEnabled,
      updateCurrentPosition,
      editLiveStop,
      moveStopToBreakEven,
      toggleTrailingStop,
      convertToExtendedProtection,
      extendedProtectionLoading,
      closePosition,
      closePositionPercent,
      closePositionShares,
      flattenAllPositions,

      openOrders,
      cancelOpenOrder,
      fillOpenOrder,

      journalTrades,
      selectedTrade,
      hasSelectedTrade: Boolean(selectedTrade),

      connectionStatus: executionSnapshot.connectionStatus,
      executionStatus: executionSnapshot.status,
      executionAction: executionSnapshot.action,
      executionLoading: executionSnapshot.loading,
      executionError: executionSnapshot.lastError,
      executionMessage: executionSnapshot.lastMessage,
      executionRefreshCount: executionSnapshot.refreshCount,
      executionUpdatedAt: executionSnapshot.updatedAt,
      refreshTradingData,
    }),
    [
      cancelOpenOrder,
      closePosition,
      closePositionPercent,
      closePositionShares,
      currentPosition,
      currentPositionStats,
      executionSnapshot.account,
      executionSnapshot.action,
      executionSnapshot.connectionStatus,
      executionSnapshot.lastError,
      executionSnapshot.lastMessage,
      executionSnapshot.loading,
      executionSnapshot.refreshCount,
      executionSnapshot.status,
      executionSnapshot.updatedAt,
      executionMode,
      editLiveStop,
      fillOpenOrder,
      flattenAllPositions,
      journalTrades,
      moveStopToBreakEven,
      openOrders,
      positionProtection,
      positionProtectionOwner,
      positionStage,
      quickOrder,
      refreshTradingData,
      safeSymbol,
      selectedTrade,
      serverTrailEnabled,
      submitQuickOrder,
      submitTradePlan,
      syncPlanToOrder,
      syncPlanToPosition,
      switchTradingMode,
      tradePlan,
      tradePlanStats,
      toggleTrailingStop,
      convertToExtendedProtection,
      extendedProtectionLoading,
      updateCurrentPosition,
      updateQuickOrder,
      updateTradePlan,
      workingOrderStatus,
    ],
  );
}
