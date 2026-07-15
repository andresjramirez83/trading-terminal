import {
  BaselineSeries,
  LineSeries,
  type BaselineData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from "lightweight-charts";
import {
  DEFAULT_FX_ANALYSIS_SETTINGS,
  type FxAnalysisResult,
  type FxAnalysisSettings,
} from "./AnalysisTypes";

function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean;

  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return `rgba(34,197,94,${opacity})`;

  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;

  return `rgba(${r},${g},${b},${opacity})`;
}

function lineWidth(value: number): 1 | 2 | 3 | 4 {
  if (value <= 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  return 4;
}

export class AnalysisRenderer {
  private chart: IChartApi;
  private lineSeries = new Map<string, ISeriesApi<"Line">>();
  private zoneSeries = new Map<string, ISeriesApi<"Baseline">>();
  private visibleFrom: Time | null = null;
  private visibleTo: Time | null = null;

  constructor(chart: IChartApi) {
    this.chart = chart;
  }

  setVisibleRange(from: Time | null, to: Time | null): void {
    this.visibleFrom = from;
    this.visibleTo = to;
  }

  renderAll(
    results: FxAnalysisResult[],
    settings: FxAnalysisSettings = DEFAULT_FX_ANALYSIS_SETTINGS,
    selectedResultId: string | null = null,
  ): void {
    this.clear();

    for (const result of results) {
      this.renderResult(result, settings, selectedResultId);
    }
  }

  render(
    result: FxAnalysisResult,
    settings: FxAnalysisSettings = DEFAULT_FX_ANALYSIS_SETTINGS,
    selectedResultId: string | null = null,
  ): void {
    this.renderAll([result], settings, selectedResultId);
  }

  private renderResult(
    result: FxAnalysisResult,
    settings: FxAnalysisSettings,
    selectedResultId: string | null,
  ): void {
    if (result.tool === "none") return;

    const toolSettings = settings[result.tool];
    if (!toolSettings?.enabled) return;

    const showVisual = toolSettings.showLine !== false;
    if (!showVisual) return;

    const selected = result.id === selectedResultId;
    const showLabel = toolSettings.showLabels !== false;
    const extendRight = toolSettings.extendRight !== false;
    const from = this.visibleFrom ?? result.anchorTime;
    const to = this.visibleTo ?? result.anchorTime;
    const selectedColor = "#38bdf8";
    const baseColor = toolSettings.color;
    const visualColor = selected ? selectedColor : baseColor;
    const visualWidth = lineWidth((toolSettings.lineWidth ?? 2) + (selected ? 1 : 0));

    if (result.zone) {
      const zoneFrom = result.anchorTime;
      const zoneTo = extendRight ? to : result.anchorTime;
      const fillColor = selected
        ? "rgba(56,189,248,.20)"
        : hexToRgba(toolSettings.color, toolSettings.opacity);

      const zone = this.chart.addSeries(BaselineSeries, {
        baseValue: {
          type: "price",
          price: result.zone.low,
        },
        topLineColor: visualColor,
        bottomLineColor: selected ? visualColor : "rgba(0,0,0,0)",
        topFillColor1: fillColor,
        topFillColor2: fillColor,
        bottomFillColor1: "rgba(0,0,0,0)",
        bottomFillColor2: "rgba(0,0,0,0)",
        lineWidth: visualWidth,
        priceLineVisible: false,
        lastValueVisible: false,
        title: showLabel ? result.zone.title : "",
        priceScaleId: "right",
        autoscaleInfoProvider: () => null,
      });

      zone.setData([
        { time: zoneFrom, value: result.zone.high },
        { time: zoneTo, value: result.zone.high },
      ] as BaselineData<Time>[]);

      this.zoneSeries.set(result.zone.id, zone);
    }

    const lineFrom = result.zone ? result.anchorTime : from;

    for (const line of result.lines) {
      const lineTo = extendRight ? to : result.anchorTime;

      const series = this.chart.addSeries(LineSeries, {
        color: selected ? selectedColor : toolSettings.color || line.color,
        lineWidth: selected ? visualWidth : lineWidth(toolSettings.lineWidth ?? line.lineWidth ?? 2),
        lineStyle: line.lineStyle,
        priceLineVisible: showLabel,
        lastValueVisible: showLabel,
        title: showLabel ? line.title : "",
        priceScaleId: "right",
        autoscaleInfoProvider: () => null,
      });

      series.setData([
        { time: lineFrom, value: line.price },
        { time: lineTo, value: line.price },
      ] as LineData<Time>[]);

      this.lineSeries.set(line.id, series);
    }
  }

  clear(): void {
    for (const series of this.lineSeries.values()) {
      this.chart.removeSeries(series);
    }

    this.lineSeries.clear();

    for (const series of this.zoneSeries.values()) {
      this.chart.removeSeries(series);
    }

    this.zoneSeries.clear();
  }
}
