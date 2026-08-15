import { API_BASE_URL } from "../config";
import type {
  BarsResponse,
  LastTradeResponse,
  OvernightSnapshotListResponse,
  OvernightSnapshotSaveResponse,
  ScannerDefinition,
  ScannerResponse,
  ScannerV2Response,
} from "../types/market";

export function resolveApiBaseUrl(): string {
  const envBase = String(import.meta.env.VITE_API_BASE_URL || "").trim();
  const configBase = String(API_BASE_URL || "").trim();
  const rawBase = envBase || configBase;

  const normalize = (value: string): string => {
    const trimmed = value.trim().replace(/\/$/, "");
    if (!trimmed || trimmed === "/") {
      throw new Error("empty api base");
    }

    try {
      const url = new URL(trimmed);
      const hasExplicitPort = Boolean(url.port);
      const isBareOrigin = url.pathname === "/" || url.pathname === "";

      if (!hasExplicitPort && isBareOrigin) {
        url.port = "8000";
      }

      return url.toString().replace(/\/$/, "");
    } catch {
      return trimmed;
    }
  };

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const protocol = window.location.protocol;

    if (!rawBase || rawBase === "/" || rawBase === window.location.origin) {
      return `${protocol}//${host}:8000`;
    }
  }

  return normalize(rawBase);
}

