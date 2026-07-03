// src/components/ChartPanelV2/DragManager.ts

import type {
  ChartDrawing,
  DrawingPoint,
  DrawingPointerEvent,
  HorizontalLineDrawing,
  TrendlineDrawing,
} from "./DrawingTypes";

export type DragMode = "p1" | "p2" | "line" | "horizontal";

export type DragState = {
  drawingId: string;
  mode: DragMode;
  startPoint: DrawingPointerEvent;
  original: ChartDrawing;
};

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
      style: { ...drawing.style },
    };
  }

  return {
    ...drawing,
    p1: clonePoint(drawing.p1),
    p2: clonePoint(drawing.p2),
    style: { ...drawing.style },
  };
}

export class DragManager {
  private dragState: DragState | null = null;

  beginDrag(
    drawing: ChartDrawing,
    mode: DragMode,
    startPoint: DrawingPointerEvent
  ): void {
    this.dragState = {
      drawingId: drawing.id,
      mode,
      startPoint: { ...startPoint },
      original: cloneDrawing(drawing),
    };
  }

  updateDrag(drawing: ChartDrawing, point: DrawingPointerEvent): ChartDrawing | null {
    if (!this.dragState) return null;
    if (drawing.id !== this.dragState.drawingId) return null;

    if (drawing.type === "trendline") {
      return this.dragTrendline(drawing, point);
    }

    if (drawing.type === "horizontal") {
      return this.dragHorizontalLine(drawing, point);
    }

    return null;
  }

  endDrag(): boolean {
    if (!this.dragState) return false;
    this.dragState = null;
    return true;
  }

  isDragging(): boolean {
    return this.dragState !== null;
  }

  getDrawingId(): string | null {
    return this.dragState?.drawingId ?? null;
  }

  private dragTrendline(
    drawing: TrendlineDrawing,
    point: DrawingPointerEvent
  ): TrendlineDrawing | null {
    if (!this.dragState) return null;
    if (this.dragState.original.type !== "trendline") return null;

    const original = this.dragState.original;
    const updated: TrendlineDrawing = {
      ...drawing,
      p1: clonePoint(drawing.p1),
      p2: clonePoint(drawing.p2),
      style: { ...drawing.style },
    };

    if (this.dragState.mode === "p1") {
      updated.p1 = clonePoint(point);
      return updated;
    }

    if (this.dragState.mode === "p2") {
      updated.p2 = clonePoint(point);
      return updated;
    }

    const deltaTime = Number(point.time) - Number(this.dragState.startPoint.time);
    const startPrice = Number(
      this.dragState.startPoint.rawPrice ?? this.dragState.startPoint.price
    );
    const currentPrice = Number(point.rawPrice ?? point.price);
    const deltaPrice = currentPrice - startPrice;

    updated.p1 = {
      ...original.p1,
      time: Number(original.p1.time) + deltaTime,
      price: Number(original.p1.price) + deltaPrice,
    };

    updated.p2 = {
      ...original.p2,
      time: Number(original.p2.time) + deltaTime,
      price: Number(original.p2.price) + deltaPrice,
    };

    return updated;
  }

  private dragHorizontalLine(
    drawing: HorizontalLineDrawing,
    point: DrawingPointerEvent
  ): HorizontalLineDrawing | null {
    return {
      ...drawing,
      price: Number(point.rawPrice ?? point.price),
      style: { ...drawing.style },
    };
  }
}
