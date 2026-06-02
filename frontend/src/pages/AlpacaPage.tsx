import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import ChartPanel, { type OverlayVisibility, type TrendlineControlAction } from "../components/ChartPanel";
import ScannerPanel from "../components/ScannerPanel";
import GlobalHotkeys from "../components/GlobalHotkeys";
import QuickOrderModal, { type OrderTemplate } from "../components/QuickOrderModal";
import QuickAlertModal from "../components/QuickAlertModal";
import {
  fetchAlpacaAccount,
  fetchAlpacaOrders,
  fetchAlpacaPositions,
  placeAlpacaOrder,
  cancelAlpacaOrder,
  updateAlpacaOrder,
  sendBackendTestAlert,
  fetchSharedAlpacaState,
  saveSharedAlpacaState,
  fetchAutoTradeStatus,
  updateAutoTradeConfig,
  startAutoTrade,
  stopAutoTrade,
  checkAutoTradeOnce,
  queueOverniteHailMaryPlan,
  API_BASE,
  type SharedChartRange,
  type AutoTradeStatus,
  type AutoTradeSource,
  type AutoTradeSizingMode,
  type AutoTradeStrategy,
} from "../services/api";
import type { PlaceAlpacaOrderRequest } from "../types/market";

type AlpacaMode = "paper" | "live";

type OverlayPreset = "clean" | "runner" | "levels" | "confirmation";

const STUDY_OPTIONS: Array<{ key: keyof OverlayVisibility; label: string }> = [
  { key: "pmh", label: "PMH" },
  { key: "vwap", label: "VWAP" },
  { key: "compression", label: "Compression" },
  { key: "choch", label: "Change of Character" },
  { key: "sessionBands", label: "Session Bands" },
  { key: "projections", label: "Projections" },
  { key: "trendlines", label: "Trendlines" },
  { key: "fakeEngulfing", label: "Fake Engulfing / Fakeouts" },
  { key: "significantCandles", label: "Significant Candle Dots" },
  { key: "liquiditySweeps", label: "Liquidity Sweeps" },
  { key: "sixSevenSweep", label: "6-7 Sweep Entry/Target" },
  { key: "volumeSignals", label: "Volume Signals" },
  { key: "volumeProfile", label: "Volume Profile" },
  { key: "shortSqueezeEstimate", label: "Short Squeeze Estimate" },
  { key: "previousRthHighLow", label: "Previous Day RTH High/Low" },
  { key: "bodyBreakDots", label: "Black Dots" },
  { key: "closeAbovePrevCloseDots", label: "White Dots" },
  { key: "atrExpansionCandles", label: "ATR Expansion Candles" },
  { key: "resistanceBreakoutConfirm", label: "Resistance Breakout Confirm" },
  { key: "fvgFlip", label: "FVG / IFVG Flip" },
  { key: "trendlineCloseAlerts", label: "Trendline Close Alerts" },
  { key: "adaptiveRunnerRsi", label: "Adaptive Runner RSI" },
];

const ALL_STUDIES_ON: OverlayVisibility = {
  pmh: true,
  vwap: true,
  compression: true,
  choch: true,
  sessionBands: true,
  projections: true,
  trendlines: true,
  fakeEngulfing: true,
  significantCandles: true,
  liquiditySweeps: true,
  sixSevenSweep: true,
  volumeSignals: true,
  volumeProfile: true,
  shortSqueezeEstimate: true,
  previousRthHighLow: true,
  bodyBreakDots: true,
  closeAbovePrevCloseDots: true,
  atrExpansionCandles: true,
  resistanceBreakoutConfirm: true,
  fvgFlip: true,
  trendlineCloseAlerts: true,
  adaptiveRunnerRsi: true,
};

const ALL_STUDIES_OFF: OverlayVisibility = {
  pmh: false,
  vwap: false,
  compression: false,
  choch: false,
  sessionBands: false,
  projections: false,
  trendlines: false,
  fakeEngulfing: false,
  significantCandles: false,
  liquiditySweeps: false,
  sixSevenSweep: false,
  volumeSignals: false,
  volumeProfile: false,
  shortSqueezeEstimate: false,
  previousRthHighLow: false,
  bodyBreakDots: false,
  closeAbovePrevCloseDots: false,
  atrExpansionCandles: false,
  resistanceBreakoutConfirm: false,
  fvgFlip: false,
  trendlineCloseAlerts: false,
  adaptiveRunnerRsi: false,
};

const OVERLAY_PRESETS: Record<OverlayPreset, OverlayVisibility> = {
  clean: ALL_STUDIES_OFF,
  runner: ALL_STUDIES_ON,
  levels: {
    ...ALL_STUDIES_OFF,
    pmh: true,
    vwap: true,
    sessionBands: true,
    trendlines: true,
    trendlineCloseAlerts: true,
    previousRthHighLow: true,
    volumeProfile: true,
  },
  confirmation: {
    ...ALL_STUDIES_OFF,
    vwap: true,
    compression: true,
    choch: true,
    projections: true,
    trendlines: true,
    trendlineCloseAlerts: true,
    significantCandles: true,
    volumeSignals: true,
    volumeProfile: true,
    bodyBreakDots: true,
    closeAbovePrevCloseDots: true,
    atrExpansionCandles: true,
    resistanceBreakoutConfirm: true,
    fvgFlip: true,
  },
};

// IMPORTANT:
// The previous Alpaca page defaulted every study OFF and stored that state under
// *.v2.defaultOff. That parent visibility object overrides ChartPanel, which is
// why only projections / 6-7 sweep appeared after ChartPanel was fixed.
// Use a fresh default-ON key so old localStorage cannot silently disable studies.
const DEFAULT_VISIBILITY: OverlayVisibility = ALL_STUDIES_ON;

const SHARED_STUDY_VISIBILITY_STORAGE_KEY = "sharedChartStudyVisibility.v3.defaultOn";
const CHART_STUDY_VISIBILITY_STORAGE_KEY = "alpacaChartStudyVisibilityByTimeframe.v3.defaultOn";
type ChartTimeframe = Exclude<ExpandedChartKey, null>;
type ChartStudyVisibilityMap = Record<ChartTimeframe, OverlayVisibility>;
type ChartPresetMap = Record<ChartTimeframe, OverlayPreset>;

function normalizeOverlayVisibility(value: Partial<OverlayVisibility> | null | undefined): OverlayVisibility {
  return {
    ...DEFAULT_VISIBILITY,
    ...(value ?? {}),
  };
}

function buildDefaultChartStudyVisibilityMap(): ChartStudyVisibilityMap {
  return {
    "1m": { ...DEFAULT_VISIBILITY },
    "5m": { ...DEFAULT_VISIBILITY },
    "15m": { ...DEFAULT_VISIBILITY },
  };
}

function loadChartStudyVisibilityMap(): ChartStudyVisibilityMap {
  const defaults = buildDefaultChartStudyVisibilityMap();
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(CHART_STUDY_VISIBILITY_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<ChartTimeframe, Partial<OverlayVisibility>>>;
    return {
      "1m": normalizeOverlayVisibility(parsed["1m"]),
      "5m": normalizeOverlayVisibility(parsed["5m"]),
      "15m": normalizeOverlayVisibility(parsed["15m"]),
    };
  } catch {
    return defaults;
  }
}

function saveChartStudyVisibilityMap(nextMap: ChartStudyVisibilityMap) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CHART_STUDY_VISIBILITY_STORAGE_KEY, JSON.stringify(nextMap));
}

function countVisibleStudies(visibility: OverlayVisibility): number {
  return STUDY_OPTIONS.filter((study) => visibility[study.key]).length;
}

function loadSharedStudyVisibility(): OverlayVisibility {
  if (typeof window === "undefined") return DEFAULT_VISIBILITY;
  try {
    const raw = window.localStorage.getItem(SHARED_STUDY_VISIBILITY_STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBILITY;
    return normalizeOverlayVisibility(JSON.parse(raw));
  } catch {
    return DEFAULT_VISIBILITY;
  }
}

function saveSharedStudyVisibility(nextVisibility: OverlayVisibility) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SHARED_STUDY_VISIBILITY_STORAGE_KEY, JSON.stringify(nextVisibility));
  window.dispatchEvent(
    new CustomEvent<OverlayVisibility>("shared-chart-study-visibility-change", {
      detail: nextVisibility,
    })
  );
}


const EMERGENCY_FALLBACK_SYMBOL = "AAPL";

const MANUAL_WATCHLIST_STORAGE_KEY = "alpacaManualWatchlist";
const SCANNER_WATCHLIST_STORAGE_KEY = "watchlist";
const ACTIVE_SYMBOL_STORAGE_KEY = "activeSymbol";
const ACTIVE_ALPACA_CHART_STORAGE_KEY = "alpacaActiveChartTimeframe";
const BRACKET_PLAN_STORAGE_PREFIX = "alpacaBracketPlan";
const SCANNER_CACHE_URL = `${API_BASE}/scanner/cache`;
const SCANNER_POLL_MS = 30000;
const BROKER_POLL_MS = 30000;
const MAX_ALPACA_SCANNER_SYMBOLS = 25;

function uniqueSymbols(items: Array<string | number | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const symbol = normalizeSingleSymbol(String(item ?? ""));
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}


function extractScannerSymbols(payload: any): string[] {
  const rows =
    payload?.data?.rows ??
    payload?.data?.results ??
    payload?.rows ??
    payload?.results ??
    [];

  if (!Array.isArray(rows)) return [];

  return uniqueSymbols(
    rows
      .map((row: any) => row?.symbol ?? row?.ticker ?? row)
      .filter(Boolean)
      .slice(0, MAX_ALPACA_SCANNER_SYMBOLS)
  );
}

function loadStoredSymbolList(...keys: string[]): string[] {
  if (typeof window === "undefined") return [];
  for (const key of keys) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      const cleaned = uniqueSymbols(parsed.map((item) => String(item)));
      if (cleaned.length > 0) return cleaned;
    } catch {
      // Try the next storage key.
    }
  }
  return [];
}

function loadInitialWatchlist(): string[] {
  return loadStoredSymbolList(SCANNER_WATCHLIST_STORAGE_KEY);
}

function loadInitialSelectedSymbol(initialWatchlist: string[]): string {
  if (typeof window !== "undefined") {
    const stored = normalizeSingleSymbol(window.localStorage.getItem(ACTIVE_SYMBOL_STORAGE_KEY) || "");
    if (stored) return stored;
  }
  return initialWatchlist[0] || EMERGENCY_FALLBACK_SYMBOL;
}

function normalizeExpandedChart(value: string | null | undefined): ExpandedChartKey {
  return value === "1m" || value === "5m" || value === "15m" ? value : null;
}

function loadInitialExpandedChart(): ExpandedChartKey {
  if (typeof window === "undefined") return null;
  return normalizeExpandedChart(window.localStorage.getItem(ACTIVE_ALPACA_CHART_STORAGE_KEY));
}

