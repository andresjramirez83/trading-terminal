import {
  fetchSharedAlpacaState,
  saveSharedAlpacaState,
  type SharedAlpacaStatePayload,
} from "../../api";
import type { Watchlist } from "./WatchlistTypes";
import { normalizeSymbol } from "./WatchlistStore";
import { loadLegacyManualWatchlist } from "./WatchlistMigration";

export type BackendWatchlistPayload = {
  scannerSymbols: string[];
  manualSymbols: string[];
};

function normalizeSymbolArray(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) return [];

  return symbols.map(normalizeSymbol).filter(Boolean);
}

export async function loadBackendWatchlists(): Promise<BackendWatchlistPayload> {
  let shared: SharedAlpacaStatePayload | null = null;

  try {
    shared = await fetchSharedAlpacaState();
  } catch (error) {
    console.warn("[WatchlistPersistence] Backend load failed", error);
  }

  const scannerSymbols = normalizeSymbolArray(shared?.watchlist);
  const backendManualSymbols = normalizeSymbolArray(shared?.manualWatchlist);
  const legacyManualSymbols = loadLegacyManualWatchlist();

  return {
    scannerSymbols,
    manualSymbols:
      backendManualSymbols.length > 0 ? backendManualSymbols : legacyManualSymbols,
  };
}

export async function saveBackendWatchlists(watchlists: Watchlist[]): Promise<void> {
  const scanner = watchlists.find((item) => item.id === "scanner");
  const manual = watchlists.find((item) => item.id === "manual");

  const scannerSymbols = (scanner?.symbols ?? []).map((item) => item.symbol);
  const manualSymbols = (manual?.symbols ?? []).map((item) => item.symbol);

  // Safety: never let an empty startup state wipe backend lists.
  if (scannerSymbols.length === 0 && manualSymbols.length === 0) return;

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
    console.warn("[WatchlistPersistence] Backend save failed", error);
  }
}
