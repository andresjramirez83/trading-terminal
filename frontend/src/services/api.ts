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

      // If env/config is only http://165.22.145.148, that hits frontend/nginx.
      // FastAPI is on :8000, so force :8000 for bare origins with no explicit port.
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

/* =========================
   CORE FETCH HELPER
   ========================= */

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

/* =========================
   MARKET DATA
   ========================= */

type BarsCacheEntry = {
  expiresAt: number;
  data: BarsResponse;
};

const BARS_CACHE_TTL_MS = 45_000;
const barsCache = new Map<string, BarsCacheEntry>();
const barsInflight = new Map<string, Promise<BarsResponse>>();

function normalizeLookback(timeframe: string, requested?: string): string {
  if (requested) return requested;
  switch (timeframe.toLowerCase()) {
    case "1m":
      return "2d";
    case "5m":
      return "3d";
    case "15m":
      return "5d";
    case "30m":
      return "10d";
    case "1h":
      return "20d";
    case "1d":
    case "day":
      return "6m";
    default:
      return "3d";
  }
}

function defaultBarsLimit(timeframe: string): number {
  switch (timeframe.toLowerCase()) {
    case "1m":
      return 650;
    case "5m":
      return 550;
    case "15m":
      return 450;
    case "30m":
      return 400;
    case "1h":
      return 350;
    case "1d":
    case "day":
      return 500;
    default:
      return 500;
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
    forceRefresh?: boolean;
    limit?: number;
  }
): Promise<BarsResponse> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedTimeframe = timeframe.trim().toLowerCase();
  const normalizedLookback = normalizeLookback(normalizedTimeframe, options?.lookback);

  const params = new URLSearchParams({
    symbol: normalizedSymbol,
    timeframe: normalizedTimeframe,
  });

  if (options?.date) params.set("date", options.date);
  if (normalizedLookback) params.set("lookback", normalizedLookback);
  const limit = Math.max(50, Math.min(5000, Math.floor(options?.limit ?? defaultBarsLimit(normalizedTimeframe))));
  params.set("limit", String(limit));

  const cacheKey = `${normalizedSymbol}|${normalizedTimeframe}|${options?.date ?? ""}|${normalizedLookback}|${limit}`;
  const now = Date.now();

  if (!options?.forceRefresh) {
    const cached = barsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const inflight = barsInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }
  }

  const request = fetch(`${API_BASE}/bars?${params.toString()}`)
    .then((res) => parseJson<BarsResponse>(res))
    .then((data) => {
      barsCache.set(cacheKey, {
        expiresAt: Date.now() + BARS_CACHE_TTL_MS,
        data,
      });
      return data;
    })
    .finally(() => {
      barsInflight.delete(cacheKey);
    });

  barsInflight.set(cacheKey, request);
  return request;
}

export async function fetchLastTrade(symbol: string): Promise<LastTradeResponse> {
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
  });

  const res = await fetch(`${API_BASE}/last-trade?${params.toString()}`);
  return parseJson<LastTradeResponse>(res);
}

/* =========================
   SCANNER
   ========================= */

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
};

export async function fetchScannerCache(): Promise<ScannerCacheResponse> {
  const res = await fetch(`${API_BASE}/scanner/cache`);
  return parseJson<ScannerCacheResponse>(res);
}

export type ScannerRefreshParams = Record<string, string | number | boolean | null | undefined>;

function appendScannerParams(qs: URLSearchParams, params?: ScannerRefreshParams) {
  if (!params) return;
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    qs.set(key, String(value));
  });
}

export async function refreshScannerCache(params?: ScannerRefreshParams): Promise<ScannerCacheResponse> {
  const qs = new URLSearchParams();
  appendScannerParams(qs, params);

  const res = await fetch(`${API_BASE}/scanner/cache/refresh${qs.toString() ? `?${qs.toString()}` : ""}`, {
    method: "POST",
  });
  return parseJson<ScannerCacheResponse>(res);
}

export async function fetchScannerDefinitions(): Promise<ScannerDefinition[]> {
  const res = await fetch(`${API_BASE}/scanner-v2/list`);
  return parseJson<ScannerDefinition[]>(res);
}

export async function fetchOvernightSnapshots(
  scannerId: string
): Promise<OvernightSnapshotListResponse> {
  const qs = new URLSearchParams({ scanner_id: scannerId });
  const res = await fetch(`${API_BASE}/scanner-v2/overnight/snapshots?${qs.toString()}`);
  return parseJson<OvernightSnapshotListResponse>(res);
}