export const API_BASE = resolveApiBaseUrl();

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();

  if (!res.ok) {
    console.error("API ERROR:", res.status, text);
    throw new Error(`Request failed: ${res.status} ${text}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    console.error("INVALID JSON:", text);
    throw new Error(`Expected JSON but got: ${text.slice(0, 200)}`);
  }
}

type BarsCacheEntry = {
  expiresAt: number;
  data: BarsResponse;
};

const BARS_CACHE_TTL_MS = 45_000;
const MAX_BARS_CACHE_ENTRIES = 120;
const barsCache = new Map<string, BarsCacheEntry>();
const barsInflight = new Map<string, Promise<BarsResponse>>();

function pruneBarsCache(now = Date.now()): void {
  for (const [key, entry] of Array.from(barsCache.entries())) {
    if (entry.expiresAt <= now) barsCache.delete(key);
  }

  while (barsCache.size > MAX_BARS_CACHE_ENTRIES) {
    const oldestKey = barsCache.keys().next().value;
    if (!oldestKey) break;
    barsCache.delete(oldestKey);
  }
}

function normalizeLookback(timeframe: string, requested?: string): string {
  if (requested) return requested;

  switch (timeframe.toLowerCase()) {
    case "1m":
      return "2d";
    case "2m":
    case "3m":
    case "5m":
      return "5d";
    case "10m":
    case "15m":
    case "20m":
      return "10d";
    case "30m":
    case "45m":
      return "20d";
    case "1h":
    case "2h":
      return "60d";
    case "4h":
    case "6h":
    case "8h":
    case "12h":
      return "180d";
    case "1d":
    case "2d":
    case "3d":
    case "day":
      return "1y";
    case "1w":
    case "week":
      return "5y";
    case "1mo":
    case "1month":
    case "month":
      return "10y";
    default:
      return "5d";
  }
}

function defaultBarsLimit(timeframe: string): number {
  switch (timeframe.toLowerCase()) {
    case "1m":
      return 520;
    case "2m":
    case "3m":
    case "5m":
    case "10m":
    case "15m":
    case "20m":
    case "30m":
    case "45m":
      return 650;
    case "1h":
    case "2h":
    case "4h":
    case "6h":
    case "8h":
    case "12h":
      return 800;
    case "1d":
    case "2d":
    case "3d":
    case "day":
      return 600;
    case "1w":
    case "week":
      return 520;
    case "1mo":
    case "1month":
    case "month":
      return 240;
    default:
      return 650;
  }
}

export function clearBarsCache(symbol?: string): void {
  if (!symbol) {
    barsCache.clear();
    barsInflight.clear();
    return;
  }

  const prefix = `${symbol.trim().toUpperCase()}|`;
  for (const key of Array.from(barsCache.keys())) {
    if (key.startsWith(prefix)) barsCache.delete(key);
  }
  for (const key of Array.from(barsInflight.keys())) {
    if (key.startsWith(prefix)) barsInflight.delete(key);
  }
}

export async function fetchBars(
  symbol: string,
  timeframe: string = "5m",
  options?: {
    date?: string;
    lookback?: string;
    session?: "regular" | "extended";
    forceRefresh?: boolean;
    limit?: number;
    signal?: AbortSignal;
  }
): Promise<BarsResponse> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedTimeframe = timeframe.trim().toLowerCase();
  const normalizedDate = String(options?.date ?? "").trim();

  const normalizedLookback = normalizedDate
    ? ""
    : normalizeLookback(
        normalizedTimeframe,
        options?.lookback,
      );

  const params = new URLSearchParams({
    symbol: normalizedSymbol,
    timeframe: normalizedTimeframe,
  });

  if (normalizedDate) {
    params.set("date", normalizedDate);
  }

  if (normalizedLookback) {
    params.set("lookback", normalizedLookback);
  }

  const normalizedSession =
    options?.session === "regular"
      ? "regular"
      : options?.session === "extended"
        ? "extended"
        : undefined;

  if (normalizedSession) params.set("session", normalizedSession);

  const limit = Math.max(
    50,
    Math.min(
      5000,
      Math.floor(options?.limit ?? defaultBarsLimit(normalizedTimeframe)),
    ),
  );

  params.set("limit", String(limit));

  if (options?.forceRefresh) {
    params.set("_ts", String(Date.now()));
  }

  const cacheKey = `${normalizedSymbol}|${normalizedTimeframe}|${normalizedDate}|${normalizedLookback}|${normalizedSession ?? ""}|${limit}`;
  const now = Date.now();
  pruneBarsCache(now);

  if (!options?.forceRefresh) {
    const cached = barsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    if (!options?.signal) {
      const inflight = barsInflight.get(cacheKey);
      if (inflight) return inflight;
    }
  }

  const request = fetch(`${API_BASE}/bars?${params.toString()}`, {
    signal: options?.signal,
    cache: options?.forceRefresh ? "no-store" : "default",
    headers: options?.forceRefresh
      ? {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        }
      : undefined,
  })
    .then((res) => parseJson<BarsResponse>(res))
    .then((data) => {
      barsCache.set(cacheKey, {
        expiresAt: Date.now() + BARS_CACHE_TTL_MS,
        data,
      });
      pruneBarsCache();
      return data;
    })
    .finally(() => {
      barsInflight.delete(cacheKey);
    });

  if (!options?.signal) {
    barsInflight.set(cacheKey, request);
  }

  return request;
}

export async function fetchLastTrade(symbol: string): Promise<LastTradeResponse> {
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
  });

  const res = await fetch(`${API_BASE}/last-trade?${params.toString()}`);
  return parseJson<LastTradeResponse>(res);
}

export async function fetchScanner(params?: {
  max_symbols?: number;
  min_price?: number;
  max_price?: number;
  min_volume?: number;
  min_change_pct?: number;
}): Promise<ScannerResponse> {
  const qs = new URLSearchParams();

  if (params?.max_symbols != null) qs.set("max_symbols", String(params.max_symbols));
  if (params?.min_price != null) qs.set("min_price", String(params.min_price));
  if (params?.max_price != null) qs.set("max_price", String(params.max_price));
  if (params?.min_volume != null) qs.set("min_volume", String(params.min_volume));
  if (params?.min_change_pct != null) qs.set("min_change_pct", String(params.min_change_pct));

  const url = `${API_BASE}/scanner${qs.toString() ? `?${qs.toString()}` : ""}`;
  const res = await fetch(url);
  return parseJson<ScannerResponse>(res);
}

export type ScannerCacheResponse = {
  ok?: boolean;
  enabled?: boolean;
  running?: boolean;
  status?: string;
  last_run?: string | null;
  last_error?: string | null;
  run_count?: number;
  interval_seconds?: number;
  filters?: Record<string, unknown>;
  data?: ScannerResponse | null;
  all_data?: Record<string, unknown>;
  scanner_errors?: Record<string, string>;
};

export async function fetchScannerCache(
  scannerId?: string,
): Promise<ScannerCacheResponse> {
  const qs = new URLSearchParams();
  if (scannerId) qs.set("scanner_id", scannerId);
  const res = await fetch(
    `${API_BASE}/scanner/cache${qs.toString() ? `?${qs.toString()}` : ""}`,
  );
  return parseJson<ScannerCacheResponse>(res);
}

export type ScannerRefreshParams = Record<
  string,
  string | number | boolean | null | undefined
>;

function appendScannerParams(
  qs: URLSearchParams,
  params?: ScannerRefreshParams,
) {
  if (!params) return;

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    qs.set(key, String(value));
  });
}

export async function refreshScannerCache(
  params?: ScannerRefreshParams,
): Promise<ScannerCacheResponse> {
  const qs = new URLSearchParams();
  appendScannerParams(qs, params);

  const res = await fetch(
    `${API_BASE}/scanner/cache/refresh${qs.toString() ? `?${qs.toString()}` : ""}`,
    { method: "POST" },
  );

  return parseJson<ScannerCacheResponse>(res);
}

export type Vwap3TargetHitHistoryResponse = {
  trade_date: string;
  pacific_today: string;
  count: number;
  rows: Record<string, unknown>[];
};

export async function fetchVwap3TargetHitHistory(
  tradeDate?: string,
): Promise<Vwap3TargetHitHistoryResponse> {
  const qs = new URLSearchParams();
  if (tradeDate) qs.set("trade_date", tradeDate);
  const res = await fetch(
    `${API_BASE}/scanner-v2/vwap3/target-hits${qs.toString() ? `?${qs.toString()}` : ""}`,
    { cache: "no-store" },
  );
  return parseJson<Vwap3TargetHitHistoryResponse>(res);
}

const ENABLED_SCANNER_IDS = new Set(["vwap3_target"]);

export async function fetchScannerDefinitions(): Promise<ScannerDefinition[]> {
  const res = await fetch(`${API_BASE}/scanner-v2/list`);
  const definitions = await parseJson<ScannerDefinition[]>(res);
  return definitions.filter((definition) => ENABLED_SCANNER_IDS.has(definition.id));
}

export async function fetchOvernightSnapshots(
  scannerId: string,
): Promise<OvernightSnapshotListResponse> {
  const qs = new URLSearchParams({ scanner_id: scannerId });
  const res = await fetch(
    `${API_BASE}/scanner-v2/overnight/snapshots?${qs.toString()}`,
  );
  return parseJson<OvernightSnapshotListResponse>(res);
}

export async function saveAfterhoursSnapshot(
  params: ScannerRefreshParams & { scanner_id: string },
): Promise<OvernightSnapshotSaveResponse> {
  const qs = new URLSearchParams({ scanner_id: String(params.scanner_id) });
  appendScannerParams(qs, params);

  const res = await fetch(
    `${API_BASE}/scanner-v2/overnight/save-ah?${qs.toString()}`,
    { method: "POST" },
  );

  return parseJson<OvernightSnapshotSaveResponse>(res);
}

export async function runScannerV2(
  params: ScannerRefreshParams & {
    scanner_id: string;
    workflow?: "auto" | "combined" | "live";
  },
): Promise<ScannerV2Response> {
  const qs = new URLSearchParams({
    scanner_id: String(params.scanner_id),
    workflow: String(params.workflow ?? "combined"),
  });

  appendScannerParams(qs, params);

  const res = await fetch(`${API_BASE}/scanner-v2/run?${qs.toString()}`);
  return parseJson<ScannerV2Response>(res);
}

export async function runIfvgHtfScanner(
  params: ScannerRefreshParams = {},
): Promise<ScannerV2Response> {
  return runScannerV2({
    scanner_id: "ifvg_htf",
    workflow: "combined",
    max_symbols: 25,
    min_price: 0.5,
    max_price: 20,
    min_volume: 250000,
    timeframes: "15m",
    trigger_timeframe: "5m",
    ...params,
  });
}

export type BackendAlertSetup =
  | "compression_abs_breakout"
  | "failed_breakdown_reclaim"
  | "aggressive_buyers_reclaim"
  | "bullish_structure_shift"
  | "ifvg_retest"
  | "ifvg_bounce_confirmed"
  | "ifvg_failure"
  | "trendline_close_cross"
  | "trendline_near"
  | "projection_touch_cross"
  | "vwap_reclaim"
  | "pmh_break"
  | "rth_high_break"
  | "ah_high_break";

export type BackendAlertsConfig = {
  symbols: string[];
  timeframe?: string;
  timeframes?: string[];
  confluence_mode?: "any" | "all";
  alert_setups?: BackendAlertSetup[];
  poll_seconds: number;
  cooldown_seconds: number;
  lookback_bars: number;
  notify_phone: boolean;
  notify_webhook?: boolean;
  webhook_url?: string | null;
  alert_on_prealert?: boolean;
};

export type BackendAlertFeatures = {
  compression_score?: number;
  absorption_score?: number;
  rvol?: number;
  breakout_score?: number;
  vwap_score?: number;
  structure_score?: number;
  failed_breakdown_score?: number;
  aggressive_buyers_score?: number;
  [key: string]: any;
};

export type BackendAlertResult = {
  symbol: string;
  triggered?: boolean;
  setup?: string | null;
  phase?: "confirmed" | "prealert" | "none" | string;
  score?: number;
  reason?: string;
  message?: string;
  became_new?: boolean;
  features?: BackendAlertFeatures;
  state?: Record<string, any>;
  error?: string;
  [key: string]: any;
};

export type BackendAlertsStatus = {
  enabled: boolean;
  running?: boolean;
  symbols?: string[];
  effective_symbols?: string[];
  selected_symbols?: string[];
  scanner_auto_arm?: boolean;
  timeframe?: string;
  timeframes?: string[];
  confluence_mode?: "any" | "all";
  alert_setups?: BackendAlertSetup[];
  poll_seconds?: number;
  cooldown_seconds?: number;
  lookback_bars?: number;
  notify_phone?: boolean;
  notify_webhook?: boolean;
  webhook_url?: string | null;
  alert_on_prealert?: boolean;
  config?: Partial<BackendAlertsConfig>;
  last_check?: string | null;
  last_error?: string | null;
  last_alert_at?: string | null;
  last_alert?: BackendAlertResult | null;
  recent_results?: BackendAlertResult[];
  signal_config?: Record<string, any>;
};

export type SelectedAlertSymbolsResponse = {
  ok?: boolean;
  symbols: string[];
  count?: number;
  source?: string;
  scanner_auto_arm?: boolean;
  updated_at?: string;
};

export async function fetchSelectedAlertSymbols(): Promise<SelectedAlertSymbolsResponse> {
  const res = await fetch(`${API_BASE}/backend-alerts/selected-symbols`);
  return parseJson<SelectedAlertSymbolsResponse>(res);
}

export async function saveSelectedAlertSymbols(
  symbols: string[],
): Promise<SelectedAlertSymbolsResponse> {
  const clean = Array.from(
    new Set(
      symbols
        .map((symbol) => String(symbol).trim().toUpperCase())
        .filter(Boolean),
    ),
  );

  const res = await fetch(`${API_BASE}/backend-alerts/selected-symbols`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ symbols: clean }),
  });

  return parseJson<SelectedAlertSymbolsResponse>(res);
}

export async function toggleSelectedAlertSymbol(
  symbol: string,
  enabled?: boolean,
): Promise<SelectedAlertSymbolsResponse> {
  const payload: { symbol: string; enabled?: boolean } = {
    symbol: String(symbol).trim().toUpperCase(),
  };

  if (enabled !== undefined) payload.enabled = enabled;

  const res = await fetch(
    `${API_BASE}/backend-alerts/selected-symbols/toggle`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  return parseJson<SelectedAlertSymbolsResponse>(res);
}

export async function fetchBackendAlertsStatus(): Promise<BackendAlertsStatus> {
  const res = await fetch(`${API_BASE}/backend-alerts/status`);
  return parseJson<BackendAlertsStatus>(res);
}

export async function startBackendAlerts(
  payload: Partial<BackendAlertsConfig> = {},
): Promise<BackendAlertsStatus> {
  const res = await fetch(`${API_BASE}/backend-alerts/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return parseJson<BackendAlertsStatus>(res);
}

export async function stopBackendAlerts(): Promise<BackendAlertsStatus> {
  const res = await fetch(`${API_BASE}/backend-alerts/stop`, {
    method: "POST",
  });

  return parseJson<BackendAlertsStatus>(res);
}

export async function updateBackendAlertsConfig(
  payload: Partial<BackendAlertsConfig>,
): Promise<BackendAlertsStatus> {
  const res = await fetch(`${API_BASE}/backend-alerts/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return parseJson<BackendAlertsStatus>(res);
}

export type InstantChartAlertPayload = {
  symbol: string;
  timeframe: string;
  setup: BackendAlertSetup | string;
  phase: "confirmed" | "prealert" | "none" | string;
  score?: number;
  message: string;
  reason?: string;
  features?: Record<string, any>;
  source?: "frontend" | "backend" | string;
  debounce_key?: string;
};

export async function sendInstantChartAlert(
  payload: InstantChartAlertPayload,
): Promise<any> {
  const res = await fetch(`${API_BASE}/backend-alerts/instant-chart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    keepalive: true,
    body: JSON.stringify(payload),
  });

  return parseJson(res);
}

