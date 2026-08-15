import {
  fetchVwap3CoachStudy,
  reviewVwap3Trade,
  type Vwap3StudyResponse,
  type Vwap3TradeCoachReview,
} from "../../services/api";
import type { TradeHistoryEntry } from "../../components/chart/right-panel/workspaces/trading/TradingTypes";

const STORAGE_KEY = "trading.vwap3Coach.reviews.v1";
const UPDATE_EVENT = "vwap3-trade-coach-updated";

export type Vwap3PersonalCoachSummary = {
  reviewedTrades: number;
  scannerMatchedTrades: number;
  likelyEarlyExits: number;
  defensiveExits: number;
  targetExits: number;
  targetHitAfterExit: number;
  estimatedMissedPnlToTarget: number;
  averageEntryQuality: number | null;
};

function loadStored(): Record<string, Vwap3TradeCoachReview> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persist(value: Record<string, Vwap3TradeCoachReview>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Journal/history still works if storage is unavailable.
  }
}

export class Vwap3TradeCoachService {
  private reviews: Record<string, Vwap3TradeCoachReview> = loadStored();
  private inflight = new Set<string>();
  private study: Vwap3StudyResponse | null = null;
  private studyInflight: Promise<Vwap3StudyResponse | null> | null = null;
  private studyFetchedAt = 0;
  private lastRequestedAt = new Map<string, number>();

  getReviews(): Record<string, Vwap3TradeCoachReview> {
    return { ...this.reviews };
  }

  getReview(tradeId: string): Vwap3TradeCoachReview | undefined {
    return this.reviews[tradeId];
  }

  getStudy(): Vwap3StudyResponse | null {
    return this.study;
  }

  getPersonalSummary(): Vwap3PersonalCoachSummary {
    const rows = Object.values(this.reviews);
    const matched = rows.filter((row) => row.scanner_match);
    const entryScores = matched
      .map((row) => row.entry_quality?.score)
      .filter((value): value is number => Number.isFinite(value));

    return {
      reviewedTrades: rows.length,
      scannerMatchedTrades: matched.length,
      likelyEarlyExits: matched.filter((row) => row.classification === "likely_early_exit").length,
      defensiveExits: matched.filter((row) => row.classification === "defensive_exit").length,
      targetExits: matched.filter((row) => row.classification === "target_exit").length,
      targetHitAfterExit: matched.filter((row) => row.target_hit_after_exit).length,
      estimatedMissedPnlToTarget: matched
        .filter((row) => row.classification === "likely_early_exit")
        .reduce(
          (sum, row) => sum + (Number(row.estimated_missed_pnl_to_target) || 0),
          0,
        ),
      averageEntryQuality:
        entryScores.length > 0
          ? entryScores.reduce((sum, value) => sum + value, 0) / entryScores.length
          : null,
    };
  }

  async refreshStudy(days = 30, force = false): Promise<Vwap3StudyResponse | null> {
    if (this.studyInflight) return this.studyInflight;
    if (!force && this.study && Date.now() - this.studyFetchedAt < 15 * 60_000) {
      return this.study;
    }
    this.studyInflight = fetchVwap3CoachStudy(days)
      .then((study) => {
        this.study = study;
        this.studyFetchedAt = Date.now();
        this.emit();
        return study;
      })
      .catch((error) => {
        console.warn("[vwap3-coach] study refresh failed", error);
        return null;
      })
      .finally(() => {
        this.studyInflight = null;
      });
    return this.studyInflight;
  }

  syncClosedTrades(trades: TradeHistoryEntry[]): void {
    for (const trade of trades) {
      if (trade.status !== "closed") continue;
      if (!trade.entryTimestamp || !trade.exitTimestamp) continue;
      if (trade.entryPrice <= 0 || trade.exitPrice <= 0) continue;

      const existing = this.reviews[trade.id];
      const lastRequest = this.lastRequestedAt.get(trade.id) ?? 0;
      const reviewedAt = existing?.reviewed_at ? Date.parse(existing.reviewed_at) : 0;
      const reviewAge = reviewedAt > 0 ? Date.now() - reviewedAt : Number.POSITIVE_INFINITY;
      const needsFollowUp = Boolean(
        existing &&
          (existing.classification === "early_exit_unresolved" ||
            (!existing.scanner_match && reviewAge < 24 * 60 * 60_000)),
      );

      if (existing && !needsFollowUp) continue;
      // Unresolved exits are rechecked as the scanner receives new bars. Limit
      // retries so normal 8-second execution polling cannot hammer the backend.
      if (needsFollowUp && reviewAge < 5 * 60_000) continue;
      if (Date.now() - lastRequest < 60_000 || this.inflight.has(trade.id)) continue;

      this.inflight.add(trade.id);
      this.lastRequestedAt.set(trade.id, Date.now());

      void reviewVwap3Trade({
        trade_id: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        shares: trade.shares,
        entry_price: trade.entryPrice,
        exit_price: trade.exitPrice,
        entry_time: trade.entryTimestamp,
        exit_time: trade.exitTimestamp,
        planned_target: trade.plannedTarget,
        planned_stop: trade.plannedStop,
        strategy: trade.strategy,
        realized_pnl: trade.netPnl,
        r_multiple: trade.rMultiple,
      })
        .then((review) => {
          this.reviews = { ...this.reviews, [trade.id]: review };
          persist(this.reviews);
          this.emit();
        })
        .catch((error) => {
          console.warn(`[vwap3-coach] review failed trade=${trade.id}`, error);
        })
        .finally(() => {
          this.inflight.delete(trade.id);
        });
    }
  }

  subscribe(listener: () => void): () => void {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener(UPDATE_EVENT, listener);
    return () => window.removeEventListener(UPDATE_EVENT, listener);
  }

  private emit(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
  }
}

let shared: Vwap3TradeCoachService | null = null;

export function getSharedVwap3TradeCoachService(): Vwap3TradeCoachService {
  if (!shared) shared = new Vwap3TradeCoachService();
  return shared;
}
