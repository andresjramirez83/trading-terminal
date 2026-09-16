// src/trading/engine/TradeEngine.ts

import { TradeEvents } from "./TradeEvents";
import { TradeRegistry } from "./TradeRegistry";
import { validateTrade } from "./TradeValidator";
import { getSharedMarketIntelligenceStore } from "../intelligence/integration/MarketIntelligenceStore";
import type {
  TradeCreateInput,
  TradeObject,
  TradeStatus,
  TradeUpdateInput,
  TradeValidationResult,
  TradeWorkspace,
} from "./TradeTypes";

function cleanSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function captureEntryDecisionSnapshot(
  symbol: string,
  timeframe?: string,
) {
  const report =
    getSharedMarketIntelligenceStore().getSnapshot().report;

  if (!report || cleanSymbol(report.symbol) !== cleanSymbol(symbol)) {
    return undefined;
  }

  const requestedTimeframe = String(timeframe ?? "").trim().toLowerCase();
  const reportTimeframe = String(report.timeframe ?? "").trim().toLowerCase();

  if (
    requestedTimeframe &&
    reportTimeframe &&
    requestedTimeframe !== reportTimeframe
  ) {
    return undefined;
  }

  const triggers = (report.triggers ?? [])
    .filter(
      (trigger) =>
        trigger.status === "confirmed" ||
        trigger.status === "armed",
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((trigger) =>
      trigger.description
        ? `${trigger.label}: ${trigger.description}`
        : trigger.label,
    );

  return {
    score: report.tradeScore,
    grade: String(report.grade ?? ""),
    entryQuality: report.entry?.score,
    risk: report.risk?.score,
    summary: report.summary,
    thesis: report.thesis,
    triggers,
    capturedAt: new Date().toISOString(),
  };
}

export class TradeEngine {
  readonly events = new TradeEvents();
  private registry: TradeRegistry;

  constructor(workspace?: TradeWorkspace) {
    this.registry = new TradeRegistry(workspace);
  }

  setWorkspace(workspace: TradeWorkspace): void {
    this.registry.setWorkspace(workspace);
    this.events.emit({ type: "registry-reset", tradeId: null, trade: null, previousTrade: null });
  }

  getWorkspace() {
    return this.registry.getWorkspace();
  }

  getTrades(): TradeObject[] {
    return this.registry.getAll();
  }

  getTrade(id: string): TradeObject | null {
    return this.registry.get(id);
  }

  getSelectedTrade(): TradeObject | null {
    return this.registry.getSelected();
  }

  getSelectedTradeId(): string | null {
    return this.registry.getSelectedId();
  }

  selectTrade(id: string | null): TradeObject | null {
    const trade = this.registry.select(id);
    this.events.emit({ type: "trade-selected", tradeId: id, trade, previousTrade: null });
    return trade;
  }

  createTrade(input: TradeCreateInput): TradeObject {
    const shouldCaptureAtCreate =
      input.status === "submitted" &&
      input.decisionSnapshot == null;

    const trade = this.registry.create(
      shouldCaptureAtCreate
        ? {
            ...input,
            decisionSnapshot:
              captureEntryDecisionSnapshot(
                input.symbol,
                input.timeframe,
              ),
          }
        : input,
    );
    this.events.emit({ type: "trade-created", tradeId: trade.id, trade, previousTrade: null });
    this.events.emit({ type: "trade-selected", tradeId: trade.id, trade, previousTrade: null });
    return trade;
  }

  updateTrade(id: string, input: TradeUpdateInput): TradeObject | null {
    const previousTrade = this.registry.get(id);

    let nextInput = input;
    const isFreshSubmission =
      previousTrade != null &&
      previousTrade.decisionSnapshot == null &&
      input.decisionSnapshot == null &&
      input.status === "submitted" &&
      (previousTrade.status === "draft" ||
        previousTrade.status === "ready");

    if (isFreshSubmission) {
      const decisionSnapshot =
        captureEntryDecisionSnapshot(
          previousTrade.symbol,
          previousTrade.timeframe,
        );

      if (decisionSnapshot) {
        nextInput = {
          ...input,
          decisionSnapshot,
        };
      }
    }

    const trade = this.registry.update(id, nextInput);
    if (!trade) return null;

    this.events.emit({ type: "trade-updated", tradeId: id, trade, previousTrade });

    if (previousTrade && previousTrade.status !== trade.status) {
      this.events.emit({ type: "trade-status-changed", tradeId: id, trade, previousTrade });
    }

    return trade;
  }

  updateEntry(id: string, entry: number | null): TradeObject | null {
    return this.updateTrade(id, { entry });
  }

  updateStop(id: string, stop: number | null): TradeObject | null {
    return this.updateTrade(id, { stop });
  }

  updateTarget(id: string, targetPrice: number | null, targetId?: string): TradeObject | null {
    const previousTrade = this.registry.get(id);
    const trade = this.registry.updateTarget(id, targetPrice, targetId);
    if (!trade) return null;
    this.events.emit({ type: "trade-updated", tradeId: id, trade, previousTrade });
    return trade;
  }

  updateStatus(id: string, status: TradeStatus): TradeObject | null {
    return this.updateTrade(id, { status });
  }

  deleteTrade(id: string): TradeObject | null {
    const previousTrade = this.registry.remove(id);
    if (!previousTrade) return null;
    this.events.emit({ type: "trade-deleted", tradeId: id, trade: null, previousTrade });
    return previousTrade;
  }

  validateTrade(id: string): TradeValidationResult | null {
    const trade = this.registry.get(id);
    return trade ? validateTrade(trade) : null;
  }

  clear(): void {
    this.registry.clear();
    this.events.emit({ type: "registry-reset", tradeId: null, trade: null, previousTrade: null });
  }

  destroy(): void {
    this.events.clear();
  }
}
