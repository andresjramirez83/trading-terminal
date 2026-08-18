import { useCallback, useMemo, useState } from "react";
import type {
  CurrentPositionState,
  CurrentPositionStats,
  JournalTradeState,
  OpenOrderState,
  QuickOrderState,
  TradePlanState,
  TradePlanStats,
  TradingAccount,
} from "./TradingTypes";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function getOrderTime(): string {
  return new Date().toLocaleTimeString([], {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getJournalDate(): string {
  return new Date().toLocaleDateString([], {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function calculateTradePlanStats(
  plan: TradePlanState,
  currentPrice: number
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
  currentPrice: number
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

export function useTradingWorkspaceStore(symbol: string, currentPrice: number) {
  const safeSymbol = symbol || "—";

  const [account] = useState<TradingAccount>({
    buyingPower: 25000,
    cash: 25000,
    portfolioValue: 25000,
    dayPnl: 0,
    dayPnlPct: 0,
  });

  const [tradePlan, setTradePlan] = useState<TradePlanState>({
    symbol: safeSymbol,
    side: "long",
    entry: 0,
    target: 0,
    stop: 0,
    shares: 100,
  });

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

  const [currentPosition, setCurrentPosition] =
    useState<CurrentPositionState>({
      symbol: safeSymbol,
      side: "long",
      shares: 0,
      entry: 0,
      target: 0,
      stop: 0,
    });

  const [openOrders, setOpenOrders] = useState<OpenOrderState[]>([]);
  const [journalTrades, setJournalTrades] = useState<JournalTradeState[]>([]);

  const updateTradePlan = useCallback(
    (patch: Partial<TradePlanState>) => {
      setTradePlan((current) => ({ ...current, ...patch, symbol: safeSymbol }));
    },
    [safeSymbol]
  );

  const updateQuickOrder = useCallback(
    (patch: Partial<QuickOrderState>) => {
      setQuickOrder((current) => ({
        ...current,
        ...patch,
        symbol: safeSymbol,
      }));
    },
    [safeSymbol]
  );

  const updateCurrentPosition = useCallback(
    (patch: Partial<CurrentPositionState>) => {
      setCurrentPosition((current) => ({
        ...current,
        ...patch,
        symbol: safeSymbol,
      }));
    },
    [safeSymbol]
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
    setCurrentPosition({
      symbol: safeSymbol,
      side: tradePlan.side,
      shares: tradePlan.shares,
      entry: tradePlan.entry,
      target: tradePlan.target,
      stop: tradePlan.stop,
    });
  }, [safeSymbol, tradePlan]);

  const moveStopToBreakEven = useCallback(() => {
    setCurrentPosition((current) => ({
      ...current,
      stop: current.entry > 0 ? current.entry : currentPrice,
    }));
  }, [currentPrice]);

  const submitQuickOrder = useCallback(
    (estimatedShares: number) => {
      if (estimatedShares <= 0) return;

      const newOrder: OpenOrderState = {
        id: crypto.randomUUID(),
        symbol: safeSymbol,
        side: quickOrder.side,
        type: quickOrder.bracketEnabled ? "bracket" : quickOrder.orderType,
        shares: estimatedShares,
        limitPrice:
          quickOrder.orderType === "limit" ? quickOrder.limitPrice : undefined,
        stopPrice: quickOrder.bracketEnabled
          ? quickOrder.bracketStop
          : quickOrder.orderType === "stop"
            ? quickOrder.stopPrice
            : undefined,
        targetPrice: quickOrder.bracketEnabled
          ? quickOrder.bracketTarget
          : undefined,
        status: "open",
        createdAt: getOrderTime(),
      };

      setOpenOrders((current) => [newOrder, ...current]);
    },
    [quickOrder, safeSymbol]
  );

  const cancelOpenOrder = useCallback((orderId: string) => {
    setOpenOrders((current) => current.filter((order) => order.id !== orderId));
  }, []);

  const fillOpenOrder = useCallback(
    (orderId: string) => {
      const order = openOrders.find((item) => item.id === orderId);
      if (!order) return;

      const fillPrice =
        order.limitPrice && order.limitPrice > 0
          ? order.limitPrice
          : currentPrice;

      setOpenOrders((current) =>
        current.filter((item) => item.id !== orderId)
      );

      setCurrentPosition({
        symbol: order.symbol,
        side: order.side === "buy" ? "long" : "short",
        shares: order.shares,
        entry: fillPrice,
        target: order.targetPrice ?? 0,
        stop: order.stopPrice ?? 0,
      });

      const riskPerShare =
        order.side === "buy"
          ? Math.max(0, fillPrice - (order.stopPrice ?? 0))
          : Math.max(0, (order.stopPrice ?? 0) - fillPrice);

      const journalTrade: JournalTradeState = {
        id: crypto.randomUUID(),
        date: getJournalDate(),
        time: getOrderTime(),
        symbol: order.symbol,
        strategy: "Manual",
        side: order.side,
        shares: order.shares,
        entry: fillPrice,
        exit: fillPrice,
        target: order.targetPrice ?? 0,
        stop: order.stopPrice ?? 0,
        exitReason: "mock-fill",
        holdTime: "0m",
        grossPnl: 0,
        netPnl: 0,
        rMultiple: riskPerShare > 0 ? 0 : 0,
        notes: "Mock fill created from Quick Order.",
      };

      setJournalTrades((current) => [journalTrade, ...current]);
    },
    [currentPrice, openOrders]
  );

  const tradePlanStats = useMemo(
    () => calculateTradePlanStats(tradePlan, currentPrice),
    [tradePlan, currentPrice]
  );

  const currentPositionStats = useMemo(
    () => calculateCurrentPositionStats(currentPosition, currentPrice),
    [currentPosition, currentPrice]
  );

  return useMemo(
    () => ({
      account,

      tradePlan: { ...tradePlan, symbol: safeSymbol },
      tradePlanStats,
      updateTradePlan,
      syncPlanToOrder,
      syncPlanToPosition,

      quickOrder: { ...quickOrder, symbol: safeSymbol },
      updateQuickOrder,
      submitQuickOrder,

      currentPosition: { ...currentPosition, symbol: safeSymbol },
      currentPositionStats,
      updateCurrentPosition,
      moveStopToBreakEven,

      openOrders,
      cancelOpenOrder,
      fillOpenOrder,

      journalTrades,
    }),
    [
      account,
      cancelOpenOrder,
      currentPosition,
      currentPositionStats,
      fillOpenOrder,
      journalTrades,
      moveStopToBreakEven,
      openOrders,
      quickOrder,
      safeSymbol,
      submitQuickOrder,
      syncPlanToOrder,
      syncPlanToPosition,
      tradePlan,
      tradePlanStats,
      updateCurrentPosition,
      updateQuickOrder,
      updateTradePlan,
    ]
  );
}