// src/components/chart/DrawingEngine.ts

import { type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";

import type {
  ChartDrawing,
  DrawingPoint,
  DrawingPointerEvent,
  DrawingStyle,
  DrawingTool,
  HorizontalLineDrawing,
  RectangleDrawing,
  PriceRangeDrawing,
  LongPositionDrawing,
  TrendlineDrawing,
} from "./DrawingTypes";
import { DEFAULT_DRAWING_STYLE } from "./DrawingTypes";
import { DrawingStore } from "./DrawingStore";
import { DrawingRenderer } from "./DrawingRenderer";
import { DragManager, type DragMode } from "./DragManager";
import { roundToTick } from "../../trading/pricing/TickSizeManager";

type HitResult = { drawingId: string; mode: DragMode } | null;

export type DrawingChangeReason =
  | "workspace"
  | "create"
  | "update"
  | "remove"
  | "clear"
  | "select"
  | "duplicate"
  | "trade-sync";

export type DrawingChangeListener = (
  drawings: ChartDrawing[],
  reason: DrawingChangeReason,
) => void;

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

function cloneTickPoint(point: DrawingPoint): DrawingPoint {
  const price = roundToTick(Number(point.price));

  return {
    ...clonePoint(point),
    price,
    rawPrice: price,
  };
}

function cloneDrawing(drawing: ChartDrawing): ChartDrawing {
  if (drawing.type === "horizontal") {
    return {
      ...drawing,
      style: cloneStyle(drawing.style),
    };
  }

  if (drawing.type === "longPosition") {
    return {
      ...drawing,
      entry: cloneTickPoint(drawing.entry),
      stop: cloneTickPoint(drawing.stop),
      target: cloneTickPoint(drawing.target),
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
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return pointDistance(px, py, x1, y1);
  }

  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)),
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
  private store: DrawingStore;
  private renderer: DrawingRenderer;
  private pendingTrendPoint: DrawingPoint | null = null;
  private selectedDrawingId: string | null = null;
  private drawingChangeListeners = new Set<DrawingChangeListener>();
  private dragManager = new DragManager();
  private redrawFrame: number | null = null;
  private redrawTimer: number | null = null;

  private readonly handleVisibleRangeChange = (): void => {
    this.scheduleRenderAll();
  };

  constructor(
    chart: IChartApi,
    priceSeries: ISeriesApi<"Candlestick">,
    workspace?: { symbol?: string; timeframe?: string },
    container?: HTMLDivElement,
  ) {
    this.chart = chart;
    this.priceSeries = priceSeries;
    this.store = new DrawingStore(
      workspace?.symbol ?? "SPY",
      workspace?.timeframe ?? "5m",
    );
    this.renderer = new DrawingRenderer(chart, priceSeries, container);

    this.chart
      .timeScale()
      .subscribeVisibleLogicalRangeChange(this.handleVisibleRangeChange);
    this.scheduleRenderAll();
  }

  subscribeDrawings(listener: DrawingChangeListener): () => void {
    this.drawingChangeListeners.add(listener);
    listener(this.getDrawings(), "workspace");

    return () => {
      this.drawingChangeListeners.delete(listener);
    };
  }

  private emitDrawingChange(reason: DrawingChangeReason): void {
    const drawings = this.getDrawings();

    for (const listener of this.drawingChangeListeners) {
      listener(drawings, reason);
    }
  }

  setWorkspace(symbol: string, timeframe: string): void {
    this.store.setWorkspace(symbol, timeframe);
    this.pendingTrendPoint = null;
    this.selectedDrawingId = null;
    this.dragManager.endDrag();
    this.renderAll();
    this.emitDrawingChange("workspace");
  }

  destroy(): void {
    this.chart
      .timeScale()
      .unsubscribeVisibleLogicalRangeChange(this.handleVisibleRangeChange);

    if (this.redrawFrame != null) {
      window.cancelAnimationFrame(this.redrawFrame);
      this.redrawFrame = null;
    }

    if (this.redrawTimer != null) {
      window.clearTimeout(this.redrawTimer);
      this.redrawTimer = null;
    }

    this.renderer.clear();
    this.pendingTrendPoint = null;
    this.selectedDrawingId = null;
    this.dragManager.endDrag();
    this.setChartNavigationEnabled(true);
    this.drawingChangeListeners.clear();
  }

  setTool(tool: DrawingTool): void {
    this.activeTool = tool;
    this.pendingTrendPoint = null;
    this.setChartNavigationEnabled(tool === "cursor" || tool === "trendline");
  }

  getTool(): DrawingTool {
    return this.activeTool;
  }

  setDefaultStyle(style: DrawingStyle): void {
    this.defaultStyle = cloneStyle(style);
  }

  getDefaultStyle(): DrawingStyle {
    return cloneStyle(this.defaultStyle);
  }

  createHorizontalAtPoint(
    point: DrawingPoint,
    style: DrawingStyle = this.defaultStyle,
  ): HorizontalLineDrawing {
    const drawing: HorizontalLineDrawing = {
      id: makeId("hline"),
      type: "horizontal",
      price: Number(point.price),
      style: cloneStyle(style),
    };

    this.store.add(drawing);
    this.selectedDrawingId = drawing.id;
    this.renderAll();
    this.emitDrawingChange("create");
    return drawing;
  }

  createRectangleFromPoints(
    p1: DrawingPoint,
    p2: DrawingPoint,
    style: DrawingStyle = this.defaultStyle,
  ): RectangleDrawing | null {
    if (
      Number(p1.time) === Number(p2.time) &&
      Number(p1.price) === Number(p2.price)
    ) {
      return null;
    }

    const drawing: RectangleDrawing = {
      id: makeId("rect"),
      type: "rectangle",
      p1: clonePoint(p1),
      p2: clonePoint(p2),
      style: cloneStyle(style),
      selected: true,
    };

    this.pendingTrendPoint = null;
    this.store.add(drawing);
    this.selectedDrawingId = drawing.id;
    this.renderAll();
    this.scheduleRenderAll();
    this.emitDrawingChange("create");
    return drawing;
  }

  createPriceRangeFromPoints(
    p1: DrawingPoint,
    p2: DrawingPoint,
    style: DrawingStyle = this.defaultStyle,
  ): PriceRangeDrawing | null {
    if (
      Number(p1.time) === Number(p2.time) &&
      Number(p1.price) === Number(p2.price)
    ) {
      return null;
    }

    const drawing: PriceRangeDrawing = {
      id: makeId("priceRange"),
      type: "priceRange",
      p1: clonePoint(p1),
      p2: clonePoint(p2),
      style: cloneStyle(style),
      selected: true,
    };

    this.pendingTrendPoint = null;
    this.store.add(drawing);
    this.selectedDrawingId = drawing.id;
    this.renderAll();
    this.scheduleRenderAll();
    this.emitDrawingChange("create");
    return drawing;
  }

  createLongPositionFromPoints(
    entry: DrawingPoint,
    stop: DrawingPoint,
    target: DrawingPoint,
    style: DrawingStyle = this.defaultStyle,
  ): LongPositionDrawing | null {
    const snappedEntry = cloneTickPoint(entry);
    const snappedStop = cloneTickPoint(stop);
    const snappedTarget = cloneTickPoint(target);

    const entryPrice = Number(snappedEntry.price);
    const stopPrice = Number(snappedStop.price);
    const targetPrice = Number(snappedTarget.price);

    if (
      !Number.isFinite(entryPrice) ||
      !Number.isFinite(stopPrice) ||
      !Number.isFinite(targetPrice) ||
      (entryPrice === stopPrice && entryPrice === targetPrice)
    ) {
      return null;
    }

    const drawing: LongPositionDrawing = {
      id: makeId("longPosition"),
      type: "longPosition",
      tradeId: null,
      entry: snappedEntry,
      stop: snappedStop,
      target: snappedTarget,
      style: cloneStyle(style),
      selected: true,
    };

    this.pendingTrendPoint = null;
    this.store.add(drawing);
    this.selectedDrawingId = drawing.id;
    this.renderAll();
    this.scheduleRenderAll();
    this.emitDrawingChange("create");
    return drawing;
  }

  linkLongPositionToTrade(
    drawingId: string,
    tradeId: string | null,
  ): LongPositionDrawing | null {
    const drawing = this.findDrawing(drawingId);
    if (!drawing || drawing.type !== "longPosition") return null;

    const updated: LongPositionDrawing = {
      ...drawing,
      tradeId,
      entry: clonePoint(drawing.entry),
      stop: clonePoint(drawing.stop),
      target: clonePoint(drawing.target),
      style: cloneStyle(drawing.style),
    };

    this.store.update(updated);
    this.renderAll();
    this.emitDrawingChange("update");
    return cloneDrawing(updated) as LongPositionDrawing;
  }

  updateLongPositionFromTrade(params: {
    tradeId: string;
    entry?: number | null;
    stop?: number | null;
    target?: number | null;
  }): LongPositionDrawing | null {
    const drawing = this.store
      .getAll()
      .find((item): item is LongPositionDrawing => {
        return item.type === "longPosition" && item.tradeId === params.tradeId;
      });

    if (!drawing) return null;

    const updated: LongPositionDrawing = {
      ...drawing,
      entry: clonePoint(drawing.entry),
      stop: clonePoint(drawing.stop),
      target: clonePoint(drawing.target),
      style: cloneStyle(drawing.style),
    };

    if (params.entry != null && Number.isFinite(Number(params.entry))) {
      const price = roundToTick(Number(params.entry));
      updated.entry.price = price;
      updated.entry.rawPrice = price;
    }

    if (params.stop != null && Number.isFinite(Number(params.stop))) {
      const price = roundToTick(Number(params.stop));
      updated.stop.price = price;
      updated.stop.rawPrice = price;
    }

    if (params.target != null && Number.isFinite(Number(params.target))) {
      const price = roundToTick(Number(params.target));
      updated.target.price = price;
      updated.target.rawPrice = price;
    }

    this.store.update(updated);
    this.renderAll();
    this.emitDrawingChange("trade-sync");
    return cloneDrawing(updated) as LongPositionDrawing;
  }

  createTrendlineFromPoints(
    p1: DrawingPoint,
    p2: DrawingPoint,
    style: DrawingStyle = this.defaultStyle,
  ): TrendlineDrawing | null {
    if (
      Number(p1.time) === Number(p2.time) &&
      Number(p1.price) === Number(p2.price)
    ) {
      return null;
    }

    const drawing: TrendlineDrawing = {
      id: makeId("trend"),
      type: "trendline",
      p1: clonePoint(p1),
      p2: clonePoint(p2),
      style: cloneStyle(style),
      selected: true,
    };

    this.pendingTrendPoint = null;
    this.store.add(drawing);
    this.selectedDrawingId = drawing.id;
    this.renderAll();
    this.emitDrawingChange("create");
    return drawing;
  }

  cancelPendingDrawing(): void {
    this.pendingTrendPoint = null;
  }

  handleClick(point: DrawingPoint): ChartDrawing | null {
    if (this.activeTool === "horizontal") {
      return this.createHorizontalAtPoint(point);
    }

    // Legacy fallback only. The new interaction path owns trendline clicks in
    // interaction/tools/TrendlineTool.ts. Keeping this fallback prevents older
    // callers from breaking while the remaining tools migrate.
    if (this.activeTool === "trendline") {
      if (!this.pendingTrendPoint) {
        this.pendingTrendPoint = clonePoint(point);
        return null;
      }

      return this.createTrendlineFromPoints(this.pendingTrendPoint, point);
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

    const normalized =
      updated.type === "longPosition"
        ? {
            ...updated,
            entry: cloneTickPoint(updated.entry),
            stop: cloneTickPoint(updated.stop),
            target: cloneTickPoint(updated.target),
          }
        : updated;

    this.store.update(normalized);
    this.renderDrawing(normalized);
    this.emitDrawingChange("update");
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
    this.emitDrawingChange("clear");
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
    this.emitDrawingChange("select");
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
    cloned.id = makeId(
      source.type === "horizontal"
        ? "hline"
        : source.type === "rectangle"
          ? "rect"
          : source.type === "priceRange"
            ? "priceRange"
            : source.type === "longPosition"
              ? "longPosition"
              : "trend",
    );

    if (
      cloned.type === "trendline" ||
      cloned.type === "rectangle" ||
      cloned.type === "priceRange" ||
      cloned.type === "longPosition"
    ) {
      cloned.selected = true;
    }

    this.store.add(cloned);
    this.selectedDrawingId = cloned.id;
    this.renderAll();
    this.emitDrawingChange("duplicate");
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
    this.emitDrawingChange("remove");
  }

  private renderAll(): void {
    this.renderer.renderAll(this.store.getAll(), this.selectedDrawingId);
  }

  private scheduleRenderAll(): void {
    if (this.redrawFrame != null) {
      window.cancelAnimationFrame(this.redrawFrame);
    }

    this.redrawFrame = window.requestAnimationFrame(() => {
      this.redrawFrame = null;
      this.renderAll();
    });

    if (this.redrawTimer != null) {
      window.clearTimeout(this.redrawTimer);
    }

    // On refresh, Lightweight Charts may not have coordinates ready on the
    // first frame. This second pass makes extended lines recalculate after
    // the chart has settled.
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = null;
      this.renderAll();
    }, 80);
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

      if (drawing.type === "rectangle" || drawing.type === "priceRange") {
        const hit = this.hitTestRectangle(drawing, x, y);
        if (hit) return hit;
      }

      if (drawing.type === "longPosition") {
        const hit = this.hitTestLongPosition(drawing, x, y);
        if (hit) return hit;
      }
    }

    return null;
  }

  private hitTestTrendline(
    drawing: TrendlineDrawing,
    x: number,
    y: number,
  ): HitResult {
    const p1x = this.chart
      .timeScale()
      .timeToCoordinate(Number(drawing.p1.time) as Time);
    const p1y = this.priceSeries.priceToCoordinate(Number(drawing.p1.price));
    const p2x = this.chart
      .timeScale()
      .timeToCoordinate(Number(drawing.p2.time) as Time);
    const p2y = this.priceSeries.priceToCoordinate(Number(drawing.p2.price));

    if (p1x == null || p1y == null || p2x == null || p2y == null) return null;

    if (pointDistance(x, y, p1x, p1y) <= 12) {
      return { drawingId: drawing.id, mode: "p1" };
    }

    if (pointDistance(x, y, p2x, p2y) <= 12) {
      return { drawingId: drawing.id, mode: "p2" };
    }

    const rendered = this.getRenderedTrendlinePoints(drawing);
    const r1x = this.chart
      .timeScale()
      .timeToCoordinate(rendered.p1Time as Time);
    const r1y = this.priceSeries.priceToCoordinate(rendered.p1Price);
    const r2x = this.chart
      .timeScale()
      .timeToCoordinate(rendered.p2Time as Time);
    const r2y = this.priceSeries.priceToCoordinate(rendered.p2Price);

    if (r1x == null || r1y == null || r2x == null || r2y == null) return null;

    if (distanceToSegment(x, y, r1x, r1y, r2x, r2y) <= 8) {
      return { drawingId: drawing.id, mode: "line" };
    }

    return null;
  }

  private hitTestRectangle(
    drawing: RectangleDrawing | PriceRangeDrawing,
    x: number,
    y: number,
  ): HitResult {
    const p1x = this.chart
      .timeScale()
      .timeToCoordinate(Number(drawing.p1.time) as Time);
    const p2x = this.chart
      .timeScale()
      .timeToCoordinate(Number(drawing.p2.time) as Time);
    const p1y = this.priceSeries.priceToCoordinate(Number(drawing.p1.price));
    const p2y = this.priceSeries.priceToCoordinate(Number(drawing.p2.price));

    if (p1x == null || p2x == null || p1y == null || p2y == null) return null;

    const left = Math.min(p1x, p2x);
    const right = Math.max(p1x, p2x);
    const top = Math.min(p1y, p2y);
    const bottom = Math.max(p1y, p2y);
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;
    const handleTolerance = 12;
    const edgeTolerance = 8;

    const handles: Array<{ x: number; y: number; mode: DragMode }> = [
      { x: left, y: top, mode: "rectangle-nw" },
      { x: midX, y: top, mode: "rectangle-n" },
      { x: right, y: top, mode: "rectangle-ne" },
      { x: right, y: midY, mode: "rectangle-e" },
      { x: right, y: bottom, mode: "rectangle-se" },
      { x: midX, y: bottom, mode: "rectangle-s" },
      { x: left, y: bottom, mode: "rectangle-sw" },
      { x: left, y: midY, mode: "rectangle-w" },
    ];

    for (const handle of handles) {
      if (pointDistance(x, y, handle.x, handle.y) <= handleTolerance) {
        return { drawingId: drawing.id, mode: handle.mode };
      }
    }

    const onLeft =
      Math.abs(x - left) <= edgeTolerance &&
      y >= top - edgeTolerance &&
      y <= bottom + edgeTolerance;
    const onRight =
      Math.abs(x - right) <= edgeTolerance &&
      y >= top - edgeTolerance &&
      y <= bottom + edgeTolerance;
    const onTop =
      Math.abs(y - top) <= edgeTolerance &&
      x >= left - edgeTolerance &&
      x <= right + edgeTolerance;
    const onBottom =
      Math.abs(y - bottom) <= edgeTolerance &&
      x >= left - edgeTolerance &&
      x <= right + edgeTolerance;
    const inside = x > left && x < right && y > top && y < bottom;

    if (onLeft) return { drawingId: drawing.id, mode: "rectangle-w" };
    if (onRight) return { drawingId: drawing.id, mode: "rectangle-e" };
    if (onTop) return { drawingId: drawing.id, mode: "rectangle-n" };
    if (onBottom) return { drawingId: drawing.id, mode: "rectangle-s" };

    if (inside) {
      return { drawingId: drawing.id, mode: "rectangle" };
    }

    return null;
  }

  private hitTestLongPosition(
    drawing: LongPositionDrawing,
    x: number,
    y: number,
  ): HitResult {
    const entryX = this.chart
      .timeScale()
      .timeToCoordinate(Number(drawing.entry.time) as Time);
    const stopX = this.chart
      .timeScale()
      .timeToCoordinate(Number(drawing.stop.time) as Time);
    const targetX = this.chart
      .timeScale()
      .timeToCoordinate(Number(drawing.target.time) as Time);
    const entryY = this.priceSeries.priceToCoordinate(
      Number(drawing.entry.price),
    );
    const stopY = this.priceSeries.priceToCoordinate(
      Number(drawing.stop.price),
    );
    const targetY = this.priceSeries.priceToCoordinate(
      Number(drawing.target.price),
    );

    if (
      entryX == null ||
      stopX == null ||
      targetX == null ||
      entryY == null ||
      stopY == null ||
      targetY == null
    ) {
      return null;
    }

    const left = Math.min(entryX, stopX, targetX);
    const right = Math.max(entryX, stopX, targetX);
    const top = Math.min(entryY, stopY, targetY);
    const bottom = Math.max(entryY, stopY, targetY);
    const levelTolerance = 8;

    if (
      Math.abs(y - entryY) <= levelTolerance &&
      x >= left - 8 &&
      x <= right + 8
    ) {
      return { drawingId: drawing.id, mode: "long-entry" };
    }

    if (
      Math.abs(y - stopY) <= levelTolerance &&
      x >= left - 8 &&
      x <= right + 8
    ) {
      return { drawingId: drawing.id, mode: "long-stop" };
    }

    if (
      Math.abs(y - targetY) <= levelTolerance &&
      x >= left - 8 &&
      x <= right + 8
    ) {
      return { drawingId: drawing.id, mode: "long-target" };
    }

    const inside = x >= left && x <= right && y >= top && y <= bottom;
    if (inside) {
      return { drawingId: drawing.id, mode: "long-position" };
    }

    return null;
  }

  private hitTestHorizontal(
    drawing: HorizontalLineDrawing,
    _x: number,
    y: number,
  ): HitResult {
    const lineY = this.priceSeries.priceToCoordinate(drawing.price);
    if (lineY == null) return null;

    if (Math.abs(y - lineY) <= 8) {
      return { drawingId: drawing.id, mode: "horizontal" };
    }

    return null;
  }
}