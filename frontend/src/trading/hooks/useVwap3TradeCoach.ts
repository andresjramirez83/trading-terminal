import { useEffect, useMemo, useState } from "react";
import type { TradeHistoryEntry } from "../../components/chart/right-panel/workspaces/trading/TradingTypes";
import { getSharedVwap3TradeCoachService } from "../coach/Vwap3TradeCoachService";

export function useVwap3TradeCoach(trades: TradeHistoryEntry[]) {
  const service = getSharedVwap3TradeCoachService();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    service.syncClosedTrades(trades);
    void service.refreshStudy(30);
  }, [service, trades]);

  useEffect(
    () => service.subscribe(() => setRevision((value) => value + 1)),
    [service],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      service.syncClosedTrades(trades);
      void service.refreshStudy(30);
    }, 5 * 60_000);

    return () => window.clearInterval(timer);
  }, [service, trades]);

  return useMemo(
    () => ({
      reviews: service.getReviews(),
      study: service.getStudy(),
      personalSummary: service.getPersonalSummary(),
    }),
    [service, revision],
  );
}

export default useVwap3TradeCoach;
