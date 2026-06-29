// src/components/ChartPanelV2/ChartPanel.tsx

import { memo, useEffect, useRef, useState } from "react";

import { ChartEngine } from "../chart/ChartEngine";
import type { ChartState } from "../chart/ChartState";
import type {
  CrosshairInfo,
  LiveStatus,
  StudyVisibility,
} from "../chart/ChartTypes";
import { connectLiveBars, loadHistoricalBars } from "../chart/LiveDataEngine";
import { useActiveSymbol } from "../chart/ActiveSymbolContext";
import ChartToolbarV2 from "./ChartToolbarV2";
import ChartViewport from "./ChartViewport";
import LeftDrawingBar from "./LeftDrawingBar";
import RightInfoPanel from "./RightInfoPanel";
import { DrawingEngine } from "./DrawingEngine";
import SettingsPanel, { type SettingsMode } from "./SettingsPanel";
import { DEFAULT_DRAWING_STYLE } from "./DrawingTypes";
import type { DrawingStyle, DrawingTool } from "./DrawingTypes";
import {
  DEFAULT_FX_ANALYSIS_SETTINGS,
  type FxAnalysisSettings,
  type FxAnalysisToolId,
} from "../chart/analysis";
import {
  DEFAULT_CHART_SETTINGS,
  normalizeChartSettings,
  type ChartSettings,
} from "../chart/ChartSettingsTypes";

const TIMEFRAME_STORAGE_KEY = "chartv2.timeframe";
const STUDY_STORAGE_KEY = "chartv2.studyVisibility";
const RIGHT_PANEL_COLLAPSED_KEY = "chartv2.rightPanelCollapsed";
const DRAWING_STYLE_STORAGE_KEY = "chartv2.drawingStyle";
const FX_ANALYSIS_TOOL_STORAGE_KEY = "chartv2.fxAnalysisTool";
const FX_ANALYSIS_SETTINGS_STORAGE_KEY = "chartv2.fxAnalysisSettings";
const CHART_SETTINGS_STORAGE_KEY = "chartv2.chartSettings";

interface Props {
  timeframe?: string;
}

function loadStudyVisibility(): StudyVisibility {
  const fallback: StudyVisibility = {
    vwap: true,
    ema9: true,
    ema20: true,
    volume: true,
  };

  const saved = localStorage.getItem(STUDY_STORAGE_KEY);
  if (!saved) return fallback;

  try {
    return {
      ...fallback,
      ...JSON.parse(saved),
    };
  } catch {
    return fallback;
  }
}

function loadDrawingStyle(): DrawingStyle {
  const saved = localStorage.getItem(DRAWING_STYLE_STORAGE_KEY);
  if (!saved) return DEFAULT_DRAWING_STYLE;

  try {
    return {
      ...DEFAULT_DRAWING_STYLE,
      ...JSON.parse(saved),
    };
  } catch {
    return DEFAULT_DRAWING_STYLE;
  }
}

