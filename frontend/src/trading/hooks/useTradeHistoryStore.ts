// src/trading/hooks/useTradeHistoryStore.ts

import { useEffect, useMemo, useState } from "react";
import type { TradeExecutionSnapshot } from "../services/execution/TradeExecutionTypes";
import { getSharedTradeHistoryEngine } from "../history/TradeHistoryEngine";
import { getSharedTradeEngine } from "../engine/TradeEngineRuntime";
import { getSharedExecutionGateway } from "../execution/ExecutionGateway";
import { getSharedExecutionModeRuntime } from "../execution/router/ExecutionModeRuntime";
import { useVwap3TradeCoach } from "./useVwap3TradeCoach";

export function useTradeHistoryStore() {
  const gateway = getSharedExecutionGateway();
  const modeRuntime = getSharedExecutionModeRuntime();
  const historyEngine = getSharedTradeHistoryEngine();
  const tradeEngine = getSharedTradeEngine();

  const [snapshot, setSnapshot] = useState<TradeExecutionSnapshot>(() =>
    gateway.getSnapshot(),
  );
  const [historyRevision, setHistoryRevision] = useState(0);

  useEffect(() => {
    const refreshHistory = () => {
      historyEngine.setTrades(tradeEngine.getTrades());
      setHistoryRevision((current) => current + 1);
    };

    const applySnapshot = (next: TradeExecutionSnapshot) => {
      historyEngine.setTrades(tradeEngine.getTrades());

      if (gateway.getMode() === "practice") {
        historyEngine.mergeFilledOrders(next.filledOrders);
      } else {
        historyEngine.setFilledOrders(next.filledOrders);
      }

      setSnapshot(next);
      setHistoryRevision((current) => current + 1);
    };

    // Build the initial Journal and Performance state immediately instead of
    // waiting for the first execution polling cycle.
    applySnapshot(gateway.getSnapshot());

    const unsubscribeExecution = gateway.subscribe(applySnapshot);

    // TradeEngine is the authoritative source for trade lifecycle changes.
    // Practice fills can complete several trades without changing the gateway
    // snapshot identity in a way React can observe, so listen to trade events
    // directly and rebuild the history-derived UI state on every mutation.
    const unsubscribeTrades = tradeEngine.events.subscribe((event) => {
      switch (event.type) {
        case "trade-created":
        case "trade-updated":
        case "trade-deleted":
        case "trade-status-changed":
        case "registry-reset":
          refreshHistory();
          break;
        case "trade-selected":
          break;
      }
    });

    const unsubscribeMode = modeRuntime.subscribe(() => {
      applySnapshot(gateway.getSnapshot());
    });

    gateway.startPolling(8000);

    return () => {
      unsubscribeExecution();
      unsubscribeTrades();
      unsubscribeMode();
    };
  }, [gateway, historyEngine, modeRuntime, tradeEngine]);

  const tradeHistory = useMemo(
    () => historyEngine.getTradeHistory(),
    [historyEngine, historyRevision],
  );
  const vwap3Coach = useVwap3TradeCoach(tradeHistory);

  return useMemo(
    () => ({
      filledOrders: historyEngine.getFilledOrders(),
      tradeHistory,
      journalTrades: historyEngine.getJournal(),
      performance: historyEngine.getPerformance(),
      vwap3CoachReviews: vwap3Coach.reviews,
      vwap3CoachStudy: vwap3Coach.study,
      vwap3CoachPersonalSummary: vwap3Coach.personalSummary,
      connectionStatus: snapshot.connectionStatus,
      loading: snapshot.loading,
      updatedAt: snapshot.updatedAt,
    }),
    [
      historyEngine,
      tradeHistory,
      historyRevision,
      vwap3Coach.reviews,
      vwap3Coach.study,
      vwap3Coach.personalSummary,
      snapshot.connectionStatus,
      snapshot.loading,
      snapshot.updatedAt,
    ],
  );
}

export default useTradeHistoryStore;
