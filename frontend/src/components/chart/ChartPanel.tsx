// src/components/chart/ChartPanel.tsx

import { memo, useEffect, useRef, useState } from "react";

import { ChartEngine } from "./ChartEngine";
import type { ChartState } from "./ChartState";
import type { CrosshairInfo, LiveStatus, StudyVisibility } from "./ChartTypes";
import { connectLiveBars, loadHistoricalBars } from "./LiveDataEngine";
import { getSharedReplayRuntime } from "../../trading/replay/ReplayRuntime";
import type {
  MarketDataMode,
  ReplaySnapshot,
  ReplaySpeed,
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
import { API_BASE } from "../../services/api";

const TIMEFRAME_STORAGE_KEY = "chartv2.timeframe";
const STUDY_STORAGE_KEY = "chartv2.studyVisibility";
const RIGHT_PANEL_COLLAPSED_KEY = "chartv2.rightPanelCollapsed";
const DRAWING_STYLE_STORAGE_KEY = "chartv2.drawingStyle";
const FX_ANALYSIS_TOOL_STORAGE_KEY = "chartv2.fxAnalysisTool";
const FX_ANALYSIS_SETTINGS_STORAGE_KEY = "chartv2.fxAnalysisSettings";
const CHART_SETTINGS_STORAGE_KEY = "chartv2.chartSettings";
const MARKET_DATA_MODE_STORAGE_KEY = "chartv2.marketDataMode";
const CHART_PREFERENCES_POLL_MS = 3_000;
const CHART_PREFERENCES_SAVE_DELAY_MS = 180;

const DEFAULT_STUDY_VISIBILITY: StudyVisibility = {
  vwap: true,
  ema9: true,
  ema20: true,
  volume: true,
  marketStructure: true,
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
  const tradeEngineRef = useRef<TradeEngine | null>(null);
  const tradeControllerRef = useRef<TradeController | null>(null);
  const positionOverlayRef = useRef<PositionOverlayManager | null>(null);
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
    tradeEngineRef.current = tradeEngine;

    const executionService = getSharedExecutionGateway();
    const positionOverlay = new PositionOverlayManager(engine.series.candles, {
      onCommit: async (change: PositionOverlayCommit) => {
        if (!change.isLive || !change.orderId) {
          console.warn(
            `[PositionOverlay] ${change.level} is local and cannot be sent to Alpaca.`,
          );
          return false;
        }

        const updatedOrder = await executionService.modifyOrder(
          change.orderId,
          change.level === "stop"
            ? { stop_price: change.price }
            : { limit_price: change.price },
        );

        if (!updatedOrder) {
          return false;
        }

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
              change.orderId,
            ]),
          );

          if (change.level === "stop") {
            tradeEngine.updateStop(liveTrade.id, change.price);
          } else {
            tradeEngine.updateTarget(liveTrade.id, change.price);
          }

          const latestTrade = tradeEngine.getTrade(liveTrade.id) ?? liveTrade;

          tradeEngine.updateTrade(liveTrade.id, {
            status: "managing",
            links: {
              ...latestTrade.links,
              alpacaOrderIds: nextOrderIds,
            },
          });

          if (tradeEngine.getSelectedTradeId() !== liveTrade.id) {
            tradeEngine.selectTrade(liveTrade.id);
          }
        }

        executionService.queueRefresh();
        return true;
      },
      onDragStateChange: (dragging) => {
        container.style.cursor = dragging ? "ns-resize" : "";
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

    const handleOverlayPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (drawingToolRef.current !== "cursor") return;
      if (fxAnalysisToolRef.current !== "none") return;

      const started = positionOverlay.beginDrag(getLocalY(event));
      if (!started) return;

      container.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };

    const handleOverlayPointerMove = (event: PointerEvent) => {
      if (!positionOverlay.isDragging()) {
        const hit = positionOverlay.hitTest(getLocalY(event));
        container.style.cursor = hit ? "ns-resize" : "";
        return;
      }

      positionOverlay.moveDrag(getLocalY(event));
      event.preventDefault();
      event.stopPropagation();
    };

    const handleOverlayPointerUp = (event: PointerEvent) => {
      if (!positionOverlay.isDragging()) return;

      container.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      void positionOverlay.endDrag();
    };

    const handleOverlayPointerCancel = (event: PointerEvent) => {
      if (!positionOverlay.isDragging()) return;

      container.releasePointerCapture?.(event.pointerId);
      positionOverlay.cancelDrag();
      event.preventDefault();
      event.stopPropagation();
    };

    container.addEventListener("pointerdown", handleOverlayPointerDown, true);
    container.addEventListener("pointermove", handleOverlayPointerMove, true);
    container.addEventListener("pointerup", handleOverlayPointerUp, true);
    container.addEventListener("pointercancel", handleOverlayPointerCancel, true);

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
      container.removeEventListener("pointerdown", handleOverlayPointerDown, true);
      container.removeEventListener("pointermove", handleOverlayPointerMove, true);
      container.removeEventListener("pointerup", handleOverlayPointerUp, true);
      container.removeEventListener("pointercancel", handleOverlayPointerCancel, true);
      container.style.cursor = "";
      tradeController.detach();
      tradeControllerRef.current = null;
      tradeEngineRef.current = null;
      positionOverlay.destroy();
      positionOverlayRef.current = null;
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

    const applySnapshot = (
      snapshot: ReturnType<typeof executionService.getSnapshot>,
    ) => {
      const protection = protectionEngine.findProtection(
        symbol,
        snapshot.positions,
        snapshot.openOrders,
      );

      positionOverlayRef.current?.update(protection);
    };

    const unsubscribe = executionService.subscribe(applySnapshot);
    applySnapshot(executionService.getSnapshot());
    executionService.queueRefresh();

    return () => {
      unsubscribe();
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
        commitChartState(engine, "live-bar-updated");
        engine.setStudyVisibility(studyVisibility);

        setCrosshairInfo((current) => current ?? engine.getLastBarInfo());
      },
    });

    return cleanup;
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
