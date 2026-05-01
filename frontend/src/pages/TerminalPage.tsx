import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ChartPanel, {
  type OverlayVisibility,
  type TrendlineControlAction,
  type TrendlineSnapMode,
} from "../components/ChartPanel";
import ScannerPanel from "../components/ScannerPanel";
import GlobalHotkeys from "../components/GlobalHotkeys";
import QuickAlertModal from "../components/QuickAlertModal";
import QuickOrderModal, { type OrderTemplate } from "../components/QuickOrderModal";
import {
  fetchAlpacaOrders,
  placeAlpacaOrder,
  cancelAlpacaOrder,
} from "../services/api";
import type { PlaceAlpacaOrderRequest } from "../types/market";

type Stats = {
  last: number | null;
  pmh: number | null;
  vwap: number | null;
  barsCount: number;
};

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

const PRESETS: Record<OverlayPreset, OverlayVisibility> = {
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
    trendlines: true,
    significantCandles: true,
    bodyBreakDots: true,
    closeAbovePrevCloseDots: true,
  },
};

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

const EMERGENCY_FALLBACK_SYMBOL = "";

const MANUAL_WATCHLIST_STORAGE_KEY = "terminalManualWatchlist";
const SHARED_SCANNER_WATCHLIST_STORAGE_KEY = "watchlist";
const SHARED_ACTIVE_SYMBOL_STORAGE_KEY = "activeSymbol";

function loadSharedScannerWatchlist(): string[] {
  // Scanner watchlist must come from live ScannerPanel results only.
  // Do not hydrate from old localStorage because that is where the legacy defaults came from.
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(SHARED_SCANNER_WATCHLIST_STORAGE_KEY);
  }
  return [];
}

function loadSharedActiveSymbol(fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const saved = normalizeSingleSymbol(window.localStorage.getItem(SHARED_ACTIVE_SYMBOL_STORAGE_KEY) || "");
  return saved || fallback;
}

function saveSharedScannerWatchlist(nextWatchlist: string[]) {
  if (typeof window === "undefined") return;
  // Dispatch only. Do not persist scanner watchlist in localStorage.
  // The scanner list should repopulate only from live scanner/cache rows.
  window.dispatchEvent(new CustomEvent<string[]>("scanner-watchlist-change", { detail: nextWatchlist }));
}

function saveSharedActiveSymbol(nextSymbol: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SHARED_ACTIVE_SYMBOL_STORAGE_KEY, nextSymbol);
  window.dispatchEvent(new CustomEvent<string>("scanner-active-symbol-change", { detail: nextSymbol }));
}

function loadManualWatchlist(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MANUAL_WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map((item) => normalizeSingleSymbol(String(item))).filter(Boolean)));
  } catch {
    return [];
  }
}

const topToolButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "#0a1f44",
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 700,
};

type AlpacaMode = "paper" | "live";

function normalizeSingleSymbol(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
}

function normalizeSymbolList(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[\s,;]+/)
        .map((item) => normalizeSingleSymbol(item))
        .filter(Boolean)
    )
  );
}

