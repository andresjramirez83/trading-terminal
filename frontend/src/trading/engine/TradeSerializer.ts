// src/trading/engine/TradeSerializer.ts

import type { TradeObject } from "./TradeTypes";

const STORAGE_PREFIX = "trading.tradeEngine.v1";

function safeKeyPart(value: string): string {
  return String(value || "default").trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_");
}

export function makeTradeStorageKey(workspace?: { symbol?: string; timeframe?: string }): string {
  const symbol = safeKeyPart(workspace?.symbol ?? "GLOBAL");
  const timeframe = safeKeyPart(workspace?.timeframe ?? "ALL");
  return `${STORAGE_PREFIX}.${symbol}.${timeframe}`;
}

export function cloneTrade<T extends TradeObject>(trade: T): T {
  return JSON.parse(JSON.stringify(trade)) as T;
}

export function cloneTrades(trades: TradeObject[]): TradeObject[] {
  return trades.map((trade) => cloneTrade(trade));
}

export function serializeTrades(trades: TradeObject[]): string {
  return JSON.stringify(cloneTrades(trades));
}

export function deserializeTrades(raw: string | null): TradeObject[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TradeObject[]) : [];
  } catch {
    return [];
  }
}
