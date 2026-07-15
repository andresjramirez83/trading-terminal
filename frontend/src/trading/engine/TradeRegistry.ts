// src/trading/engine/TradeRegistry.ts

import { calculateTradeMetrics } from "./TradeCalculator";
import { cloneTrade, cloneTrades, deserializeTrades, makeTradeStorageKey, serializeTrades } from "./TradeSerializer";
import type {
  TradeCreateInput,
  TradeObject,
  TradeTarget,
  TradeUpdateInput,
  TradeWorkspace,
} from "./TradeTypes";

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeSymbol(symbol: string): string {
  return String(symbol || "SPY").trim().toUpperCase();
}

function normalizeTarget(target: Partial<TradeTarget> & { price: number }, index: number): TradeTarget {
  return {
    id: target.id ?? makeId("target"),
    price: Number(target.price),
    quantityPercent: Number.isFinite(Number(target.quantityPercent))
      ? Number(target.quantityPercent)
      : index === 0
        ? 100
        : 0,
    label: target.label ?? `T${index + 1}`,
  };
}

function createTargets(input: TradeCreateInput): TradeTarget[] {
  if (input.targets?.length) {
    return input.targets.map((target, index) => normalizeTarget(target, index));
  }

  if (input.target != null && Number.isFinite(Number(input.target))) {
    return [normalizeTarget({ price: Number(input.target), quantityPercent: 100, label: "T1" }, 0)];
  }

  return [];
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

export class TradeRegistry {
  private trades: TradeObject[] = [];
  private selectedTradeId: string | null = null;
  private workspace: TradeWorkspace = {};
  private storageKey = makeTradeStorageKey(this.workspace);

  constructor(workspace?: TradeWorkspace) {
    this.setWorkspace(workspace ?? {});
  }

  setWorkspace(workspace: TradeWorkspace): void {
    this.workspace = {
      symbol: workspace.symbol ? normalizeSymbol(workspace.symbol) : undefined,
      timeframe: workspace.timeframe,
    };
    this.storageKey = makeTradeStorageKey(this.workspace);
    this.load();
  }

  getWorkspace(): TradeWorkspace & { storageKey: string } {
    return {
      ...this.workspace,
      storageKey: this.storageKey,
    };
  }

  getAll(): TradeObject[] {
    return cloneTrades(this.trades);
  }

  get(id: string): TradeObject | null {
    const trade = this.trades.find((item) => item.id === id);
    return trade ? cloneTrade(trade) : null;
  }

  getSelected(): TradeObject | null {
    return this.selectedTradeId ? this.get(this.selectedTradeId) : null;
  }

  getSelectedId(): string | null {
    return this.selectedTradeId;
  }

  select(id: string | null): TradeObject | null {
    if (id == null) {
      this.selectedTradeId = null;
      return null;
    }

    const exists = this.trades.some((trade) => trade.id === id);
    this.selectedTradeId = exists ? id : null;
    return this.getSelected();
  }

  create(input: TradeCreateInput): TradeObject {
    const createdAt = now();
    const trade: TradeObject = {
      id: makeId("trade"),
      symbol: normalizeSymbol(input.symbol),
      timeframe: input.timeframe,
      direction: input.direction ?? "long",
      source: input.source ?? "manual",
      mode: input.mode ?? "paper",
      status: input.status ?? "draft",
      entry: input.entry ?? null,
      stop: input.stop ?? null,
      targets: createTargets(input),
      sizingMode: input.sizingMode ?? "risk",
      shares: input.shares ?? null,
      dollarAmount: input.dollarAmount ?? null,
      riskAmount: input.riskAmount ?? 100,
      metrics: {
        riskPerShare: 0,
        rewardPerShare: 0,
        riskPercent: 0,
        rewardPercent: 0,
        riskAmount: 0,
        rewardAmount: 0,
        rr: 0,
        positionValue: 0,
        estimatedShares: 0,
      },
      notes: input.notes ?? "",
      tags: input.tags ?? [],
      strategy: input.strategy,
      setup: input.setup,
      links: {
        drawingId: input.drawingId,
        alpacaOrderIds: [],
      },
      fills: [],
      decisionSnapshot: input.decisionSnapshot,
      createdAt,
      updatedAt: createdAt,
    };

    trade.metrics = calculateTradeMetrics(trade);
    this.trades.push(cloneTrade(trade));
    this.selectedTradeId = trade.id;
    this.save();
    return cloneTrade(trade);
  }

  update(id: string, input: TradeUpdateInput): TradeObject | null {
    const index = this.trades.findIndex((trade) => trade.id === id);
    if (index < 0) return null;

    const current = this.trades[index];
    const updated: TradeObject = {
      ...current,
      ...input,
      links: input.links ? { ...current.links, ...input.links } : current.links,
      updatedAt: now(),
    };

    updated.symbol = normalizeSymbol(updated.symbol);
    updated.metrics = calculateTradeMetrics(updated);
    this.trades[index] = cloneTrade(updated);
    this.save();
    return cloneTrade(updated);
  }

  updateEntry(id: string, entry: number | null): TradeObject | null {
    return this.update(id, { entry });
  }

  updateStop(id: string, stop: number | null): TradeObject | null {
    return this.update(id, { stop });
  }

  updateTarget(id: string, targetPrice: number | null, targetId?: string): TradeObject | null {
    const trade = this.get(id);
    if (!trade) return null;

    let targets = trade.targets.slice();

    if (targetPrice == null) {
      targets = targetId ? targets.filter((target) => target.id !== targetId) : [];
    } else if (!targets.length) {
      targets = [normalizeTarget({ price: targetPrice, quantityPercent: 100, label: "T1" }, 0)];
    } else if (targetId) {
      targets = targets.map((target) =>
        target.id === targetId ? { ...target, price: Number(targetPrice) } : target,
      );
    } else {
      targets[0] = { ...targets[0], price: Number(targetPrice) };
    }

    return this.update(id, { targets });
  }

  remove(id: string): TradeObject | null {
    const existing = this.get(id);
    if (!existing) return null;

    this.trades = this.trades.filter((trade) => trade.id !== id);
    if (this.selectedTradeId === id) this.selectedTradeId = null;
    this.save();
    return existing;
  }

  clear(): void {
    this.trades = [];
    this.selectedTradeId = null;
    this.save();
  }

  private load(): void {
    if (!canUseLocalStorage()) {
      this.trades = [];
      this.selectedTradeId = null;
      return;
    }

    this.trades = deserializeTrades(window.localStorage.getItem(this.storageKey));
    if (this.selectedTradeId && !this.trades.some((trade) => trade.id === this.selectedTradeId)) {
      this.selectedTradeId = null;
    }
  }

  private save(): void {
    if (!canUseLocalStorage()) return;
    window.localStorage.setItem(this.storageKey, serializeTrades(this.trades));
  }
}
