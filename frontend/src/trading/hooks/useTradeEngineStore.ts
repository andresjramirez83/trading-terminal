// src/trading/hooks/useTradeEngineStore.ts

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSharedTradeEngine } from "../engine/TradeEngineRuntime";
import type { TradeDirection, TradeObject } from "../engine/TradeTypes";
import { getSharedExecutionGateway } from "../execution/ExecutionGateway";
import type { TradeExecutionSnapshot } from "../services/execution/TradeExecutionTypes";
import { calculateQuickOrderEstimate } from "../../components/chart/right-panel/workspaces/trading/OrderCalculator";
import { getSharedPositionProtectionEngine } from "../position/PositionProtectionEngine";
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

  const [quickOrder, setQuickOrder] = useState<QuickOrderState>({
    symbol: safeSymbol,
    side: "buy",
    sizingMode: "dollars",
    shares: 100,
    dollars: 1000,
    orderType: "market",
    limitPrice: 0,
    stopPrice: 0,
    extendedHours: true,
    bracketEnabled: true,
    bracketTarget: 0,
    bracketStop: 0,
  });

  const [positionDraft, setPositionDraft] = useState<CurrentPositionState>(() =>
    emptyPosition(safeSymbol),
  );

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
    const unsubscribe = executionService.subscribe(setExecutionSnapshot);
    executionService.startPolling(8000);

    return () => {
      unsubscribe();
    };
  }, [executionService]);

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

  const livePosition = useMemo(
    () => findPositionForSymbol(executionSnapshot.positions, safeSymbol),
    [executionSnapshot.positions, safeSymbol],
  );

  const positionProtection = useMemo(() => {
    if (livePosition.shares <= 0) return null;

    return protectionEngine.buildProtection(
      {
        ...livePosition,
        stop: positionDraft.stop,
        target: positionDraft.target,
      },
      executionSnapshot.openOrders,
    );
  }, [
    executionSnapshot.openOrders,
    livePosition,
    positionDraft.stop,
    positionDraft.target,
    protectionEngine,
  ]);

  const currentPosition = useMemo<CurrentPositionState>(() => {
    if (positionProtection) {
      return positionProtection.position;
    }

    return {
      ...positionDraft,
      symbol: safeSymbol,
    };
  }, [positionDraft, positionProtection, safeSymbol]);

  const openOrders = useMemo<OpenOrderState[]>(
    () =>
      executionSnapshot.openOrders.filter(
        (order) => order.symbol === safeSymbol || safeSymbol === "—",
      ),
    [executionSnapshot.openOrders, safeSymbol],
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
            mode: "paper",
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
    [safeSymbol, tradeEngine],
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

  const moveStopToBreakEven = useCallback(async () => {
    const breakEvenPrice =
      currentPosition.entry > 0 ? currentPosition.entry : currentPrice;
    const stopOrderId = positionProtection?.stopOrderId;

    if (!stopOrderId || breakEvenPrice <= 0) return;

    const updatedOrder = await executionService.modifyOrder(stopOrderId, {
      stop_price: breakEvenPrice,
    });

    if (!updatedOrder) {
      executionService.queueRefresh();
      return;
    }

    setPositionDraft((current) => ({
      ...current,
      stop: breakEvenPrice,
    }));

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
                !["closed", "cancelled", "rejected"].includes(trade.status),
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;

    if (activeTrade) {
      tradeEngine.updateStop(activeTrade.id, breakEvenPrice);
      const latestTrade = tradeEngine.getTrade(activeTrade.id) ?? activeTrade;

      tradeEngine.updateTrade(activeTrade.id, {
        status: "managing",
        links: {
          ...latestTrade.links,
          alpacaOrderIds: Array.from(
            new Set([
              ...(latestTrade.links.alpacaOrderIds ?? []),
              stopOrderId,
            ]),
          ),
        },
      });
    }

    executionService.queueRefresh();
  }, [
    currentPosition.entry,
    currentPrice,
    executionService,
    positionProtection,
    safeSymbol,
    tradeEngine,
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
        mode: "paper",
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
    executionService.queueRefresh();
  }, [executionService]);

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
    const result = await executionService.closePosition(safeSymbol, {
      extendedHours: quickOrder.extendedHours,
    });

    if (result.ok) {
      recordExitOrder(result.order);
    }
  }, [
    executionService,
    quickOrder.extendedHours,
    recordExitOrder,
    safeSymbol,
  ]);

  const closePositionPercent = useCallback(
    async (percent: number) => {
      const result = await executionService.closePositionPercent(
        safeSymbol,
        percent,
        {
          extendedHours: quickOrder.extendedHours,
        },
      );

      if (result.ok) {
        recordExitOrder(result.order);
      }
    },
    [
      executionService,
      quickOrder.extendedHours,
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
          extendedHours: quickOrder.extendedHours,
        },
      );

      if (result.ok) {
        recordExitOrder(result.order);
      }
    },
    [
      executionService,
      quickOrder.extendedHours,
      recordExitOrder,
      safeSymbol,
    ],
  );

  const flattenAllPositions = useCallback(async () => {
    const result = await executionService.flattenAllPositions({
      extendedHours: quickOrder.extendedHours,
    });

    if (!result.ok) return;

    const trade = tradeEngine.getSelectedTrade();

    if (
      trade &&
      trade.symbol.trim().toUpperCase() === safeSymbol
    ) {
      const exitOrderIds = result.results.flatMap((item) =>
        item.ok ? collectAlpacaOrderIds(item.order) : [],
      );

      tradeEngine.updateTrade(trade.id, {
        status: "managing",
        links: {
          ...trade.links,
          alpacaOrderIds: Array.from(
            new Set([
              ...(trade.links.alpacaOrderIds ?? []),
              ...exitOrderIds,
            ]),
          ),
        },
      });
    }

    executionService.queueRefresh();
  }, [
    executionService,
    quickOrder.extendedHours,
    safeSymbol,
    tradeEngine,
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
      updateCurrentPosition,
      moveStopToBreakEven,
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
      fillOpenOrder,
      flattenAllPositions,
      journalTrades,
      moveStopToBreakEven,
      openOrders,
      positionProtection,
      quickOrder,
      refreshTradingData,
      safeSymbol,
      selectedTrade,
      submitQuickOrder,
      submitTradePlan,
      syncPlanToOrder,
      syncPlanToPosition,
      tradePlan,
      tradePlanStats,
      updateCurrentPosition,
      updateQuickOrder,
      updateTradePlan,
    ],
  );
}
