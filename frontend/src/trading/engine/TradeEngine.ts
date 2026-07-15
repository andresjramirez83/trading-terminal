// src/trading/engine/TradeEngine.ts

import { TradeEvents } from "./TradeEvents";
import { TradeRegistry } from "./TradeRegistry";
import { validateTrade } from "./TradeValidator";
import type {
  TradeCreateInput,
  TradeObject,
  TradeStatus,
  TradeUpdateInput,
  TradeValidationResult,
  TradeWorkspace,
} from "./TradeTypes";

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
    const trade = this.registry.create(input);
    this.events.emit({ type: "trade-created", tradeId: trade.id, trade, previousTrade: null });
    this.events.emit({ type: "trade-selected", tradeId: trade.id, trade, previousTrade: null });
    return trade;
  }

  updateTrade(id: string, input: TradeUpdateInput): TradeObject | null {
    const previousTrade = this.registry.get(id);
    const trade = this.registry.update(id, input);
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