function saveActiveAlpacaChartLocal(nextChart: ExpandedChartKey) {
  if (typeof window === "undefined") return;
  if (nextChart) {
    window.localStorage.setItem(ACTIVE_ALPACA_CHART_STORAGE_KEY, nextChart);
  } else {
    window.localStorage.removeItem(ACTIVE_ALPACA_CHART_STORAGE_KEY);
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function chartRangeKey(symbol: string, timeframe: string): string {
  return `${normalizeSingleSymbol(symbol)}::${String(timeframe).toLowerCase()}`;
}

function normalizeChartRanges(value: unknown): Record<string, SharedChartRange> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, SharedChartRange> = {};
  for (const [key, range] of Object.entries(value as Record<string, any>)) {
    const from = Number(range?.from);
    const to = Number(range?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    out[String(key).toUpperCase()] = { from, to };
  }
  return out;
}

function saveScannerWatchlistLocal(nextWatchlist: string[]) {
  if (typeof window === "undefined") return;
  const cleanWatchlist = uniqueSymbols(nextWatchlist);
  window.localStorage.setItem(SCANNER_WATCHLIST_STORAGE_KEY, JSON.stringify(cleanWatchlist));
  window.dispatchEvent(new CustomEvent<string[]>("scanner-watchlist-change", { detail: cleanWatchlist }));
}

function saveActiveSymbolLocal(nextSymbol: string) {
  if (typeof window === "undefined") return;
  const cleanSymbol = normalizeSingleSymbol(nextSymbol);
  if (!cleanSymbol) return;
  window.localStorage.setItem(ACTIVE_SYMBOL_STORAGE_KEY, cleanSymbol);
  window.dispatchEvent(new CustomEvent<string>("scanner-active-symbol-change", { detail: cleanSymbol }));
}

function loadManualWatchlist(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MANUAL_WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return uniqueSymbols(parsed.map((item) => String(item)));
  } catch {
    return [];
  }
}

type ChartStats = {
  last: number | null;
  pmh: number | null;
  vwap: number | null;
  barsCount: number;
};

type ExpandedChartKey = "1m" | "5m" | "15m" | null;

const emptyStats: ChartStats = {
  last: null,
  pmh: null,
  vwap: null,
  barsCount: 0,
};

function formatMoney(value: string | number | null | undefined): string {
  if (value == null || value === "") return "N/A";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatNumber(value: string | number | null | undefined, digits = 2): string {
  if (value == null || value === "") return "N/A";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toFixed(digits);
}

function formatSignedPercent(value: string | number | null | undefined): string {
  if (value == null || value === "") return "N/A";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(2)}%`;
}

function normalizeWatchlist(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[^A-Za-z.]+/)
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

function normalizeSingleSymbol(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z.]/g, "");
}

function bracketPlanStorageKey(mode: AlpacaMode, symbol: string): string {
  return `${BRACKET_PLAN_STORAGE_PREFIX}:${mode}:${normalizeSingleSymbol(symbol)}`;
}

function loadBracketPlan(mode: AlpacaMode, symbol: string): { targetPrice: string; stopPrice: string } | null {
  if (typeof window === "undefined") return null;
  const normalizedSymbol = normalizeSingleSymbol(symbol);
  if (!normalizedSymbol) return null;
  try {
    const raw = window.localStorage.getItem(bracketPlanStorageKey(mode, normalizedSymbol));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      targetPrice: String(parsed?.targetPrice ?? ""),
      stopPrice: String(parsed?.stopPrice ?? ""),
    };
  } catch {
    return null;
  }
}

function saveBracketPlan(mode: AlpacaMode, symbol: string, targetPrice: string, stopPrice: string): void {
  if (typeof window === "undefined") return;
  const normalizedSymbol = normalizeSingleSymbol(symbol);
  if (!normalizedSymbol) return;
  const cleanTarget = String(targetPrice ?? "").trim();
  const cleanStop = String(stopPrice ?? "").trim();
  const key = bracketPlanStorageKey(mode, normalizedSymbol);
  if (!cleanTarget && !cleanStop) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(
    key,
    JSON.stringify({
      symbol: normalizedSymbol,
      targetPrice: cleanTarget,
      stopPrice: cleanStop,
      updatedAt: Date.now(),
    })
  );
}

function clearBracketPlan(mode: AlpacaMode, symbol: string): void {
  if (typeof window === "undefined") return;
  const normalizedSymbol = normalizeSingleSymbol(symbol);
  if (!normalizedSymbol) return;
  window.localStorage.removeItem(bracketPlanStorageKey(mode, normalizedSymbol));
}

function parsePositiveNumber(value: string | number | null | undefined): number {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeAlpacaOrderPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return value;

  // Alpaca minimum pricing rule:
  // - $1.00 and above: max 2 decimal places
  // - below $1.00: max 4 decimal places
  // This also strips JS floating-point tails such as 0.37010000000000004.
  const decimals = value >= 1 ? 2 : 4;
  return Number(value.toFixed(decimals));
}

function AlpacaPage() {
  const navigate = useNavigate();

  const [mode, setMode] = useState<AlpacaMode>("paper");
  const initialWatchlistRef = useRef<string[]>(loadInitialWatchlist());
  const [symbol, setSymbol] = useState<string>(() => loadInitialSelectedSymbol(initialWatchlistRef.current));
  const [symbolInput, setSymbolInput] = useState<string>(() => loadInitialSelectedSymbol(initialWatchlistRef.current));
  const [watchlist, setWatchlist] = useState<string[]>(() => initialWatchlistRef.current);
  const [watchlistInput, setWatchlistInput] = useState<string>(() => initialWatchlistRef.current.join(", "));
  const [manualWatchlist, setManualWatchlist] = useState<string[]>(() => loadManualWatchlist());
  const [manualWatchlistInput, setManualWatchlistInput] = useState<string>("");
  const [expandedChart, setExpandedChart] = useState<ExpandedChartKey>(() => loadInitialExpandedChart());
  const [chartRanges, setChartRanges] = useState<Record<string, SharedChartRange>>({});
  const sharedStateHydratedRef = useRef(false);
  const sharedStateSaveTimerRef = useRef<number | null>(null);
  const bracketPlanHydratedRef = useRef(false);

  const [account, setAccount] = useState<any | null>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [submitMessage, setSubmitMessage] = useState<string>("");
  const [autoTradeStatus, setAutoTradeStatus] = useState<AutoTradeStatus | null>(null);
  const [autoTradeBusy, setAutoTradeBusy] = useState(false);
  const [autoTradeError, setAutoTradeError] = useState<string>("");
  const [hailMaryEntryPrice, setHailMaryEntryPrice] = useState<string>("");
  const [hailMaryStopPrice, setHailMaryStopPrice] = useState<string>("");
  const [hailMaryTargetPrice, setHailMaryTargetPrice] = useState<string>("");
  const [hailMaryMessage, setHailMaryMessage] = useState<string>("");
  const brokerLoadInFlightRef = useRef(false);
  const orderPriceLocksRef = useRef<Record<string, { price: number; kind: string; expiresAt: number }>>({});
  // Order cancel quarantine: Alpaca can return a just-canceled order in the next
  // open-orders poll for a short moment. Keep those ids locally hidden so the
  // chart X deletes on the first click and polling cannot re-add it.
  const cancelOrderLocksRef = useRef<Record<string, number>>({});
  const [, forceOrderLockRender] = useState(0);

  const [stats1m, setStats1m] = useState<ChartStats>(emptyStats);
  const [stats5m, setStats5m] = useState<ChartStats>(emptyStats);
  const [stats15m, setStats15m] = useState<ChartStats>(emptyStats);

  const [orderForm, setOrderForm] = useState<PlaceAlpacaOrderRequest>({
    mode: "paper",
    symbol: loadInitialSelectedSymbol(initialWatchlistRef.current),
    side: "buy",
    qty: 1,
    type: "limit",
    time_in_force: "day",
    extended_hours: false,
    limit_price: undefined,
  });

  const [cashAmount, setCashAmount] = useState<string>("1000");
  const [targetPrice, setTargetPrice] = useState<string>("");
  const [stopPrice, setStopPrice] = useState<string>("");

  const [quickOrderOpen, setQuickOrderOpen] = useState(false);
  const [quickOrderTemplate, setQuickOrderTemplate] = useState<OrderTemplate>("buy_only");
  const [quickAlertOpen, setQuickAlertOpen] = useState(false);
  const [chartResetNonce, setChartResetNonce] = useState(0);
  const [trendlineAction, setTrendlineAction] = useState<TrendlineControlAction>({ type: "none" });
  const [overlayPreset, setOverlayPreset] = useState<OverlayPreset>("runner");
  const [chartOverlayPresets, setChartOverlayPresets] = useState<ChartPresetMap>({ "1m": "runner", "5m": "runner", "15m": "runner" });
  const [chartStudyVisibility, setChartStudyVisibility] = useState<ChartStudyVisibilityMap>(() => loadChartStudyVisibilityMap());
  const deferredChartStudyVisibility = useDeferredValue(chartStudyVisibility);
  const [openStudiesMenu, setOpenStudiesMenu] = useState<ExpandedChartKey>(null);
  const [trendlineUiState, setTrendlineUiState] = useState({
    drawMode: false,
    pendingPoint: false,
    count: 0,
  });
  const alertCooldownsRef = useRef<Map<string, number>>(new Map());
  const scannerLoadInFlightRef = useRef(false);
  const lastScannerSymbolsRef = useRef<string[]>(initialWatchlistRef.current);

  useEffect(() => {
    let cancelled = false;

    const hydrateSharedState = async () => {
      try {
        const remote = await fetchSharedAlpacaState();
        if (cancelled || !remote) return;

        const nextSymbol = normalizeSingleSymbol(String(remote.selectedSymbol || ""));
        if (nextSymbol) {
          setSymbol(nextSymbol);
          setSymbolInput(nextSymbol);
          saveActiveSymbolLocal(nextSymbol);
        }

        if (Array.isArray(remote.manualWatchlist)) {
          setManualWatchlist(uniqueSymbols(remote.manualWatchlist));
        }

        // Study visibility is intentionally local per chart timeframe.
        // Do not hydrate one shared visibility object here, or clearing one chart
        // would modify every other chart after a refresh/sync.

        const remoteActiveChart = normalizeExpandedChart(remote.activeChart || remote.timeframe || null);
        if (remoteActiveChart) {
          setExpandedChart(remoteActiveChart);
          saveActiveAlpacaChartLocal(remoteActiveChart);
        }

        setChartRanges(normalizeChartRanges(remote.chartRanges));
      } catch (err) {
        console.warn("Shared Alpaca state load failed", err);
      } finally {
        if (!cancelled) sharedStateHydratedRef.current = true;
      }
    };

    void hydrateSharedState();

    return () => {
      cancelled = true;
      if (sharedStateSaveTimerRef.current !== null) {
        window.clearTimeout(sharedStateSaveTimerRef.current);
        sharedStateSaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sharedStateHydratedRef.current) return;

    if (sharedStateSaveTimerRef.current !== null) {
      window.clearTimeout(sharedStateSaveTimerRef.current);
    }

    sharedStateSaveTimerRef.current = window.setTimeout(() => {
      sharedStateSaveTimerRef.current = null;
      const persistedActiveChart = expandedChart || loadInitialExpandedChart() || "1m";
      void saveSharedAlpacaState({
        selectedSymbol: symbol,
        timeframe: persistedActiveChart,
        activeChart: persistedActiveChart,
        watchlist,
        manualWatchlist,
        studyVisibility: undefined,
        chartRanges,
        updatedAt: Date.now(),
      }).catch((err) => console.warn("Shared Alpaca state save failed", err));
    }, 650);
  }, [symbol, expandedChart, watchlist, manualWatchlist, chartRanges]);

  const handleVisibleRangeChange = useCallback((timeframe: Exclude<ExpandedChartKey, null>, range: SharedChartRange) => {
    const key = chartRangeKey(symbol, timeframe);
    setChartRanges((prev) => {
      const previous = prev[key];
      if (previous && Math.abs(previous.from - range.from) < 0.01 && Math.abs(previous.to - range.to) < 0.01) {
        return prev;
      }
      return { ...prev, [key]: range };
    });
  }, [symbol]);

  const selectActiveSymbol = useCallback((nextSymbol: string, options?: { addToScannerWatchlist?: boolean; addToManualWatchlist?: boolean }) => {
    const next = normalizeSingleSymbol(nextSymbol);
    if (!next) return;

    setSubmitMessage("");
    setError("");
    setSymbol(next);
    setSymbolInput(next);
    saveActiveSymbolLocal(next);

    if (options?.addToScannerWatchlist) {
      setWatchlist((prev) => {
        const updated = uniqueSymbols(prev.includes(next) ? prev : [next, ...prev]).slice(0, MAX_ALPACA_SCANNER_SYMBOLS);
        setWatchlistInput(updated.join(", "));
        saveScannerWatchlistLocal(updated);
        return updated;
      });
    }

    if (options?.addToManualWatchlist) {
      setManualWatchlist((prev) => uniqueSymbols(prev.includes(next) ? prev : [next, ...prev]));
    }
  }, []);

  useEffect(() => {
    const applyScannerWatchlist = (symbols: string[]) => {
      const cleaned = uniqueSymbols(symbols).slice(0, MAX_ALPACA_SCANNER_SYMBOLS);
      if (arraysEqual(lastScannerSymbolsRef.current, cleaned)) return;

      lastScannerSymbolsRef.current = cleaned;

      startTransition(() => {
        setWatchlist((prev) => (arraysEqual(prev, cleaned) ? prev : cleaned));
        setWatchlistInput(cleaned.join(", "));
      });

      // IMPORTANT: do not auto-switch the active chart symbol when the scanner updates.
      // Scanner updates can happen in the background and must not force chart reloads or freeze the page.
    };

    const storedScannerWatchlist = loadInitialWatchlist();
    if (storedScannerWatchlist.length > 0) {
      applyScannerWatchlist(storedScannerWatchlist);
    }

    const handleScannerWatchlistEvent = (event: Event) => {
      const nextWatchlist = (event as CustomEvent<string[]>).detail;
      if (Array.isArray(nextWatchlist)) applyScannerWatchlist(nextWatchlist);
    };

    const handleScannerActiveSymbolEvent = (event: Event) => {
      const next = normalizeSingleSymbol((event as CustomEvent<string>).detail || "");
      if (!next) return;
      setSymbol(next);
      setSymbolInput(next);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === SCANNER_WATCHLIST_STORAGE_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          if (Array.isArray(parsed)) applyScannerWatchlist(parsed);
        } catch {
          // Ignore bad scanner watchlist storage.
        }
      }

      if (event.key === ACTIVE_SYMBOL_STORAGE_KEY && event.newValue) {
        const next = normalizeSingleSymbol(event.newValue);
        if (next) {
          setSymbol(next);
          setSymbolInput(next);
        }
      }
    };

    window.addEventListener("scanner-watchlist-change", handleScannerWatchlistEvent);
    window.addEventListener("scanner-active-symbol-change", handleScannerActiveSymbolEvent);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("scanner-watchlist-change", handleScannerWatchlistEvent);
      window.removeEventListener("scanner-active-symbol-change", handleScannerActiveSymbolEvent);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let timerId: number | undefined;
    let abortController: AbortController | null = null;

    const loadScannerCache = async () => {
      if (!mounted || scannerLoadInFlightRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;

      scannerLoadInFlightRef.current = true;
      abortController?.abort();
      abortController = new AbortController();

      try {
        const response = await fetch(SCANNER_CACHE_URL, {
          signal: abortController.signal,
          cache: "no-store",
        });

        if (!response.ok) return;

        const payload = await response.json();
        const nextSymbols = extractScannerSymbols(payload);

        if (!mounted || arraysEqual(lastScannerSymbolsRef.current, nextSymbols)) return;

        lastScannerSymbolsRef.current = nextSymbols;
        saveScannerWatchlistLocal(nextSymbols);

        startTransition(() => {
          setWatchlist(nextSymbols);
          setWatchlistInput(nextSymbols.join(", "));
        });
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          console.error("Alpaca scanner cache load failed", err);
        }
      } finally {
        scannerLoadInFlightRef.current = false;
      }
    };

    void loadScannerCache();
    timerId = window.setInterval(loadScannerCache, SCANNER_POLL_MS);

    return () => {
      mounted = false;
      if (timerId !== undefined) window.clearInterval(timerId);
      abortController?.abort();
    };
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== CHART_STUDY_VISIBILITY_STORAGE_KEY || !event.newValue) return;
      try {
        setChartStudyVisibility(loadChartStudyVisibilityMap());
      } catch {
        // Ignore bad storage data and keep the current chart state.
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const syncOrderSymbol = useCallback((nextSymbol: string) => {
    setOrderForm((prev: PlaceAlpacaOrderRequest) => ({ ...prev, symbol: nextSymbol }));
  }, []);

  useEffect(() => {
    syncOrderSymbol(symbol);
    setSymbolInput(symbol);
  }, [symbol, syncOrderSymbol]);

  useEffect(() => {
    setOrderForm((prev: PlaceAlpacaOrderRequest) => ({ ...prev, mode }));
  }, [mode]);

  useEffect(() => {
    bracketPlanHydratedRef.current = false;
    const plan = loadBracketPlan(mode, symbol);
    setTargetPrice(plan?.targetPrice ?? "");
    setStopPrice(plan?.stopPrice ?? "");
  }, [mode, symbol]);

  useEffect(() => {
    if (!bracketPlanHydratedRef.current) {
      bracketPlanHydratedRef.current = true;
      return;
    }
    saveBracketPlan(mode, symbol, targetPrice, stopPrice);
  }, [mode, symbol, targetPrice, stopPrice]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MANUAL_WATCHLIST_STORAGE_KEY, JSON.stringify(uniqueSymbols(manualWatchlist)));
  }, [manualWatchlist]);


  const patchOrderWithPriceLock = useCallback((order: any) => {
    const orderId = String(order?.id ?? "");
    const lock = orderId ? orderPriceLocksRef.current[orderId] : undefined;
    if (!lock) return order;
    if (Date.now() > lock.expiresAt) {
      delete orderPriceLocksRef.current[orderId];
      return order;
    }

    const kind = String(lock.kind || "limit").toLowerCase();
    const patched: any = { ...order };

    if (kind === "take_profit") {
      patched.take_profit = { ...(patched.take_profit ?? {}), limit_price: lock.price };
      patched.take_profit_price = lock.price;
      patched.takeProfitPrice = lock.price;
    } else if (kind === "stop_loss" || kind === "stop") {
      patched.stop_loss = { ...(patched.stop_loss ?? {}), stop_price: lock.price };
      patched.stop_loss_price = lock.price;
      patched.stopLossPrice = lock.price;
      patched.stop_price = lock.price;
      patched.stopPrice = lock.price;
    } else {
      patched.limit_price = lock.price;
      patched.limitPrice = lock.price;
      patched.price = lock.price;
    }

    return patched;
  }, []);

  const applyOrderPriceLocks = useCallback((incomingOrders: any[]) => {
    const now = Date.now();
    for (const [orderId, lock] of Object.entries(orderPriceLocksRef.current)) {
      if (!lock || now > lock.expiresAt) delete orderPriceLocksRef.current[orderId];
    }
    return (Array.isArray(incomingOrders) ? incomingOrders : []).map(patchOrderWithPriceLock);
  }, [patchOrderWithPriceLock]);


  const collectOrderRelationIds = useCallback((order: any): string[] => {
    const ids = new Set<string>();
    const add = (value: unknown) => {
      const id = String(value ?? "").trim();
      if (id) ids.add(id);
    };

    add(order?.id);
    add(order?.parent_order_id);
    add(order?.parentOrderId);
    add(order?.replaced_by);
    add(order?.replaces);

    if (Array.isArray(order?.legs)) {
      for (const leg of order.legs) {
        add(leg?.id);
        add(leg?.parent_order_id);
        add(leg?.parentOrderId);
      }
    }

    return Array.from(ids);
  }, []);

  const applyCancelOrderLocks = useCallback((incomingOrders: any[]) => {
    const now = Date.now();
    for (const [orderId, expiresAt] of Object.entries(cancelOrderLocksRef.current)) {
      if (!expiresAt || now > expiresAt) delete cancelOrderLocksRef.current[orderId];
    }

    const lockedIds = new Set(Object.keys(cancelOrderLocksRef.current));
    if (!lockedIds.size) return Array.isArray(incomingOrders) ? incomingOrders : [];

    return (Array.isArray(incomingOrders) ? incomingOrders : []).filter((order) => {
      const relationIds = collectOrderRelationIds(order);
      return !relationIds.some((id) => lockedIds.has(id));
    });
  }, [collectOrderRelationIds]);

  const lockCanceledOrder = useCallback((orderId: string, ttlMs = 20000) => {
    const id = String(orderId || "").trim();
    if (!id) return;

    const expiresAt = Date.now() + ttlMs;
    cancelOrderLocksRef.current[id] = expiresAt;

    // Also quarantine any known bracket children/parent ids tied to this order.
    for (const order of Array.isArray(orders) ? orders : []) {
      const relationIds = collectOrderRelationIds(order);
      if (relationIds.includes(id)) {
        for (const relatedId of relationIds) cancelOrderLocksRef.current[relatedId] = expiresAt;
      }
    }

    forceOrderLockRender((value) => value + 1);
  }, [collectOrderRelationIds, orders]);

  const lockChartOrderPrice = useCallback((orderId: string, kind: string, price: number, ttlMs = 12000) => {
    if (!orderId || !Number.isFinite(price) || price <= 0) return;
    orderPriceLocksRef.current[orderId] = {
      price,
      kind: String(kind || "limit").toLowerCase(),
      expiresAt: Date.now() + ttlMs,
    };
    forceOrderLockRender((value) => value + 1);
  }, []);

  const patchOrderPrice = useCallback((order: any, kind: string, price: number) => {
    const lineKind = String(kind || "limit").toLowerCase();
    const patched: any = { ...order };
    if (lineKind === "take_profit") {
      patched.take_profit = { ...(patched.take_profit ?? {}), limit_price: price };
      patched.take_profit_price = price;
      patched.takeProfitPrice = price;
    } else if (lineKind === "stop_loss" || lineKind === "stop") {
      patched.stop_loss = { ...(patched.stop_loss ?? {}), stop_price: price };
      patched.stop_loss_price = price;
      patched.stopLossPrice = price;
      patched.stop_price = price;
      patched.stopPrice = price;
    } else {
      patched.limit_price = price;
      patched.limitPrice = price;
      patched.price = price;
    }
    return patched;
  }, []);

  const loadBrokerData = useCallback(async (silent = false) => {
    if (brokerLoadInFlightRef.current) return;
    brokerLoadInFlightRef.current = true;

    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    setError("");

    try {
      const [accountResponse, positionsResponse, ordersResponse] = await Promise.all([
        fetchAlpacaAccount(mode),
        fetchAlpacaPositions(mode),
        fetchAlpacaOrders(mode, "open"),
      ]);

      setAccount(accountResponse);
      setPositions(Array.isArray(positionsResponse) ? positionsResponse : []);
      setOrders(applyCancelOrderLocks(applyOrderPriceLocks(Array.isArray(ordersResponse) ? ordersResponse : [])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Alpaca data");
    } finally {
      brokerLoadInFlightRef.current = false;
      if (silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [mode, applyOrderPriceLocks]);

  useEffect(() => {
    void loadBrokerData();
  }, [loadBrokerData]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadBrokerData(true);
    }, BROKER_POLL_MS);
    return () => window.clearInterval(id);
  }, [loadBrokerData]);


  const loadAutoTradeStatus = useCallback(async (silent = true) => {
    if (!silent) setAutoTradeBusy(true);
    setAutoTradeError("");
    try {
      const status = await fetchAutoTradeStatus();
      setAutoTradeStatus(status);
    } catch (err) {
      setAutoTradeError(err instanceof Error ? err.message : "Failed to load auto-trade status");
    } finally {
      if (!silent) setAutoTradeBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadAutoTradeStatus(true);
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadAutoTradeStatus(true);
    }, 5000);
    return () => window.clearInterval(id);
  }, [loadAutoTradeStatus]);

  const patchAutoTradeConfig = useCallback(async (patch: Record<string, unknown>) => {
    setAutoTradeBusy(true);
    setAutoTradeError("");
    try {
      const status = await updateAutoTradeConfig(patch);
      setAutoTradeStatus(status);
    } catch (err) {
      setAutoTradeError(err instanceof Error ? err.message : "Failed to update auto-trade config");
    } finally {
      setAutoTradeBusy(false);
    }
  }, []);

  const toggleAutoTrade = useCallback(async () => {
    setAutoTradeBusy(true);
    setAutoTradeError("");
    try {
      const isOn = Boolean(autoTradeStatus?.config?.enabled);
      const nextMode = autoTradeStatus?.config?.mode === "live" && autoTradeStatus?.config?.allow_live ? "live" : "paper";
      const next = isOn
        ? await stopAutoTrade()
        : await startAutoTrade({ enabled: true, mode: nextMode, allow_live: nextMode === "live" });
      setAutoTradeStatus(next);
    } catch (err) {
      setAutoTradeError(err instanceof Error ? err.message : "Failed to toggle auto trade");
    } finally {
      setAutoTradeBusy(false);
    }
  }, [autoTradeStatus?.config?.allow_live, autoTradeStatus?.config?.enabled, autoTradeStatus?.config?.mode]);

  const runAutoTradeCheckOnce = useCallback(async () => {
    setAutoTradeBusy(true);
    setAutoTradeError("");
    try {
      await checkAutoTradeOnce();
      await loadAutoTradeStatus(true);
      await loadBrokerData(true);
    } catch (err) {
      setAutoTradeError(err instanceof Error ? err.message : "Auto trade check failed");
    } finally {
      setAutoTradeBusy(false);
    }
  }, [loadAutoTradeStatus, loadBrokerData]);

  const applyWatchlist = () => {
    const next = normalizeWatchlist(watchlistInput);
    setWatchlist(next);
    setWatchlistInput(next.join(", "));
    saveScannerWatchlistLocal(next);
    lastScannerSymbolsRef.current = next;
  };

  const handleScannerSelectSymbol = useCallback((nextSymbol: string) => {
    const next = normalizeSingleSymbol(nextSymbol);
    if (!next) return;
    setSubmitMessage("");
    setError("");
    // Keep expanded chart open while switching symbols; Restore is the only exit.
    selectActiveSymbol(next);
  }, [selectActiveSymbol]);

  const handleManualSelectSymbol = useCallback((nextSymbol: string) => {
    const next = normalizeSingleSymbol(nextSymbol);
    if (!next) return;
    setSubmitMessage("");
    setError("");
    // Keep expanded chart open while switching symbols; Restore is the only exit.
    selectActiveSymbol(next);
  }, [selectActiveSymbol]);

  const handleRemoveManualSymbol = useCallback((nextSymbol: string) => {
    const next = normalizeSingleSymbol(nextSymbol);
    setManualWatchlist((prev) => prev.filter((item) => item !== next));
  }, []);

  const submitManualWatchlistAdd = useCallback(() => {
    const next = normalizeSingleSymbol(manualWatchlistInput || symbol);
    if (!next) return;

    setSubmitMessage("");
    setError("");
    // Keep expanded chart open while switching symbols; Restore is the only exit.
    selectActiveSymbol(next);
    setManualWatchlist((prev) => uniqueSymbols(prev.includes(next) ? prev : [next, ...prev]));
    setManualWatchlistInput("");
  }, [manualWatchlistInput, symbol, selectActiveSymbol]);

  const loadTypedSymbol = useCallback(() => {
    const nextSymbol = normalizeSingleSymbol(symbolInput);
    if (!nextSymbol) return;

    setSubmitMessage("");
    setError("");
    // Keep expanded chart open while switching symbols; Restore is the only exit.
    selectActiveSymbol(nextSymbol, { addToScannerWatchlist: true });
  }, [symbolInput, selectActiveSymbol]);

  const handleAddSymbolToWatchlist = useCallback((nextSymbol: string) => {
    const next = normalizeSingleSymbol(nextSymbol);
    if (!next) return;

    setSubmitMessage("");
    setError("");
    // Keep expanded chart open while switching symbols; Restore is the only exit.
    selectActiveSymbol(next, { addToManualWatchlist: true });
  }, [selectActiveSymbol]);

  const getModeButtonStyle = (buttonMode: AlpacaMode): CSSProperties => {
    const isActive = mode === buttonMode;

    if (buttonMode === "live") {
      return {
        padding: "8px 12px",
        borderRadius: 999,
        border: isActive
          ? "1px solid rgba(239,68,68,0.85)"
          : "1px solid rgba(255,255,255,0.12)",
        background: isActive
          ? "rgba(127,29,29,0.65)"
          : "#071731",
        color: "#ffffff",
        fontWeight: 700,
        cursor: "pointer",
      };
    }

    return {
      padding: "8px 12px",
      borderRadius: 999,
      border: isActive
        ? "1px solid rgba(78,161,255,0.85)"
        : "1px solid rgba(255,255,255,0.12)",
      background: isActive
        ? "rgba(18,57,107,0.75)"
        : "#071731",
      color: "#ffffff",
      fontWeight: 700,
      cursor: "pointer",
    };
  };

  const toggleChartExpand = (chartKey: Exclude<ExpandedChartKey, null>) => {
    setExpandedChart((prev) => {
      const next = prev === chartKey ? null : chartKey;
      saveActiveAlpacaChartLocal(chartKey);
      return next;
    });
  };

  const pulseTrendlineAction = useCallback((action: TrendlineControlAction) => {
    setTrendlineAction(action);
    window.setTimeout(() => {
      setTrendlineAction({ type: "none" });
    }, 80);
  }, []);

  const updateChartStudyVisibility = useCallback((timeframe: ChartTimeframe, updater: (current: OverlayVisibility) => OverlayVisibility) => {
    startTransition(() => {
      setChartStudyVisibility((prev) => {
        const nextMap: ChartStudyVisibilityMap = {
          ...prev,
          [timeframe]: normalizeOverlayVisibility(updater(prev[timeframe] ?? DEFAULT_VISIBILITY)),
        };
        saveChartStudyVisibilityMap(nextMap);
        return nextMap;
      });
    });
  }, []);

  const applyOverlayPreset = useCallback((timeframe: ChartTimeframe, nextPreset: OverlayPreset) => {
    setOverlayPreset(nextPreset);
    setChartOverlayPresets((prev) => ({ ...prev, [timeframe]: nextPreset }));
    updateChartStudyVisibility(timeframe, () => OVERLAY_PRESETS[nextPreset]);
  }, [updateChartStudyVisibility]);

  const toggleOverlayVisibility = useCallback((timeframe: ChartTimeframe, key: keyof OverlayVisibility) => {
    setOverlayPreset("runner");
    setChartOverlayPresets((prev) => ({ ...prev, [timeframe]: "runner" }));
    updateChartStudyVisibility(timeframe, (current) => ({
      ...current,
      [key]: !current[key],
    }));
  }, [updateChartStudyVisibility]);

  const showAllStudies = useCallback((timeframe: ChartTimeframe) => {
    setOverlayPreset("runner");
    setChartOverlayPresets((prev) => ({ ...prev, [timeframe]: "runner" }));
    updateChartStudyVisibility(timeframe, () => ALL_STUDIES_ON);
  }, [updateChartStudyVisibility]);

  const clearAllStudies = useCallback((timeframe: ChartTimeframe) => {
    setOverlayPreset("clean");
    setChartOverlayPresets((prev) => ({ ...prev, [timeframe]: "clean" }));
    updateChartStudyVisibility(timeframe, () => ALL_STUDIES_OFF);
  }, [updateChartStudyVisibility]);

  const handleTrendlineActionHandled = useCallback(() => {
    setTrendlineAction({ type: "none" });
  }, []);

  const handleOpenTemplate = useCallback((template: OrderTemplate) => {
    setQuickOrderTemplate(template);
    setQuickOrderOpen(true);
  }, []);

  const handleChartAlert = useCallback(
    async (alert: { title: string; message: string; dedupeKey?: string }) => {
      const key = alert.dedupeKey ?? `${alert.title}|${alert.message}`;
      const now = Date.now();
      const cooldownMs = 20000;
      const lastSentAt = alertCooldownsRef.current.get(key) ?? 0;
      if (now - lastSentAt < cooldownMs) return;
      alertCooldownsRef.current.set(key, now);

      try {
        await sendBackendTestAlert(alert.title, alert.message);
      } catch (err) {
        console.error("Failed to send push alert", err);
      }
    },
    []
  );

  const handleEscapeHotkey = useCallback(() => {
    setQuickOrderOpen(false);
    setQuickAlertOpen(false);
    pulseTrendlineAction({ type: "cancel_draw" });
  }, [pulseTrendlineAction]);

  const activeOrderSymbol = normalizeSingleSymbol(orderForm.symbol ?? symbol);
  const cashAmountValue = parsePositiveNumber(cashAmount);
  const entryLimitPriceValue = parsePositiveNumber(orderForm.limit_price);
  const marketReferencePrice = stats1m.last ?? stats5m.last ?? stats15m.last ?? null;

  const entryPriceForCalc =
    orderForm.type === "limit"
      ? entryLimitPriceValue
      : marketReferencePrice && marketReferencePrice > 0
        ? marketReferencePrice
        : 0;

  const calculatedQty =
    cashAmountValue > 0 && entryPriceForCalc > 0
      ? Math.floor(cashAmountValue / entryPriceForCalc)
      : 0;

  const estimatedCost =
    calculatedQty > 0 && entryPriceForCalc > 0
      ? calculatedQty * entryPriceForCalc
      : 0;

  const targetPriceValue = parsePositiveNumber(targetPrice);
  const stopPriceValue = parsePositiveNumber(stopPrice);

  const targetPnL =
    calculatedQty > 0 && entryPriceForCalc > 0 && targetPriceValue > 0
      ? calculatedQty * (targetPriceValue - entryPriceForCalc)
      : 0;

  const stopRisk =
    calculatedQty > 0 && entryPriceForCalc > 0 && stopPriceValue > 0
      ? calculatedQty * (entryPriceForCalc - stopPriceValue)
      : 0;

  const riskRewardRatio =
    stopRisk > 0 && targetPnL > 0
      ? targetPnL / stopRisk
      : null;

  const ordersForChart = useMemo(() => {
    const baseOrders = applyOrderPriceLocks(Array.isArray(orders) ? orders : []);
    const firstActiveOrderForSymbol = baseOrders.find((order: any) => {
      const orderSymbol = normalizeSingleSymbol(String(order?.symbol ?? activeOrderSymbol));
      const status = String(order?.status ?? "open").toLowerCase();
      return (
        activeOrderSymbol &&
        orderSymbol === activeOrderSymbol &&
        !["filled", "canceled", "cancelled", "expired", "rejected"].includes(status)
      );
    });
    const activeOrderEntryPrice = parsePositiveNumber(
      firstActiveOrderForSymbol?.limit_price ??
        firstActiveOrderForSymbol?.limitPrice ??
        firstActiveOrderForSymbol?.price
    );
    const bracketEntryPrice = entryPriceForCalc > 0 ? entryPriceForCalc : activeOrderEntryPrice;
    const hasPlanningBracket =
      activeOrderSymbol &&
      bracketEntryPrice > 0 &&
      targetPriceValue > 0 &&
      stopPriceValue > 0;

    if (!hasPlanningBracket) return baseOrders;

    let patchedAnyActiveOrder = false;
    const nextOrders = baseOrders.map((order: any) => {
      const orderSymbol = normalizeSingleSymbol(String(order?.symbol ?? activeOrderSymbol));
      if (orderSymbol !== activeOrderSymbol) return order;

      const status = String(order?.status ?? "open").toLowerCase();
      if (["filled", "canceled", "cancelled", "expired", "rejected"].includes(status)) return order;

      const alreadyHasTarget = parsePositiveNumber(
        order?.take_profit?.limit_price ??
          order?.take_profit?.price ??
          order?.take_profit_price ??
          order?.takeProfitPrice
      ) > 0;
      const alreadyHasStop = parsePositiveNumber(
        order?.stop_loss?.stop_price ??
          order?.stop_loss?.price ??
          order?.stop_loss_price ??
          order?.stopLossPrice ??
          order?.stop_price ??
          order?.stopPrice
      ) > 0;

      patchedAnyActiveOrder = true;
      return {
        ...order,
        order_class: order?.order_class ?? order?.orderClass ?? "bracket",
        orderClass: order?.orderClass ?? order?.order_class ?? "bracket",
        limit_price: parsePositiveNumber(order?.limit_price ?? order?.limitPrice ?? order?.price) > 0
          ? order?.limit_price ?? order?.limitPrice ?? order?.price
          : bracketEntryPrice,
        limitPrice: parsePositiveNumber(order?.limitPrice ?? order?.limit_price ?? order?.price) > 0
          ? order?.limitPrice ?? order?.limit_price ?? order?.price
          : bracketEntryPrice,
        take_profit: alreadyHasTarget
          ? order?.take_profit
          : { ...(order?.take_profit ?? {}), limit_price: targetPriceValue },
        take_profit_price: alreadyHasTarget ? order?.take_profit_price : targetPriceValue,
        takeProfitPrice: alreadyHasTarget ? order?.takeProfitPrice : targetPriceValue,
        stop_loss: alreadyHasStop
          ? order?.stop_loss
          : { ...(order?.stop_loss ?? {}), stop_price: stopPriceValue },
        stop_loss_price: alreadyHasStop ? order?.stop_loss_price : stopPriceValue,
        stopLossPrice: alreadyHasStop ? order?.stopLossPrice : stopPriceValue,
        stop_price: alreadyHasStop ? order?.stop_price : stopPriceValue,
        stopPrice: alreadyHasStop ? order?.stopPrice : stopPriceValue,
      };
    });

    if (patchedAnyActiveOrder) return nextOrders;

    return [
      ...nextOrders,
      {
        id: `planning-bracket-${activeOrderSymbol}`,
        symbol: activeOrderSymbol,
        side: "buy",
        qty: calculatedQty > 0 ? calculatedQty : "",
        status: "open",
        template: "bracket",
        order_class: "bracket",
        orderClass: "bracket",
        type: orderForm.type || "limit",
        order_type: orderForm.type || "limit",
        limit_price: bracketEntryPrice,
        limitPrice: bracketEntryPrice,
        price: bracketEntryPrice,
        take_profit: { limit_price: targetPriceValue },
        take_profit_price: targetPriceValue,
        takeProfitPrice: targetPriceValue,
        stop_loss: { stop_price: stopPriceValue },
        stop_loss_price: stopPriceValue,
        stopLossPrice: stopPriceValue,
        stop_price: stopPriceValue,
        stopPrice: stopPriceValue,
      },
    ];
  }, [orders, activeOrderSymbol, entryPriceForCalc, targetPriceValue, stopPriceValue, calculatedQty, orderForm.type, applyOrderPriceLocks]);

  const activePosition =
    positions.find((position) => normalizeSingleSymbol(position.symbol) === activeOrderSymbol) ?? null;

  const submitEntryOrder = async (side: "buy" | "sell") => {
    setSubmitMessage("");
    setError("");

    try {
      if (!activeOrderSymbol) {
        throw new Error("Symbol is required");
      }

      if (cashAmountValue <= 0) {
        throw new Error("Cash amount must be greater than 0");
      }

      if (orderForm.type === "limit" && entryLimitPriceValue <= 0) {
        throw new Error("Limit price must be greater than 0");
      }

      if (calculatedQty <= 0) {
        throw new Error("Calculated share quantity must be at least 1");
      }

      const hasTarget = targetPriceValue > 0;
      const hasStop = stopPriceValue > 0;

      const payload: PlaceAlpacaOrderRequest = {
        ...orderForm,
        mode,
        symbol: activeOrderSymbol,
        side,
        qty: calculatedQty,
        type: orderForm.type,
        time_in_force: orderForm.time_in_force,
        extended_hours: orderForm.extended_hours ?? false,
        limit_price:
          orderForm.type === "limit"
            ? normalizeAlpacaOrderPrice(entryLimitPriceValue)
            : undefined,
        order_class:
          hasTarget && hasStop
            ? "bracket"
            : hasTarget || hasStop
              ? "oto"
              : undefined,
        take_profit: hasTarget
          ? {
              limit_price: normalizeAlpacaOrderPrice(targetPriceValue),
            }
          : undefined,
        stop_loss: hasStop
          ? {
              stop_price: normalizeAlpacaOrderPrice(stopPriceValue),
            }
          : undefined,
      };

      setOrderForm(payload);

      await placeAlpacaOrder(payload);
      saveBracketPlan(mode, activeOrderSymbol, targetPrice, stopPrice);

      const targetText = targetPriceValue > 0 ? ` | Target ${formatNumber(targetPriceValue, 4)}` : "";
      const stopText = stopPriceValue > 0 ? ` | Stop ${formatNumber(stopPriceValue, 4)}` : "";

      setSubmitMessage(
        `${side.toUpperCase()} order sent for ${payload.symbol} | ${calculatedQty} shares${targetText}${stopText}`
      );

      await loadBrokerData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to place order");
    }
  };

  const flattenPosition = async () => {
    setSubmitMessage("");
    setError("");

    try {
      if (!activeOrderSymbol) {
        throw new Error("Symbol is required");
      }

      if (!activePosition) {
        throw new Error(`No open position found for ${activeOrderSymbol}`);
      }

      const positionQty = parsePositiveNumber(activePosition.qty);
      if (positionQty <= 0) {
        throw new Error(`Position quantity for ${activeOrderSymbol} is not valid`);
      }

      const positionSide = String(activePosition.side ?? "long").toLowerCase();
      const closeSide: "buy" | "sell" = positionSide === "short" ? "buy" : "sell";

      const payload: PlaceAlpacaOrderRequest = {
        mode,
        symbol: activeOrderSymbol,
        side: closeSide,
        qty: positionQty,
        type: "market",
        time_in_force: "day",
        extended_hours: false,
      };

      await placeAlpacaOrder(payload);

      setSubmitMessage(
        `FLATTEN order sent for ${activeOrderSymbol} | ${formatNumber(positionQty, 4)} shares`
      );

      await loadBrokerData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to flatten position");
    }
  };

  const cancelOpenOrder = useCallback(async (orderId: string, orderSymbol: string) => {
    setSubmitMessage("");
    setError("");

    const id = String(orderId || "").trim();
    if (!id) return;

    const previousOrders = orders;
    lockCanceledOrder(id, 20000);
    setOrders((prev) => applyCancelOrderLocks(prev));

    try {
      await cancelAlpacaOrder(id, mode);
      setSubmitMessage(`Canceled order for ${orderSymbol}`);
      await loadBrokerData(true);
    } catch (err) {
      delete cancelOrderLocksRef.current[id];
      setOrders(previousOrders);
      setError(err instanceof Error ? err.message : "Failed to cancel order");
      throw err;
    }
  }, [orders, mode, loadBrokerData, lockCanceledOrder, applyCancelOrderLocks]);
  const cancelChartOrderLine = useCallback(
    async (order: any, line?: any) => {
      const orderId = String(order?.id ?? "");
      const orderSymbol = normalizeSingleSymbol(String(order?.symbol ?? symbol));

      // Chart-only planning bracket: this is NOT an Alpaca order yet.
      // Clear the planning fields immediately and do not call the broker.
      if (!orderId || orderId.startsWith("planning-bracket-")) {
        clearBracketPlan(mode, orderSymbol || symbol);
        setTargetPrice("");
        setStopPrice("");
        setSubmitMessage("Cleared bracket plan from chart");
        setError("");
        return;
      }

      // If this was a chart bracket built from target/stop planning fields,
      // clear those planning fields immediately too. The real broker order
      // cancel still happens through cancelOpenOrder below.
      clearBracketPlan(mode, orderSymbol || symbol);
      setTargetPrice("");
      setStopPrice("");

      await cancelOpenOrder(orderId, orderSymbol || symbol);
    },
    [mode, symbol, cancelOpenOrder]
  );

  const replaceChartOrderLinePrice = useCallback(
    async (order: any, line: any, nextPrice: number) => {
      setSubmitMessage("");
      setError("");

      const orderId = String(order?.id ?? "");
      const lineKind = String(line?.kind ?? "limit").toLowerCase();
      const orderSymbol = normalizeSingleSymbol(String(order?.symbol ?? symbol));

      try {
        if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
          throw new Error("Replacement price is not valid");
        }

        const brokerPrice = normalizeAlpacaOrderPrice(nextPrice);

        // Chart-only planning bracket: move the drawn TP/SL/entry line locally.
        // This prevents a fake broker call from snapping the line back.
        if (!orderId || orderId.startsWith("planning-bracket-")) {
          if (lineKind === "take_profit") {
            setTargetPrice(String(brokerPrice));
          } else if (lineKind === "stop_loss" || lineKind === "stop") {
            setStopPrice(String(brokerPrice));
          } else {
            setOrderForm((prev) => ({ ...prev, limit_price: brokerPrice }));
          }
          setSubmitMessage(`Moved ${orderSymbol || symbol} ${String(line?.label ?? "order")} to ${formatMoney(brokerPrice)}`);
          return;
        }

        // Lock the price FIRST so ChartPanel and polling cannot snap back to stale Alpaca data.
        lockChartOrderPrice(orderId, lineKind, brokerPrice, 15000);
        setOrders((prev) =>
          applyOrderPriceLocks(
            prev.map((existingOrder) =>
              String(existingOrder?.id ?? "") === orderId
                ? patchOrderPrice(existingOrder, lineKind, brokerPrice)
                : existingOrder
            )
          )
        );

        // Keep the bracket planning inputs aligned when those chart lines are moved.
        if (lineKind === "take_profit") {
          setTargetPrice(String(brokerPrice));
        } else if (lineKind === "stop_loss" || lineKind === "stop") {
          setStopPrice(String(brokerPrice));
        }

        const orderType = String(order?.type ?? order?.order_type ?? "limit").toLowerCase();
        const patchPayload: any = {};
        if (lineKind === "stop_loss" || lineKind === "stop" || orderType.includes("stop")) {
          patchPayload.stop_price = brokerPrice;
        } else {
          patchPayload.limit_price = brokerPrice;
        }

        try {
          await updateAlpacaOrder(orderId, patchPayload, mode);
          setSubmitMessage(`Moved ${orderSymbol || symbol} order to ${formatMoney(brokerPrice)}`);
        } catch (patchErr) {
          // Last resort for plain entry/limit orders only: cancel first, then recreate.
          // Do NOT submit-new first; that was the duplicate-order bug.
          const isSimpleEntryLine = !(lineKind === "take_profit" || lineKind === "stop_loss" || lineKind === "stop");
          const qty = parsePositiveNumber(order?.qty ?? order?.quantity ?? line?.qty);
          const side: "buy" | "sell" = String(order?.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
          if (!isSimpleEntryLine || qty <= 0 || !orderSymbol) {
            throw patchErr;
          }

          await cancelAlpacaOrder(orderId, mode);
          await placeAlpacaOrder({
            mode,
            symbol: orderSymbol,
            side,
            qty,
            type: "limit",
            time_in_force: String(order?.time_in_force ?? order?.timeInForce ?? "day"),
            limit_price: brokerPrice,
            extended_hours: Boolean(order?.extended_hours ?? order?.extendedHours ?? orderForm.extended_hours),
          });
          setSubmitMessage(`Moved ${orderSymbol} order to ${formatMoney(brokerPrice)}`);
        }

        // Let Alpaca catch up, but keep the local lock active during stale poll responses.
        window.setTimeout(() => {
          void loadBrokerData(true);
        }, 900);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to move order price");
        throw err;
      }
    },
    [
      mode,
      symbol,
      loadBrokerData,
      orderForm.extended_hours,
      lockChartOrderPrice,
      applyOrderPriceLocks,
      patchOrderPrice,
    ]
  );


  const queueOverniteHailMary = useCallback(async () => {
    const cfg = autoTradeStatus?.config;
    const entry = normalizeAlpacaOrderPrice(parsePositiveNumber(hailMaryEntryPrice));
    const stop = normalizeAlpacaOrderPrice(parsePositiveNumber(hailMaryStopPrice));
    const target = normalizeAlpacaOrderPrice(parsePositiveNumber(hailMaryTargetPrice));
    const symbolToTrade = normalizeSingleSymbol(symbol);

    setAutoTradeError("");
    setHailMaryMessage("");

    if (!symbolToTrade) {
      setAutoTradeError("Select a symbol first.");
      return;
    }
    if (entry <= 0 || stop <= 0 || target <= 0) {
      setAutoTradeError("Enter entry, stop, and target prices.");
      return;
    }
    if (stop >= entry) {
      setAutoTradeError("Stop must be below entry for a long Overnite Hail Mary trade.");
      return;
    }
    if (target <= entry) {
      setAutoTradeError("Target must be above entry for a long Overnite Hail Mary trade.");
      return;
    }

    const autoTradeConfigIsLive = cfg?.mode === "live" && cfg?.allow_live;
    const desiredAutoTradeMode: AlpacaMode = autoTradeConfigIsLive || mode === "live" ? "live" : "paper";
    const sizingMode = cfg?.sizing_mode ?? "dollars";
    const payload = {
      symbol: symbolToTrade,
      entry_price: entry,
      stop_price: stop,
      target_price: target,
      qty: sizingMode === "shares" ? Number(cfg?.fixed_shares ?? 0) : undefined,
      trade_amount: sizingMode === "dollars" ? Number(cfg?.trade_amount ?? 0) : undefined,
      mode: desiredAutoTradeMode,
      note: "Queued from Alpaca Auto Trade panel",
    };

    setAutoTradeBusy(true);
    try {
      if (desiredAutoTradeMode === "live" && !autoTradeConfigIsLive) {
        const armedStatus = await updateAutoTradeConfig({ enabled: true, mode: "live", allow_live: true });
        setAutoTradeStatus(armedStatus);
      }
      const status = await queueOverniteHailMaryPlan(payload);
      setAutoTradeStatus(status);
      setHailMaryMessage(`Queued ${symbolToTrade} ${payload.mode.toUpperCase()}: entry ${entry} / stop ${stop} / target ${target}`);
      await loadBrokerData();
    } catch (err) {
      setAutoTradeError(err instanceof Error ? err.message : "Failed to queue Overnite Hail Mary plan");
    } finally {
      setAutoTradeBusy(false);
    }
  }, [autoTradeStatus?.config, hailMaryEntryPrice, hailMaryStopPrice, hailMaryTargetPrice, loadBrokerData, mode, symbol]);


  const renderAutoTradePanel = () => {
    const cfg = autoTradeStatus?.config;
    const enabled = Boolean(cfg?.enabled);
    const lastSkip = autoTradeStatus?.last_skip;
    const lastSignal = autoTradeStatus?.last_signal;
    const lastOrder = autoTradeStatus?.last_order;
    const selectedStrategy = String((cfg as any)?.strategies?.[0]?.strategy_id ?? "six_seven_sweep") as AutoTradeStrategy;
    const isOverniteHailMary = selectedStrategy === "overnite_hail_mary";
    const autoTradeMode = cfg?.mode === "live" && cfg?.allow_live ? "live" : "paper";
    const queuedOrderMode: AlpacaMode = autoTradeMode === "live" || mode === "live" ? "live" : "paper";
    const autoTradeModeLabel = queuedOrderMode === "live" ? "LIVE / REAL MONEY" : "PAPER";

    return (
      <section style={{ ...subPanelStyle, border: enabled ? "1px solid rgba(34,197,94,0.42)" : subPanelStyle.border }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div>
            <div style={sectionTitleStyle}>Auto Trade</div>
            <div style={{ fontSize: 11, opacity: 0.72 }}>
              {`${isOverniteHailMary
                ? "Overnite Hail Mary · manual entry/stop/target only"
                : selectedStrategy === "five_am_sweep"
                  ? "5AM sweep synthetic bracket"
                  : "Bullish 6-7 sweep"} · ${autoTradeModeLabel}`}
            </div>
          </div>
          <button
            type="button"
            onClick={toggleAutoTrade}
            disabled={autoTradeBusy}
            style={{
              ...primaryButtonStyle,
              background: enabled ? "#16a34a" : "#334155",
              border: enabled ? "1px solid rgba(187,247,208,0.55)" : "1px solid rgba(255,255,255,0.14)",
              minWidth: 112,
            }}
          >
            {autoTradeBusy ? "Working..." : enabled ? "AUTO ON" : "AUTO OFF"}
          </button>
        </div>

        {autoTradeError ? <div style={errorBoxStyle}>{autoTradeError}</div> : null}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label style={labelStyle}>Source</label>
            <select
              value={(cfg?.source ?? "manual") as AutoTradeSource}
              onChange={(e) => void patchAutoTradeConfig({ source: e.target.value as AutoTradeSource })}
              style={selectStyle}
            >
              <option value="manual">Manual WL</option>
              <option value="scanner">Scanner WL</option>
              <option value="both">Both</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Strategy</label>
            <select
              value={selectedStrategy}
              onChange={(e) => {
                const nextStrategy = e.target.value as AutoTradeStrategy;
                void patchAutoTradeConfig({
                  source: nextStrategy === "overnite_hail_mary" ? "manual" : cfg?.source ?? "manual",
                  extended_hours: true,
                  strategies: [
                    {
                      enabled: true,
                      strategy_id: nextStrategy,
                      weight: 1,
                      min_score: 60,
                    },
                  ],
                });
              }}
              style={selectStyle}
            >
              <option value="six_seven_sweep">6/7 Sweep</option>
              <option value="five_am_sweep">5AM Sweep</option>
              <option value="overnite_hail_mary">Overnite Hail Mary</option>
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div>
            <label style={labelStyle}>Timeframe</label>
            <select
              value={cfg?.timeframe ?? "1m"}
              onChange={(e) => void patchAutoTradeConfig({ timeframe: e.target.value })}
              style={selectStyle}
            >
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
            </select>
          </div>

          {selectedStrategy === "five_am_sweep" ? (
            <div>
              <label style={labelStyle}>Target R</label>
              <input
                type="number"
                min="1"
                step="0.5"
                value={String((cfg as any)?.target_r ?? 2)}
                onChange={(e) => void patchAutoTradeConfig({ target_r: Number(e.target.value || 2) })}
                style={inputStyle}
              />
            </div>
          ) : (
            <div>
              <label style={labelStyle}>Signal Type</label>
              <div
                style={{
                  ...inputStyle,
                  display: "flex",
                  alignItems: "center",
                  opacity: 0.72,
                  fontSize: 12,
                }}
              >
                {isOverniteHailMary ? "Manual price plan" : "Bullish reclaim"}
              </div>
            </div>
          )}
        </div>

        {!isOverniteHailMary ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8, marginTop: 8 }}>
            <div>
              <label style={labelStyle}>Entry Trigger</label>
              <select
                value={String((cfg as any)?.entry_trigger_mode ?? "reclaim_close")}
                onChange={(e) => void patchAutoTradeConfig({ entry_trigger_mode: e.target.value })}
                style={selectStyle}
              >
                <option value="reclaim_close">Reclaim Close</option>
                <option value="sweep_touch">Sweep Touch (Aggressive)</option>
              </select>
              <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7, lineHeight: 1.25 }}>
                Reclaim Close waits for candle close back above the blue line. Sweep Touch enters as soon as the low sweep is detected.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
            <div>
              <label style={labelStyle}>Entry Limit</label>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={hailMaryEntryPrice}
                onChange={(e) => setHailMaryEntryPrice(e.target.value)}
                style={inputStyle}
                placeholder="0.82"
              />
            </div>
            <div>
              <label style={labelStyle}>Stop Loss</label>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={hailMaryStopPrice}
                onChange={(e) => setHailMaryStopPrice(e.target.value)}
                style={inputStyle}
                placeholder="0.74"
              />
            </div>
            <div>
              <label style={labelStyle}>Target</label>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={hailMaryTargetPrice}
                onChange={(e) => setHailMaryTargetPrice(e.target.value)}
                style={inputStyle}
                placeholder="1.05"
              />
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div>
            <label style={labelStyle}>Sizing</label>
            <select
              value={(cfg?.sizing_mode ?? "dollars") as AutoTradeSizingMode}
              onChange={(e) => void patchAutoTradeConfig({ sizing_mode: e.target.value as AutoTradeSizingMode })}
              style={selectStyle}
            >
              <option value="dollars">Dollars</option>
              <option value="shares">Shares</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>{(cfg?.sizing_mode ?? "dollars") === "shares" ? "Shares" : "Trade $"}</label>
            <input
              type="number"
              min="1"
              step={(cfg?.sizing_mode ?? "dollars") === "shares" ? "1" : "25"}
              value={(cfg?.sizing_mode ?? "dollars") === "shares" ? String(cfg?.fixed_shares ?? 100) : String(cfg?.trade_amount ?? 500)}
              onChange={(e) => {
                const value = Number(e.target.value || 0);
                void patchAutoTradeConfig((cfg?.sizing_mode ?? "dollars") === "shares" ? { fixed_shares: value } : { trade_amount: value });
              }}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <div>
            <label style={labelStyle}>Min Range $</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={String(cfg?.min_profit_range ?? 0.15)}
              onChange={(e) => void patchAutoTradeConfig({ min_profit_range: Number(e.target.value || 0) })}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Max Active</label>
            <input
              type="number"
              min="1"
              step="1"
              value={String(cfg?.max_active_trades ?? 1)}
              onChange={(e) => void patchAutoTradeConfig({ max_active_trades: Number(e.target.value || 1) })}
              style={inputStyle}
            />
          </div>
        </div>

        <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <input
            type="checkbox"
            checked={Boolean(cfg?.require_flat_account ?? true)}
            onChange={(e) => void patchAutoTradeConfig({ require_flat_account: e.target.checked })}
          />
          Lock out if any position/open order exists
        </label>

        {isOverniteHailMary ? (
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={queueOverniteHailMary}
              disabled={autoTradeBusy}
              style={{ ...primaryButtonStyle, width: "100%", background: "#7c3aed", border: "1px solid rgba(221,214,254,0.55)" }}
            >
              Queue Overnite Hail Mary
            </button>
            <div style={{ marginTop: 5, fontSize: 11, opacity: 0.72, lineHeight: 1.25 }}>
              Queues one manual limit entry for {symbol}. Backend manages synthetic stop/target after fill. No 6/7 or 5AM signal is used.
            </div>
            {hailMaryMessage ? <div style={{ marginTop: 6, color: "#86efac", fontSize: 12 }}>{hailMaryMessage}</div> : null}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => void loadAutoTradeStatus(false)} style={{ ...secondaryButtonStyle, flex: 1 }}>
            Refresh
          </button>
          <button type="button" onClick={runAutoTradeCheckOnce} disabled={autoTradeBusy} style={{ ...secondaryButtonStyle, flex: 1 }}>
            Check Once
          </button>
        </div>

        <div style={{ marginTop: 10, display: "grid", gap: 5, fontSize: 12, opacity: 0.86 }}>
          <div>Status: <strong>{autoTradeStatus?.status ?? "N/A"}</strong>{autoTradeStatus?.running ? " · loop running" : ""}</div>
          {lastSignal ? <div>Last signal: {lastSignal.symbol} entry {lastSignal.entry_price} → target {lastSignal.target_price}</div> : null}
          {lastOrder ? <div style={{ color: "#86efac" }}>Last order: {lastOrder.symbol} qty {lastOrder.qty}</div> : null}
          {Array.isArray((autoTradeStatus as any)?.queued_manual_plans) && (autoTradeStatus as any).queued_manual_plans.length > 0 ? (
            <div style={{ color: "#c4b5fd" }}>Queued plans: {(autoTradeStatus as any).queued_manual_plans.length}</div>
          ) : null}
          {lastSkip ? <div style={{ color: "#fbbf24" }}>Last skip: {lastSkip.symbol ?? "—"} · {lastSkip.reason}</div> : null}
          <div style={{ opacity: 0.72, color: queuedOrderMode === "live" ? "#86efac" : "#cbd5e1" }}>
            Auto-trade order mode: <strong>{autoTradeModeLabel}</strong>
          </div>
        </div>
      </section>
    );
  };

  const renderChartControls = (activeTimeframe: Exclude<ExpandedChartKey, null>) => (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "nowrap",
        justifyContent: "flex-end",
        minWidth: 0,
        overflow: "visible",
        scrollbarWidth: "none",
        whiteSpace: "nowrap",
      }}
    >
      <div
        style={{
          fontSize: 13,
          opacity: 0.8,
          background: "#071731",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          padding: "6px 8px",
        }}
      >
        Timeframe: {activeTimeframe}
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "nowrap",
          background: "#071731",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          padding: "6px 8px",
        }}
      >
        <select
          value={chartOverlayPresets[activeTimeframe] ?? overlayPreset}
          onChange={(e) => applyOverlayPreset(activeTimeframe, e.target.value as OverlayPreset)}
          style={{
            padding: "5px 8px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "#0a1f44",
            color: "#ffffff",
          }}
        >
          <option value="clean">Clean</option>
          <option value="runner">Runner</option>
          <option value="levels">Levels</option>
          <option value="confirmation">Confirmation</option>
        </select>

        <div style={{ position: "relative", flex: "0 0 auto", zIndex: 100000 }}>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpenStudiesMenu((prev) => (prev === activeTimeframe ? null : activeTimeframe));
            }}
            style={{
              ...topControlButtonStyle,
              minWidth: 132,
              justifyContent: "center",
              border:
                openStudiesMenu === activeTimeframe
                  ? "1px solid rgba(0,229,255,0.75)"
                  : "1px solid rgba(255,255,255,0.12)",
              background: openStudiesMenu === activeTimeframe ? "#0d2a55" : "#0a1f44",
            }}
          >
            Studies {countVisibleStudies(chartStudyVisibility[activeTimeframe] ?? DEFAULT_VISIBILITY)}/{STUDY_OPTIONS.length} ▾
          </button>

          {openStudiesMenu === activeTimeframe ? (
            <div
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              style={{
                position: "fixed",
                top: 96,
                right: 24,
                zIndex: 2147483647,
                width: "min(380px, calc(100vw - 32px))",
                maxHeight: "min(620px, calc(100vh - 120px))",
                overflowY: "auto",
                overscrollBehavior: "contain",
                WebkitOverflowScrolling: "touch",
                padding: 12,
                borderRadius: 12,
                background: "#061936",
                border: "1px solid rgba(0,229,255,0.28)",
                boxShadow: "0 18px 45px rgba(0,0,0,0.65)",
                color: "#ffffff",
                pointerEvents: "auto",
              }}
            >
              <div style={{ position: "sticky", top: -12, zIndex: 2, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "10px 0 8px", background: "#061936" }}>
                <div style={{ fontSize: 13, fontWeight: 900 }}>Chart Studies</div>
                <div style={{ fontSize: 11, opacity: 0.75 }}>{countVisibleStudies(chartStudyVisibility[activeTimeframe] ?? DEFAULT_VISIBILITY)} / {STUDY_OPTIONS.length} on</div>
              </div>

              <div style={{ display: "grid", gap: 8, paddingBottom: 8 }}>
                {STUDY_OPTIONS.map((study) => (
                  <label
                    key={study.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "7px 8px",
                      borderRadius: 8,
                      background: (chartStudyVisibility[activeTimeframe] ?? DEFAULT_VISIBILITY)[study.key] ? "rgba(14,165,233,0.14)" : "rgba(15,23,42,0.82)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 800,
                    }}
                  >
                    <span>{study.label}</span>
                    <input
                      type="checkbox"
                      checked={Boolean((chartStudyVisibility[activeTimeframe] ?? DEFAULT_VISIBILITY)[study.key])}
                      onChange={() => toggleOverlayVisibility(activeTimeframe, study.key)}
                    />
                  </label>
                ))}
              </div>

              <div style={{
                position: "sticky",
                bottom: -12,
                display: "flex",
                gap: 8,
                marginTop: 12,
                paddingTop: 10,
                paddingBottom: 2,
                background: "linear-gradient(180deg, rgba(6,25,54,0.70), #061936 35%)",
              }}>
                <button type="button" onClick={() => showAllStudies(activeTimeframe)} style={{ ...topControlButtonStyle, flex: 1 }}>
                  Show All
                </button>
                <button type="button" onClick={() => clearAllStudies(activeTimeframe)} style={{ ...topControlButtonStyle, flex: 1 }}>
                  Clear All
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "nowrap",
          background: "#071731",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          padding: "6px 8px",
        }}
      >
        <button
          onClick={() => pulseTrendlineAction({ type: "toggle_draw" })}
          style={{
            ...topControlButtonStyle,
            border: trendlineUiState.drawMode
              ? "1px solid rgba(34,197,94,0.6)"
              : "1px solid rgba(0,229,255,0.35)",
            background: trendlineUiState.drawMode ? "rgba(34,197,94,0.18)" : "#0a1f44",
          }}
        >
          {trendlineUiState.drawMode ? "Drawing..." : "Trendline"}
        </button>

        {(trendlineUiState.drawMode || trendlineUiState.pendingPoint) ? (
          <button onClick={() => pulseTrendlineAction({ type: "cancel_draw" })} style={topControlButtonStyle}>
            Cancel
          </button>
        ) : null}

        {trendlineUiState.count > 0 ? (
          <button onClick={() => pulseTrendlineAction({ type: "delete_last" })} style={topControlButtonStyle}>
            Delete Last
          </button>
        ) : null}

        {trendlineUiState.count > 0 ? (
          <button onClick={() => pulseTrendlineAction({ type: "clear_all" })} style={topControlButtonStyle}>
            Clear All
          </button>
        ) : null}

        <div style={{ fontSize: 12, opacity: 0.8 }}>
          TL: {trendlineUiState.count}
          {trendlineUiState.pendingPoint ? " · P1 set" : ""}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "nowrap",
          background: "#071731",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          padding: "6px 8px",
        }}
      >
        <input
          value={symbolInput}
          onChange={(e) => setSymbolInput(normalizeSingleSymbol(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddSymbolToWatchlist(symbolInput);
          }}
          placeholder="Symbol"
          style={{ ...inputStyle, width: 96, padding: "5px 8px", height: 32 }}
        />
        <button onClick={() => handleAddSymbolToWatchlist(symbolInput)} style={{ ...primaryButtonStyle, padding: "5px 10px", height: 32 }}>
          Add WL
        </button>
      </div>
    </div>
  );


  const renderAlpacaChartCard = ({
    chartId,
    timeframe,
    title,
    subtitle,
    lookback,
    loadDelayMs,
    statsSetter,
    cardHeight,
    chartBodyHeight,
    legendDensity = "compact",
  }: {
    chartId: string;
    timeframe: Exclude<ExpandedChartKey, null>;
    title: string;
    subtitle: string;
    lookback: string;
    loadDelayMs: number;
    statsSetter: (stats: ChartStats) => void;
    cardHeight?: string;
    chartBodyHeight?: string;
    legendDensity?: "full" | "compact" | "minimal";
  }) => {
    const isExpanded = expandedChart === timeframe;
    const isVisible = expandedChart === null || isExpanded;
    if (!isVisible) return null;

    return (
      <ChartCard
        title={title}
        subtitle={subtitle}
        expanded={isExpanded}
        compact={expandedChart === null && chartId.startsWith("bottom-")}
        cardHeight={cardHeight}
        chartBodyHeight={chartBodyHeight}
        onToggleExpand={() => toggleChartExpand(timeframe)}
        controls={renderChartControls(timeframe)}
      >
        <div style={{ width: "100%", height: "100%" }}>
          <ChartPanel
            key={`${chartId}-${symbol}-${timeframe}-${expandedChart === timeframe ? "expanded" : "normal"}-${chartResetNonce}`}
            symbol={symbol}
            timeframe={timeframe}
            onTimeframeChange={(nextTimeframe) => {
              const normalized = normalizeExpandedChart(nextTimeframe);
              if (normalized) {
                setExpandedChart(normalized);
                saveActiveAlpacaChartLocal(normalized);
              }
            }}
            initialVisibleLogicalRange={null}
            onVisibleLogicalRangeChange={(range) => handleVisibleRangeChange(timeframe, range)}
            lookback={lookback}
            loadDelayMs={loadDelayMs}
            enableLiveStream={isVisible}
            legendDensity={isExpanded ? "full" : legendDensity}
            compactTools={!isExpanded && chartId.startsWith("bottom-")}
            visibility={deferredChartStudyVisibility[timeframe] ?? DEFAULT_VISIBILITY}
            onStatsUpdate={statsSetter}
            trendlineAction={trendlineAction}
            onRequestAddSymbolToWatchlist={handleAddSymbolToWatchlist}
            showInChartWatchlistAdder={false}
            onTrendlineActionHandled={handleTrendlineActionHandled}
            onTrendlineStateChange={setTrendlineUiState}
            openOrders={ordersForChart}
            onCancelOrder={cancelChartOrderLine}
            onReplaceOrderPrice={replaceChartOrderLinePrice}
          />
        </div>
      </ChartCard>
    );
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#03152f",
        color: "#ffffff",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <GlobalHotkeys
        onOpenTemplate={handleOpenTemplate}
        onOpenQuickAlert={() => setQuickAlertOpen(true)}
        onToggleTrendline={() => pulseTrendlineAction({ type: "toggle_draw" })}
        onResetCharts={() => setChartResetNonce((prev) => prev + 1)}
        onEscape={handleEscapeHotkey}
      />

      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          background: "#061a3b",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "nowrap",
        }}
      >
        <div>
          <div style={{ fontSize: 34, fontWeight: 700 }}>Alpaca Trading Module</div>
          <div style={{ fontSize: 13, opacity: 0.78 }}>
            1m, 5m, 15m charts with watchlist, account, orders, and positions
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              value={symbolInput}
              onChange={(e) => setSymbolInput(normalizeSingleSymbol(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  loadTypedSymbol();
                }
              }}
              placeholder="Type symbol"
              style={{
                ...inputStyle,
                width: 140,
              }}
            />
            <button onClick={loadTypedSymbol} style={primaryButtonStyle}>
              Load
            </button>
          </div>

          <button onClick={() => navigate("/alpaca")} style={secondaryButtonStyle}>
            Alpaca
          </button>

          <button onClick={() => navigate("/scanner")} style={secondaryButtonStyle}>
            Scanner
          </button>

          <button
            onClick={() => navigate(`/chart?symbol=${encodeURIComponent(symbol)}&tf=1m`)}
            style={secondaryButtonStyle}
          >
            Expand Chart
          </button>

          <button onClick={() => navigate("/terminal")} style={secondaryButtonStyle}>
            Terminal
          </button>

          <button onClick={() => setMode("paper")} style={getModeButtonStyle("paper")}>
            Paper
          </button>

          <button onClick={() => setMode("live")} style={getModeButtonStyle("live")}>
            Live
          </button>

          <button onClick={() => void loadBrokerData()} style={secondaryButtonStyle}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "280px minmax(0, 1fr) 360px",
          gap: 16,
          padding: 16,
          boxSizing: "border-box",
          alignItems: "start",
          minWidth: 0,
          width: "100%",
          maxWidth: "100vw",
          overflowX: "hidden",
        }}
      >
        <aside style={panelStyle}>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>Auto Scanner Watchlist</div>
          <div style={{ height: 430, minHeight: 0, marginBottom: 18 }}>
            <ScannerPanel
              selectedSymbol={symbol}
              onSelectSymbol={handleScannerSelectSymbol}
              onWatchlistChange={(symbols) => {
                const cleaned = uniqueSymbols(symbols).slice(0, MAX_ALPACA_SCANNER_SYMBOLS);
                lastScannerSymbolsRef.current = cleaned;
                setWatchlist(cleaned);
                setWatchlistInput(cleaned.join(", "));
                saveScannerWatchlistLocal(cleaned);
              }}
            />
          </div>

          <div style={{ marginTop: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 13, opacity: 0.8 }}>Manual Watchlist</div>
              <div style={{ fontSize: 11, opacity: 0.55 }}>Not scanner controlled</div>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input
                value={manualWatchlistInput}
                onChange={(e) => setManualWatchlistInput(normalizeSingleSymbol(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitManualWatchlistAdd();
                }}
                placeholder="ADD SYMBOL"
                style={{
                  minWidth: 0,
                  flex: 1,
                  padding: "9px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "#071731",
                  color: "#dbeafe",
                  outline: "none",
                  fontSize: 13,
                  fontWeight: 700,
                  textTransform: "uppercase",
                }}
              />
              <button
                type="button"
                onClick={submitManualWatchlistAdd}
                style={{
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(34,197,94,0.35)",
                  background: "rgba(21,128,61,0.92)",
                  color: "#ecfdf5",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                Add
              </button>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {manualWatchlist.length === 0 ? (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px dashed rgba(255,255,255,0.12)",
                    background: "rgba(7,23,49,0.55)",
                    color: "rgba(255,255,255,0.6)",
                    fontSize: 12,
                  }}
                >
                  Add symbols here to keep them separate from your main watchlist.
                </div>
              ) : (
                uniqueSymbols(manualWatchlist).map((item) => {
                  const active = item === symbol;
                  return (
                    <div key={`manual-watchlist-${item}`} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={() => handleManualSelectSymbol(item)}
                        style={{
                          textAlign: "left",
                          padding: "10px 12px",
                          borderRadius: 8,
                          border: active ? "1px solid #4ea1ff" : "1px solid rgba(255,255,255,0.08)",
                          background: active ? "#12396b" : "#071731",
                          color: "white",
                          cursor: "pointer",
                          fontWeight: active ? 700 : 500,
                        }}
                      >
                        {item}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveManualSymbol(item)}
                        title={`Remove ${item} from manual watchlist`}
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 8,
                          border: "1px solid rgba(248,113,113,0.3)",
                          background: "rgba(127,29,29,0.35)",
                          color: "#fecaca",
                          cursor: "pointer",
                          fontWeight: 900,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        <main style={{ display: "grid", gap: 16, minWidth: 0, width: "100%", maxWidth: "100%", overflow: "visible" }}>
          <div
            style={{
              ...panelStyle,
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
              padding: 14,
            }}
          >
            <InfoCard label="Symbol" value={symbol} />
            <InfoCard
              label="1m Last"
              value={stats1m.last != null ? formatNumber(stats1m.last, stats1m.last >= 10 ? 2 : 4) : "N/A"}
            />
            <InfoCard
              label="15m VWAP"
              value={stats15m.vwap != null ? formatNumber(stats15m.vwap, stats15m.vwap >= 10 ? 2 : 4) : "N/A"}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr)",
              gap: 12,
              minWidth: 0,
              alignItems: "start",
            }}
          >
            {(expandedChart === null || expandedChart === "15m") && renderAlpacaChartCard({
              chartId: "main-15m",
              timeframe: "15m",
              title: `${symbol} · Main 15 Minute`,
              subtitle: `Large top chart · Bars: ${stats15m.barsCount} · Last ${stats15m.last != null ? formatNumber(stats15m.last) : "N/A"}`,
              lookback: "5d",
              loadDelayMs: 0,
              statsSetter: setStats15m,
              cardHeight: expandedChart === "15m" ? "calc(100vh - 220px)" : "560px",
              chartBodyHeight: expandedChart === "15m" ? "100%" : "455px",
              legendDensity: expandedChart === "15m" ? "full" : "compact",
            })}

            {expandedChart === null ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(360px, 1fr))",
                  gap: 12,
                  minWidth: 0,
                  alignItems: "start",
                  overflow: "visible",
                }}
              >
                {renderAlpacaChartCard({
                  chartId: "bottom-1m",
                  timeframe: "1m",
                  title: `${symbol} · 1 Minute`,
                  subtitle: `Bottom chart · Bars: ${stats1m.barsCount} · PMH ${stats1m.pmh != null ? formatNumber(stats1m.pmh) : "N/A"}`,
                  lookback: "2d",
                  loadDelayMs: 180,
                  statsSetter: setStats1m,
                  cardHeight: "470px",
                  chartBodyHeight: "360px",
                  legendDensity: "minimal",
                })}

                {renderAlpacaChartCard({
                  chartId: "bottom-5m",
                  timeframe: "5m",
                  title: `${symbol} · 5 Minute`,
                  subtitle: `Bottom chart · Bars: ${stats5m.barsCount} · VWAP ${stats5m.vwap != null ? formatNumber(stats5m.vwap) : "N/A"}`,
                  lookback: "2d",
                  loadDelayMs: 360,
                  statsSetter: setStats5m,
                  cardHeight: "470px",
                  chartBodyHeight: "360px",
                  legendDensity: "minimal",
                })}
              </div>
            ) : null}

            {expandedChart === "1m" && renderAlpacaChartCard({
              chartId: "expanded-1m",
              timeframe: "1m",
              title: `${symbol} · Expanded 1 Minute`,
              subtitle: `Expanded bottom chart · Bars: ${stats1m.barsCount} · PMH ${stats1m.pmh != null ? formatNumber(stats1m.pmh) : "N/A"}`,
              lookback: "2d",
              loadDelayMs: 0,
              statsSetter: setStats1m,
              cardHeight: "calc(100vh - 220px)",
              chartBodyHeight: "100%",
              legendDensity: "full",
            })}

            {expandedChart === "5m" && renderAlpacaChartCard({
              chartId: "expanded-5m",
              timeframe: "5m",
              title: `${symbol} · Expanded 5 Minute`,
              subtitle: `Expanded bottom chart · Bars: ${stats5m.barsCount} · VWAP ${stats5m.vwap != null ? formatNumber(stats5m.vwap) : "N/A"}`,
              lookback: "2d",
              loadDelayMs: 0,
              statsSetter: setStats5m,
              cardHeight: "calc(100vh - 220px)",
              chartBodyHeight: "100%",
              legendDensity: "full",
            })}
          </div>
        </main>

        <aside style={{ ...panelStyle, display: "grid", gridTemplateRows: "auto auto auto 1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Broker</div>
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 8 }}>
              Current mode: <strong>{mode.toUpperCase()}</strong>
            </div>
            {loading ? <div style={{ fontSize: 13, opacity: 0.8 }}>Loading account...</div> : null}
            {error ? <div style={errorBoxStyle}>{error}</div> : null}
            {submitMessage ? <div style={successBoxStyle}>{submitMessage}</div> : null}
          </div>

          <section style={subPanelStyle}>
            <div style={sectionTitleStyle}>Account</div>
            <div style={kvRowStyle}><span>Status</span><strong>{account?.status ?? "N/A"}</strong></div>
            <div style={kvRowStyle}><span>Equity</span><strong>{formatMoney(account?.equity)}</strong></div>
            <div style={kvRowStyle}><span>Buying Power</span><strong>{formatMoney(account?.buying_power)}</strong></div>
            <div style={kvRowStyle}><span>Cash</span><strong>{formatMoney(account?.cash)}</strong></div>
            <div style={kvRowStyle}><span>PDT Count</span><strong>{account?.daytrade_count ?? "N/A"}</strong></div>
          </section>

          {renderAutoTradePanel()}

          <section style={subPanelStyle}>
            <div style={sectionTitleStyle}>Custom Order Entry</div>

            <label style={labelStyle}>Symbol</label>
            <input
              value={orderForm.symbol}
              onChange={(e) =>
                setOrderForm((prev: PlaceAlpacaOrderRequest) => ({
                  ...prev,
                  symbol: normalizeSingleSymbol(e.target.value),
                }))
              }
              style={inputStyle}
            />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={labelStyle}>Cash Amount</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={cashAmount}
                  onChange={(e) => setCashAmount(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Type</label>
                <select
                  value={orderForm.type}
                  onChange={(e) =>
                    setOrderForm((prev: PlaceAlpacaOrderRequest) => ({
                      ...prev,
                      type: e.target.value as "market" | "limit",
                    }))
                  }
                  style={selectStyle}
                >
                  <option value="limit">Limit</option>
                  <option value="market">Market</option>
                </select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={labelStyle}>
                  {orderForm.type === "limit" ? "Entry Limit" : "Market Ref"}
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={orderForm.type === "limit" ? orderForm.limit_price ?? "" : marketReferencePrice ?? ""}
                  onChange={(e) => {
                    if (orderForm.type !== "limit") return;
                    setOrderForm((prev: PlaceAlpacaOrderRequest) => ({
                      ...prev,
                      limit_price: e.target.value ? Number(e.target.value) : undefined,
                    }));
                  }}
                  style={{
                    ...inputStyle,
                    opacity: orderForm.type === "limit" ? 1 : 0.7,
                  }}
                  readOnly={orderForm.type !== "limit"}
                />
              </div>

              <div>
                <label style={labelStyle}>TIF</label>
                <select
                  value={orderForm.time_in_force}
                  onChange={(e) =>
                    setOrderForm((prev: PlaceAlpacaOrderRequest) => ({
                      ...prev,
                      time_in_force: e.target.value as any,
                    }))
                  }
                  style={selectStyle}
                >
                  <option value="day">day</option>
                  <option value="gtc">gtc</option>
                  <option value="ioc">ioc</option>
                  <option value="fok">fok</option>
                  <option value="opg">opg</option>
                  <option value="cls">cls</option>
                </select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={labelStyle}>Target Price</label>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={targetPrice}
                  onChange={(e) => setTargetPrice(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Stop Price</label>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={stopPrice}
                  onChange={(e) => setStopPrice(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>

            <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={orderForm.extended_hours ?? false}
                onChange={(e) =>
                  setOrderForm((prev: PlaceAlpacaOrderRequest) => ({
                    ...prev,
                    extended_hours: e.target.checked,
                  }))
                }
              />
              Extended hours
            </label>

            <div style={{ ...subPanelStyle, marginTop: 10, padding: 10 }}>
              <div style={kvRowStyle}><span>Calc Qty</span><strong>{calculatedQty > 0 ? formatNumber(calculatedQty, 0) : "N/A"}</strong></div>
              <div style={kvRowStyle}><span>Entry Price</span><strong>{entryPriceForCalc > 0 ? formatMoney(entryPriceForCalc) : "N/A"}</strong></div>
              <div style={kvRowStyle}><span>Estimated Cost</span><strong>{estimatedCost > 0 ? formatMoney(estimatedCost) : "N/A"}</strong></div>
              <div style={kvRowStyle}><span>Target PnL</span><strong style={{ color: targetPnL >= 0 ? "#86efac" : "#fca5a5" }}>{targetPriceValue > 0 ? formatMoney(targetPnL) : "N/A"}</strong></div>
              <div style={kvRowStyle}><span>Stop Risk</span><strong style={{ color: stopRisk > 0 ? "#fca5a5" : "#dbeafe" }}>{stopPriceValue > 0 ? formatMoney(stopRisk) : "N/A"}</strong></div>
              <div style={kvRowStyle}><span>Risk / Reward</span><strong>{riskRewardRatio != null ? `1 : ${formatNumber(riskRewardRatio, 2)}` : "N/A"}</strong></div>
            </div>

            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 10 }}>
              Target and stop will be submitted as linked Alpaca bracket orders.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <button
                onClick={async () => {
                  await submitEntryOrder("buy");
                }}
                style={{ ...primaryButtonStyle, background: "#0f7b42" }}
              >
                Buy Entry
              </button>

              <button
                onClick={async () => {
                  await submitEntryOrder("sell");
                }}
                style={{ ...primaryButtonStyle, background: "#a12c2c" }}
              >
                Sell Entry
              </button>
            </div>

            <button
              onClick={async () => {
                await flattenPosition();
              }}
              style={{
                ...secondaryButtonStyle,
                marginTop: 10,
                width: "100%",
                background: "rgba(153,27,27,0.85)",
                border: "1px solid rgba(248,113,113,0.65)",
                color: "#fff",
              }}
            >
              Flatten Position
            </button>
          </section>

          <section style={{ ...subPanelStyle, overflow: "auto", minHeight: 180 }}>
            <div style={sectionTitleStyle}>Positions</div>
            {positions.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.75 }}>No open positions</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {positions.map((position) => (
                  <div key={`position-${position.asset_id ?? position.symbol}-${position.qty ?? ""}`} style={listCardStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong>{position.symbol}</strong>
                      <span>{position.side ?? "long"}</span>
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Qty: {formatNumber(position.qty, 4)}</div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Market Value: {formatMoney(position.market_value)}</div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Unrealized: {formatMoney(position.unrealized_pl)}</div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>
                      Unrealized %: {formatSignedPercent(position.unrealized_plpc != null ? Number(position.unrealized_plpc) * 100 : null)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section style={{ ...subPanelStyle, overflow: "auto", minHeight: 180 }}>
            <div style={sectionTitleStyle}>Open Orders</div>
            {orders.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.75 }}>No open orders</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {orders.map((order) => (
                  <div key={order.id} style={listCardStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong>{order.symbol}</strong>
                      <span>{order.side}</span>
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>
                      {order.type} · {order.time_in_force} · {order.status}
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>
                      Qty: {formatNumber(order.qty, 4)}
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>
                      Limit: {order.limit_price ? formatMoney(order.limit_price) : "N/A"}
                    </div>

                    <button
                      onClick={async () => {
                        await cancelOpenOrder(order.id, order.symbol);
                      }}
                      style={{
                        ...secondaryButtonStyle,
                        marginTop: 8,
                        width: "100%",
                        background: "rgba(153,27,27,0.85)",
                        border: "1px solid rgba(248,113,113,0.65)",
                        color: "#fff",
                      }}
                    >
                      Cancel Order
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <QuickOrderModal
        open={quickOrderOpen}
        initialTemplate={quickOrderTemplate}
        initialSymbol={symbol}
        onClose={() => setQuickOrderOpen(false)}
      />

      <QuickAlertModal
        open={quickAlertOpen}
        initialSymbol={symbol}
        onClose={() => setQuickAlertOpen(false)}
      />
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={subPanelStyle}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
  expanded,
  onToggleExpand,
  controls,
  compact = false,
  cardHeight: cardHeightOverride,
  chartBodyHeight: chartBodyHeightOverride,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  expanded: boolean;
  onToggleExpand: () => void;
  controls?: ReactNode;
  compact?: boolean;
  cardHeight?: string;
  chartBodyHeight?: string;
}) {
  const cardHeight = cardHeightOverride ?? (expanded ? "calc(100vh - 220px)" : compact ? "390px" : "420px");
  const chartBodyHeight = chartBodyHeightOverride ?? (expanded ? "100%" : compact ? "290px" : "320px");
  const minimized = compact && !expanded;
  const controlScale = minimized ? 0.64 : 1;

  return (
    <section
      style={{
        ...panelStyle,
        padding: minimized ? 8 : 12,
        display: "flex",
        flexDirection: "column",
        height: cardHeight,
        minHeight: cardHeight,
        maxHeight: cardHeight,
        minWidth: 0,
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
        overflow: "visible",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: minimized ? "column" : "row",
          justifyContent: minimized ? "flex-start" : "space-between",
          alignItems: minimized ? "stretch" : "center",
          gap: minimized ? 5 : 12,
          marginBottom: minimized ? 5 : 10,
          flexShrink: 0,
          position: "relative",
          zIndex: 50,
          minHeight: minimized ? 45 : undefined,
          maxHeight: undefined,
          overflow: "visible",
        }}
      >
        <div
          style={{
            minWidth: 0,
            width: minimized ? "100%" : undefined,
            maxWidth: minimized ? "100%" : undefined,
            overflow: "hidden",
            paddingTop: minimized ? 0 : 0,
            position: "relative",
            zIndex: 1,
            display: "flex",
            alignItems: minimized ? "center" : "flex-start",
            gap: minimized ? 6 : 0,
          }}
        >
          <div
            style={{
              fontSize: minimized ? 10 : 18,
              fontWeight: 800,
              lineHeight: minimized ? "12px" : "22px",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: minimized ? "44%" : undefined,
              opacity: minimized ? 0.92 : 1,
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: minimized ? 9 : 12,
              opacity: minimized ? 0.58 : 0.7,
              lineHeight: minimized ? "11px" : "15px",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: minimized ? "56%" : undefined,
              marginTop: minimized ? 0 : undefined,
            }}
          >
            {subtitle}
          </div>
        </div>

        <div
          style={{
            minWidth: 0,
            width: minimized ? "100%" : undefined,
            maxWidth: "100%",
            overflow: "visible",
            display: "flex",
            justifyContent: "flex-end",
            position: "relative",
            zIndex: 2,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: minimized ? 6 : 10,
              flexWrap: "nowrap",
              transform: minimized ? `scale(${controlScale})` : undefined,
              transformOrigin: "top right",
              width: minimized ? `${100 / controlScale}%` : undefined,
              maxWidth: minimized ? `${100 / controlScale}%` : "100%",
              overflow: "visible",
            }}
          >
            {controls}
            <button
              onClick={onToggleExpand}
              style={{
                ...secondaryButtonStyle,
                height: minimized ? 32 : undefined,
                padding: minimized ? "5px 10px" : undefined,
                fontSize: minimized ? 13 : undefined,
                flex: "0 0 auto",
              }}
            >
              {expanded ? "Restore" : "Expand"}
            </button>
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          height: chartBodyHeight,
          minHeight: chartBodyHeight,
          maxHeight: chartBodyHeight,
          width: "100%",
          minWidth: 0,
          maxWidth: "100%",
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", height: "100%", overflow: "hidden" }}>
          {children}
        </div>
      </div>
    </section>
  );
}

const panelStyle: CSSProperties = {
  background: "#0a1f44",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: 16,
  minHeight: 0,
};

const subPanelStyle: CSSProperties = {
  background: "#071731",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 10,
  padding: 12,
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "#0a1f44",
  color: "#fff",
  fontSize: 14,
};

const selectStyle: CSSProperties = {
  ...inputStyle,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  marginBottom: 10,
};

const primaryButtonStyle: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid rgba(78,161,255,0.65)",
  background: "#12396b",
  color: "#fff",
  cursor: "pointer",
  fontWeight: 700,
};

const topControlButtonStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "#0a1f44",
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 700,
};

const secondaryButtonStyle: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "#071731",
  color: "#fff",
  cursor: "pointer",
  fontWeight: 700,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  marginBottom: 10,
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  opacity: 0.75,
  marginBottom: 6,
  marginTop: 6,
};

const kvRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 13,
  padding: "4px 0",
};

const listCardStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  padding: 10,
  background: "rgba(255,255,255,0.03)",
};

const errorBoxStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "rgba(153,27,27,0.55)",
  border: "1px solid rgba(248,113,113,0.55)",
  fontSize: 13,
};

const successBoxStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "rgba(20,83,45,0.55)",
  border: "1px solid rgba(74,222,128,0.45)",
  fontSize: 13,
};

export default AlpacaPage;
