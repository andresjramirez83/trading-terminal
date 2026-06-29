// src/components/ChartPanelV2/DrawingEngine.ts

import {
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

import type {
  ChartDrawing,
  DrawingPoint,
  DrawingPointerEvent,
  DrawingStyle,
  DrawingTool,
  HorizontalLineDrawing,
  TrendlineDrawing,
} from "./DrawingTypes";
import { DEFAULT_DRAWING_STYLE } from "./DrawingTypes";
import { DrawingStore } from "./DrawingStore";
import { DrawingRenderer } from "./DrawingRenderer";
import { DragManager, type DragMode } from "./DragManager";


type HitResult =
  | { drawingId: string; mode: DragMode }
  | null;

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneStyle(style: DrawingStyle): DrawingStyle {
  return {
    color: style.color,
    width: style.width,
    extendRight: style.extendRight,
  };
}

function clonePoint(point: DrawingPoint): DrawingPoint {
  return {
    time: Number(point.time),
    price: Number(point.price),
    rawPrice: point.rawPrice,
    x: point.x,
    y: point.y,
    snappedTo: point.snappedTo ?? null,
    bar: point.bar ?? null,
  };
}

function cloneDrawing(drawing: ChartDrawing): ChartDrawing {
  if (drawing.type === "horizontal") {
    return {
      ...drawing,
      style: cloneStyle(drawing.style),
    };
  }

  return {
    ...drawing,
    p1: clonePoint(drawing.p1),
    p2: clonePoint(drawing.p2),
    style: cloneStyle(drawing.style),
  };
}

function pointDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}

function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return pointDistance(px, py, x1, y1);
  }

  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))
  );

  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;

  return pointDistance(px, py, closestX, closestY);
}

export class DrawingEngine {
  private chart: IChartApi;
  private priceSeries: ISeriesApi<"Candlestick">;
  private activeTool: DrawingTool = "cursor";
  private defaultStyle: DrawingStyle = cloneStyle(DEFAULT_DRAWING_STYLE);
  private store = new DrawingStore();
  private renderer: DrawingRenderer;
  private pendingTrendPoint: DrawingPoint | null = null;
  private selectedDrawingId: string | null = null;
  private dragManager = new DragManager();

  constructor(chart: IChartApi, priceSeries: ISeriesApi<"Candlestick">) {
    this.chart = chart;
    this.priceSeries = priceSeries;
    this.renderer = new DrawingRenderer(chart, priceSeries);
  }

  setTool(tool: DrawingTool): void {
    this.activeTool = tool;
    this.pendingTrendPoint = null;
    this.setChartNavigationEnabled(tool === "cursor");
  }

  getTool(): DrawingTool {
    return this.activeTool;
  }

  setDefaultStyle(style: DrawingStyle): void {
    this.defaultStyle = cloneStyle(style);
  }

  handleClick(point: DrawingPoint): ChartDrawing | null {
    if (this.activeTool === "horizontal") {
      const drawing: HorizontalLineDrawing = {
        id: makeId("hline"),
        type: "horizontal",
        price: point.price,
        style: cloneStyle(this.defaultStyle),
      };

      this.store.add(drawing);
      this.selectedDrawingId = drawing.id;
      this.renderAll();
      return drawing;
    }

    if (this.activeTool === "trendline") {
      if (!this.pendingTrendPoint) {
        this.pendingTrendPoint = clonePoint(point);
        return null;
      }

      const drawing: TrendlineDrawing = {
        id: makeId("trend"),
        type: "trendline",
        p1: clonePoint(this.pendingTrendPoint),
        p2: clonePoint(point),
        style: cloneStyle(this.defaultStyle),
        selected: true,
      };

      this.pendingTrendPoint = null;
      this.store.add(drawing);
      this.selectedDrawingId = drawing.id;
      this.renderAll();
      return drawing;
    }

    return null;
  }

  handlePointerDown(point: DrawingPointerEvent): boolean {
    if (this.activeTool !== "cursor" && this.activeTool !== "eraser") {
      return false;
    }

    const hit = this.hitTestAt(point);

    if (this.activeTool === "eraser") {
      if (hit) {
        this.removeDrawing(hit.drawingId);
        return true;
      }
      return false;
    }

    if (!hit) {
      this.selectedDrawingId = null;
      this.renderAll();
      return false;
    }

    const drawing = this.findDrawing(hit.drawingId);
    if (!drawing) return false;

    this.selectedDrawingId = hit.drawingId;
    this.dragManager.beginDrag(drawing, hit.mode, point);

    this.setChartNavigationEnabled(false);
    this.renderAll();
    return true;
  }

  handlePointerMove(point: DrawingPointerEvent): boolean {
    const drawingId = this.dragManager.getDrawingId();
    if (!drawingId) return false;

    const drawing = this.findDrawing(drawingId);
    if (!drawing) return false;

    const updated = this.dragManager.updateDrag(drawing, point);
    if (!updated) return false;

    this.store.update(updated);
    this.renderDrawing(updated);
    return true;
  }