function parsePositiveNumber(value: string | number | null | undefined): number {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

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

export default function TerminalPage() {
  const navigate = useNavigate();

  const initialScannerWatchlist = useMemo(() => loadSharedScannerWatchlist(), []);
  const initialSymbol = EMERGENCY_FALLBACK_SYMBOL;

  const [symbol, setSymbol] = useState(initialSymbol);
  const [scannerSelectedSymbol, setScannerSelectedSymbol] = useState(initialSymbol);
  const [timeframe, setTimeframe] = useState("1m");
  const [watchlist, setWatchlist] = useState<string[]>(initialScannerWatchlist);
  const [manualWatchlist, setManualWatchlist] = useState<string[]>(() => loadManualWatchlist());
  const [stats, setStats] = useState<Stats>({
    last: null,
    pmh: null,
    vwap: null,
    barsCount: 0,
  });

  const [preset, setPreset] = useState<OverlayPreset>("runner");
  const [visibility, setVisibility] = useState<OverlayVisibility>(() => loadSharedStudyVisibility());
  const deferredVisibility = useDeferredValue(visibility);
  const [openStudiesMenu, setOpenStudiesMenu] = useState(false);

  const [trendlineAction, setTrendlineAction] = useState<TrendlineControlAction>({
    type: "none",
  });

  const [trendlineSnapMode, setTrendlineSnapMode] =
    useState<TrendlineSnapMode>("auto");

  const [trendlineUiState, setTrendlineUiState] = useState({
    drawMode: false,
    pendingPoint: false,
    count: 0,
  });
  const [manualWatchlistInput, setManualWatchlistInput] = useState("");
  const [quickOrderOpen, setQuickOrderOpen] = useState(false);
  const [quickOrderTemplate, setQuickOrderTemplate] = useState<OrderTemplate>("buy_only");
  const [quickAlertOpen, setQuickAlertOpen] = useState(false);
  const [mode, setMode] = useState<AlpacaMode>("paper");
  const [orders, setOrders] = useState<any[]>([]);
  const [orderMessage, setOrderMessage] = useState("");
  const [orderError, setOrderError] = useState("");
  const brokerOrdersInFlightRef = useRef(false);


  useEffect(() => {
    const handleSharedStudyVisibilityChange = (event: Event) => {
      const nextVisibility = normalizeOverlayVisibility(
        (event as CustomEvent<OverlayVisibility>).detail
      );
      setVisibility(nextVisibility);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SHARED_STUDY_VISIBILITY_STORAGE_KEY || !event.newValue) return;
      try {
        setVisibility(normalizeOverlayVisibility(JSON.parse(event.newValue)));
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

  const symbolUpper = useMemo(() => normalizeSingleSymbol(symbol), [symbol]);

  useEffect(() => {
    window.localStorage.setItem(MANUAL_WATCHLIST_STORAGE_KEY, JSON.stringify(manualWatchlist));
  }, [manualWatchlist]);

  useEffect(() => {
    const applySharedWatchlist = (nextWatchlist: string[]) => {
      const cleaned = Array.from(
        new Set(nextWatchlist.map((item) => normalizeSingleSymbol(String(item))).filter(Boolean))
      );
      if (!cleaned.length) return;

      setWatchlist((prev) => {
        if (prev.length === cleaned.length && prev.every((item, index) => item === cleaned[index])) {
          return prev;
        }
        return cleaned;
      });
      setScannerSelectedSymbol((prev) => (cleaned.includes(prev) ? prev : cleaned[0]));
    };

    const handleScannerWatchlistEvent = (event: Event) => {
      const nextWatchlist = (event as CustomEvent<string[]>).detail;
      if (Array.isArray(nextWatchlist)) applySharedWatchlist(nextWatchlist);
    };

    const handleScannerActiveSymbolEvent = (event: Event) => {
      const next = normalizeSingleSymbol((event as CustomEvent<string>).detail || "");
      if (!next) return;
      setSymbol(next);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === SHARED_ACTIVE_SYMBOL_STORAGE_KEY && event.newValue) {
        const next = normalizeSingleSymbol(event.newValue);
        if (next) {
          setSymbol(next);
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

  const openExpandedChart = () => {
    const url = `/chart?symbol=${encodeURIComponent(symbolUpper)}&tf=${encodeURIComponent(timeframe)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const applyPreset = (nextPreset: OverlayPreset) => {
    const nextVisibility = PRESETS[nextPreset];
    setPreset(nextPreset);
    saveSharedStudyVisibility(nextVisibility);
    setVisibility(nextVisibility);
  };

  const toggleVisibility = (key: keyof OverlayVisibility) => {
    setPreset("runner");
    setVisibility((prev) => {
      const nextVisibility = {
        ...prev,
        [key]: !prev[key],
      };
      saveSharedStudyVisibility(nextVisibility);
      return nextVisibility;
    });
  };

  const visibleStudiesCount = useMemo(
    () => STUDY_OPTIONS.filter((study) => visibility[study.key]).length,
    [visibility]
  );

  const showAllStudies = () => {
    setPreset("runner");
    saveSharedStudyVisibility(ALL_STUDIES_ON);
    setVisibility(ALL_STUDIES_ON);
  };

  const clearAllStudies = () => {
    setPreset("clean");
    saveSharedStudyVisibility(ALL_STUDIES_OFF);
    setVisibility(ALL_STUDIES_OFF);
  };

  const handleScannerWatchlistChange = useCallback((symbols: string[]) => {
    const cleaned = Array.from(
      new Set(
        symbols
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean)
      )
    );

    if (!cleaned.length) return;

    setWatchlist((prev) => {
      if (
        prev.length === cleaned.length &&
        prev.every((item, index) => item === cleaned[index])
      ) {
        return prev;
      }
      return cleaned;
    });
    saveSharedScannerWatchlist(cleaned);

    setScannerSelectedSymbol((prev) =>
      cleaned.includes(prev) ? prev : cleaned[0]
    );
  }, []);

  const handleScannerSelectSymbol = useCallback((nextSymbol: string) => {
    const next = normalizeSingleSymbol(nextSymbol);
    if (!next) return;
    setScannerSelectedSymbol(next);
    setSymbol(next);
    saveSharedActiveSymbol(next);
  }, []);

  const handleManualSelectSymbol = useCallback((nextSymbol: string) => {
    const next = normalizeSingleSymbol(nextSymbol);
    if (!next) return;
    setSymbol(next);
    saveSharedActiveSymbol(next);
  }, []);

  const handleAddSymbolToWatchlist = useCallback((nextSymbol: string) => {
    const symbolsToAdd = normalizeSymbolList(nextSymbol);
    if (!symbolsToAdd.length) return;

    setManualWatchlist((prev) => {
      const nextList = [...symbolsToAdd, ...prev];
      return Array.from(new Set(nextList));
    });

    const firstSymbol = symbolsToAdd[0];
    setSymbol(firstSymbol);
    saveSharedActiveSymbol(firstSymbol);
  }, []);

  const handleRemoveManualSymbol = useCallback((nextSymbol: string) => {
    const next = normalizeSingleSymbol(nextSymbol);
    setManualWatchlist((prev) => prev.filter((item) => item !== next));
  }, []);

  const submitTopWatchlistAdd = useCallback(() => {
    const next = manualWatchlistInput.trim().toUpperCase() || symbolUpper;
    if (!next) return;
    handleAddSymbolToWatchlist(next);
    setManualWatchlistInput("");
  }, [handleAddSymbolToWatchlist, manualWatchlistInput, symbolUpper]);

  const openQuickOrderTemplate = useCallback((template: OrderTemplate) => {
    localStorage.setItem("activeSymbol", symbolUpper);
    setQuickOrderTemplate(template);
    setQuickOrderOpen(true);
  }, [symbolUpper]);

  const openQuickAlert = useCallback(() => {
    localStorage.setItem("activeSymbol", symbolUpper);
    setQuickAlertOpen(true);
  }, [symbolUpper]);

  const loadBrokerOrders = useCallback(async (silent = false) => {
    if (brokerOrdersInFlightRef.current) return;
    brokerOrdersInFlightRef.current = true;

    try {
      if (!silent) setOrderError("");
      const openOrders = await fetchAlpacaOrders(mode, "open");
      setOrders(Array.isArray(openOrders) ? openOrders : []);
    } catch (err) {
      setOrderError(err instanceof Error ? err.message : "Failed to load open orders");
    } finally {
      brokerOrdersInFlightRef.current = false;
    }
  }, [mode]);

  useEffect(() => {
    void loadBrokerOrders();
  }, [loadBrokerOrders]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadBrokerOrders(true);
    }, 8000);
    return () => window.clearInterval(id);
  }, [loadBrokerOrders]);

  const closeQuickOrderAndRefresh = useCallback(() => {
    setQuickOrderOpen(false);
    window.setTimeout(() => {
      void loadBrokerOrders(true);
    }, 350);
  }, [loadBrokerOrders]);

  const cancelChartOrderLine = useCallback(
    async (order: any) => {
      const orderId = String(order?.id ?? "");
      const orderSymbol = normalizeSingleSymbol(String(order?.symbol ?? symbolUpper));
      if (!orderId) {
        setOrderError("Order id is missing");
        return;
      }
      try {
        setOrderError("");
        setOrderMessage("");
        await cancelAlpacaOrder(orderId, mode);
        setOrderMessage(`Canceled order for ${orderSymbol || symbolUpper}`);
        await loadBrokerOrders(true);
      } catch (err) {
        setOrderError(err instanceof Error ? err.message : "Failed to cancel order");
      }
    },
    [mode, symbolUpper, loadBrokerOrders]
  );

  const replaceChartOrderLinePrice = useCallback(
    async (order: any, line: any, nextPrice: number) => {
      setOrderMessage("");
      setOrderError("");
      try {
        const orderId = String(order?.id ?? "");
        const orderSymbol = normalizeSingleSymbol(String(order?.symbol ?? symbolUpper));
        const side: "buy" | "sell" = String(order?.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
        const qty = parsePositiveNumber(order?.qty ?? order?.quantity ?? line?.qty);
        const timeInForce = String(order?.time_in_force ?? order?.timeInForce ?? "day");
        const currentType = String(order?.type ?? order?.order_type ?? "limit").toLowerCase();
        const currentLimit = parsePositiveNumber(order?.limit_price ?? order?.limitPrice ?? order?.price);
        const currentTakeProfit = parsePositiveNumber(order?.take_profit?.limit_price ?? order?.take_profit?.price ?? order?.take_profit_price ?? order?.takeProfitPrice);
        const currentStopLoss = parsePositiveNumber(order?.stop_loss?.stop_price ?? order?.stop_loss?.price ?? order?.stop_loss_price ?? order?.stopLossPrice ?? order?.stop_price ?? order?.stopPrice);
        if (!orderId) throw new Error("Order id is missing");
        if (!orderSymbol) throw new Error("Order symbol is missing");
        if (qty <= 0) throw new Error("Order quantity is not valid");
        if (!Number.isFinite(nextPrice) || nextPrice <= 0) throw new Error("Replacement price is not valid");
        const ok = window.confirm(`Move ${orderSymbol} ${String(line?.label ?? "order")} to ${formatNumber(nextPrice, nextPrice >= 10 ? 2 : 4)}?\n\nA replacement order will be submitted first. The old order will only be canceled after the replacement is accepted.`);
        if (!ok) {
          await loadBrokerOrders(true);
          return;
        }
        const nextPayload: PlaceAlpacaOrderRequest = {
          mode,
          symbol: orderSymbol,
          side,
          qty,
          type: currentType.includes("stop") ? "stop" : "limit",
          time_in_force: timeInForce,
          extended_hours: Boolean(order?.extended_hours ?? order?.extendedHours ?? false),
        } as PlaceAlpacaOrderRequest;
        const orderClass = String(order?.order_class ?? order?.orderClass ?? "").toLowerCase();
        const hasBracketPrices = currentTakeProfit > 0 || currentStopLoss > 0 || Array.isArray(order?.legs);
        const isBracket = orderClass === "bracket" || hasBracketPrices;
        if (line?.kind === "take_profit") {
          (nextPayload as any).limit_price = currentLimit > 0 ? currentLimit : undefined;
          (nextPayload as any).order_class = "bracket";
          (nextPayload as any).take_profit = { limit_price: nextPrice };
          if (currentStopLoss > 0) (nextPayload as any).stop_loss = { stop_price: currentStopLoss };
        } else if (line?.kind === "stop_loss" || line?.kind === "stop") {
          if (currentType.includes("stop") && !isBracket) {
            (nextPayload as any).type = "stop";
            (nextPayload as any).stop_price = nextPrice;
          } else {
            (nextPayload as any).limit_price = currentLimit > 0 ? currentLimit : undefined;
            (nextPayload as any).order_class = "bracket";
            if (currentTakeProfit > 0) (nextPayload as any).take_profit = { limit_price: currentTakeProfit };
            (nextPayload as any).stop_loss = { stop_price: nextPrice };
          }
        } else {
          if ((nextPayload as any).type === "stop") (nextPayload as any).stop_price = nextPrice;
          else (nextPayload as any).limit_price = nextPrice;
          if (isBracket) {
            (nextPayload as any).order_class = "bracket";
            if (currentTakeProfit > 0) (nextPayload as any).take_profit = { limit_price: currentTakeProfit };
            if (currentStopLoss > 0) (nextPayload as any).stop_loss = { stop_price: currentStopLoss };
          }
        }
        await placeAlpacaOrder(nextPayload);
        await cancelAlpacaOrder(orderId, mode);
        setOrderMessage(`Moved ${orderSymbol} order to ${formatMoney(nextPrice)}`);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        await loadBrokerOrders(true);
      } catch (err) {
        setOrderError(err instanceof Error ? err.message : "Failed to replace order price");
        await loadBrokerOrders(true);
      }
    },
    [mode, symbolUpper, loadBrokerOrders]
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
        onOpenTemplate={openQuickOrderTemplate}
        onOpenQuickAlert={openQuickAlert}
        onToggleTrendline={() => setTrendlineAction({ type: "toggle_draw" })}
        onResetCharts={() => {
          setVisibility(PRESETS.runner);
          setPreset("runner");
        }}
        onEscape={() => {
          setTrendlineAction({ type: "cancel_draw" });
          setQuickOrderOpen(false);
          setQuickAlertOpen(false);
        }}
      />

      <QuickOrderModal
        open={quickOrderOpen}
        initialTemplate={quickOrderTemplate}
        initialSymbol={symbolUpper}
        onClose={closeQuickOrderAndRefresh}
      />

      <QuickAlertModal
        open={quickAlertOpen}
        initialSymbol={symbolUpper}
        onClose={() => setQuickAlertOpen(false)}
      />

      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          background: "#061a3b",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 34, fontWeight: 700 }}>
          Trading Terminal
        </h1>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => navigate("/alpaca")}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #4ea1ff",
              background: "#071731",
              color: "#ffffff",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Alpaca
          </button>

          <button
            onClick={() => navigate("/scanner")}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #4ea1ff",
              background: "#071731",
              color: "#ffffff",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Scanner
          </button>

          <button
            onClick={openExpandedChart}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #4ea1ff",
              background: "#12396b",
              color: "#ffffff",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Expand Chart
          </button>

          <div
            style={{
              display: "flex",
              gap: 4,
              padding: 4,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "#071731",
            }}
            title="Controls which Alpaca open orders are drawn on this chart"
          >
            <button
              onClick={() => setMode("paper")}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: mode === "paper" ? "1px solid #4ea1ff" : "1px solid transparent",
                background: mode === "paper" ? "#12396b" : "transparent",
                color: "#ffffff",
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              Paper
            </button>
            <button
              onClick={() => setMode("live")}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: mode === "live" ? "1px solid rgba(239,68,68,0.85)" : "1px solid transparent",
                background: mode === "live" ? "rgba(127,29,29,0.75)" : "transparent",
                color: "#ffffff",
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              Live
            </button>
          </div>

          <button
            onClick={() => openQuickOrderTemplate("buy_only")}
            title="Hotkey: Alt+B"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid rgba(34,197,94,0.45)",
              background: "rgba(21,128,61,0.95)",
              color: "#ffffff",
              cursor: "pointer",
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            Buy
          </button>

          <button
            onClick={openQuickAlert}
            title="Hotkey: Alt+A"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid rgba(251,191,36,0.45)",
              background: "rgba(146,64,14,0.95)",
              color: "#ffffff",
              cursor: "pointer",
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            Alert
          </button>

          <button
            onClick={() =>
              navigate(`/chart?symbol=${encodeURIComponent(symbolUpper)}&tf=${encodeURIComponent(timeframe)}`)
            }
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "#071731",
              color: "#ffffff",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Open Here
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "320px minmax(0, 1fr)",
          gap: 16,
          padding: 16,
          alignItems: "stretch",
          overflow: "hidden",
          isolation: "isolate",
        }}
      >
        <aside
          style={{
            background: "#0a1f44",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12,
            padding: 16,
            height: "calc(100vh - 110px)",
            overflow: "auto",
            position: "relative",
            zIndex: 20,
            boxSizing: "border-box",
            minWidth: 0,
          }}
        >
          <div style={{ height: 350, marginBottom: 16 }}>
            <ScannerPanel
              selectedSymbol={scannerSelectedSymbol}
              onSelectSymbol={handleScannerSelectSymbol}
              onWatchlistChange={handleScannerWatchlistChange}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
              Symbol
            </div>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="Ticker"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "#071731",
                color: "white",
                fontSize: 16,
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
              Timeframe
            </div>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "#071731",
                color: "white",
                fontSize: 15,
              }}
            >
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="30m">30m</option>
              <option value="1h">1h</option>
              <option value="1d">1d</option>
            </select>
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
              Trendline Snap
            </div>
            <select
              value={trendlineSnapMode}
              onChange={(e) => setTrendlineSnapMode(e.target.value as TrendlineSnapMode)}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "#071731",
                color: "white",
                fontSize: 15,
              }}
            >
              <option value="auto">Auto</option>
              <option value="wick">High / Low Wicks</option>
              <option value="body">Open / Close Body</option>
            </select>
          </div>

          <div
            style={{
              background: "#071731",
              borderRadius: 10,
              padding: 12,
              marginBottom: 18,
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
              Stats
            </div>
            <div style={{ marginBottom: 8 }}>
              <strong>Last:</strong> {stats.last ?? "N/A"}
            </div>
            <div style={{ marginBottom: 8 }}>
              <strong>PMH:</strong> {stats.pmh ?? "N/A"}
            </div>
            <div style={{ marginBottom: 8 }}>
              <strong>VWAP:</strong> {stats.vwap ?? "N/A"}
            </div>
            <div>
              <strong>Bars:</strong> {stats.barsCount}
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>Scanner Watchlist</div>
            <div style={{ display: "grid", gap: 8 }}>
              {watchlist.length === 0 ? (
                <div style={{ padding: "10px 12px", borderRadius: 8, border: "1px dashed rgba(255,255,255,0.12)", background: "rgba(7,23,49,0.55)", color: "rgba(255,255,255,0.6)", fontSize: 12 }}>
                  Scanner watchlist is empty. Run or refresh the scanner to populate this list.
                </div>
              ) : null}
              {watchlist.map((item) => {
                const active = item === symbolUpper;
                return (
                  <button key={item} type="button" onClick={() => handleScannerSelectSymbol(item)} style={{ textAlign: "left", padding: "10px 12px", borderRadius: 8, border: active ? "1px solid #4ea1ff" : "1px solid rgba(255,255,255,0.08)", background: active ? "#12396b" : "#071731", color: "white", cursor: "pointer", fontWeight: active ? 700 : 500 }}>
                    {item}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 13, opacity: 0.8 }}>Manual Watchlist</div>
              <div style={{ fontSize: 11, opacity: 0.55 }}>Not scanner controlled</div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input value={manualWatchlistInput} onChange={(e) => setManualWatchlistInput(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") submitTopWatchlistAdd(); }} placeholder="ADD SYMBOL" style={{ minWidth: 0, flex: 1, padding: "9px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.14)", background: "#071731", color: "#dbeafe", outline: "none", fontSize: 13, fontWeight: 700, textTransform: "uppercase" }} />
              <button type="button" onClick={submitTopWatchlistAdd} style={{ padding: "0 12px", borderRadius: 8, border: "1px solid rgba(34,197,94,0.35)", background: "rgba(21,128,61,0.92)", color: "#ecfdf5", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Add</button>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {manualWatchlist.length === 0 ? (
                <div style={{ padding: "10px 12px", borderRadius: 8, border: "1px dashed rgba(255,255,255,0.12)", background: "rgba(7,23,49,0.55)", color: "rgba(255,255,255,0.6)", fontSize: 12 }}>Add symbols here to keep them separate from scanner picks.</div>
              ) : (
                manualWatchlist.map((item) => {
                  const active = item === symbolUpper;
                  return (
                    <div key={item} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
                      <button type="button" onClick={() => handleManualSelectSymbol(item)} style={{ textAlign: "left", padding: "10px 12px", borderRadius: 8, border: active ? "1px solid #4ea1ff" : "1px solid rgba(255,255,255,0.08)", background: active ? "#12396b" : "#071731", color: "white", cursor: "pointer", fontWeight: active ? 700 : 500 }}>{item}</button>
                      <button type="button" onClick={() => handleRemoveManualSymbol(item)} title={"Remove " + item + " from manual watchlist"} style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid rgba(248,113,113,0.3)", background: "rgba(127,29,29,0.35)", color: "#fecaca", cursor: "pointer", fontWeight: 900 }}>×</button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        <main
          style={{
            background: "#0a1f44",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12,
            padding: 12,
            height: "calc(100vh - 110px)",
            minHeight: 500,
            minWidth: 0,
            overflow: "hidden",
            position: "relative",
            zIndex: 1,
            boxSizing: "border-box",
            contain: "layout paint",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
              padding: "4px 8px 10px 8px",
              gap: 12,
              minWidth: 0,
            }}
          >
            <div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>
                {symbolUpper}
              </div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>
                Candles with PMH + VWAP
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                minWidth: 0,
                flex: 1,
                justifyContent: "flex-end",
                overflowX: "visible",
                overflowY: "visible",
                whiteSpace: "nowrap",
                paddingBottom: 2,
                scrollbarWidth: "thin",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  opacity: 0.8,
                  background: "#071731",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  flex: "0 0 auto",
                }}
              >
                Timeframe: {timeframe}
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  background: "#071731",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  flex: "0 0 auto",
                }}
              >
                <select
                  value={preset}
                  onChange={(e) => applyPreset(e.target.value as OverlayPreset)}
                  style={{
                    padding: "6px 8px",
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
                      setOpenStudiesMenu((prev) => !prev);
                    }}
                    style={{
                      ...topToolButtonStyle,
                      minWidth: 132,
                      border: openStudiesMenu
                        ? "1px solid rgba(0,229,255,0.75)"
                        : "1px solid rgba(255,255,255,0.12)",
                      background: openStudiesMenu ? "#0d2a55" : "#0a1f44",
                    }}
                  >
                    Studies {visibleStudiesCount}/{STUDY_OPTIONS.length} ▾
                  </button>

                  {openStudiesMenu ? (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: "absolute",
                        top: "calc(100% + 8px)",
                        left: 0,
                        zIndex: 99999,
                        width: 270,
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
                              background: visibility[study.key] ? "rgba(14,165,233,0.14)" : "rgba(15,23,42,0.82)",
                              border: "1px solid rgba(255,255,255,0.08)",
                              cursor: "pointer",
                              fontSize: 13,
                              fontWeight: 800,
                            }}
                          >
                            <span>{study.label}</span>
                            <input
                              type="checkbox"
                              checked={Boolean(visibility[study.key])}
                              onChange={() => toggleVisibility(study.key)}
                            />
                          </label>
                        ))}
                      </div>

                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button type="button" onClick={showAllStudies} style={{ ...topToolButtonStyle, flex: 1 }}>
                          Show All
                        </button>
                        <button type="button" onClick={clearAllStudies} style={{ ...topToolButtonStyle, flex: 1 }}>
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
                  background: "#071731",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  flex: "0 0 auto",
                }}
              >
                <button
                  onClick={() =>
                    setTrendlineAction({ type: "toggle_draw" })
                  }
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: trendlineUiState.drawMode
                      ? "1px solid rgba(34,197,94,0.6)"
                      : "1px solid rgba(0,229,255,0.35)",
                    background: trendlineUiState.drawMode
                      ? "rgba(34,197,94,0.18)"
                      : "#0a1f44",
                    color: "#ffffff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  {trendlineUiState.drawMode ? "Drawing..." : "Trendline"}
                </button>

                {(trendlineUiState.drawMode || trendlineUiState.pendingPoint) ? (
                  <button
                    onClick={() => setTrendlineAction({ type: "cancel_draw" })}
                    style={topToolButtonStyle}
                  >
                    Cancel
                  </button>
                ) : null}

                {trendlineUiState.count > 0 ? (
                  <button
                    onClick={() => setTrendlineAction({ type: "delete_last" })}
                    style={topToolButtonStyle}
                  >
                    Delete Last
                  </button>
                ) : null}

                {trendlineUiState.count > 0 ? (
                  <button
                    onClick={() => setTrendlineAction({ type: "clear_all" })}
                    style={topToolButtonStyle}
                  >
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
                  background: "#071731",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  flex: "0 0 auto",
                }}
              >
                <input
                  value={manualWatchlistInput}
                  onChange={(e) => setManualWatchlistInput(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitTopWatchlistAdd();
                  }}
                  placeholder={symbolUpper}
                  style={{
                    width: 96,
                    height: 30,
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(2, 18, 43, 0.95)",
                    color: "#dbeafe",
                    padding: "0 10px",
                    outline: "none",
                    fontSize: 12,
                    fontWeight: 700,
                    textTransform: "uppercase",
                  }}
                />
                <button
                  onClick={submitTopWatchlistAdd}
                  style={{
                    height: 30,
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
                  Add WL
                </button>
              </div>

              <button
                onClick={openExpandedChart}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #4ea1ff",
                  background: "#12396b",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                  flex: "0 0 auto",
                }}
              >
                Expand
              </button>
            </div>
          </div>

          {(orderMessage || orderError) ? (
            <div
              style={{
                margin: "0 8px 8px 8px",
                padding: "8px 10px",
                borderRadius: 8,
                border: orderError ? "1px solid rgba(248,113,113,0.35)" : "1px solid rgba(34,197,94,0.3)",
                background: orderError ? "rgba(127,29,29,0.18)" : "rgba(21,128,61,0.16)",
                color: orderError ? "#fecaca" : "#bbf7d0",
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {orderError || orderMessage}
            </div>
          ) : null}

          <div
            style={{
              height: orderMessage || orderError ? "calc(100% - 102px)" : "calc(100% - 60px)",
              minWidth: 0,
              width: "100%",
              overflow: "hidden",
              position: "relative",
              borderRadius: 8,
              isolation: "isolate",
              contain: "layout paint",
            }}
          >
            <ChartPanel
              symbol={symbolUpper}
              timeframe={timeframe}
              visibility={deferredVisibility}
              onStatsUpdate={(next) => setStats(next)}
              trendlineAction={trendlineAction}
              trendlineSnapMode={trendlineSnapMode}
              onTrendlineActionHandled={() =>
                setTrendlineAction({ type: "none" })
              }
              onTrendlineStateChange={setTrendlineUiState}
              onRequestAddSymbolToWatchlist={handleAddSymbolToWatchlist}
              showInChartWatchlistAdder={false}
              openOrders={orders}
              onCancelOrder={cancelChartOrderLine}
              onReplaceOrderPrice={replaceChartOrderLinePrice}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
