import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import ChartPanel, { type OverlayVisibility, type TrendlineControlAction } from "../components/ChartPanel";
import GlobalHotkeys from "../components/GlobalHotkeys";
import QuickOrderModal, { type OrderTemplate } from "../components/QuickOrderModal";
import QuickAlertModal from "../components/QuickAlertModal";
import {
  fetchAlpacaAccount,
  fetchAlpacaOrders,
  fetchAlpacaPositions,
  placeAlpacaOrder,
  cancelAlpacaOrder,
  sendBackendTestAlert,
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
  { key: "volumeSignals", label: "Volume Signals" },
  { key: "bodyBreakDots", label: "Black Dots" },
  { key: "closeAbovePrevCloseDots", label: "White Dots" },
  { key: "trendlineCloseAlerts", label: "Trendline Close Alerts" },
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
  volumeSignals: true,
  bodyBreakDots: true,
  closeAbovePrevCloseDots: true,
  trendlineCloseAlerts: true,
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
  volumeSignals: false,
  bodyBreakDots: false,
  closeAbovePrevCloseDots: false,
  trendlineCloseAlerts: false,
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
  },
  confirmation: {
    ...ALL_STUDIES_OFF,
    vwap: true,
    compression: true,
    choch: true,
    projections: true,
  },
};

const DEFAULT_VISIBILITY: OverlayVisibility = ALL_STUDIES_ON;

const SHARED_STUDY_VISIBILITY_STORAGE_KEY = "sharedChartStudyVisibility";

function normalizeOverlayVisibility(value: Partial<OverlayVisibility> | null | undefined): OverlayVisibility {
  return {
    ...ALL_STUDIES_ON,
    ...(value ?? {}),
  };
}