export async function sendBackendTestAlert(
  title: string,
  message: string,
): Promise<any> {
  const res = await fetch(`${API_BASE}/alerts/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, message }),
  });

  return parseJson(res);
}

export type AlpacaMode = "paper" | "live";
export type AlpacaSide = "buy" | "sell";
export type AlpacaOrderType = "market" | "limit";
export type AlpacaOrderClass = "simple" | "bracket" | "oco" | "oto";

export type AlpacaTakeProfit = {
  limit_price: number;
};

export type AlpacaStopLoss = {
  stop_price: number;
  limit_price?: number;
};

export type PlaceAlpacaOrderRequest = {
  symbol: string;
  qty: number;
  side: AlpacaSide;
  type: AlpacaOrderType;
  time_in_force?: string;
  limit_price?: number;
  mode?: AlpacaMode;
  extended_hours?: boolean;
  order_class?: AlpacaOrderClass;
  take_profit?: AlpacaTakeProfit;
  stop_loss?: AlpacaStopLoss;
};

const ALPACA_NO_CACHE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
};

export async function fetchAlpacaAccount(mode: AlpacaMode = "paper") {
  const params = new URLSearchParams({
    mode,
    _ts: String(Date.now()),
  });

  const res = await fetch(
    `${API_BASE}/alpaca/account?${params.toString()}`,
    {
      cache: "no-store",
      headers: ALPACA_NO_CACHE_HEADERS,
    },
  );

  return parseJson(res);
}

export async function fetchAlpacaPositions(mode: AlpacaMode = "paper") {
  const params = new URLSearchParams({
    mode,
    _ts: String(Date.now()),
  });

  const res = await fetch(
    `${API_BASE}/alpaca/positions?${params.toString()}`,
    {
      cache: "no-store",
      headers: ALPACA_NO_CACHE_HEADERS,
    },
  );

  return parseJson(res);
}

export async function fetchAlpacaOrders(
  mode: AlpacaMode = "paper",
  status: "open" | "closed" | "all" = "open",
  nested = true,
) {
  const params = new URLSearchParams({
    mode,
    status,
    nested: String(nested),
    // Pull enough recent broker history to reconstruct completed round trips
    // even after a browser refresh or date rollover.
    limit: "500",
    _ts: String(Date.now()),
  });

  const res = await fetch(
    `${API_BASE}/alpaca/orders?${params.toString()}`,
    {
      cache: "no-store",
      headers: ALPACA_NO_CACHE_HEADERS,
    },
  );

  return parseJson(res);
}

export async function placeAlpacaOrder(
  payload: PlaceAlpacaOrderRequest,
) {
  const cleanPayload = {
    ...payload,
    symbol: payload.symbol.toUpperCase(),
    time_in_force: payload.time_in_force ?? "day",
    mode: payload.mode ?? "paper",
    extended_hours: payload.extended_hours ?? false,
  };

  console.log("[api] placing Alpaca order", cleanPayload);

  const res = await fetch(`${API_BASE}/alpaca/order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...ALPACA_NO_CACHE_HEADERS,
    },
    cache: "no-store",
    body: JSON.stringify(cleanPayload),
  });

  return parseJson(res);
}

