// src/chart/HitTestManager.ts

import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { ChartDrawing, DrawingPoint } from "./DrawingTypes";

export type HitTestResult =
  | { type: "none" }
  | { type: "drawing"; drawingId: string }
  | { type: "handle"; drawingId: string; handle: "start" | "end" };

type PointXY = {
  x: number;
  y: number;
};

function distance(a: PointXY, b: PointXY): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distanceToSegment(point: PointXY, a: PointXY, b: PointXY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (dx === 0 && dy === 0) return distance(point, a);

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)
    )
  );

  return distance(point, {
    x: a.x + t * dx,
    y: a.y + t * dy,
  });
}

export class HitTestManager {
  private chart: IChartApi;
  private priceSeries: ISeriesApi<"Candlestick">;

  constructor(chart: IChartApi, priceSeries: ISeriesApi<"Candlestick">) {
    this.chart = chart;
    this.priceSeries = priceSeries;
  }

  hitTest(
    drawings: ChartDrawing[],
    mouse: PointXY,
    handleRadiusPx = 8,
    lineTolerancePx = 6
  ): HitTestResult {
    for (let i = drawings.length - 1; i >= 0; i--) {
      const drawing = drawings[i];

      if (drawing.type === "trendline") {
        const start = this.toScreenPoint(drawing.p1);
        const end = this.toScreenPoint(drawing.p2);

        if (!start || !end) continue;

        if (distance(mouse, start) <= handleRadiusPx) {
          return { type: "handle", drawingId: drawing.id, handle: "start" };
        }

        if (distance(mouse, end) <= handleRadiusPx) {
          return { type: "handle", drawingId: drawing.id, handle: "end" };
        }

        if (distanceToSegment(mouse, start, end) <= lineTolerancePx) {
          return { type: "drawing", drawingId: drawing.id };
        }
      }

      if (drawing.type === "horizontal") {
        const y = this.priceSeries.priceToCoordinate(drawing.price);
        if (y == null) continue;

        if (Math.abs(mouse.y - y) <= lineTolerancePx) {
          return { type: "drawing", drawingId: drawing.id };
        }
      }
    }

    return { type: "none" };
  }

  private toScreenPoint(point: DrawingPoint): PointXY | null {
    const x = this.chart.timeScale().timeToCoordinate(point.time as Time);
    const y = this.priceSeries.priceToCoordinate(point.price);

    if (x == null || y == null) return null;

    return { x, y };
  }
}