// src/trading/hooks/useTradeHistoryStore.ts

import { useEffect, useMemo, useState } from "react";
import type { TradeExecutionSnapshot } from "../services/execution/TradeExecutionTypes";
import { getSharedTradeHistoryEngine } from "../history/TradeHistoryEngine";
import { getSharedTradeEngine } from "../engine/TradeEngineRuntime";
import { getSharedExecutionGateway } from "../execution/ExecutionGateway";
import { getSharedExecutionModeRuntime } from "../execution/router/ExecutionModeRuntime";

export function useTradeHistoryStore() {
  const gateway = getSharedExecutionGateway();
  const modeRuntime = getSharedExecutionModeRuntime();
  const historyEngine = getSharedTradeHistoryEngine();
  const tradeEngine = getSharedTradeEngine();

  const [snapshot, setSnapshot] = useState<TradeExecutionSnapshot>(() =>
    gateway.getSnapshot(),
  );

  useEffect(() => {
    const applySnapshot = (next: TradeExecutionSnapshot) => {
      const isPractice = gateway.getMode() === "practice";

      historyEngine.setTrades(tradeEngine.getTrades());

      if (isPractice) {
        historyEngine.mergeFilledOrders(next.filledOrders);
      } else {
        historyEngine.setFilledOrders(next.filledOrders);
      }

      setSnapshot(next);
    };

    const unsubscribeExecution = gateway.subscribe(applySnapshot);

    const unsubscribeMode = modeRuntime.subscribe(() => {
      applySnapshot(gateway.getSnapshot());
    });

    gateway.startPolling(8000);

    return () => {
      unsubscribeExecution();
      unsubscribeMode();
    };
  }, [
    gateway,
    historyEngine,
    modeRuntime,
    tradeEngine,
  ]);

  return useMemo(() => {
    return {
      filledOrders: historyEngine.getFilledOrders(),
      tradeHistory: historyEngine.getTradeHistory(),
      journalTrades: historyEngine.getJournal(),
      performance: historyEngine.getPerformance(),
      connectionStatus: snapshot.connectionStatus,
      loading: snapshot.loading,
      updatedAt: snapshot.updatedAt,
    };
  }, [
    historyEngine,
    snapshot.connectionStatus,
    snapshot.filledOrders,
    snapshot.loading,
    snapshot.refreshCount,
    snapshot.updatedAt,
  ]);
}

export default useTradeHistoryStore;