export type UpdateAlpacaOrderRequest = {
  qty?: number;
  limit_price?: number;
  stop_price?: number;
  time_in_force?: string;
  mode?: AlpacaMode;
};

export async function updateAlpacaOrder(
  orderId: string,
  payload: UpdateAlpacaOrderRequest,
  mode: AlpacaMode = "paper",
) {
  const params = new URLSearchParams({
    mode,
    _ts: String(Date.now()),
  });

  const res = await fetch(
    `${API_BASE}/alpaca/order/${orderId}?${params.toString()}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...ALPACA_NO_CACHE_HEADERS,
      },
      cache: "no-store",
      body: JSON.stringify({
        ...payload,
        mode: payload.mode ?? mode,
      }),
    },
  );

  return parseJson(res);
}

export async function cancelAlpacaOrder(
  orderId: string,
  mode: AlpacaMode = "paper",
) {
  const params = new URLSearchParams({
    mode,
    _ts: String(Date.now()),
  });

  const res = await fetch(
    `${API_BASE}/alpaca/order/${orderId}?${params.toString()}`,
    {
      method: "DELETE",
      cache: "no-store",
      headers: ALPACA_NO_CACHE_HEADERS,
    },
  );

  return parseJson(res);
}

export type AutoTradeSource = "manual" | "scanner" | "both";
export type AutoTradeSizingMode = "dollars" | "shares";
export type AutoTradeRunnerMode = "off" | "scale_trail";
export type AutoTradeEntryTriggerMode = "reclaim_close" | "sweep_touch";
export type AutoTradeStrategy =
  | "six_seven_sweep"
  | "five_am_sweep"
  | "overnight_protected_order"
  | "overnite_hail_mary";

export type AutoTradeStrategyConfig = {
  enabled: boolean;
  strategy_id: AutoTradeStrategy;
  weight: number;
  min_score: number;
};

export type AutoTradeConfig = {
  enabled: boolean;
  mode: AlpacaMode;
  allow_live: boolean;
  source: AutoTradeSource;
  timeframe: "1m" | "5m" | "15m";
  sizing_mode: AutoTradeSizingMode;
  trade_amount: number;
  fixed_shares: number;
  max_active_trades: number;
  min_profit_range: number;
  sweep_buffer_pct: number;
  stop_buffer_pct: number;
  target_r: number;
  poll_seconds: number;
  extended_hours: boolean;
  max_symbols: number;
  require_flat_account: boolean;
  max_signal_age_bars: number;
  runner_mode: AutoTradeRunnerMode;
  entry_trigger_mode: AutoTradeEntryTriggerMode;
  scale_out_pct: number;
  trail_lookback_bars: number;
  trail_buffer_pct: number;
  strategies: AutoTradeStrategyConfig[];
};

export type AutoTradeStatus = {
  config: AutoTradeConfig;
  running: boolean;
  status: string;
  worker?: Record<string, any>;
  last_check?: string | null;
  last_error?: string | null;
  last_skip?: any;
  last_signal?: any;
  last_order?: any;
  runner_states?: Record<string, any>;
  pending_entries?: any[];
  active_trades?: any[];
  queued_manual_plans?: any[];
  manual_trade_plans?: any[];
  history?: any[];
};

export type AutoTradeConfigUpdate = Partial<AutoTradeConfig>;

const AUTO_TRADE_STATUS_CACHE_MS = 4_500;
let autoTradeStatusCache: AutoTradeStatus | null = null;
let autoTradeStatusCacheAt = 0;
let autoTradeStatusInFlight: Promise<AutoTradeStatus> | null = null;

function rememberAutoTradeStatus(status: AutoTradeStatus): AutoTradeStatus {
  autoTradeStatusCache = status;
  autoTradeStatusCacheAt = Date.now();
  return status;
}

function clearAutoTradeStatusCache(): void {
  autoTradeStatusCache = null;
  autoTradeStatusCacheAt = 0;
}

export async function fetchAutoTradeStatus(): Promise<AutoTradeStatus> {
  const now = Date.now();
  if (
    autoTradeStatusCache &&
    now - autoTradeStatusCacheAt < AUTO_TRADE_STATUS_CACHE_MS
  ) {
    return autoTradeStatusCache;
  }

  if (autoTradeStatusInFlight) {
    return autoTradeStatusInFlight;
  }

  autoTradeStatusInFlight = (async () => {
    const res = await fetch(`${API_BASE}/auto-trade/status`);
    const status = await parseJson<AutoTradeStatus>(res);
    return rememberAutoTradeStatus(status);
  })();

  try {
    return await autoTradeStatusInFlight;
  } finally {
    autoTradeStatusInFlight = null;
  }
}

export async function updateAutoTradeConfig(
  payload: AutoTradeConfigUpdate,
): Promise<AutoTradeStatus> {
  const res = await fetch(`${API_BASE}/auto-trade/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  clearAutoTradeStatusCache();
  const status = await parseJson<AutoTradeStatus>(res);
  return rememberAutoTradeStatus(status);
}

export async function startAutoTrade(
  payload: AutoTradeConfigUpdate = {},
): Promise<AutoTradeStatus> {
  const res = await fetch(`${API_BASE}/auto-trade/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  clearAutoTradeStatusCache();
  const status = await parseJson<AutoTradeStatus>(res);
  return rememberAutoTradeStatus(status);
}

export async function stopAutoTrade(): Promise<AutoTradeStatus> {
  const res = await fetch(`${API_BASE}/auto-trade/stop`, {
    method: "POST",
  });

  clearAutoTradeStatusCache();
  const status = await parseJson<AutoTradeStatus>(res);
  return rememberAutoTradeStatus(status);
}

export async function checkAutoTradeOnce(): Promise<any> {
  const res = await fetch(`${API_BASE}/auto-trade/check-once`, {
    method: "POST",
  });

  return parseJson<any>(res);
}

export type ManualTradePlanRequest = {
  symbol: string;
  entry_price: number;
  stop_price: number;
  target_price: number;
  qty?: number;
  trade_amount?: number;
  fixed_shares?: number;
  mode?: AlpacaMode;
  sizing_mode?: AutoTradeSizingMode;
  extended_hours?: boolean;
  strategy_id?: AutoTradeStrategy | string;
  setup?: string;
  note?: string;
};

export async function queueOvernightProtectedOrder(
  payload: ManualTradePlanRequest,
): Promise<AutoTradeStatus> {
  const res = await fetch(`${API_BASE}/auto-trade/overnight-protected-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      strategy_id: "overnight_protected_order",
      setup: "overnight_protected_limit_entry_stop_target",
      extended_hours: true,
    }),
  });

  clearAutoTradeStatusCache();
  const status = await parseJson<AutoTradeStatus>(res);
  return rememberAutoTradeStatus(status);
}

