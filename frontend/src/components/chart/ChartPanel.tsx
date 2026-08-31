// src/components/chart/ChartPanel.tsx

import { memo, useEffect, useRef, useState } from "react";

import { ChartEngine } from "./ChartEngine";
import type { ChartState } from "./ChartState";
import type { CrosshairInfo, LiveStatus, StudyVisibility } from "./ChartTypes";
import { connectLiveBars, loadHistoricalBars } from "./LiveDataEngine";
import { getSharedReplayRuntime } from "../../trading/replay/ReplayRuntime";
import {
  MARKET_DATA_MODE_CHANGE_EVENT,
  MARKET_DATA_MODE_STORAGE_KEY,
  type MarketDataMode,
  type ReplaySnapshot,
  type ReplaySpeed,
} from "../../trading/replay/ReplayTypes";
import {
  readSavedPracticeReplayRequest,
  readSelectedPracticeTradingDate,
  saveSelectedPracticeTradingDate,
  subscribeToPracticeReplayRequests,
  subscribeToSelectedPracticeTradingDate,
} from "../../trading/practice/PracticeReplayLauncher";
import type { ReplayStartMode } from "../../trading/replay/ReplaySessionManager";
import { switchExecutionMode } from "../../trading/execution/router/ExecutionProviderRuntime";
import { useActiveSymbol } from "./ActiveSymbolContext";
import ChartToolbarV2 from "./ChartToolbarV2";
import ChartViewport from "./ChartViewport";
import LeftDrawingBar from "./LeftDrawingBar";
import RightInfoPanel from "./RightInfoPanel";
import { DrawingEngine } from "./DrawingEngine";
import { MarketObjectDrawingBridge } from "./analysis/market-objects/MarketObjectDrawingBridge";
import type { ChartIntelligenceBridge } from "../../trading/intelligence/integration/ChartIntelligenceBridge";
import { TrendlineTool } from "./interaction/tools/TrendlineTool";
import { HorizontalLineTool } from "./interaction/tools/HorizontalLineTool";
import { RectangleTool } from "./interaction/tools/RectangleTool";
import { PriceRangeTool } from "./interaction/tools/PriceRangeTool";
import { LongPositionTool } from "./interaction/tools/LongPositionTool";
import { MarketStructureTool } from "./interaction/tools/MarketStructureTool";
import { SelectTool } from "./interaction/tools/SelectTool";
import {
  CHART_TOOL_COMPLETED_EVENT,
  type ChartToolCompletionEvent,
} from "./interaction/ChartTool";
import type { TradeEngine } from "../../trading/engine/TradeEngine";
import { getSharedTradeEngine } from "../../trading/engine/TradeEngineRuntime";
import { TradeController } from "../../trading/controller/TradeController";
import { getSharedExecutionGateway } from "../../trading/execution/ExecutionGateway";
import { getSharedPositionProtectionEngine } from "../../trading/position/PositionProtectionEngine";
import { setPositionLevelIntent } from "../../trading/position/PositionLevelIntentStore";
import {
  PositionOverlayManager,
  type PositionOverlayCommit,
} from "./PositionOverlayManager";
import SettingsPanel, { type SettingsMode } from "./SettingsPanel";
import { DEFAULT_DRAWING_STYLE } from "./DrawingTypes";
import type { DrawingStyle, DrawingTool } from "./DrawingTypes";
import {
  DEFAULT_FX_ANALYSIS_SETTINGS,
  type FxAnalysisSettings,
  type FxAnalysisToolId,
} from "./analysis";
import {
  DEFAULT_CHART_SETTINGS,
  normalizeChartSettings,
  type ChartSettings,
} from "./ChartSettingsTypes";
import {
  API_BASE,
  fetchAutoTradeStatus,
  fetchScannerCache,
  fetchVwap3SetupHistory,
  updateOvernightProtectedOrderPrice,
  type AutoTradeStatus,
  type Vwap3SetupHistoryRow,
} from "../../services/api";

const TIMEFRAME_STORAGE_KEY = "chartv2.timeframe";
const STUDY_STORAGE_KEY = "chartv2.studyVisibility";
const RIGHT_PANEL_COLLAPSED_KEY = "chartv2.rightPanelCollapsed";
const DRAWING_STYLE_STORAGE_KEY = "chartv2.drawingStyle";
const FX_ANALYSIS_TOOL_STORAGE_KEY = "chartv2.fxAnalysisTool";
const FX_ANALYSIS_SETTINGS_STORAGE_KEY = "chartv2.fxAnalysisSettings";
const CHART_SETTINGS_STORAGE_KEY = "chartv2.chartSettings";
const CHART_PREFERENCES_POLL_MS = 15_000;
const CHART_PREFERENCES_SAVE_DELAY_MS = 180;
const LIVE_CHART_STATE_THROTTLE_MS = 250;
const VWAP3_CHART_OVERLAY_REFRESH_MS = 15_000;
const VWAP3_SELECTED_SETUP_STORAGE_KEY = "trading.vwap3Chart.selectedSetup.v1";