function loadSharedStudyVisibility(): OverlayVisibility {
  if (typeof window === "undefined") return ALL_STUDIES_ON;
  try {
    const raw = window.localStorage.getItem(SHARED_STUDY_VISIBILITY_STORAGE_KEY);
    if (!raw) return ALL_STUDIES_ON;
    return normalizeOverlayVisibility(JSON.parse(raw));
  } catch {
    return ALL_STUDIES_ON;
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
const SCANNER_CACHE_URL = "http://127.0.0.1:8000/scanner/cache";
const SCANNER_POLL_MS = 20000;
const BROKER_POLL_MS = 20000;
const MAX_ALPACA_SCANNER_SYMBOLS = 25;

function uniqueSymbols(items: Array<string | null | undefined>): string[] {
  return Array.from(new Set(items.map((item) => normalizeSingleSymbol(String(item ?? ""))).filter(Boolean)));
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

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
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

function parsePositiveNumber(value: string | number | null | undefined): number {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
  const [expandedChart, setExpandedChart] = useState<ExpandedChartKey>(null);

  const [account, setAccount] = useState<any | null>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [submitMessage, setSubmitMessage] = useState<string>("");
  const brokerLoadInFlightRef = useRef(false);

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
  const [overlayVisibility, setOverlayVisibility] = useState<OverlayVisibility>(() => loadSharedStudyVisibility());
  const deferredOverlayVisibility = useDeferredValue(overlayVisibility);
  const [openStudiesMenu, setOpenStudiesMenu] = useState<ExpandedChartKey>(null);
  const [trendlineUiState, setTrendlineUiState] = useState({
    drawMode: false,
    pendingPoint: false,
    count: 0,
  });
  const alertCooldownsRef = useRef<Map<string, number>>(new Map());
  const scannerLoadInFlightRef = useRef(false);
  const lastScannerSymbolsRef = useRef<string[]>(initialWatchlistRef.current);

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
        const updated = prev.includes(next) ? prev : [next, ...prev];
        setWatchlistInput(updated.join(", "));
        saveScannerWatchlistLocal(updated);
        return updated;
      });
    }

    if (options?.addToManualWatchlist) {
      setManualWatchlist((prev) => (prev.includes(next) ? prev : [next, ...prev]));
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
    const handleSharedStudyVisibilityChange = (event: Event) => {
      const nextVisibility = normalizeOverlayVisibility(
        (event as CustomEvent<OverlayVisibility>).detail
      );
      setOverlayVisibility(nextVisibility);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SHARED_STUDY_VISIBILITY_STORAGE_KEY || !event.newValue) return;
      try {
        setOverlayVisibility(normalizeOverlayVisibility(JSON.parse(event.newValue)));
      } catch {
        // Ignore bad storage data and keep the current chart state.
      }
    };

    window.addEventListener("shared-chart-study-visibility-change", handleSharedStudyVisibilityChange);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("shared-chart-study-visibility-change", handleSharedStudyVisibilityChange);
      window.removeEventListener("storage", handleStorage);
    };
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
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MANUAL_WATCHLIST_STORAGE_KEY, JSON.stringify(uniqueSymbols(manualWatchlist)));
  }, [manualWatchlist]);

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
      setOrders(Array.isArray(ordersResponse) ? ordersResponse : []);
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
  }, [mode]);

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
    setManualWatchlist((prev) => (prev.includes(next) ? prev : [next, ...prev]));
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
    setExpandedChart((prev) => (prev === chartKey ? null : chartKey));
  };

  const pulseTrendlineAction = useCallback((action: TrendlineControlAction) => {
    setTrendlineAction(action);
    window.setTimeout(() => {
      setTrendlineAction({ type: "none" });
    }, 80);
  }, []);

  const applyOverlayPreset = useCallback((nextPreset: OverlayPreset) => {
    const nextVisibility = OVERLAY_PRESETS[nextPreset];
    setOverlayPreset(nextPreset);
    saveSharedStudyVisibility(nextVisibility);
    startTransition(() => {
      setOverlayVisibility(nextVisibility);
    });
  }, []);

  const toggleOverlayVisibility = useCallback((key: keyof OverlayVisibility) => {
    setOverlayPreset("runner");
    startTransition(() => {
      setOverlayVisibility((prev) => {
        const nextVisibility = {
          ...prev,
          [key]: !prev[key],
        };
        saveSharedStudyVisibility(nextVisibility);
        return nextVisibility;
      });
    });
  }, []);

  const showAllStudies = useCallback(() => {
    setOverlayPreset("runner");
    saveSharedStudyVisibility(ALL_STUDIES_ON);
    startTransition(() => {
      setOverlayVisibility(ALL_STUDIES_ON);
    });
  }, []);

  const clearAllStudies = useCallback(() => {
    setOverlayPreset("clean");
    saveSharedStudyVisibility(ALL_STUDIES_OFF);
    startTransition(() => {
      setOverlayVisibility(ALL_STUDIES_OFF);
    });
  }, []);

  const visibleStudiesCount = useMemo(
    () => STUDY_OPTIONS.filter((study) => overlayVisibility[study.key]).length,
    [overlayVisibility]
  );

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

      const payload: PlaceAlpacaOrderRequest = {
        ...orderForm,
        mode,
        symbol: activeOrderSymbol,
        side,
        qty: calculatedQty,
        type: orderForm.type,
        time_in_force: orderForm.time_in_force,
        extended_hours: orderForm.extended_hours ?? false,
        limit_price: orderForm.type === "limit" ? entryLimitPriceValue : undefined,
      };

      setOrderForm(payload);

      await placeAlpacaOrder(payload);

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

  const cancelOpenOrder = async (orderId: string, orderSymbol: string) => {
    setSubmitMessage("");
    setError("");

    try {
      await cancelAlpacaOrder(orderId, mode);
      setSubmitMessage(`Canceled order for ${orderSymbol}`);
      await loadBrokerData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel order");
    }
  };
  const cancelChartOrderLine = useCallback(
    async (order: any) => {
      const orderId = String(order?.id ?? "");
      const orderSymbol = normalizeSingleSymbol(String(order?.symbol ?? symbol));

      if (!orderId) {
        setError("Order id is missing");
        return;
      }

      await cancelOpenOrder(orderId, orderSymbol || symbol);
    },
    [mode, symbol, loadBrokerData]
  );

  const replaceChartOrderLinePrice = useCallback(
    async (order: any, line: any, nextPrice: number) => {
      setSubmitMessage("");
      setError("");

      try {
        const orderId = String(order?.id ?? "");
        const orderSymbol = normalizeSingleSymbol(String(order?.symbol ?? symbol));
        const side: "buy" | "sell" = String(order?.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
        const qty = parsePositiveNumber(order?.qty ?? order?.quantity ?? line?.qty);
        const timeInForce = String(order?.time_in_force ?? order?.timeInForce ?? "day");
        const currentType = String(order?.type ?? order?.order_type ?? "limit").toLowerCase();
        const currentLimit = parsePositiveNumber(order?.limit_price ?? order?.limitPrice ?? order?.price);
        const currentTakeProfit = parsePositiveNumber(
          order?.take_profit?.limit_price ??
            order?.take_profit?.price ??
            order?.take_profit_price ??
            order?.takeProfitPrice
        );
        const currentStopLoss = parsePositiveNumber(
          order?.stop_loss?.stop_price ??
            order?.stop_loss?.price ??
            order?.stop_loss_price ??
            order?.stopLossPrice ??
            order?.stop_price ??
            order?.stopPrice
        );

        if (!orderId) throw new Error("Order id is missing");
        if (!orderSymbol) throw new Error("Order symbol is missing");
        if (qty <= 0) throw new Error("Order quantity is not valid");
        if (!Number.isFinite(nextPrice) || nextPrice <= 0) throw new Error("Replacement price is not valid");

        const ok = window.confirm(
          `Move ${orderSymbol} ${String(line?.label ?? "order")} to ${formatNumber(nextPrice, nextPrice >= 10 ? 2 : 4)}?\n\nA replacement order will be submitted first. The old order will only be canceled after the replacement is accepted.`
        );

        if (!ok) {
          await loadBrokerData(true);
          return;
        }

        const nextPayload: any = {
          mode,
          symbol: orderSymbol,
          side,
          qty,
          type: currentType || "limit",
          time_in_force: timeInForce,
          extended_hours: Boolean(
            order?.extended_hours ??
              order?.extendedHours ??
              orderForm.extended_hours
          ),
        };

        const orderClass = String(order?.order_class ?? order?.orderClass ?? "").toLowerCase();
        const hasBracketPrices = currentTakeProfit > 0 || currentStopLoss > 0 || Array.isArray(order?.legs);
        const isBracket = orderClass === "bracket" || hasBracketPrices;

        if (line?.kind === "take_profit") {
          nextPayload.limit_price = currentLimit > 0 ? currentLimit : undefined;
          nextPayload.order_class = "bracket";
          nextPayload.take_profit = { limit_price: nextPrice };
          if (currentStopLoss > 0) nextPayload.stop_loss = { stop_price: currentStopLoss };
        } else if (line?.kind === "stop_loss" || line?.kind === "stop") {
          if (currentType.includes("stop") && !isBracket) {
            nextPayload.type = "stop";
            nextPayload.stop_price = nextPrice;
          } else {
            nextPayload.limit_price = currentLimit > 0 ? currentLimit : undefined;
            nextPayload.order_class = "bracket";
            if (currentTakeProfit > 0) nextPayload.take_profit = { limit_price: currentTakeProfit };
            nextPayload.stop_loss = { stop_price: nextPrice };
          }
        } else {
          nextPayload.type = currentType.includes("stop") ? "stop" : "limit";
          if (nextPayload.type === "stop") {
            nextPayload.stop_price = nextPrice;
          } else {
            nextPayload.limit_price = nextPrice;
          }

          if (isBracket) {
            nextPayload.order_class = "bracket";
            if (currentTakeProfit > 0) nextPayload.take_profit = { limit_price: currentTakeProfit };
            if (currentStopLoss > 0) nextPayload.stop_loss = { stop_price: currentStopLoss };
          }
        }

        // Safer chart-drag replacement:
        // Submit the replacement first. Only cancel the old order after the new one is accepted.
        // This prevents the order from disappearing if Alpaca rejects the new price/order payload.
        await placeAlpacaOrder(nextPayload);

        const patchDraggedOrderPrice = (existingOrder: any) => {
          if (String(existingOrder?.id ?? "") !== orderId) return existingOrder;

          const patched = { ...existingOrder };
          const lineKind = String(line?.kind ?? "limit").toLowerCase();

          if (lineKind === "take_profit") {
            patched.take_profit = {
              ...(patched.take_profit ?? {}),
              limit_price: nextPrice,
            };
            patched.take_profit_price = nextPrice;
            patched.takeProfitPrice = nextPrice;
          } else if (lineKind === "stop_loss" || lineKind === "stop") {
            patched.stop_loss = {
              ...(patched.stop_loss ?? {}),
              stop_price: nextPrice,
            };
            patched.stop_loss_price = nextPrice;
            patched.stopLossPrice = nextPrice;
            patched.stop_price = nextPrice;
            patched.stopPrice = nextPrice;
          } else {
            patched.limit_price = nextPrice;
            patched.limitPrice = nextPrice;
            patched.price = nextPrice;
          }

          return patched;
        };

        // Keep the Open Orders panel in sync immediately instead of leaving it
        // showing the old price while the broker refresh is still in flight.
        setOrders((prev) => prev.map(patchDraggedOrderPrice));

        try {
          await cancelAlpacaOrder(orderId, mode);
          setSubmitMessage(`Moved ${orderSymbol} order to ${formatMoney(nextPrice)}`);
        } catch (cancelErr) {
          setError(
            cancelErr instanceof Error
              ? `Replacement order was submitted, but old order could not be canceled: ${cancelErr.message}`
              : "Replacement order was submitted, but old order could not be canceled"
          );
          setSubmitMessage(`Replacement submitted for ${orderSymbol} at ${formatMoney(nextPrice)}`);
        }

        // Alpaca can take a moment to show the new open order after cancel/replace.
        // Small delay prevents the UI from snapping back to the stale old price.
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        await loadBrokerData(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to replace order price");
        await loadBrokerData(true);
      }
    },
    [mode, symbol, loadBrokerData, orderForm.extended_hours]
  );

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
          value={overlayPreset}
          onChange={(e) => applyOverlayPreset(e.target.value as OverlayPreset)}
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

        <div style={{ position: "relative", flex: "0 0 auto" }}>
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
            Studies {visibleStudiesCount}/{STUDY_OPTIONS.length} ▾
          </button>

          {openStudiesMenu === activeTimeframe ? (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                top: "calc(100% + 8px)",
                left: 0,
                zIndex: 99999,
                width: 260,
                padding: 12,
                borderRadius: 12,
                background: "#061936",
                border: "1px solid rgba(0,229,255,0.28)",
                boxShadow: "0 18px 45px rgba(0,0,0,0.55)",
                color: "#ffffff",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 900 }}>Chart Studies</div>
                <div style={{ fontSize: 11, opacity: 0.75 }}>{visibleStudiesCount} / {STUDY_OPTIONS.length} on</div>
              </div>

              <div style={{ display: "grid", gap: 8 }}>
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
                      background: overlayVisibility[study.key] ? "rgba(14,165,233,0.14)" : "rgba(15,23,42,0.82)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 800,
                    }}
                  >
                    <span>{study.label}</span>
                    <input
                      type="checkbox"
                      checked={overlayVisibility[study.key]}
                      onChange={() => toggleOverlayVisibility(study.key)}
                    />
                  </label>
                ))}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" onClick={showAllStudies} style={{ ...topControlButtonStyle, flex: 1 }}>
                  Show All
                </button>
                <button type="button" onClick={clearAllStudies} style={{ ...topControlButtonStyle, flex: 1 }}>
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
        }}
      >
        <aside style={panelStyle}>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>Scanner Watchlist</div>

          <textarea
            value={watchlistInput}
            onChange={(e) => setWatchlistInput(e.target.value.toUpperCase())}
            rows={4}
            style={textareaStyle}
          />

          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <button onClick={applyWatchlist} style={primaryButtonStyle}>
              Apply
            </button>
            <button
              onClick={() => {
                setWatchlist([]);
                setWatchlistInput("");
                setExpandedChart(null);
                saveScannerWatchlistLocal([]);
              }}
              style={secondaryButtonStyle}
            >
              Clear
            </button>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {watchlist.length === 0 ? (
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
                Scanner watchlist is empty. Run or refresh the scanner to populate this list.
              </div>
            ) : null}
            {watchlist.map((item) => {
              const active = item === symbol;
              return (
                <button
                  key={item}
                  onClick={() => handleScannerSelectSymbol(item)}
                  style={{
                    textAlign: "left",
                    padding: "11px 12px",
                    borderRadius: 10,
                    border: active ? "1px solid #4ea1ff" : "1px solid rgba(255,255,255,0.08)",
                    background: active ? "#12396b" : "#071731",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: active ? 700 : 500,
                  }}
                >
                  {item}
                </button>
              );
            })}
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
                manualWatchlist.map((item) => {
                  const active = item === symbol;
                  return (
                    <div key={item} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
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

        <main style={{ display: "grid", gap: 16, minWidth: 0 }}>
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

          <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
            {(expandedChart === null || expandedChart === "1m") && (
              <ChartCard
                title={`${symbol} · 1 Minute`}
                subtitle={`Bars: ${stats1m.barsCount} · PMH ${stats1m.pmh != null ? formatNumber(stats1m.pmh) : "N/A"}`}
                expanded={expandedChart === "1m"}
                onToggleExpand={() => toggleChartExpand("1m")}
                controls={renderChartControls("1m")}
              >
                <div style={{ width: "100%", height: "100%" }}>
                  <ChartPanel
                    key={`${symbol}-1m-${expandedChart === "1m" ? "expanded" : "normal"}-${chartResetNonce}`}
                    symbol={symbol}
                    timeframe="1m"
                    lookback="1d"
                    loadDelayMs={0}
                    enableLiveStream={expandedChart === null || expandedChart === "1m"}
                    visibility={deferredOverlayVisibility}
                    onStatsUpdate={setStats1m}
                    trendlineAction={trendlineAction}
                    onRequestAddSymbolToWatchlist={handleAddSymbolToWatchlist}
                    showInChartWatchlistAdder={false}
                    onTrendlineActionHandled={handleTrendlineActionHandled}
                    onTrendlineStateChange={setTrendlineUiState}
                    openOrders={orders}
                    onCancelOrder={cancelChartOrderLine}
                    onReplaceOrderPrice={replaceChartOrderLinePrice}
                  />
                </div>
              </ChartCard>
            )}

            {(expandedChart === null || expandedChart === "5m") && (
              <ChartCard
                title={`${symbol} · 5 Minute`}
                subtitle={`Bars: ${stats5m.barsCount} · VWAP ${stats5m.vwap != null ? formatNumber(stats5m.vwap) : "N/A"}`}
                expanded={expandedChart === "5m"}
                onToggleExpand={() => toggleChartExpand("5m")}
                controls={renderChartControls("5m")}
              >
                <div style={{ width: "100%", height: "100%" }}>
                  <ChartPanel
                    key={`${symbol}-5m-${expandedChart === "5m" ? "expanded" : "normal"}-${chartResetNonce}`}
                    symbol={symbol}
                    timeframe="5m"
                    lookback="2d"
                    loadDelayMs={250}
                    enableLiveStream={expandedChart === "5m"}
                    visibility={deferredOverlayVisibility}
                    onStatsUpdate={setStats5m}
                    trendlineAction={trendlineAction}
                    onRequestAddSymbolToWatchlist={handleAddSymbolToWatchlist}
                    showInChartWatchlistAdder={false}
                    onTrendlineActionHandled={handleTrendlineActionHandled}
                    onTrendlineStateChange={setTrendlineUiState}
                    openOrders={orders}
                    onCancelOrder={cancelChartOrderLine}
                    onReplaceOrderPrice={replaceChartOrderLinePrice}
                  />
                </div>
              </ChartCard>
            )}

            {(expandedChart === null || expandedChart === "15m") && (
              <ChartCard
                title={`${symbol} · 15 Minute`}
                subtitle={`Bars: ${stats15m.barsCount} · Last ${stats15m.last != null ? formatNumber(stats15m.last) : "N/A"}`}
                expanded={expandedChart === "15m"}
                onToggleExpand={() => toggleChartExpand("15m")}
                controls={renderChartControls("15m")}
              >
                <div style={{ width: "100%", height: "100%" }}>
                  <ChartPanel
                    key={`${symbol}-15m-${expandedChart === "15m" ? "expanded" : "normal"}-${chartResetNonce}`}
                    symbol={symbol}
                    timeframe="15m"
                    lookback="5d"
                    loadDelayMs={500}
                    enableLiveStream={expandedChart === "15m"}
                    visibility={deferredOverlayVisibility}
                    onStatsUpdate={setStats15m}
                    trendlineAction={trendlineAction}
                    onRequestAddSymbolToWatchlist={handleAddSymbolToWatchlist}
                    showInChartWatchlistAdder={false}
                    onTrendlineActionHandled={handleTrendlineActionHandled}
                    onTrendlineStateChange={setTrendlineUiState}
                    openOrders={orders}
                    onCancelOrder={cancelChartOrderLine}
                    onReplaceOrderPrice={replaceChartOrderLinePrice}
                  />
                </div>
              </ChartCard>
            )}
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
              Target and stop are planning values only for now.
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
                  <div key={position.asset_id ?? position.symbol} style={listCardStyle}>
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
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  expanded: boolean;
  onToggleExpand: () => void;
  controls?: ReactNode;
}) {
  const cardHeight = expanded ? "calc(100vh - 220px)" : "420px";
  const chartBodyHeight = expanded ? "100%" : "320px";

  return (
    <section
      style={{
        ...panelStyle,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        height: cardHeight,
        minHeight: cardHeight,
        maxHeight: cardHeight,
        overflow: "visible",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 10,
          flexShrink: 0,
          position: "relative",
          zIndex: 50,
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{subtitle}</div>
        </div>

<div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "nowrap", justifyContent: "flex-end" }}>
          {controls}
          <button onClick={onToggleExpand} style={secondaryButtonStyle}>
            {expanded ? "Restore" : "Expand"}
          </button>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          height: chartBodyHeight,
          minHeight: chartBodyHeight,
          maxHeight: chartBodyHeight,
          overflow: "hidden",
        }}
      >
        {children}
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