function loadFxAnalysisSettings(): FxAnalysisSettings {
  const saved = localStorage.getItem(FX_ANALYSIS_SETTINGS_STORAGE_KEY);
  if (!saved) return DEFAULT_FX_ANALYSIS_SETTINGS;

  try {
    const parsed = JSON.parse(saved) as Partial<FxAnalysisSettings>;

    return {
      supportPrediction: {
        ...DEFAULT_FX_ANALYSIS_SETTINGS.supportPrediction,
        ...(parsed.supportPrediction ?? {}),
      },
      resistancePrediction: {
        ...DEFAULT_FX_ANALYSIS_SETTINGS.resistancePrediction,
        ...(parsed.resistancePrediction ?? {}),
      },
      demandZone: {
        ...DEFAULT_FX_ANALYSIS_SETTINGS.demandZone,
        ...(parsed.demandZone ?? {}),
      },
    };
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

function ChartPanel({ timeframe: initialTimeframe = "5m" }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ChartEngine | null>(null);
  const drawingEngineRef = useRef<DrawingEngine | null>(null);
  const fxAnalysisToolRef = useRef<FxAnalysisToolId>("none");

  const { activeSymbol, setActiveSymbol } = useActiveSymbol();
  const symbol = activeSymbol;

useEffect(() => {
  console.log("ChartPanel activeSymbol:", activeSymbol);
}, [activeSymbol]);

  const [timeframe, setTimeframe] = useState(
    () => localStorage.getItem(TIMEFRAME_STORAGE_KEY) || initialTimeframe
  );
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [crosshairInfo, setCrosshairInfo] = useState<CrosshairInfo | null>(
    null
  );
  const [studyVisibility, setStudyVisibility] =
    useState<StudyVisibility>(loadStudyVisibility);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("cursor");
  const [drawingStyle, setDrawingStyle] =
    useState<DrawingStyle>(loadDrawingStyle);
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
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => {
    return localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY) === "true";
  });
  const [chartState, setChartState] = useState<ChartState | null>(null);

  function commitChartState(engine: ChartEngine, reason: string): void {
    const nextState = engine.getState();

    console.log("ChartPanel setting chartState", {
      reason,
      symbol: nextState.symbol,
      timeframe: nextState.timeframe,
      bars: nextState.bars.length,
      price: nextState.price,
      vwap: nextState.vwap.value,
      aboveVwap: nextState.vwap.above,
      ema9: nextState.ema.ema9,
      ema20: nextState.ema.ema20,
      atr: nextState.atr.value,
    });

    setChartState(nextState);
  }

  function handleSymbolChange(nextSymbol: string) {
    setActiveSymbol(nextSymbol, "toolbar");
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const engine = new ChartEngine(container);
    const drawingEngine = new DrawingEngine(engine.chart, engine.series.candles);

    engine.setStudyVisibility(studyVisibility);
    engine.setFxAnalysisSettings(fxAnalysisSettings);
    engine.setChartSettings(chartSettings);
    drawingEngine.setTool(drawingTool);
    drawingEngine.setDefaultStyle(drawingStyle);

    engineRef.current = engine;
    drawingEngineRef.current = drawingEngine;

    const unsubscribeCrosshair = engine.subscribeCrosshairInfo((info) => {
      setCrosshairInfo(info ?? engine.getLastBarInfo());
    });

    const unsubscribeClick = engine.subscribeClick((point) => {
      if (fxAnalysisToolRef.current !== "none") {
        engine.runFxAnalysisTool(fxAnalysisToolRef.current, point.bar);
        return;
      }

      drawingEngine.handleClick(point);
    });

    const unsubscribePointerDown = engine.subscribePointerDown((point) => {
      drawingEngine.handlePointerDown(point);
    });

    const unsubscribePointerMove = engine.subscribePointerMove((point) => {
      drawingEngine.handlePointerMove(point);
    });

    const unsubscribePointerUp = engine.subscribePointerUp((point) => {
      drawingEngine.handlePointerUp(point);
    });

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
      drawingEngine.clear();
      drawingEngineRef.current = null;
      engine.destroy();
      engineRef.current = null;
    };
    // Run only on mount. Study changes are handled by the separate effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setStudyVisibility(studyVisibility);
  }, [studyVisibility]);

  useEffect(() => {
    drawingEngineRef.current?.setTool(drawingTool);
  }, [drawingTool]);

  useEffect(() => {
    fxAnalysisToolRef.current = fxAnalysisTool;
    localStorage.setItem(FX_ANALYSIS_TOOL_STORAGE_KEY, fxAnalysisTool);
  }, [fxAnalysisTool]);

  useEffect(() => {
    engineRef.current?.setFxAnalysisSettings(fxAnalysisSettings);
    localStorage.setItem(
      FX_ANALYSIS_SETTINGS_STORAGE_KEY,
      JSON.stringify(fxAnalysisSettings)
    );
  }, [fxAnalysisSettings]);

  useEffect(() => {
    engineRef.current?.setChartSettings(chartSettings);
    localStorage.setItem(
      CHART_SETTINGS_STORAGE_KEY,
      JSON.stringify(chartSettings)
    );
  }, [chartSettings]);

  useEffect(() => {
    drawingEngineRef.current?.setDefaultStyle(drawingStyle);
    localStorage.setItem(
      DRAWING_STYLE_STORAGE_KEY,
      JSON.stringify(drawingStyle)
    );
  }, [drawingStyle]);

  useEffect(() => {
    localStorage.setItem(TIMEFRAME_STORAGE_KEY, timeframe);
  }, [timeframe]);

  useEffect(() => {
    localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify(studyVisibility));
  }, [studyVisibility]);

  useEffect(() => {
    localStorage.setItem(
      RIGHT_PANEL_COLLAPSED_KEY,
      String(rightPanelCollapsed)
    );

    window.setTimeout(() => {
      engineRef.current?.resize();
    }, 0);
  }, [rightPanelCollapsed]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const engine = engineRef.current;
        if (!engine) return;

        const bars = await loadHistoricalBars({
          symbol,
          timeframe,
          lookback: "5d",
          limit: 500,
        });

        if (cancelled) return;

        engine.setMarketContext(symbol, timeframe);
        engine.setBars(bars);
        commitChartState(engine, "historical-bars-loaded");
        engine.clearFxAnalysis();
        engine.setStudyVisibility(studyVisibility);
        setCrosshairInfo(engine.getLastBarInfo());
        engine.resize();
        engine.fitContent();
      } catch (err) {
        console.error("ChartPanel load failed", err);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, studyVisibility]);

  useEffect(() => {
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
  }, [symbol, timeframe, studyVisibility]);

  function handleClearDrawings() {
    drawingEngineRef.current?.clear();
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
        crosshairInfo={crosshairInfo}
        studyVisibility={studyVisibility}
        onSymbolChange={handleSymbolChange}
        onTimeframeChange={setTimeframe}
        onStudyVisibilityChange={setStudyVisibility}
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

export default memo(ChartPanel);