export type ProtectedOrderChartLevel = "entry" | "stop" | "target";

export async function updateOvernightProtectedOrderPrice(
  symbol: string,
  level: ProtectedOrderChartLevel,
  price: number,
): Promise<AutoTradeStatus> {
  const safeSymbol = String(symbol ?? "").trim().toUpperCase();
  const res = await fetch(
    `${API_BASE}/auto-trade/overnight-protected-order/${encodeURIComponent(safeSymbol)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, price }),
    },
  );

  clearAutoTradeStatusCache();
  const status = await parseJson<AutoTradeStatus>(res);
  return rememberAutoTradeStatus(status);
}

export type ProtectedPositionAction =
  | { action: "scale_out"; percent: number }
  | { action: "close_all" }
  | { action: "trail_start" }
  | { action: "trail_stop" };

export async function requestOvernightProtectedPositionAction(
  symbol: string,
  action: ProtectedPositionAction,
): Promise<AutoTradeStatus> {
  const safeSymbol = String(symbol ?? "").trim().toUpperCase();
  const res = await fetch(
    `${API_BASE}/auto-trade/overnight-protected-order/${encodeURIComponent(safeSymbol)}/action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    },
  );

  clearAutoTradeStatusCache();
  const status = await parseJson<AutoTradeStatus>(res);
  return rememberAutoTradeStatus(status);
}

