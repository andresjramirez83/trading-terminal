export type WatchlistType = "manual" | "scanner" | "custom" | "favorites";

export type WatchlistSymbolTone = "ready" | "watch" | "weak";

export interface WatchlistSymbol {
  symbol: string;
  company?: string;
  score?: number;
  tone?: WatchlistSymbolTone;
  setup?: string;
  scanner?: string;
  note?: string;
  lastPrice?: number;
  percentChange?: number;
  volume?: number;
  source?: string;
}

export interface Watchlist {
  id: string;
  name: string;
  type: WatchlistType;
  description?: string;
  symbols: WatchlistSymbol[];
  source?: "user" | "scanner" | "system";
  editable?: boolean;
  deletable?: boolean;
  autoRefresh?: boolean;
}

export type ReplaceSymbolsOptions = {
  name?: string;
  type?: WatchlistType;
  description?: string;
  activate?: boolean;
  allowEmpty?: boolean;
};