export async function saveAfterhoursSnapshot(params: ScannerRefreshParams & { scanner_id: string }): Promise<OvernightSnapshotSaveResponse> {
  const qs = new URLSearchParams({ scanner_id: String(params.scanner_id) });
  appendScannerParams(qs, params);

  const res = await fetch(`${API_BASE}/scanner-v2/overnight/save-ah?${qs.toString()}`, {
    method: "POST",
  });

  return parseJson<OvernightSnapshotSaveResponse>(res);
}

export async function runScannerV2(params: ScannerRefreshParams & { scanner_id: string; workflow?: "auto" | "combined" | "live" }): Promise<ScannerV2Response> {
  const qs = new URLSearchParams({
    scanner_id: String(params.scanner_id),
    workflow: String(params.workflow ?? "combined"),
  });
  appendScannerParams(qs, params);

  const res = await fetch(`${API_BASE}/scanner-v2/run?${qs.toString()}`);
  return parseJson<ScannerV2Response>(res);
}

export async function runIfvgHtfScanner(params: ScannerRefreshParams = {}): Promise<ScannerV2Response> {
  return runScannerV2({
    scanner_id: "ifvg_htf",
    workflow: "combined",
    max_symbols: 25,
    min_price: 0.5,
    max_price: 20,
    min_volume: 250000,
    ...params,
  });
}

/* =========================
   BACKEND ALERTS
   ========================= */

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
  timeframe?: string; // legacy single-timeframe field; backend still accepts it
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

export async function saveSelectedAlertSymbols(symbols: string[]): Promise<SelectedAlertSymbolsResponse> {
  const clean = Array.from(new Set(symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)));
  const res = await fetch(`${API_BASE}/backend-alerts/selected-symbols`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ symbols: clean }),
  });
  return parseJson<SelectedAlertSymbolsResponse>(res);
}

export async function toggleSelectedAlertSymbol(symbol: string, enabled?: boolean): Promise<SelectedAlertSymbolsResponse> {
  const payload: { symbol: string; enabled?: boolean } = { symbol: String(symbol).trim().toUpperCase() };
  if (enabled !== undefined) payload.enabled = enabled;

  const res = await fetch(`${API_BASE}/backend-alerts/selected-symbols/toggle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return parseJson<SelectedAlertSymbolsResponse>(res);
}

export async function fetchBackendAlertsStatus(): Promise<BackendAlertsStatus> {
  const res = await fetch(`${API_BASE}/backend-alerts/status`);
  return parseJson<BackendAlertsStatus>(res);
}

export async function startBackendAlerts(
  payload: Partial<BackendAlertsConfig> = {}
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
  payload: Partial<BackendAlertsConfig>
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

export async function sendInstantChartAlert(payload: InstantChartAlertPayload): Promise<any> {
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
  message: string
): Promise<any> {
  const res = await fetch(`${API_BASE}/alerts/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      message,
    }),
  });

  return parseJson(res);
}

/* =========================
   ALPACA API
   ========================= */

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

export async function fetchAlpacaAccount(mode: AlpacaMode = "paper") {
  const res = await fetch(`${API_BASE}/alpaca/account?mode=${mode}`);
  return parseJson(res);
}

export async function fetchAlpacaPositions(mode: AlpacaMode = "paper") {
  const res = await fetch(`${API_BASE}/alpaca/positions?mode=${mode}`);
  return parseJson(res);
}

export async function fetchAlpacaOrders(
  mode: AlpacaMode = "paper",
  status: "open" | "closed" | "all" = "open"
) {
  const res = await fetch(`${API_BASE}/alpaca/orders?mode=${mode}&status=${status}`);
  return parseJson(res);
}

export async function placeAlpacaOrder(payload: PlaceAlpacaOrderRequest) {
  const res = await fetch(`${API_BASE}/alpaca/order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...payload,
      symbol: payload.symbol.toUpperCase(),
      time_in_force: payload.time_in_force ?? "day",
      mode: payload.mode ?? "paper",
      extended_hours: payload.extended_hours ?? false,
    }),
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
  mode: AlpacaMode = "paper"
) {
  const res = await fetch(`${API_BASE}/alpaca/order/${orderId}?mode=${mode}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...payload,
      mode: payload.mode ?? mode,
    }),
  });

  return parseJson(res);
}

export async function cancelAlpacaOrder(
  orderId: string,
  mode: AlpacaMode = "paper"
) {
  const res = await fetch(`${API_BASE}/alpaca/order/${orderId}?mode=${mode}`, {
    method: "DELETE",
  });

  return parseJson(res);
}

/* =========================
   SHARED APP STATE SYNC
   ========================= */

export type SharedChartRange = { from: number; to: number };

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

export async function saveSharedAlpacaState(payload: SharedAlpacaStatePayload): Promise<SharedAlpacaStatePayload> {
  const res = await fetch(`${API_BASE}/app-state/alpaca`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseJson<SharedAlpacaStatePayload>(res);
}
