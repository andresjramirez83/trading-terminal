export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type BarsResponse = {
  symbol: string;
  timeframe: string;
  bars: Candle[];
  trading_date: string;
};

export type LastTradeResponse = {
  symbol: string;
  price: number | null;
};

export type ScannerRow = {
  symbol: string;
  price: number;
  prev_close: number;
  change_pct: number;
  gap_pct: number;
  range_pct: number;
  volume: number;
  day_open: number;
  day_high: number;
  day_low: number;
  bid: number | null;
  ask: number | null;
  score: number;
  source?: string;
};

export type ScannerResponse = {
  trade_day: string;
  session_mode: string;
  count: number;
  rows: ScannerRow[];
};

export type ScannerDefinition = {
  id: string;
  name: string;
  description: string;
};

export type ScannerV2Row = {
  symbol: string;
  timeframe?: string;
  price?: number | null;
  volume?: number | null;
  ifvg_score?: number | null;
  ifvg_status?: string | null;
  ifvg_phase?: string | null;
  ifvg_alert_phase?: string | null;
  ifvg_direction?: string | null;
  zone_low?: number | null;
  zone_high?: number | null;
  distance_to_zone_pct?: number | null;
  rvol?: number | null;
  zone_width_pct?: number | null;
  age_bars?: number | null;
  bars_since_touch?: number | null;
  last_price: number | null;
  prev_close: number | null;
  ah_gap_pct?: number | null;
  ah_range_pct?: number | null;
  ah_volume?: number | null;
  ah_score?: number | null;
  pm_gap_pct?: number | null;
  gap_pct?: number | null;
  pm_volume?: number | null;
  pm_range_pct?: number | null;
  compression_score?: number | null;
  breakout_score?: number | null;
  runner_score?: number | null;
  pm_runner_score?: number | null;
  float_shares?: number | null;
  notes: string[];
  source?: string;
  extra?: Record<string, unknown>;
};

export type ScannerV2Response = {
  scanner_id: string;
  scanner_name: string;
  description?: string;
  workflow?: string;
  trade_day: string;
  count: number;
  rows: ScannerV2Row[];
  meta?: Record<string, unknown>;
};

export type OvernightSnapshotSaveResponse = {
  scanner_id: string;
  scanner_name: string;
  saved: boolean;
  trade_date?: string;
  count: number;
  message?: string;
  path?: string;
  snapshot_dates?: string[];
  top_rows?: ScannerV2Row[];
};

export type OvernightSnapshotListResponse = {
  scanner_id: string;
  dates: string[];
  latest: string | null;
};

/* =========================
   Alpaca types
   ========================= */

export type AlpacaMode = "paper" | "live";

export type AlpacaSide = "buy" | "sell";

export type AlpacaOrderType = "market" | "limit";

export type AlpacaTimeInForce = "day" | "gtc" | "ioc" | "fok" | "opg" | "cls";

export type AlpacaAccount = {
  account_number?: string;
  status?: string;
  currency?: string;
  buying_power?: string;
  cash?: string;
  portfolio_value?: string;
  equity?: string;
  long_market_value?: string;
  short_market_value?: string;
  pattern_day_trader?: boolean;
  trading_blocked?: boolean;
  transfers_blocked?: boolean;
  account_blocked?: boolean;
  created_at?: string;
  daytrade_count?: number;
};

export type AlpacaPosition = {
  asset_id?: string;
  symbol: string;
  exchange?: string;
  asset_class?: string;
  avg_entry_price?: string;
  qty?: string;
  side?: string;
  market_value?: string;
  cost_basis?: string;
  unrealized_pl?: string;
  unrealized_plpc?: string;
  current_price?: string;
  lastday_price?: string;
  change_today?: string;
};

export type AlpacaOrder = {
  id?: string;
  client_order_id?: string;
  created_at?: string;
  updated_at?: string;
  submitted_at?: string;
  filled_at?: string | null;
  expired_at?: string | null;
  canceled_at?: string | null;
  failed_at?: string | null;
  replaced_at?: string | null;
  replaced_by?: string | null;
  replaces?: string | null;
  asset_id?: string;
  symbol?: string;
  asset_class?: string;
  qty?: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
  order_class?: string;
  order_type?: string;
  type?: string;
  side?: string;
  time_in_force?: string;
  limit_price?: string | null;
  stop_price?: string | null;
  status?: string;
  extended_hours?: boolean;
};

export type PlaceAlpacaOrderRequest = {
  symbol: string;
  qty: number;
  side: AlpacaSide;
  type: AlpacaOrderType;
  time_in_force?: AlpacaTimeInForce;
  limit_price?: number;
  mode?: AlpacaMode;
  extended_hours?: boolean;
};