/** @deprecated Use queueOvernightProtectedOrder. */
export async function queueOverniteHailMaryPlan(
  payload: ManualTradePlanRequest,
): Promise<AutoTradeStatus> {
  return queueOvernightProtectedOrder(payload);
}

export async function queueManualTradePlan(
  payload: ManualTradePlanRequest,
): Promise<AutoTradeStatus> {
  const res = await fetch(`${API_BASE}/auto-trade/manual-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  clearAutoTradeStatusCache();
  const status = await parseJson<AutoTradeStatus>(res);
  return rememberAutoTradeStatus(status);
}

export type SharedChartRange = {
  from: number;
  to: number;
};

export type SharedAlpacaStatePayload = {
  selectedSymbol?: string | null;
  timeframe?: string | null;
  activeChart?: string | null;
  watchlist?: string[];
  manualWatchlist?: string[];
  studyVisibility?: Record<string, boolean>;
  chartRanges?: Record<string, SharedChartRange>;
  updatedAt?: number | null;
};

export async function fetchSharedAlpacaState(): Promise<SharedAlpacaStatePayload | null> {
  const res = await fetch(`${API_BASE}/app-state/alpaca`);
  if (res.status === 404) return null;
  return parseJson<SharedAlpacaStatePayload | null>(res);
}

export async function saveSharedAlpacaState(
  payload: SharedAlpacaStatePayload,
): Promise<SharedAlpacaStatePayload> {
  const res = await fetch(`${API_BASE}/app-state/alpaca`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return parseJson<SharedAlpacaStatePayload>(res);
}

export type LiveBarMessage = {
  type?: string;
  symbol?: string;
  timeframe?: string;
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  v?: number;
};

export function resolveWsBaseUrl(): string {
  const apiBase = API_BASE.replace(/\/$/, "");
  return apiBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

export function connectChartV2BarsSocket(params: {
  symbol: string;
  timeframe: string;
  onBar: (bar: LiveBarMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
}): WebSocket {
  const symbol = params.symbol.trim().toUpperCase();
  const timeframe = params.timeframe.trim().toLowerCase();

  const qs = new URLSearchParams({
    symbol,
    timeframe,
  });

  const ws = new WebSocket(
    `${resolveWsBaseUrl()}/ws/chart-bars?${qs.toString()}`,
  );

  ws.onopen = () => {
    console.log("[ChartV2 WS] connected", symbol, timeframe);
    params.onOpen?.();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // The Alpaca backend sends chart updates as an array containing one
      // normalized candle. Keep compatibility with older object and { bar }
      // payloads as well.
      const candidates = Array.isArray(msg) ? msg : [msg?.bar ?? msg];

      for (const bar of candidates) {
        if (
          bar &&
          bar.time != null &&
          bar.open != null &&
          bar.high != null &&
          bar.low != null &&
          bar.close != null
        ) {
          params.onBar(bar as LiveBarMessage);
        }
      }
    } catch (err) {
      console.error("[ChartV2 WS] bad message", event.data, err);
    }
  };

  ws.onerror = (err) => {
    console.error("[ChartV2 WS] error", err);
    params.onError?.(err);
  };

  ws.onclose = () => {
    console.log("[ChartV2 WS] closed", symbol, timeframe);
    params.onClose?.();
  };

  return ws;
}

export type Vwap3TradeCoachEntryQuality = {
  score: number;
  label: string;
  delay_minutes?: number | null;
  entry_vs_freeze_pct?: number | null;
  target_remaining_pct_at_entry?: number | null;
  risk_to_displacement_low_pct?: number | null;
};

export type Vwap3TradeCoachReview = {
  trade_id: string;
  symbol: string;
  reviewed_at: string;
  scanner_match: boolean;
  setup_key?: string;
  scanner_grade?: string;
  scanner_status?: string;
  scanner_detected_at?: string;
  freeze_time?: string;
  freeze_price?: number;
  frozen_target?: number;
  displacement_low?: number;
  displacement_high?: number;
  entry_after_scanner?: boolean;
  entry_quality?: Vwap3TradeCoachEntryQuality;
  classification: string;
  classification_label?: string;
  confidence: number;
  headline: string;
  summary: string;
  setup_valid_at_exit?: boolean;
  target_hit_after_exit?: boolean;
  target_hit_after_exit_time?: string | null;
  minutes_exit_to_target?: number | null;
  missed_upside_per_share?: number;
  estimated_missed_pnl_to_target?: number;
  mfe_after_exit_pct?: number;
  path?: Record<string, unknown>;
  historical_context?: {
    study_days?: number;
    sample_size?: number;
    best_observed_pullback?: {
      pullback_pct: number;
      opportunities: number;
      target_hits: number;
      hit_rate_pct: number | null;
    } | null;
  };
  scanner_setup?: Record<string, unknown>;
};

export type Vwap3TradeCoachReviewRequest = {
  trade_id: string;
  symbol: string;
  side: string;
  shares: number;
  entry_price: number;
  exit_price: number;
  entry_time: string;
  exit_time: string;
  planned_target?: number;
  planned_stop?: number;
  strategy?: string;
  realized_pnl?: number;
  r_multiple?: number;
};

export async function reviewVwap3Trade(
  payload: Vwap3TradeCoachReviewRequest,
): Promise<Vwap3TradeCoachReview> {
  const res = await fetch(`${API_BASE}/trading-coach/vwap3/review-trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  return parseJson<Vwap3TradeCoachReview>(res);
}

export type Vwap3StudyBucket = {
  setups: number;
  resolved: number;
  target_hits: number;
  target_hits_after_invalidation: number;
  eventual_target_hits: number;
  invalidated: number;
  expired: number;
  hit_rate_pct: number | null;
  eventual_target_rate_pct: number | null;
  median_pullback_before_target_pct: number | null;
  median_minutes_to_target: number | null;
};

export type Vwap3StudyResponse = {
  generated_at: string;
  days: number;
  overall: Vwap3StudyBucket;
  by_grade: Record<string, Vwap3StudyBucket>;
  pullback_entry_tests: Array<{
    pullback_pct: number;
    opportunities: number;
    target_hits: number;
    hit_rate_pct: number | null;
  }>;
  best_observed_pullback?: {
    pullback_pct: number;
    opportunities: number;
    target_hits: number;
    hit_rate_pct: number | null;
  } | null;
  notes: string[];
};

export async function fetchVwap3CoachStudy(
  days = 30,
): Promise<Vwap3StudyResponse> {
  const qs = new URLSearchParams({ days: String(days) });
  const res = await fetch(
    `${API_BASE}/trading-coach/vwap3/study?${qs.toString()}`,
    { cache: "no-store" },
  );
  return parseJson<Vwap3StudyResponse>(res);
}
