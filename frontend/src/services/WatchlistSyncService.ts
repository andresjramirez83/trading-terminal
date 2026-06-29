import {
  fetchSharedAlpacaState,
  saveSharedAlpacaState,
  type SharedAlpacaStatePayload,
} from "./api";
import type { Watchlist, WatchlistSymbol } from "../watchlists/WatchlistTypes";

function normalizeSymbol(symbol: unknown): string {
  return String(symbol ?? "").trim().toUpperCase();
}

function parseLegacySymbolArray(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === "string") return normalizeSymbol(item);
          if (item && typeof item === "object" && "symbol" in item) {
            return normalizeSymbol((item as { symbol?: unknown }).symbol);
          }
          return "";
        })
        .filter(Boolean);
    }
  } catch {
    return raw
      .split(/[\s,]+/g)
      .map(normalizeSymbol)
      .filter(Boolean);
  }

  return [];
}

function readLegacyManualWatchlist(): string[] {
  if (typeof window === "undefined") return [];

  const keys = [
    "alpacaManualWatchlist",
    "manualWatchlist",
    "manual-watchlist",
    "trading.manual.watchlist",
  ];

  for (const key of keys) {
    const symbols = parseLegacySymbolArray(window.localStorage.getItem(key));
    if (symbols.length > 0) return symbols;
  }

  return [];
}

export type WatchlistBootstrapPayload = {
  scannerSymbols: string[];
  manualSymbols: string[];
};

export async function loadBackendWatchlists(): Promise<WatchlistBootstrapPayload> {
  let shared: SharedAlpacaStatePayload | null = null;

  try {
    shared = await fetchSharedAlpacaState();
  } catch (error) {
    console.warn("[WatchlistSync] Backend load failed", error);
  }

  const scannerSymbols = (shared?.watchlist ?? [])
    .map(normalizeSymbol)
    .filter(Boolean);

  const backendManual = (shared?.manualWatchlist ?? [])
    .map(normalizeSymbol)
    .filter(Boolean);

  const legacyManual = readLegacyManualWatchlist();

  return {
    scannerSymbols,
    manualSymbols: backendManual.length > 0 ? backendManual : legacyManual,
  };
}

export async function saveBackendWatchlists(watchlists: Watchlist[]): Promise<void> {
  const scanner = watchlists.find((item) => item.id === "scanner");
  const manual = watchlists.find((item) => item.id === "manual");

  const scannerSymbols = (scanner?.symbols ?? []).map((item) => item.symbol);
  const manualSymbols = (manual?.symbols ?? []).map((item) => item.symbol);

  // Never allow an empty frontend startup state to wipe backend watchlists.
  if (scannerSymbols.length === 0 && manualSymbols.length === 0) {
    return;
  }

  try {
    const existing = await fetchSharedAlpacaState();

    await saveSharedAlpacaState({
      ...(existing ?? {}),
      watchlist: scannerSymbols.length > 0 ? scannerSymbols : existing?.watchlist ?? [],
      manualWatchlist:
        manualSymbols.length > 0 ? manualSymbols : existing?.manualWatchlist ?? [],
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.warn("[WatchlistSync] Backend save failed", error);
  }
}

export function symbolsToWatchlistSymbols(symbols: string[]): WatchlistSymbol[] {
  return symbols
    .map(normalizeSymbol)
    .filter(Boolean)
    .map((symbol) => ({
      symbol,
      score: 0,
      tone: "watch" as const,
      setup: "Backend Watchlist",
      note: "Synced",
      source: "backend",
    }));
}