function pacificTodayIsoForChart(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function latestVwap3SetupForSymbol(
  rows: Vwap3SetupHistoryRow[],
  symbol: string,
): Vwap3SetupHistoryRow | null {
  const normalized = symbol.trim().toUpperCase();
  const matches = rows.filter(
    (row) => String(row.symbol ?? "").trim().toUpperCase() === normalized,
  );
  matches.sort((a, b) => {
    const aTime = Date.parse(String(a.freeze_time ?? a.displacement_time ?? ""));
    const bTime = Date.parse(String(b.freeze_time ?? b.displacement_time ?? ""));
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
  return matches[0] ?? null;
}

function readSelectedVwap3SetupForSymbol(
  symbol: string,
): Vwap3SetupHistoryRow | null {
  try {
    const raw = window.localStorage.getItem(VWAP3_SELECTED_SETUP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Vwap3SetupHistoryRow;
    const selectedSymbol = String(parsed?.symbol ?? "").trim().toUpperCase();
    if (!selectedSymbol || selectedSymbol !== symbol.trim().toUpperCase()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function scannerCacheRowsForVwap3(cache: unknown): Vwap3SetupHistoryRow[] {
  if (!cache || typeof cache !== "object") return [];
  const data = (cache as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const rows = (data as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Vwap3SetupHistoryRow[]) : [];
}

const DEFAULT_STUDY_VISIBILITY: StudyVisibility = {
  vwap: true,
  ema9: true,
  ema20: true,
  ema50: true,
  volume: true,
  vwap3Expansion: true,
  bullishFvg: false,
  bearishFvg: false,
  marketStructure: true,
  demandZones: true,
};

type ChartPreferences = {
  studyVisibility: StudyVisibility;
  fxAnalysisSettings: FxAnalysisSettings;
  chartSettings: ChartSettings;
  drawingStyle: DrawingStyle;
};

function normalizeStudyVisibility(value: unknown): StudyVisibility {
  const saved = value != null && typeof value === "object"
    ? (value as Partial<StudyVisibility>)
    : {};

  return {
    ...DEFAULT_STUDY_VISIBILITY,
    ...saved,
  };
}

function normalizeFxAnalysisSettings(value: unknown): FxAnalysisSettings {
  const saved = value != null && typeof value === "object"
    ? (value as Partial<FxAnalysisSettings>)
    : {};

  return {
    supportPrediction: {
      ...DEFAULT_FX_ANALYSIS_SETTINGS.supportPrediction,
      ...(saved.supportPrediction ?? {}),
    },
    resistancePrediction: {
      ...DEFAULT_FX_ANALYSIS_SETTINGS.resistancePrediction,
      ...(saved.resistancePrediction ?? {}),
    },
    demandZone: {
      ...DEFAULT_FX_ANALYSIS_SETTINGS.demandZone,
      ...(saved.demandZone ?? {}),
    },
  };
}

function normalizeDrawingStyle(value: unknown): DrawingStyle {
  const saved = value != null && typeof value === "object"
    ? (value as Partial<DrawingStyle>)
    : {};

  return {
    ...DEFAULT_DRAWING_STYLE,
    ...saved,
  };
}

function serializeChartPreferences(preferences: ChartPreferences): string {
  return JSON.stringify(preferences);
}

interface Props {
  timeframe?: string;
}

function loadStudyVisibility(): StudyVisibility {
  const saved = localStorage.getItem(STUDY_STORAGE_KEY);
  if (!saved) return DEFAULT_STUDY_VISIBILITY;

  try {
    return normalizeStudyVisibility(JSON.parse(saved));
  } catch {
    return DEFAULT_STUDY_VISIBILITY;
  }
}

function loadDrawingStyle(): DrawingStyle {
  const saved = localStorage.getItem(DRAWING_STYLE_STORAGE_KEY);
  if (!saved) return DEFAULT_DRAWING_STYLE;

  try {
    return normalizeDrawingStyle(JSON.parse(saved));
  } catch {
    return DEFAULT_DRAWING_STYLE;
  }
}

function loadFxAnalysisSettings(): FxAnalysisSettings {
  const saved = localStorage.getItem(FX_ANALYSIS_SETTINGS_STORAGE_KEY);
  if (!saved) return DEFAULT_FX_ANALYSIS_SETTINGS;

  try {
    return normalizeFxAnalysisSettings(JSON.parse(saved));
  } catch {
    return DEFAULT_FX_ANALYSIS_SETTINGS;
  }
}

function loadChartSettings(): ChartSettings {
  const saved = localStorage.getItem(CHART_SETTINGS_STORAGE_KEY);
  if (!saved) return DEFAULT_CHART_SETTINGS;

  try {
    return normalizeChartSettings(JSON.parse(saved) as Partial<ChartSettings>);
  } catch {
    return DEFAULT_CHART_SETTINGS;
  }
}

function getInteractionToolId(tool: DrawingTool): string {
  if (tool === "trendline") return "trendline";
  if (tool === "marketStructure") return "market-structure";
  if (tool === "horizontal") return "horizontal-line";
  if (tool === "rectangle") return "rectangle";
  if (tool === "priceRange") return "price-range";
  if (tool === "longPosition") return "long-position";
  return "select";
}

function isInteractionOwnedDrawingTool(tool: DrawingTool): boolean {
  return (
    tool === "trendline" ||
    tool === "marketStructure" ||
    tool === "horizontal" ||
    tool === "rectangle" ||
    tool === "priceRange" ||
    tool === "longPosition"
  );
}

function getHistoricalRequest(timeframe: string): {
  lookback: string;
  limit: number;
} {
  const normalized = String(timeframe).trim().toLowerCase();

  // Extended-hours sessions can contain up to 960 one-minute bars per
  // trading day and 192 five-minute bars per trading day. The larger
  // lookback gives the backend enough calendar-day room for weekends
  // and market holidays; ChartEngine trims the result to exact trading days.
  if (normalized === "1m" || normalized === "1min") {
    return {
      lookback: "10d",
      limit: 4000,
    };
  }

  if (normalized === "5m" || normalized === "5min") {
    return {
      lookback: "10d",
      limit: 1500,
    };
  }

  return {
    lookback: "5d",
    limit: 500,
  };
}

function ChartPanel({ timeframe: initialTimeframe = "5m" }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ChartEngine | null>(null);
  const drawingEngineRef = useRef<DrawingEngine | null>(null);
  const marketObjectDrawingBridgeRef = useRef<MarketObjectDrawingBridge | null>(null);
  const chartIntelligenceBridgeRef = useRef<ChartIntelligenceBridge | null>(null);
  const tradeEngineRef = useRef<TradeEngine | null>(null);
  const tradeControllerRef = useRef<TradeController | null>(null);
  const positionOverlayRef = useRef<PositionOverlayManager | null>(null);
  const overnightProtectedOverlayRef = useRef<{
    symbol: string;
    phase: string;
  } | null>(null);
  const refreshProtectedOrderStateRef = useRef<(() => Promise<void>) | null>(null);
  const bracketLevelTransitionUntilRef = useRef(0);
  const fxAnalysisToolRef = useRef<FxAnalysisToolId>("none");
  const drawingToolRef = useRef<DrawingTool>("cursor");
  const drawingStyleRef = useRef<DrawingStyle>(loadDrawingStyle());
  const replayIndexRef = useRef(-1);

  const { activeSymbol, setActiveSymbol } = useActiveSymbol();
  const symbol = activeSymbol;

  const [timeframe, setTimeframe] = useState(
    () => localStorage.getItem(TIMEFRAME_STORAGE_KEY) || initialTimeframe,
  );
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [crosshairInfo, setCrosshairInfo] = useState<CrosshairInfo | null>(
    null,
  );
  const [studyVisibility, setStudyVisibility] =
    useState<StudyVisibility>(loadStudyVisibility);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("cursor");
  const [drawingStyle, setDrawingStyle] = useState<DrawingStyle>(
    () => drawingStyleRef.current,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fxAnalysisTool, setFxAnalysisTool] = useState<FxAnalysisToolId>(() => {
    const saved = localStorage.getItem(FX_ANALYSIS_TOOL_STORAGE_KEY);
    return saved === "supportPrediction" ||
      saved === "resistancePrediction" ||
      saved === "demandZone"
      ? saved
      : "none";
  });
  const [fxAnalysisSettings, setFxAnalysisSettings] =
    useState<FxAnalysisSettings>(loadFxAnalysisSettings);
  const [chartSettings, setChartSettings] =
    useState<ChartSettings>(loadChartSettings);
  const chartPreferencesReadyRef = useRef(false);
  const chartPreferencesRevisionRef = useRef(0);
  const chartPreferencesRemoteSnapshotRef = useRef("");
  const chartPreferencesCurrentSnapshotRef = useRef(
    serializeChartPreferences({
      studyVisibility,
      fxAnalysisSettings,
      chartSettings,
      drawingStyle,
    }),
  );
  const chartPreferencesSaveTimerRef = useRef<number | null>(null);
  const chartPreferencesSaveInFlightRef = useRef(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => {
    return localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY) === "true";
  });
  const [chartState, setChartState] = useState<ChartState | null>(null);
  const liveChartStateTimerRef = useRef<number | null>(null);
  const lastLiveChartStateCommitRef = useRef(0);
  const pendingLiveChartStateEngineRef = useRef<ChartEngine | null>(null);
  const replayRuntime = getSharedReplayRuntime();
  const [marketDataMode, setMarketDataMode] = useState<MarketDataMode>(() => {
    return localStorage.getItem(MARKET_DATA_MODE_STORAGE_KEY) === "replay"
      ? "replay"
      : "live";
  });
  const [replaySnapshot, setReplaySnapshot] = useState<ReplaySnapshot>(() =>
    replayRuntime.getSnapshot(),
  );
  const [practiceTradingDate, setPracticeTradingDate] = useState(
    () => readSelectedPracticeTradingDate(),
  );
  const [replayStartMode, setReplayStartMode] =
    useState<ReplayStartMode>(() => {
      return (
        readSavedPracticeReplayRequest()?.startMode ??
        "market-open"
      );
    });
  const [
    replayCustomStartTime,
    setReplayCustomStartTime,
  ] = useState<string | null>(() => {
    return (
      readSavedPracticeReplayRequest()
        ?.customStartTime ?? null
    );
  });

  function commitChartState(engine: ChartEngine, reason: string): void {
    const nextState = engine.getState();

    setChartState(nextState);
    chartIntelligenceBridgeRef.current?.update(nextState, reason);
  }

  function commitLiveChartState(engine: ChartEngine): void {
    pendingLiveChartStateEngineRef.current = engine;

    const now = performance.now();
    const elapsed = now - lastLiveChartStateCommitRef.current;

    const flush = () => {
      liveChartStateTimerRef.current = null;
      const pendingEngine = pendingLiveChartStateEngineRef.current;
      pendingLiveChartStateEngineRef.current = null;

      if (!pendingEngine) return;

      lastLiveChartStateCommitRef.current = performance.now();
      commitChartState(pendingEngine, "live-bar-updated");
    };

    if (elapsed >= LIVE_CHART_STATE_THROTTLE_MS) {
      if (liveChartStateTimerRef.current != null) {
        window.clearTimeout(liveChartStateTimerRef.current);
        liveChartStateTimerRef.current = null;
      }

      flush();
      return;
    }

    if (liveChartStateTimerRef.current != null) return;

    liveChartStateTimerRef.current = window.setTimeout(
      flush,
      Math.max(0, LIVE_CHART_STATE_THROTTLE_MS - elapsed),
    );
  }

  function handleSymbolChange(nextSymbol: string) {
    setActiveSymbol(nextSymbol, "toolbar");
  }

  function handlePracticeTradingDateChange(
    tradingDate: string,
  ): void {
    if (!tradingDate) return;

    const savedDate =
      saveSelectedPracticeTradingDate(tradingDate);

    setPracticeTradingDate(savedDate);

    if (marketDataMode !== "replay") {
      setMarketDataMode("replay");
    }
  }

  useEffect(() => {
    let cancelled = false;
    let refreshInFlight = false;

    const initialPreferences: ChartPreferences = {
      studyVisibility,
      fxAnalysisSettings,
      chartSettings,
      drawingStyle,
    };

    async function saveInitialPreferences(): Promise<void> {
      chartPreferencesSaveInFlightRef.current = true;

      try {
        const response = await fetch(
          `${API_BASE}/app-state/alpaca/chart-preferences`,
          {
            method: "PUT",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ preferences: initialPreferences }),
          },
        );

        if (!response.ok) {
          throw new Error(
            `Chart preference save failed (${response.status})`,
          );
        }

        const payload = (await response.json()) as Record<string, unknown>;
        if (cancelled) return;

        const revision = Number(payload.revision ?? 0);
        const snapshot = serializeChartPreferences(initialPreferences);
        chartPreferencesRevisionRef.current = Number.isFinite(revision)
          ? Math.max(0, revision)
          : 0;
        chartPreferencesRemoteSnapshotRef.current = snapshot;
        chartPreferencesCurrentSnapshotRef.current = snapshot;
      } finally {
        chartPreferencesSaveInFlightRef.current = false;
      }
    }

    async function refreshPreferences(): Promise<void> {
      if (
        cancelled ||
        refreshInFlight ||
        chartPreferencesSaveInFlightRef.current
      ) {
        return;
      }

      if (
        chartPreferencesReadyRef.current &&
        chartPreferencesCurrentSnapshotRef.current !==
          chartPreferencesRemoteSnapshotRef.current
      ) {
        return;
      }

      refreshInFlight = true;

      try {
        const response = await fetch(
          `${API_BASE}/app-state/alpaca/chart-preferences`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          },
        );

        if (!response.ok) {
          throw new Error(
            `Chart preference load failed (${response.status})`,
          );
        }

        const payload = (await response.json()) as Record<string, unknown>;
        if (cancelled) return;

        const exists = payload.exists === true;
        const revisionValue = Number(payload.revision ?? 0);
        const revision = Number.isFinite(revisionValue)
          ? Math.max(0, revisionValue)
          : 0;

        if (!exists && !chartPreferencesReadyRef.current) {
          chartPreferencesReadyRef.current = true;
          await saveInitialPreferences();
          return;
        }

        if (
          exists &&
          (!chartPreferencesReadyRef.current ||
            revision !== chartPreferencesRevisionRef.current)
        ) {
          const raw = payload.preferences;
          const preferences = raw != null && typeof raw === "object"
            ? (raw as Partial<ChartPreferences>)
            : {};
          const next: ChartPreferences = {
            studyVisibility: normalizeStudyVisibility(
              preferences.studyVisibility,
            ),
            fxAnalysisSettings: normalizeFxAnalysisSettings(
              preferences.fxAnalysisSettings,
            ),
            chartSettings: normalizeChartSettings(
              preferences.chartSettings,
            ),
            drawingStyle: normalizeDrawingStyle(
              preferences.drawingStyle,
            ),
          };
          const snapshot = serializeChartPreferences(next);

          chartPreferencesRevisionRef.current = revision;
          chartPreferencesRemoteSnapshotRef.current = snapshot;
          chartPreferencesCurrentSnapshotRef.current = snapshot;
          chartPreferencesReadyRef.current = true;

          setStudyVisibility(next.studyVisibility);
          setFxAnalysisSettings(next.fxAnalysisSettings);
          setChartSettings(next.chartSettings);
          setDrawingStyle(next.drawingStyle);
        } else {
          chartPreferencesReadyRef.current = true;
        }
      } catch (error) {
        console.warn("[ChartPanel] chart preference sync failed", error);
      } finally {
        refreshInFlight = false;
      }
    }

    void refreshPreferences();
    const pollTimer = window.setInterval(
      () => void refreshPreferences(),
      CHART_PREFERENCES_POLL_MS,
    );
    const handleFocus = () => void refreshPreferences();
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      window.removeEventListener("focus", handleFocus);

      if (chartPreferencesSaveTimerRef.current != null) {
        window.clearTimeout(chartPreferencesSaveTimerRef.current);
        chartPreferencesSaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {}, [activeSymbol]);

  useEffect(() => {
    return subscribeToSelectedPracticeTradingDate(
      (tradingDate) => {
        setPracticeTradingDate(tradingDate);
      },
    );
  }, []);

  useEffect(() => {
    return subscribeToPracticeReplayRequests(
      (request) => {
        setPracticeTradingDate(
          request.tradingDate,
        );
        setReplayStartMode(
          request.startMode ??
            "market-open",
        );
        setReplayCustomStartTime(
          request.customStartTime ??
            null,
        );

        setActiveSymbol(
          request.symbol,
          "practice-replay",
        );
        setTimeframe(request.timeframe);
        setMarketDataMode("replay");
      },
    );
  }, [setActiveSymbol]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const engine = new ChartEngine(container);
    const drawingEngine = new DrawingEngine(
      engine.chart,
      engine.series.candles,
      {
        symbol,
        timeframe,
      },
      engine.getContainer(),
    );
    const marketObjectDrawingBridge = new MarketObjectDrawingBridge(
      drawingEngine,
      { symbol, timeframe },
    );
    marketObjectDrawingBridge.start();
    let chartIntelligenceBridge: ChartIntelligenceBridge | null = null;
    let intelligenceLoadTimer: number | null = null;
    let intelligenceLoadCancelled = false;

    const loadChartIntelligence = async () => {
      try {
        const module = await import(
          "../../trading/intelligence/integration/ChartIntelligenceBridge"
        );

        if (intelligenceLoadCancelled) return;

        chartIntelligenceBridge = new module.ChartIntelligenceBridge({
          mode: marketDataMode === "replay" ? "replay" : "live",
          onError: (error) => {
            console.error("Chart intelligence evaluation failed", error);
          },
        });
        chartIntelligenceBridgeRef.current = chartIntelligenceBridge;

        const currentState = engine.getState();
        if (currentState.bars.length > 0) {
          chartIntelligenceBridge.update(
            currentState,
            "startup-intelligence-ready",
          );
        }
      } catch (error) {
        if (!intelligenceLoadCancelled) {
          console.error("Failed to load chart intelligence", error);
        }
      }
    };

    // Keep the chart/trading shell on the critical startup path and load the
    // heavier Decision Center intelligence shortly afterward.
    intelligenceLoadTimer = window.setTimeout(
      () => void loadChartIntelligence(),
      900,
    );

    const tradeEngine = getSharedTradeEngine({ symbol, timeframe });

    engine.setStudyVisibility(studyVisibility);
    engine.setFxAnalysisSettings(fxAnalysisSettings);
    engine.setChartSettings(chartSettings);
    drawingEngine.setTool(drawingTool);
    drawingEngine.setDefaultStyle(drawingStyle);
    engine.registerInteractionTool(new SelectTool(drawingEngine));
    engine.registerInteractionTool(
      new TrendlineTool(drawingEngine, () => drawingStyleRef.current),
    );
    engine.registerInteractionTool(
      new MarketStructureTool(
        drawingEngine,
        () => drawingStyleRef.current,
      ),
    );
    engine.registerInteractionTool(
      new HorizontalLineTool(drawingEngine, () => drawingStyleRef.current),
    );
    engine.registerInteractionTool(
      new RectangleTool(drawingEngine, () => drawingStyleRef.current),
    );
    engine.registerInteractionTool(
      new PriceRangeTool(drawingEngine, () => drawingStyleRef.current),
    );
    engine.registerInteractionTool(
      new LongPositionTool(drawingEngine, () => drawingStyleRef.current),
    );
    engine.activateInteractionTool(getInteractionToolId(drawingTool));

    engineRef.current = engine;
    drawingEngineRef.current = drawingEngine;
    marketObjectDrawingBridgeRef.current = marketObjectDrawingBridge;
    tradeEngineRef.current = tradeEngine;

    const executionService = getSharedExecutionGateway();
    const positionOverlay = new PositionOverlayManager(engine.series.candles, {
      container,
      onCommit: async (change: PositionOverlayCommit) => {
        const overnightContext = overnightProtectedOverlayRef.current;
        if (
          overnightContext &&
          overnightContext.symbol === change.symbol.trim().toUpperCase()
        ) {
          try {
            await updateOvernightProtectedOrderPrice(
              change.symbol,
              change.level,
              change.price,
            );

            // One event-driven reconciliation keeps worker/broker state caught
            // up after a drag without increasing normal background polling.
            if (change.level === "stop" || change.level === "target") {
              setPositionLevelIntent(
                change.symbol,
                change.level,
                change.price,
              );
            }
            void refreshProtectedOrderStateRef.current?.();
            return true;
          } catch (error) {
            console.error(
              `[PositionOverlay] failed to move Overnight Protected Order ${change.level}`,
              error,
            );
            return false;
          }
        }

        // Replay brackets are simulated locally. They do not have Alpaca-style
        // child leg order IDs, so trying to resolve a stop/target leg makes the
        // optimistic drag snap back. Update the replay parent bracket before
        // fill, or the active replay position protection after fill.
        if (
          executionService.getMode() === "practice" &&
          (change.level === "stop" || change.level === "target")
        ) {
          const snapshot = executionService.getSnapshot();
          const safeSymbol = change.symbol.trim().toUpperCase();
          const activePosition = snapshot.positions.find(
            (position) =>
              position.symbol.trim().toUpperCase() === safeSymbol &&
              Number(position.shares) > 0,
          );

          let updated: unknown | null = null;
          let linkedOrderId: string | null = null;

          if (activePosition) {
            updated = await executionService.modifyPositionProtection(
              safeSymbol,
              change.level === "stop"
                ? { stopPrice: change.price }
                : { targetPrice: change.price },
            );
          } else {
            const workingBracket = snapshot.openOrders.find(
              (order) =>
                order.symbol.trim().toUpperCase() === safeSymbol &&
                (Number(order.targetPrice) > 0 || Number(order.stopPrice) > 0),
            );

            if (workingBracket) {
              linkedOrderId = workingBracket.id;
              updated = await executionService.modifyOrder(
                workingBracket.id,
                change.level === "stop"
                  ? { bracket_stop_price: change.price }
                  : { target_price: change.price },
              );
            }
          }

          if (!updated) return false;

          const selectedTrade = tradeEngine.getSelectedTrade();
          const replayTrade =
            selectedTrade &&
            selectedTrade.symbol.trim().toUpperCase() === safeSymbol &&
            !["closed", "cancelled", "rejected"].includes(selectedTrade.status)
              ? selectedTrade
              : tradeEngine
                  .getTrades()
                  .filter(
                    (trade) =>
                      trade.symbol.trim().toUpperCase() === safeSymbol &&
                      !["closed", "cancelled", "rejected"].includes(trade.status),
                  )
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
                null;

          if (replayTrade) {
            if (change.level === "stop") {
              tradeEngine.updateStop(replayTrade.id, change.price);
            } else {
              tradeEngine.updateTarget(replayTrade.id, change.price);
            }

            const latestTrade =
              tradeEngine.getTrade(replayTrade.id) ?? replayTrade;
            tradeEngine.updateTrade(replayTrade.id, {
              status: activePosition ? "managing" : latestTrade.status,
              links: linkedOrderId
                ? {
                    ...latestTrade.links,
                    alpacaOrderIds: Array.from(
                      new Set([
                        ...(latestTrade.links.alpacaOrderIds ?? []),
                        linkedOrderId,
                      ]),
                    ),
                  }
                : latestTrade.links,
            });

            if (tradeEngine.getSelectedTradeId() !== replayTrade.id) {
              tradeEngine.selectTrade(replayTrade.id);
            }
          }

          setPositionLevelIntent(
            change.symbol,
            change.level as "stop" | "target",
            change.price,
          );
          executionService.queueRefresh();
          return true;
        }

        const resolveBracketLegOrderId = (
          level: "stop" | "target",
        ): string | null => {
          const snapshot = executionService.getSnapshot();
          const wantedSymbol = change.symbol.trim().toUpperCase();
          const terminalStatuses = new Set([
            "filled",
            "canceled",
            "cancelled",
            "expired",
            "replaced",
            "rejected",
            "done_for_day",
          ]);
          let resolved: string | null = null;

          const visit = (
            value: unknown,
            inheritedSymbol = "",
            nested = false,
          ) => {
            if (resolved || !value || typeof value !== "object") return;

            const order = value as Record<string, unknown>;
            const orderSymbol = String(order.symbol ?? inheritedSymbol)
              .trim()
              .toUpperCase();
            const status = String(order.status ?? "").trim().toLowerCase();
            const type = String(order.type ?? "").trim().toLowerCase();
            const id = String(order.id ?? order.order_id ?? "").trim();
            const stopPrice = Number(order.stop_price ?? 0);
            const limitPrice = Number(order.limit_price ?? 0);
            const active = !status || !terminalStatuses.has(status);

            if (
              nested &&
              active &&
              id &&
              orderSymbol === wantedSymbol &&
              ((level === "stop" &&
                (stopPrice > 0 || type === "stop" || type === "stop_limit")) ||
                (level === "target" &&
                  limitPrice > 0 &&
                  type === "limit" &&
                  !(stopPrice > 0)))
            ) {
              resolved = id;
              return;
            }

            const legs = Array.isArray(order.legs) ? order.legs : [];
            for (const leg of legs) {
              visit(leg, orderSymbol, true);
              if (resolved) return;
            }
          };

          for (const order of [
            ...snapshot.rawOpenOrders,
            ...snapshot.rawClosedOrders,
          ]) {
            visit(order);
            if (resolved) break;
          }

          return resolved;
        };

        const resolvedOrderId =
          change.orderId ||
          (change.level === "stop" || change.level === "target"
            ? resolveBracketLegOrderId(change.level)
            : null);

        if (!resolvedOrderId) {
          console.warn(
            `[PositionOverlay] could not resolve Alpaca order id for ${change.level}.`,
          );
          return false;
        }

        if (change.level === "stop" || change.level === "target") {
          // Alpaca PATCH is a replacement operation. During the short broker
          // handoff a bracket child can briefly appear as a standalone top-level
          // order. Keep the existing bracket overlay pinned so that child can
          // never be mistaken for the working entry line.
          bracketLevelTransitionUntilRef.current = Date.now() + 8_000;
        }

        const updatedOrder = await executionService.modifyOrder(
          resolvedOrderId,
          change.level === "stop"
            ? { stop_price: change.price }
            : { limit_price: change.price },
        );

        if (!updatedOrder) {
          return false;
        }

        const updatedOrderRecord =
          updatedOrder && typeof updatedOrder === "object"
            ? (updatedOrder as Record<string, unknown>)
            : null;
        const confirmedOrderId = String(
          updatedOrderRecord?.id ?? resolvedOrderId,
        ).trim();

        const safeSymbol = change.symbol.trim().toUpperCase();
        const selectedTrade = tradeEngine.getSelectedTrade();

        const liveTrade =
          selectedTrade &&
          selectedTrade.symbol.trim().toUpperCase() === safeSymbol &&
          !["closed", "cancelled", "rejected"].includes(selectedTrade.status)
            ? selectedTrade
            : tradeEngine
                .getTrades()
                .filter(
                  (trade) =>
                    trade.symbol.trim().toUpperCase() === safeSymbol &&
                    !["closed", "cancelled", "rejected"].includes(
                      trade.status,
                    ),
                )
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
              null;

        if (liveTrade) {
          const nextOrderIds = Array.from(
            new Set([
              ...(liveTrade.links.alpacaOrderIds ?? []),
              resolvedOrderId,
              confirmedOrderId,
            ]),
          );

          if (change.level === "entry") {
            tradeEngine.updateTrade(liveTrade.id, { entry: change.price });
          } else if (change.level === "stop") {
            tradeEngine.updateStop(liveTrade.id, change.price);
          } else {
            tradeEngine.updateTarget(liveTrade.id, change.price);
          }

          const latestTrade = tradeEngine.getTrade(liveTrade.id) ?? liveTrade;

          tradeEngine.updateTrade(liveTrade.id, {
            ...(change.level === "entry" ? {} : { status: "managing" as const }),
            links: {
              ...latestTrade.links,
              alpacaOrderIds: nextOrderIds,
            },
          });

          if (tradeEngine.getSelectedTradeId() !== liveTrade.id) {
            tradeEngine.selectTrade(liveTrade.id);
          }
        }

        if (change.level === "stop" || change.level === "target") {
          setPositionLevelIntent(
            change.symbol,
            change.level,
            change.price,
          );
        }
        executionService.queueRefresh();
        return true;
      },
      onCancelOrder: async (orderId) => {
        const canceled = await executionService.cancelOrder(orderId);
        if (!canceled) return false;

        // The button already switches to “Canceling…” immediately inside
        // PositionOverlayManager. After Alpaca accepts the cancel request,
        // reconcile both broker state and AutoTrade worker state right away
        // instead of waiting for the normal polling cycle. A short follow-up
        // reconciliation catches the common race where Alpaca has canceled the
        // order but the worker has not removed its runner state yet.
        void refreshProtectedOrderStateRef.current?.();
        window.setTimeout(() => {
          void refreshProtectedOrderStateRef.current?.();
        }, 500);
        window.setTimeout(() => {
          void refreshProtectedOrderStateRef.current?.();
        }, 1_500);

        return true;
      },
      onDragStateChange: (dragging) => {
        engine.setChartNavigationEnabled(!dragging);
        container.style.cursor = dragging ? "ns-resize" : "";
        container.style.touchAction = dragging ? "none" : "";
      },
    });
    positionOverlayRef.current = positionOverlay;

    const tradeController = new TradeController(drawingEngine, tradeEngine);
    tradeController.attach();
    tradeControllerRef.current = tradeController;

    const unsubscribeCrosshair = engine.subscribeCrosshairInfo((info) => {
      setCrosshairInfo(info ?? engine.getLastBarInfo());
    });

    const unsubscribeClick = engine.subscribeClick((point) => {
      if (fxAnalysisToolRef.current !== "none") {
        engine.runFxAnalysisTool(fxAnalysisToolRef.current, point.bar);
        return;
      }

      if (isInteractionOwnedDrawingTool(drawingToolRef.current)) {
        return;
      }

      const created = drawingEngine.handleClick(point);

      if (created) {
        engine.clearFxAnalysisSelection();
      }
    });

    const unsubscribePointerDown = engine.subscribePointerDown((point) => {
      if (
        drawingToolRef.current === "cursor" &&
        fxAnalysisToolRef.current === "none"
      ) {
        engine.selectFxAnalysisAtPoint(point);
      }
    });

    const unsubscribePointerMove = engine.subscribePointerMove((_point) => {
      // Selection and drawing drags are now owned by SelectTool.
    });

    const unsubscribePointerUp = engine.subscribePointerUp((_point) => {
      // Selection and drawing drags are now owned by SelectTool.
    });

    const getLocalY = (event: PointerEvent): number => {
      const rect = container.getBoundingClientRect();
      return event.clientY - rect.top;
    };

    const isChartPointerEvent = (event: PointerEvent): boolean =>
      event.target instanceof Node && container.contains(event.target);

    let overlayMoveFrame: number | null = null;
    let pendingOverlayY: number | null = null;

    const flushOverlayMove = () => {
      overlayMoveFrame = null;
      if (pendingOverlayY == null || !positionOverlay.isDragging()) return;
      const y = pendingOverlayY;
      pendingOverlayY = null;
      positionOverlay.moveDrag(y);
    };

    const queueOverlayMove = (y: number) => {
      pendingOverlayY = y;
      if (overlayMoveFrame != null) return;
      overlayMoveFrame = window.requestAnimationFrame(flushOverlayMove);
    };

    const finishOverlayMove = (event: PointerEvent) => {
      if (overlayMoveFrame != null) {
        window.cancelAnimationFrame(overlayMoveFrame);
        overlayMoveFrame = null;
      }
      pendingOverlayY = getLocalY(event);
      flushOverlayMove();
    };

    const handleOverlayPointerDown = (event: PointerEvent) => {
      if (!isChartPointerEvent(event)) return;
      if (event.button !== 0) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-position-order-controls='true']")
      ) return;
      if (drawingToolRef.current !== "cursor") return;
      if (fxAnalysisToolRef.current !== "none") return;

      const started = positionOverlay.beginDrag(getLocalY(event));
      if (!started) return;

      container.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const handleOverlayPointerMove = (event: PointerEvent) => {
      if (!positionOverlay.isDragging()) {
        if (!isChartPointerEvent(event)) return;
        const hit = positionOverlay.hitTest(getLocalY(event));
        container.style.cursor = hit ? "ns-resize" : "";
        return;
      }

      queueOverlayMove(getLocalY(event));
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const handleOverlayPointerUp = (event: PointerEvent) => {
      if (!positionOverlay.isDragging()) return;

      finishOverlayMove(event);
      if (container.hasPointerCapture?.(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void positionOverlay.endDrag();
    };

    const handleOverlayPointerCancel = (event: PointerEvent) => {
      if (!positionOverlay.isDragging()) return;

      if (overlayMoveFrame != null) {
        window.cancelAnimationFrame(overlayMoveFrame);
        overlayMoveFrame = null;
      }
      pendingOverlayY = null;
      if (container.hasPointerCapture?.(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      positionOverlay.cancelDrag();
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    // Listen above the chart container so an order-line drag is claimed before
    // Lightweight Charts and ChartInteractionManager can begin a competing
    // pan/scale gesture. Pointer capture keeps move/up delivery reliable even
    // when the cursor leaves the plot while dragging.
    window.addEventListener("pointerdown", handleOverlayPointerDown, true);
    window.addEventListener("pointermove", handleOverlayPointerMove, true);
    window.addEventListener("pointerup", handleOverlayPointerUp, true);
    window.addEventListener("pointercancel", handleOverlayPointerCancel, true);

    const resize = () => engine.resize();
    window.addEventListener("resize", resize);

    const resizeTimer = window.setTimeout(() => {
      resize();
      engine.fitContent();
    }, 0);

    return () => {
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", resize);
      unsubscribeCrosshair();
      unsubscribeClick();
      unsubscribePointerDown();
      unsubscribePointerMove();
      unsubscribePointerUp();
      window.removeEventListener("pointerdown", handleOverlayPointerDown, true);
      window.removeEventListener("pointermove", handleOverlayPointerMove, true);
      window.removeEventListener("pointerup", handleOverlayPointerUp, true);
      window.removeEventListener("pointercancel", handleOverlayPointerCancel, true);
      if (overlayMoveFrame != null) {
        window.cancelAnimationFrame(overlayMoveFrame);
      }
      container.style.cursor = "";
      tradeController.detach();
      tradeControllerRef.current = null;
      intelligenceLoadCancelled = true;
      if (intelligenceLoadTimer != null) {
        window.clearTimeout(intelligenceLoadTimer);
        intelligenceLoadTimer = null;
      }
      chartIntelligenceBridge?.destroy();
      if (chartIntelligenceBridgeRef.current === chartIntelligenceBridge) {
        chartIntelligenceBridgeRef.current = null;
      }
      tradeEngineRef.current = null;
      positionOverlay.destroy();
      positionOverlayRef.current = null;
      marketObjectDrawingBridge.destroy();
      marketObjectDrawingBridgeRef.current = null;
      drawingEngine.destroy();
      drawingEngineRef.current = null;
      engine.destroy();
      engineRef.current = null;
    };
    // Run only on mount. Study changes are handled by the separate effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const executionService = getSharedExecutionGateway();
    const protectionEngine = getSharedPositionProtectionEngine();
    const safeSymbol = symbol.trim().toUpperCase();
    let latestAutoTradeStatus: AutoTradeStatus | null = null;
    let active = true;

    const positivePrice = (value: unknown): number => {
      const price = Number(value);
      return Number.isFinite(price) && price > 0 ? price : 0;
    };

    const normalizePlanSymbol = (value: unknown): string =>
      String(value ?? "").trim().toUpperCase();

    const getOvernightPlan = () => {
      const runnerState = latestAutoTradeStatus?.runner_states?.[safeSymbol];
      if (runnerState && typeof runnerState === "object") {
        const strategyId = String(runnerState.strategy_id ?? "");
        const entry = positivePrice(runnerState.entry_price);
        const stop = positivePrice(runnerState.stop_price);
        const target = positivePrice(runnerState.target_price);

        if (
          ["overnight_protected_order", "overnite_hail_mary"].includes(strategyId) &&
          entry > 0 &&
          stop > 0 &&
          target > 0
        ) {
          const phase = String(runnerState.phase ?? "");
          const orderId = String(
            runnerState.order_id ?? runnerState.entry_order_id ?? `autotrade-${safeSymbol}`,
          );

          return {
            id: orderId,
            symbol: safeSymbol,
            entry,
            stop,
            target,
            phase,
            entryIsLive: ["entry_submitted", "entry_cancel_requested"].includes(phase),
          };
        }
      }

      const plans =
        latestAutoTradeStatus?.queued_manual_plans ??
        latestAutoTradeStatus?.manual_trade_plans ??
        [];

      for (const item of plans) {
        const payload = item?.payload ?? item ?? {};
        const strategyId = String(item?.strategy_id ?? payload.strategy_id ?? "");
        const planSymbol = normalizePlanSymbol(item?.symbol ?? payload.symbol);
        if (
          planSymbol !== safeSymbol ||
          !["overnight_protected_order", "overnite_hail_mary"].includes(strategyId)
        ) {
          continue;
        }

        const entry = positivePrice(payload.entry_price);
        const stop = positivePrice(payload.stop_price);
        const target = positivePrice(payload.target_price);
        if (entry <= 0 || stop <= 0 || target <= 0) continue;

        return {
          id: String(payload.order_id ?? `autotrade-queued-${safeSymbol}`),
          symbol: safeSymbol,
          entry,
          stop,
          target,
          phase: "queued",
          entryIsLive: false,
        };
      }

      return null;
    };

    const applySnapshot = (
      snapshot: ReturnType<typeof executionService.getSnapshot>,
    ) => {
      const protection = protectionEngine.findProtection(
        symbol,
        snapshot.positions,
        snapshot.openOrders,
      );

      // Overnight Protected Orders are intentionally submitted to Alpaca as a
      // simple extended-hours limit entry. Their stop/target live in the
      // AutoTrade worker, so the normal broker snapshot cannot reconstruct the
      // full overlay after a chart interaction or refresh. Give worker state
      // precedence. Chart drags are routed through the protected-order API so
      // entry replacements and synthetic stop/target edits remain attached to
      // the worker instead of becoming local-only chart changes.
      const overnightPlan = getOvernightPlan();
      overnightProtectedOverlayRef.current = overnightPlan
        ? { symbol: overnightPlan.symbol, phase: overnightPlan.phase }
        : null;
      if (overnightPlan) {
        // While the protected entry is still working, the overlay must follow
        // the worker's working-order price. A pre-existing/stale Alpaca position
        // for the same symbol must not pull the draggable entry controls back to
        // the position cost basis. Once the protected order has filled and the
        // worker is actively managing the position, switch to the actual fill
        // basis from PositionProtectionEngine.
        const usePositionEntry = ["active_synthetic", "exit_submitted"].includes(
          overnightPlan.phase,
        );
        const actualEntry =
          usePositionEntry && protection && protection.position.entry > 0
            ? protection.position.entry
            : overnightPlan.entry;

        positionOverlayRef.current?.updateWorkingOrder({
          id: overnightPlan.id,
          symbol: overnightPlan.symbol,
          entry: actualEntry,
          stop: overnightPlan.stop,
          target: overnightPlan.target,
          entryIsLive: overnightPlan.entryIsLive,
          entryCanDrag: ["queued", "entry_submitted", "entry_cancel_requested"].includes(
            overnightPlan.phase,
          ),
          entryCanCancel: ["entry_submitted", "entry_cancel_requested"].includes(
            overnightPlan.phase,
          ),
          stopCanDrag: ["queued", "entry_submitted", "entry_cancel_requested", "active_synthetic"].includes(
            overnightPlan.phase,
          ),
          targetCanDrag: ["queued", "entry_submitted", "entry_cancel_requested", "active_synthetic"].includes(
            overnightPlan.phase,
          ),
        });
        return;
      }

      if (protection) {
        if (executionService.getMode() === "practice") {
          positionOverlayRef.current?.updateWorkingOrder({
            id: `replay-position-${safeSymbol}`,
            symbol: safeSymbol,
            entry: protection.position.entry,
            stop: protection.stopPrice,
            target: protection.targetPrice,
            entryIsLive: false,
            entryCanDrag: false,
            entryCanCancel: false,
            stopCanDrag: protection.stopPrice > 0,
            targetCanDrag: protection.targetPrice > 0,
          });
        } else {
          positionOverlayRef.current?.update(protection);
        }
        return;
      }

      const findRawOrderById = (
        orderId: string | null | undefined,
      ): Record<string, unknown> | null => {
        if (!orderId) return null;
        const visit = (orders: unknown[]): Record<string, unknown> | null => {
          for (const value of orders) {
            if (!value || typeof value !== "object") continue;
            const order = value as Record<string, unknown>;
            if (String(order.id ?? order.order_id ?? "") === orderId) {
              return order;
            }
            const legs = Array.isArray(order.legs) ? order.legs : [];
            const nested = visit(legs);
            if (nested) return nested;
          }
          return null;
        };
        return visit(snapshot.rawOpenOrders);
      };

      const selectedForSymbol = (() => {
        const currentTradeEngine = tradeEngineRef.current;
        if (!currentTradeEngine) return null;

        const selected = currentTradeEngine.getSelectedTrade();
        if (
          selected &&
          selected.symbol.trim().toUpperCase() === safeSymbol &&
          !["closed", "cancelled", "rejected"].includes(selected.status)
        ) {
          return selected;
        }
        return (
          currentTradeEngine
            .getTrades()
            .filter(
              (trade) =>
                trade.symbol.trim().toUpperCase() === safeSymbol &&
                !["closed", "cancelled", "rejected"].includes(trade.status),
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
        );
      })();
      const expectedEntrySide =
        selectedForSymbol?.direction === "short"
          ? "sell"
          : selectedForSymbol?.direction === "long"
            ? "buy"
            : null;

      const workingOrderCandidates = snapshot.openOrders.filter((order) => {
        if (order.symbol.trim().toUpperCase() !== safeSymbol) return false;
        if (Number(order.limitPrice) <= 0) return false;

        const raw = findRawOrderById(order.id);
        // A bracket take-profit/stop replacement can temporarily surface as a
        // top-level order. parent_order_id is the reliable signal that it is a
        // child and must NEVER become the yellow draggable entry line.
        if (String(raw?.parent_order_id ?? "").trim()) return false;
        if (expectedEntrySide && order.side !== expectedEntrySide) return false;
        return true;
      });

      const workingOrder =
        workingOrderCandidates.find((order) => order.type === "bracket") ??
        workingOrderCandidates[0] ??
        null;

      const rawWorkingOrder = findRawOrderById(workingOrder?.id);

      if (
        !workingOrder &&
        Date.now() < bracketLevelTransitionUntilRef.current
      ) {
        // Preserve the previous complete bracket overlay while Alpaca swaps the
        // old leg ID for the replacement and republishes the nested parent.
        return;
      }

      const workingLegs = Array.isArray(rawWorkingOrder?.legs)
        ? (rawWorkingOrder.legs as Array<Record<string, unknown>>)
        : [];
      const stopLeg = workingLegs.find((leg) => Number(leg.stop_price) > 0);
      const targetLeg = workingLegs.find(
        (leg) =>
          String(leg.type ?? "").toLowerCase() === "limit" &&
          Number(leg.limit_price) > 0,
      );

      const workingStop = Number(
        stopLeg?.stop_price ?? workingOrder?.stopPrice ?? 0,
      );
      const workingTarget = Number(
        targetLeg?.limit_price ?? workingOrder?.targetPrice ?? 0,
      );

      positionOverlayRef.current?.updateWorkingOrder(
        workingOrder
          ? {
              id: workingOrder.id,
              symbol: workingOrder.symbol,
              entry: Number(workingOrder.limitPrice),
              stop: workingStop,
              target: workingTarget,
              stopOrderId: stopLeg ? String(stopLeg.id ?? "") || null : null,
              targetOrderId: targetLeg ? String(targetLeg.id ?? "") || null : null,
              // The bracket prices are actionable even when Alpaca temporarily
              // omits a held leg id from the normalized parent. The commit
              // handler resolves the actual child id from the raw nested order.
              stopCanDrag: workingStop > 0,
              targetCanDrag: workingTarget > 0,
            }
          : null,
      );
    };

    const refreshAutoTradeStatus = async () => {
      try {
        const next = await fetchAutoTradeStatus();
        if (!active) return;
        latestAutoTradeStatus = next;
        applySnapshot(executionService.getSnapshot());
      } catch {
        // Keep the last known worker state during a temporary API failure so a
        // protected order never disappears just because one poll failed.
      }
    };

    const refreshProtectedOrderState = async (): Promise<void> => {
      const [autoTradeResult, brokerResult] = await Promise.allSettled([
        fetchAutoTradeStatus(),
        executionService.refreshAll(),
      ]);

      if (!active) return;

      if (autoTradeResult.status === "fulfilled") {
        latestAutoTradeStatus = autoTradeResult.value;
      }

      const brokerSnapshot =
        brokerResult.status === "fulfilled"
          ? brokerResult.value
          : executionService.getSnapshot();

      applySnapshot(brokerSnapshot);
    };

    refreshProtectedOrderStateRef.current = refreshProtectedOrderState;

    const unsubscribe = executionService.subscribe(applySnapshot);
    applySnapshot(executionService.getSnapshot());
    executionService.queueRefresh();
    void refreshAutoTradeStatus();
    const autoTradeTimer = window.setInterval(
      () => void refreshAutoTradeStatus(),
      5_000,
    );

    return () => {
      active = false;
      window.clearInterval(autoTradeTimer);
      unsubscribe();
      if (refreshProtectedOrderStateRef.current === refreshProtectedOrderState) {
        refreshProtectedOrderStateRef.current = null;
      }
      if (overnightProtectedOverlayRef.current?.symbol === safeSymbol) {
        overnightProtectedOverlayRef.current = null;
      }
      positionOverlayRef.current?.clear();
    };
  }, [symbol]);

  useEffect(() => {
    const handleToolCompleted = (event: Event): void => {
      const completion = (event as CustomEvent<ChartToolCompletionEvent>).detail;
      if (!completion || completion.toolId !== "long-position") return;

      drawingToolRef.current = "cursor";
      drawingEngineRef.current?.setTool("cursor");
      engineRef.current?.activateInteractionTool("select");
      setDrawingTool("cursor");
    };

    window.addEventListener(
      CHART_TOOL_COMPLETED_EVENT,
      handleToolCompleted,
    );

    return () => {
      window.removeEventListener(
        CHART_TOOL_COMPLETED_EVENT,
        handleToolCompleted,
      );
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setStudyVisibility(studyVisibility);
  }, [studyVisibility]);

  useEffect(() => {
    drawingToolRef.current = drawingTool;
    drawingEngineRef.current?.setTool(drawingTool);
    engineRef.current?.activateInteractionTool(
      getInteractionToolId(drawingTool),
    );

    if (drawingTool !== "cursor") {
      engineRef.current?.clearFxAnalysisSelection();
    }
  }, [drawingTool]);

  useEffect(() => {
    fxAnalysisToolRef.current = fxAnalysisTool;
    localStorage.setItem(FX_ANALYSIS_TOOL_STORAGE_KEY, fxAnalysisTool);

    if (fxAnalysisTool !== "none") {
      engineRef.current?.activateInteractionTool("select");
      drawingEngineRef.current?.selectDrawing(null);
      engineRef.current?.clearFxAnalysisSelection();
    }
  }, [fxAnalysisTool]);

  useEffect(() => {
    engineRef.current?.setFxAnalysisSettings(fxAnalysisSettings);
    localStorage.setItem(
      FX_ANALYSIS_SETTINGS_STORAGE_KEY,
      JSON.stringify(fxAnalysisSettings),
    );
  }, [fxAnalysisSettings]);

  useEffect(() => {
    engineRef.current?.setChartSettings(chartSettings);
    localStorage.setItem(
      CHART_SETTINGS_STORAGE_KEY,
      JSON.stringify(chartSettings),
    );
  }, [chartSettings]);

  useEffect(() => {
    drawingStyleRef.current = drawingStyle;
    drawingEngineRef.current?.setDefaultStyle(drawingStyle);
    localStorage.setItem(
      DRAWING_STYLE_STORAGE_KEY,
      JSON.stringify(drawingStyle),
    );
  }, [drawingStyle]);

  useEffect(() => {
    localStorage.setItem(TIMEFRAME_STORAGE_KEY, timeframe);
  }, [timeframe]);

  useEffect(() => {
    let cancelled = false;

    localStorage.setItem(
      MARKET_DATA_MODE_STORAGE_KEY,
      marketDataMode,
    );
    window.dispatchEvent(
      new CustomEvent<MarketDataMode>(MARKET_DATA_MODE_CHANGE_EVENT, {
        detail: marketDataMode,
      }),
    );

    if (marketDataMode === "live") {
      replayRuntime.pause();
      replayIndexRef.current = -1;
    }

    const executionMode =
      marketDataMode === "replay"
        ? "practice"
        : "paper";

    void switchExecutionMode(executionMode).catch((error) => {
      if (cancelled) return;

      console.error(
        `Unable to switch execution mode to ${executionMode}.`,
        error,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [marketDataMode, replayRuntime]);

  useEffect(() => {
    localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify(studyVisibility));
  }, [studyVisibility]);

  useEffect(() => {
    const preferences: ChartPreferences = {
      studyVisibility,
      fxAnalysisSettings,
      chartSettings,
      drawingStyle,
    };
    const snapshot = serializeChartPreferences(preferences);
    chartPreferencesCurrentSnapshotRef.current = snapshot;

    if (
      !chartPreferencesReadyRef.current ||
      snapshot === chartPreferencesRemoteSnapshotRef.current
    ) {
      return;
    }

    let cancelled = false;

    const save = async (): Promise<void> => {
      chartPreferencesSaveTimerRef.current = null;
      chartPreferencesSaveInFlightRef.current = true;

      try {
        const response = await fetch(
          `${API_BASE}/app-state/alpaca/chart-preferences`,
          {
            method: "PUT",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ preferences }),
          },
        );

        if (!response.ok) {
          throw new Error(
            `Chart preference save failed (${response.status})`,
          );
        }

        const payload = (await response.json()) as Record<string, unknown>;
        if (cancelled) return;

        const revision = Number(payload.revision ?? 0);
        chartPreferencesRevisionRef.current = Number.isFinite(revision)
          ? Math.max(0, revision)
          : chartPreferencesRevisionRef.current;
        chartPreferencesRemoteSnapshotRef.current = snapshot;
      } catch (error) {
        if (cancelled) return;

        console.warn("[ChartPanel] chart preference save failed", error);
        chartPreferencesSaveTimerRef.current = window.setTimeout(
          () => void save(),
          CHART_PREFERENCES_POLL_MS,
        );
      } finally {
        chartPreferencesSaveInFlightRef.current = false;
      }
    };

    if (chartPreferencesSaveTimerRef.current != null) {
      window.clearTimeout(chartPreferencesSaveTimerRef.current);
    }

    chartPreferencesSaveTimerRef.current = window.setTimeout(
      () => void save(),
      CHART_PREFERENCES_SAVE_DELAY_MS,
    );

    return () => {
      cancelled = true;

      if (chartPreferencesSaveTimerRef.current != null) {
        window.clearTimeout(chartPreferencesSaveTimerRef.current);
        chartPreferencesSaveTimerRef.current = null;
      }
    };
  }, [
    studyVisibility,
    fxAnalysisSettings,
    chartSettings,
    drawingStyle,
  ]);

  useEffect(() => {
    localStorage.setItem(
      RIGHT_PANEL_COLLAPSED_KEY,
      String(rightPanelCollapsed),
    );

    window.setTimeout(() => {
      engineRef.current?.resize();
    }, 0);
  }, [rightPanelCollapsed]);

  useEffect(() => {
    chartIntelligenceBridgeRef.current?.setMode(
      marketDataMode === "replay" ? "replay" : "live",
    );
  }, [marketDataMode]);

  useEffect(() => {
    return replayRuntime.subscribe((snapshot) => {
      setReplaySnapshot(snapshot);

      if (marketDataMode !== "replay") return;

      const engine = engineRef.current;
      if (!engine || snapshot.bars.length === 0) return;

      const previousIndex = replayIndexRef.current;
      const movedForwardOne =
        previousIndex >= 0 &&
        snapshot.currentIndex === previousIndex + 1 &&
        snapshot.currentBar != null;

      engine.setMarketContext(symbol, timeframe);

      if (movedForwardOne && snapshot.currentBar) {
        engine.updateBar(snapshot.currentBar);
      } else {
        engine.setBars(snapshot.visibleBars);
      }

      replayIndexRef.current = snapshot.currentIndex;
      commitChartState(engine, "replay-updated");
      engine.setStudyVisibility(studyVisibility);
      setCrosshairInfo(engine.getLastBarInfo());
    });
  }, [
    marketDataMode,
    replayRuntime,
    studyVisibility,
    symbol,
    timeframe,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const engine = engineRef.current;
        if (!engine) return;

        setCrosshairInfo(null);
        setChartState(null);
        chartIntelligenceBridgeRef.current?.reset();
        replayIndexRef.current = -1;
        engine.setMarketContext(symbol, timeframe);
        tradeEngineRef.current?.setWorkspace({ symbol, timeframe });

        if (marketDataMode === "replay") {
          setLiveStatus("connecting");

          const snapshot = await replayRuntime.load({
            symbol,
            timeframe,
            date: practiceTradingDate || undefined,
            lookback: practiceTradingDate ? undefined : "30d",
            limit: 4000,
            startMode: replayStartMode,
            customStartTime:
              replayCustomStartTime,
            speed: replaySnapshot.speed,
            autoplay: false,
          });

          if (cancelled) return;

          engine.setMarketContext(symbol, timeframe);
          engine.setBars(snapshot.visibleBars);
          replayIndexRef.current = snapshot.currentIndex;
          drawingEngineRef.current?.setWorkspace(symbol, timeframe);
          marketObjectDrawingBridgeRef.current?.setWorkspace({ symbol, timeframe });
          tradeEngineRef.current?.setWorkspace({ symbol, timeframe });
          commitChartState(engine, "replay-loaded");
          engine.setStudyVisibility(studyVisibility);
          setCrosshairInfo(engine.getLastBarInfo());
          setLiveStatus("live");
          engine.resize();
          engine.fitContent();
          return;
        }

        const historyRequest = getHistoricalRequest(timeframe);
        const bars = await loadHistoricalBars({
          symbol,
          timeframe,
          lookback: historyRequest.lookback,
          limit: historyRequest.limit,
        });

        if (cancelled) return;

        engine.setMarketContext(symbol, timeframe);
        engine.setBars(bars);
        drawingEngineRef.current?.setWorkspace(symbol, timeframe);
        marketObjectDrawingBridgeRef.current?.setWorkspace({ symbol, timeframe });
        tradeEngineRef.current?.setWorkspace({ symbol, timeframe });
        commitChartState(engine, "historical-bars-loaded");
        engine.setStudyVisibility(studyVisibility);
        setCrosshairInfo(engine.getLastBarInfo());
        engine.resize();
        engine.fitContent();
      } catch (err) {
        console.error("ChartPanelV2 load failed", err);
        setLiveStatus("disconnected");
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [
    marketDataMode,
    practiceTradingDate,
    replayCustomStartTime,
    replayStartMode,
    symbol,
    timeframe,
  ]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const applyOverlay = async () => {
      const engine = engineRef.current;
      if (!engine) return;

      if (marketDataMode !== "live") {
        engine.setVwap3SetupOverlay(null);
        return;
      }

      try {
        // Prefer the live scanner cache. Actionable setups can survive an
        // Eastern market-date rollover, so this catches carry-forward setups and
        // ensures a new live setup wins over an older historical selection.
        const cache = await fetchScannerCache("vwap3_target");
        if (cancelled) return;
        let setup = latestVwap3SetupForSymbol(
          scannerCacheRowsForVwap3(cache),
          symbol,
        );

        // Next use the exact VWAP3 setup the user clicked in the scanner. This is
        // important for prior-day setups and resolved-history rows, which may not
        // be present in today's Pacific history file.
        if (!setup) {
          setup = readSelectedVwap3SetupForSymbol(symbol);
        }

        // Fall back to today's Pacific history for symbols selected outside the
        // scanner (watchlists/search) or after a cache restart.
        if (!setup) {
          const history = await fetchVwap3SetupHistory(pacificTodayIsoForChart());
          if (cancelled) return;
          setup = latestVwap3SetupForSymbol(history.rows ?? [], symbol);
        }

        if (!setup) {
          engine.setVwap3SetupOverlay(null);
          return;
        }

        engine.setVwap3SetupOverlay({
          symbol: String(setup.symbol ?? symbol).toUpperCase(),
          setupKey: String(setup.setup_key ?? ""),
          grade: String(setup.grade ?? ""),
          status: String(setup.confirmation_status ?? ""),
          outcome: String(setup.outcome ?? ""),
          displacementTime: setup.displacement_time ? String(setup.displacement_time) : undefined,
          displacementHigh: Number(setup.displacement_high ?? 0) || undefined,
          displacementLow: Number(setup.displacement_low ?? 0) || undefined,
          freezeUpper3Std: Number(setup.freeze_upper_3std ?? setup.frozen_target ?? setup.target_price ?? 0) || undefined,
          freezeLower3Std: Number(setup.freeze_lower_3std ?? 0) || undefined,
          targetPrice: Number(setup.target_price ?? setup.frozen_target ?? setup.freeze_upper_3std ?? 0) || undefined,
          currentScore: Number(setup.current_score ?? setup.score ?? 0),
          scoreAtFreeze: Number(setup.score_at_freeze ?? setup.original_score ?? 0),
        });
      } catch (error) {
        if (!cancelled) {
          console.warn("[vwap3-chart-overlay] refresh failed", error);
        }
      }
    };

    void applyOverlay();
    if (marketDataMode === "live") {
      timer = window.setInterval(() => void applyOverlay(), VWAP3_CHART_OVERLAY_REFRESH_MS);
    }

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [marketDataMode, symbol, timeframe]);

  useEffect(() => {
    if (marketDataMode !== "live") {
      return;
    }

    setLiveStatus("connecting");

    const cleanup = connectLiveBars({
      symbol,
      timeframe,
      onStatus: setLiveStatus,
      onBar: (bar) => {
        const engine = engineRef.current;
        if (!engine) return;

        engine.setMarketContext(symbol, timeframe);
        engine.updateBar(bar);
        commitLiveChartState(engine);

        setCrosshairInfo((current) => current ?? engine.getLastBarInfo());
      },
    });

    return () => {
      cleanup();
      pendingLiveChartStateEngineRef.current = null;

      if (liveChartStateTimerRef.current != null) {
        window.clearTimeout(liveChartStateTimerRef.current);
        liveChartStateTimerRef.current = null;
      }
    };
  }, [marketDataMode, symbol, timeframe]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;

      const tag = target.tagName.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target.isContentEditable
      );
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;

      if (event.key === "Escape") {
        positionOverlayRef.current?.cancelDrag();
        drawingEngineRef.current?.cancelPendingDrawing();
        drawingEngineRef.current?.selectDrawing(null);
        engineRef.current?.clearFxAnalysisSelection();
        engineRef.current?.activateInteractionTool("select");
        setFxAnalysisTool("none");
        setDrawingTool("cursor");
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") return;

      const removedDrawing =
        drawingEngineRef.current?.removeSelectedDrawing() ?? false;
      const removedFx = removedDrawing
        ? false
        : (engineRef.current?.removeSelectedFxAnalysis() ?? false);

      if (removedDrawing || removedFx) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function handleClearDrawings() {
    tradeControllerRef.current?.clear();
    engineRef.current?.clearFxAnalysis();
    setDrawingTool("cursor");
    setFxAnalysisTool("none");
  }

  function handleFxAnalysisToolChange(tool: FxAnalysisToolId) {
    setFxAnalysisTool((current) => (current === tool ? "none" : tool));
    setDrawingTool("cursor");
  }

  const settingsMode: SettingsMode =
    fxAnalysisTool !== "none"
      ? "function"
      : drawingTool !== "cursor"
        ? "drawing"
        : "chart";

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        background: "#111315",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ChartToolbarV2
        symbol={symbol}
        timeframe={timeframe}
        liveStatus={liveStatus}
        crosshairInfo={crosshairInfo}
        studyVisibility={studyVisibility}
        marketDataMode={marketDataMode}
        replaySnapshot={replaySnapshot}
        practiceTradingDate={practiceTradingDate}
        onSymbolChange={handleSymbolChange}
        onTimeframeChange={setTimeframe}
        onStudyVisibilityChange={setStudyVisibility}
        onMarketDataModeChange={setMarketDataMode}
        onReplayPlay={() => replayRuntime.play()}
        onReplayPause={() => replayRuntime.pause()}
        onReplayReset={() => replayRuntime.reset()}
        onReplayStepBackward={() => replayRuntime.stepBackward()}
        onReplayStepForward={() => replayRuntime.stepForward()}
        onReplaySeek={(index) => replayRuntime.seek(index)}
        onReplaySpeedChange={(speed: ReplaySpeed) =>
          replayRuntime.setSpeed(speed)
        }
        onPracticeTradingDateChange={
          handlePracticeTradingDateChange
        }
      />

      <SettingsPanel
        open={settingsOpen}
        mode={settingsMode}
        drawingStyle={drawingStyle}
        onDrawingStyleChange={setDrawingStyle}
        chartSettings={chartSettings}
        onChartSettingsChange={setChartSettings}
        activeFxTool={fxAnalysisTool}
        fxSettings={fxAnalysisSettings}
        onFxSettingsChange={setFxAnalysisSettings}
        onClearFx={() => engineRef.current?.clearFxAnalysis()}
        onFitFxLevels={() => engineRef.current?.fitFxAnalysisLevels()}
        onClose={() => setSettingsOpen(false)}
      />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        <LeftDrawingBar
          activeTool={drawingTool}
          activeAnalysisTool={fxAnalysisTool}
          settingsOpen={settingsOpen}
          onToolChange={(tool) => {
            setFxAnalysisTool("none");
            setDrawingTool(tool);
          }}
          onAnalysisToolChange={handleFxAnalysisToolChange}
          onClear={handleClearDrawings}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
        />

        <ChartViewport ref={containerRef} liveStatus={liveStatus} />

        <RightInfoPanel
          symbol={symbol}
          chartState={chartState}
          collapsed={rightPanelCollapsed}
          onToggleCollapsed={() =>
            setRightPanelCollapsed((current) => !current)
          }
        />
      </div>
    </div>
  );
}

const MemoizedChartPanel = memo(ChartPanel);

export { MemoizedChartPanel as ChartPanel };
export default MemoizedChartPanel;