  handlePointerUp(_point?: DrawingPointerEvent): boolean {
    const ended = this.dragManager.endDrag();
    if (!ended) return false;

    this.setChartNavigationEnabled(true);
    return true;
  }

  clear(): void {
    this.renderer.clear();
    this.store.clear();
    this.pendingTrendPoint = null;
    this.selectedDrawingId = null;
    this.dragManager.endDrag();
    this.setChartNavigationEnabled(true);
  }

  getDrawings(): ChartDrawing[] {
    return this.store.getAll().map(cloneDrawing);
  }


  selectDrawing(id: string | null): void {
    this.selectedDrawingId = id;
    this.renderAll();
  }

  getSelectedDrawingId(): string | null {
    return this.selectedDrawingId;
  }

  removeSelectedDrawing(): boolean {
    if (!this.selectedDrawingId) return false;

    this.removeDrawing(this.selectedDrawingId);
    return true;
  }

  duplicateSelectedDrawing(): ChartDrawing | null {
    if (!this.selectedDrawingId) return null;

    const source = this.findDrawing(this.selectedDrawingId);
    if (!source) return null;

    const cloned = cloneDrawing(source);
    cloned.id = makeId(source.type === "horizontal" ? "hline" : "trend");

    if (cloned.type === "trendline") {
      cloned.selected = true;
    }

    this.store.add(cloned);
    this.selectedDrawingId = cloned.id;
    this.renderAll();
    return cloneDrawing(cloned);
  }

  private setChartNavigationEnabled(enabled: boolean): void {
    this.chart.applyOptions({
      handleScroll: enabled,
      handleScale: enabled,
    });
  }

  private findDrawing(id: string): ChartDrawing | null {
    return this.store.get(id) ?? null;
  }

  removeDrawing(id: string): void {
    this.renderer.removeDrawing(id);
    this.store.remove(id);
    if (this.selectedDrawingId === id) this.selectedDrawingId = null;
  }

  private renderAll(): void {
    this.renderer.renderAll(this.store.getAll(), this.selectedDrawingId);
  }

  private renderDrawing(drawing: ChartDrawing): void {
    this.renderer.renderDrawing(drawing, this.selectedDrawingId);
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

  hitTestAt(point: DrawingPointerEvent): HitResult {
    const x = Number(point.x);
    const y = Number(point.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const drawings = this.store.getAll();

    for (let i = drawings.length - 1; i >= 0; i -= 1) {
      const drawing = drawings[i];

      if (drawing.type === "trendline") {
        const hit = this.hitTestTrendline(drawing, x, y);
        if (hit) return hit;
      }

      if (drawing.type === "horizontal") {
        const hit = this.hitTestHorizontal(drawing, x, y);
        if (hit) return hit;
      }
    }

    return null;
  }

  private hitTestTrendline(
    drawing: TrendlineDrawing,
    x: number,
    y: number
  ): HitResult {
    const p1x = this.chart.timeScale().timeToCoordinate(Number(drawing.p1.time) as Time);
    const p1y = this.priceSeries.priceToCoordinate(Number(drawing.p1.price));
    const p2x = this.chart.timeScale().timeToCoordinate(Number(drawing.p2.time) as Time);
    const p2y = this.priceSeries.priceToCoordinate(Number(drawing.p2.price));

    if (p1x == null || p1y == null || p2x == null || p2y == null) return null;

    if (pointDistance(x, y, p1x, p1y) <= 12) {
      return { drawingId: drawing.id, mode: "p1" };
    }

    if (pointDistance(x, y, p2x, p2y) <= 12) {
      return { drawingId: drawing.id, mode: "p2" };
    }

    const rendered = this.getRenderedTrendlinePoints(drawing);
    const r1x = this.chart.timeScale().timeToCoordinate(rendered.p1Time as Time);
    const r1y = this.priceSeries.priceToCoordinate(rendered.p1Price);
    const r2x = this.chart.timeScale().timeToCoordinate(rendered.p2Time as Time);
    const r2y = this.priceSeries.priceToCoordinate(rendered.p2Price);

    if (r1x == null || r1y == null || r2x == null || r2y == null) return null;

    if (distanceToSegment(x, y, r1x, r1y, r2x, r2y) <= 8) {
      return { drawingId: drawing.id, mode: "line" };
    }

    return null;
  }

  private hitTestHorizontal(
    drawing: HorizontalLineDrawing,
    _x: number,
    y: number
  ): HitResult {
    const lineY = this.priceSeries.priceToCoordinate(drawing.price);
    if (lineY == null) return null;

    if (Math.abs(y - lineY) <= 8) {
      return { drawingId: drawing.id, mode: "horizontal" };
    }

    return null;
  }
}
