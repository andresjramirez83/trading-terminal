// src/components/ChartPanelV2/DrawingRenderer.ts

import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

import type {
  ChartDrawing,
  DrawingStyle,
  HorizontalLineDrawing,
  TrendlineDrawing,
} from "./DrawingTypes";

type LineSeriesApi = ISeriesApi<"Line">;

function lineWidth(width: number): 1 | 2 | 3 | 4 {
  if (width <= 1) return 1;
  if (width === 2) return 2;
  if (width === 3) return 3;
  return 4;
}

export class DrawingRenderer {
  private chart: IChartApi;
  private priceSeries: ISeriesApi<"Candlestick">;
  private drawingSeries = new Map<string, LineSeriesApi>();
  private handleSeries = new Map<string, LineSeriesApi>();

  constructor(chart: IChartApi, priceSeries: ISeriesApi<"Candlestick">) {
    this.chart = chart;
    this.priceSeries = priceSeries;
  }

  clear(): void {
    for (const series of this.drawingSeries.values()) {
      this.chart.removeSeries(series);
    }

    for (const series of this.handleSeries.values()) {
      this.chart.removeSeries(series);
    }

    this.drawingSeries.clear();
    this.handleSeries.clear();
  }

  removeDrawing(id: string): void {
    const line = this.drawingSeries.get(id);
    if (line) {
      this.chart.removeSeries(line);
      this.drawingSeries.delete(id);
    }

    const handles = this.handleSeries.get(id);
    if (handles) {
      this.chart.removeSeries(handles);
      this.handleSeries.delete(id);
    }
  }

  renderAll(drawings: ChartDrawing[], selectedDrawingId: string | null): void {
    for (const drawing of drawings) {
      this.renderDrawing(drawing, selectedDrawingId);
    }
  }

  renderDrawing(drawing: ChartDrawing, selectedDrawingId: string | null): void {
    this.removeLine(drawing.id);

    if (drawing.type === "horizontal") {
      this.renderHorizontalLine(drawing);
    } else {
      this.renderTrendline(drawing);
    }

    this.renderHandlesForDrawing(drawing, selectedDrawingId);
  }

  private removeLine(id: string): void {
    const existing = this.drawingSeries.get(id);
    if (existing) {
      this.chart.removeSeries(existing);
      this.drawingSeries.delete(id);
    }
  }

  private removeHandles(id: string): void {
    const existing = this.handleSeries.get(id);
    if (existing) {
      this.chart.removeSeries(existing);
      this.handleSeries.delete(id);
    }
  }

  private baseLineOptions(style: DrawingStyle) {
    return {
      priceScaleId: "right",
      color: style.color,
      lineWidth: lineWidth(style.width),
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
    };
  }

  private handleLineOptions(style: DrawingStyle) {
    return {
      priceScaleId: "right",
      color: style.color,
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 5,
    } as any;
  }

  private renderHorizontalLine(drawing: HorizontalLineDrawing): void {
    const series = this.chart.addSeries(
      LineSeries,
      this.baseLineOptions(drawing.style),
    );

    const range = this.chart.timeScale().getVisibleRange();
    const from = Number(range?.from ?? Math.floor(Date.now() / 1000) - 86400);
    const to = Number(range?.to ?? Math.floor(Date.now() / 1000) + 86400);

    series.setData([
      { time: from as Time, value: drawing.price },
      { time: to as Time, value: drawing.price },
    ]);

    this.drawingSeries.set(drawing.id, series);
  }

  private renderTrendline(drawing: TrendlineDrawing): void {
    const { p1Time, p1Price, p2Time, p2Price } =
      this.getRenderedTrendlinePoints(drawing);

    if (p1Time === p2Time) return;

    const series = this.chart.addSeries(
      LineSeries,
      this.baseLineOptions(drawing.style),
    );

    series.setData([
      { time: p1Time as Time, value: p1Price },
      { time: p2Time as Time, value: p2Price },
    ]);

    this.drawingSeries.set(drawing.id, series);
  }

  private renderHandlesForDrawing(
    drawing: ChartDrawing,
    selectedDrawingId: string | null,
  ): void {
    this.removeHandles(drawing.id);

    if (drawing.id !== selectedDrawingId) return;
    if (drawing.type !== "trendline") return;

    const series = this.chart.addSeries(
      LineSeries,
      this.handleLineOptions(drawing.style),
    );

    series.setData([
      {
        time: Number(drawing.p1.time) as Time,
        value: Number(drawing.p1.price),
      },
      {
        time: Number(drawing.p2.time) as Time,
        value: Number(drawing.p2.price),
      },
    ]);

    this.handleSeries.set(drawing.id, series);
  }

  private getRenderedTrendlinePoints(drawing: TrendlineDrawing): {
    p1Time: number;
    p1Price: number;
    p2Time: number;
    p2Price: number;
  } {
    const p1Time = Number(drawing.p1.time);
    const p2ActualTime = Number(drawing.p2.time);
    const p1Price = Number(drawing.p1.price);
    const p2ActualPrice = Number(drawing.p2.price);

    if (!drawing.style.extendRight || p1Time === p2ActualTime) {
      return {
        p1Time,
        p1Price,
        p2Time: p2ActualTime,
        p2Price: p2ActualPrice,
      };
    }

    const visibleRange = this.chart.timeScale().getVisibleRange();
    const visibleTo = Number(visibleRange?.to ?? p2ActualTime);
    const finalTime = Math.max(p2ActualTime, visibleTo);

    const p1X = this.chart.timeScale().timeToCoordinate(p1Time as Time);
    const p2X = this.chart.timeScale().timeToCoordinate(p2ActualTime as Time);
    const finalX = this.chart.timeScale().timeToCoordinate(finalTime as Time);
    const p1Y = this.priceSeries.priceToCoordinate(p1Price);
    const p2Y = this.priceSeries.priceToCoordinate(p2ActualPrice);

    // Important: Lightweight Charts draws time using logical bar spacing, not
    // elapsed seconds. Extending by timestamp slope makes the line drift after
    // market gaps / missing bars. Extend using screen coordinates, then convert
    // the final Y back to a price. This keeps the rendered extension passing
    // through the real snapped endpoints.
    if (
      p1X == null ||
      p2X == null ||
      finalX == null ||
      p1Y == null ||
      p2Y == null ||
      p1X === p2X
    ) {
      return {
        p1Time,
        p1Price,
        p2Time: p2ActualTime,
        p2Price: p2ActualPrice,
      };
    }

    const pixelSlope = (p2Y - p1Y) / (p2X - p1X);
    const finalY = p1Y + pixelSlope * (finalX - p1X);
    const finalPrice =
      this.priceSeries.coordinateToPrice(finalY) ?? p2ActualPrice;

    return {
      p1Time,
      p1Price,
      p2Time: finalTime,
      p2Price: finalPrice,
    };
  }
}
