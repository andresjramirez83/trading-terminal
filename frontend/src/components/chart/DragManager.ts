// src/components/chart/DragManager.ts

import type {
  ChartDrawing,
  DrawingPoint,
  DrawingPointerEvent,
  HorizontalLineDrawing,
  RectangleDrawing,
  PriceRangeDrawing,
  FibonacciDrawing,
  LongPositionDrawing,
  TrendlineDrawing,
  MarketStructureDrawing,
  MarketStructureNode,
} from "./DrawingTypes";

export type DragMode =
  | "p1"
  | "p2"
  | "line"
  | "horizontal"
  | "rectangle"
  | "rectangle-nw"
  | "rectangle-n"
  | "rectangle-ne"
  | "rectangle-e"
  | "rectangle-se"
  | "rectangle-s"
  | "rectangle-sw"
  | "rectangle-w"
  | "long-position"
  | "long-entry"
  | "long-stop"
  | "long-target"
  | "market-structure"
  | `market-node-${number}`;

export type DragState = {
  drawingId: string;
  mode: DragMode;
  startPoint: DrawingPointerEvent;
  original: ChartDrawing;
};

type RectangleLikeDrawing = RectangleDrawing | PriceRangeDrawing;

type RectangleBounds = {
  leftTime: number;
  rightTime: number;
  topPrice: number;
  bottomPrice: number;
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

function cloneMarketStructureNode(
  node: MarketStructureNode,
): MarketStructureNode {
  return {
    ...clonePoint(node),
    classification: node.classification,
  };
}

function cloneDrawing(drawing: ChartDrawing): ChartDrawing {
  if (drawing.type === "horizontal") {
    return {
      ...drawing,
      style: { ...drawing.style },
    };
  }

  if (drawing.type === "longPosition") {
    return {
      ...drawing,
      entry: clonePoint(drawing.entry),
      stop: clonePoint(drawing.stop),
      target: clonePoint(drawing.target),
      style: { ...drawing.style },
    };
  }

  if (drawing.type === "marketStructure") {
    return {
      ...drawing,
      nodes: drawing.nodes.map(cloneMarketStructureNode),
      style: { ...drawing.style },
      selectedNodeIndex: drawing.selectedNodeIndex ?? null,
    };
  }

  return {
    ...drawing,
    p1: clonePoint(drawing.p1),
    p2: clonePoint(drawing.p2),
    style: { ...drawing.style },
  };
}

function getPointPrice(point: DrawingPointerEvent): number {
  return Number(point.rawPrice ?? point.price);
}

function getRectangleBounds(drawing: RectangleLikeDrawing): RectangleBounds {
  const p1Time = Number(drawing.p1.time);
  const p2Time = Number(drawing.p2.time);
  const p1Price = Number(drawing.p1.price);
  const p2Price = Number(drawing.p2.price);

  return {
    leftTime: Math.min(p1Time, p2Time),
    rightTime: Math.max(p1Time, p2Time),
    topPrice: Math.max(p1Price, p2Price),
    bottomPrice: Math.min(p1Price, p2Price),
  };
}

function buildRectangleFromBounds(
  drawing: RectangleLikeDrawing,
  bounds: RectangleBounds,
): RectangleLikeDrawing {
  return {
    ...drawing,
    p1: {
      ...drawing.p1,
      time: bounds.leftTime,
      price: bounds.topPrice,
      rawPrice: bounds.topPrice,
    },
    p2: {
      ...drawing.p2,
      time: bounds.rightTime,
      price: bounds.bottomPrice,
      rawPrice: bounds.bottomPrice,
    },
    style: { ...drawing.style },
  };
}

function parseMarketNodeIndex(mode: DragMode): number | null {
  if (!mode.startsWith("market-node-")) return null;

  const index = Number(mode.slice("market-node-".length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export class DragManager {
  private dragState: DragState | null = null;

  beginDrag(
    drawing: ChartDrawing,
    mode: DragMode,
    startPoint: DrawingPointerEvent,
  ): void {
    this.dragState = {
      drawingId: drawing.id,
      mode,
      startPoint: { ...startPoint },
      original: cloneDrawing(drawing),
    };
  }

  updateDrag(
    drawing: ChartDrawing,
    point: DrawingPointerEvent,
  ): ChartDrawing | null {
    if (!this.dragState) return null;
    if (drawing.id !== this.dragState.drawingId) return null;

    if (drawing.type === "trendline") {
      return this.dragTrendline(drawing, point);
    }

    if (drawing.type === "marketStructure") {
      return this.dragMarketStructure(drawing, point);
    }

    if (drawing.type === "horizontal") {
      return this.dragHorizontalLine(drawing, point);
    }

    if (drawing.type === "rectangle" || drawing.type === "priceRange") {
      return this.dragRectangle(drawing, point);
    }

    if (drawing.type === "fibonacci") {
      return this.dragFibonacci(drawing, point);
    }

    if (drawing.type === "longPosition") {
      return this.dragLongPosition(drawing, point);
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
    point: DrawingPointerEvent,
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

    const deltaTime =
      Number(point.time) - Number(this.dragState.startPoint.time);
    const startPrice = Number(
      this.dragState.startPoint.rawPrice ?? this.dragState.startPoint.price,
    );
    const currentPrice = getPointPrice(point);
    const deltaPrice = currentPrice - startPrice;

    updated.p1 = {
      ...original.p1,
      time: Number(original.p1.time) + deltaTime,
      price: Number(original.p1.price) + deltaPrice,
      rawPrice: Number(original.p1.price) + deltaPrice,
    };

    updated.p2 = {
      ...original.p2,
      time: Number(original.p2.time) + deltaTime,
      price: Number(original.p2.price) + deltaPrice,
      rawPrice: Number(original.p2.price) + deltaPrice,
    };

    return updated;
  }

  private dragFibonacci(
    drawing: FibonacciDrawing,
    point: DrawingPointerEvent,
  ): FibonacciDrawing | null {
    if (!this.dragState) return null;
    if (this.dragState.original.type !== "fibonacci") return null;

    const original = this.dragState.original;
    const updated: FibonacciDrawing = {
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

    if (this.dragState.mode !== "line") return null;

    const deltaTime = Number(point.time) - Number(this.dragState.startPoint.time);
    const startPrice = Number(
      this.dragState.startPoint.rawPrice ?? this.dragState.startPoint.price,
    );
    const currentPrice = getPointPrice(point);
    const deltaPrice = currentPrice - startPrice;

    updated.p1 = {
      ...original.p1,
      time: Number(original.p1.time) + deltaTime,
      price: Number(original.p1.price) + deltaPrice,
      rawPrice: Number(original.p1.price) + deltaPrice,
    };
    updated.p2 = {
      ...original.p2,
      time: Number(original.p2.time) + deltaTime,
      price: Number(original.p2.price) + deltaPrice,
      rawPrice: Number(original.p2.price) + deltaPrice,
    };

    return updated;
  }

  private dragMarketStructure(
    drawing: MarketStructureDrawing,
    point: DrawingPointerEvent,
  ): MarketStructureDrawing | null {
    if (!this.dragState) return null;
    if (this.dragState.original.type !== "marketStructure") return null;

    const original = this.dragState.original;
    const nodeIndex = parseMarketNodeIndex(this.dragState.mode);

    if (nodeIndex != null) {
      if (nodeIndex >= original.nodes.length) return null;

      const nodes = original.nodes.map(cloneMarketStructureNode);
      nodes[nodeIndex] = {
        ...cloneMarketStructureNode(nodes[nodeIndex]),
        ...clonePoint(point),
        classification: nodes[nodeIndex].classification,
      };

      return {
        ...drawing,
        nodes,
        selected: true,
        selectedNodeIndex: nodeIndex,
        style: { ...drawing.style },
      };
    }

    if (this.dragState.mode !== "market-structure") return null;

    const deltaTime =
      Number(point.time) - Number(this.dragState.startPoint.time);
    const startPrice = Number(
      this.dragState.startPoint.rawPrice ?? this.dragState.startPoint.price,
    );
    const currentPrice = getPointPrice(point);
    const deltaPrice = currentPrice - startPrice;

    const nodes = original.nodes.map((node) => ({
      ...cloneMarketStructureNode(node),
      time: Number(node.time) + deltaTime,
      price: Number(node.price) + deltaPrice,
      rawPrice: Number(node.price) + deltaPrice,
    }));

    return {
      ...drawing,
      nodes,
      selected: true,
      selectedNodeIndex: null,
      style: { ...drawing.style },
    };
  }

  private dragHorizontalLine(
    drawing: HorizontalLineDrawing,
    point: DrawingPointerEvent,
  ): HorizontalLineDrawing | null {
    return {
      ...drawing,
      price: getPointPrice(point),
      style: { ...drawing.style },
    };
  }

  private dragRectangle(
    drawing: RectangleLikeDrawing,
    point: DrawingPointerEvent,
  ): RectangleLikeDrawing | null {
    if (!this.dragState) return null;
    if (
      this.dragState.original.type !== "rectangle" &&
      this.dragState.original.type !== "priceRange"
    ) {
      return null;
    }

    const original = this.dragState.original;
    const mode = this.dragState.mode;
    const currentTime = Number(point.time);
    const currentPrice = getPointPrice(point);

    if (mode === "rectangle") {
      const deltaTime = currentTime - Number(this.dragState.startPoint.time);
      const startPrice = Number(
        this.dragState.startPoint.rawPrice ?? this.dragState.startPoint.price,
      );
      const deltaPrice = currentPrice - startPrice;

      return {
        ...drawing,
        p1: {
          ...original.p1,
          time: Number(original.p1.time) + deltaTime,
          price: Number(original.p1.price) + deltaPrice,
          rawPrice: Number(original.p1.price) + deltaPrice,
        },
        p2: {
          ...original.p2,
          time: Number(original.p2.time) + deltaTime,
          price: Number(original.p2.price) + deltaPrice,
          rawPrice: Number(original.p2.price) + deltaPrice,
        },
        style: { ...drawing.style },
      };
    }

    const bounds = getRectangleBounds(original);
    const nextBounds: RectangleBounds = { ...bounds };

    if (
      mode === "rectangle-nw" ||
      mode === "rectangle-w" ||
      mode === "rectangle-sw"
    ) {
      nextBounds.leftTime = currentTime;
    }

    if (
      mode === "rectangle-ne" ||
      mode === "rectangle-e" ||
      mode === "rectangle-se"
    ) {
      nextBounds.rightTime = currentTime;
    }

    if (
      mode === "rectangle-nw" ||
      mode === "rectangle-n" ||
      mode === "rectangle-ne"
    ) {
      nextBounds.topPrice = currentPrice;
    }

    if (
      mode === "rectangle-sw" ||
      mode === "rectangle-s" ||
      mode === "rectangle-se"
    ) {
      nextBounds.bottomPrice = currentPrice;
    }

    return buildRectangleFromBounds(drawing, nextBounds);
  }

  private dragLongPosition(
    drawing: LongPositionDrawing,
    point: DrawingPointerEvent,
  ): LongPositionDrawing | null {
    if (!this.dragState) return null;
    if (this.dragState.original.type !== "longPosition") return null;

    const original = this.dragState.original;
    const mode = this.dragState.mode;
    const currentPrice = getPointPrice(point);

    if (mode === "long-entry") {
      return {
        ...drawing,
        entry: {
          ...drawing.entry,
          time: Number(point.time),
          price: currentPrice,
          rawPrice: currentPrice,
        },
        style: { ...drawing.style },
      };
    }

    if (mode === "long-stop") {
      return {
        ...drawing,
        stop: {
          ...drawing.stop,
          time: Number(point.time),
          price: currentPrice,
          rawPrice: currentPrice,
        },
        style: { ...drawing.style },
      };
    }

    if (mode === "long-target") {
      return {
        ...drawing,
        target: {
          ...drawing.target,
          time: Number(point.time),
          price: currentPrice,
          rawPrice: currentPrice,
        },
        style: { ...drawing.style },
      };
    }

    if (mode !== "long-position") return null;

    const deltaTime =
      Number(point.time) - Number(this.dragState.startPoint.time);
    const startPrice = Number(
      this.dragState.startPoint.rawPrice ?? this.dragState.startPoint.price,
    );
    const deltaPrice = currentPrice - startPrice;

    return {
      ...drawing,
      entry: {
        ...original.entry,
        time: Number(original.entry.time) + deltaTime,
        price: Number(original.entry.price) + deltaPrice,
        rawPrice: Number(original.entry.price) + deltaPrice,
      },
      stop: {
        ...original.stop,
        time: Number(original.stop.time) + deltaTime,
        price: Number(original.stop.price) + deltaPrice,
        rawPrice: Number(original.stop.price) + deltaPrice,
      },
      target: {
        ...original.target,
        time: Number(original.target.time) + deltaTime,
        price: Number(original.target.price) + deltaPrice,
        rawPrice: Number(original.target.price) + deltaPrice,
      },
      style: { ...drawing.style },
    };
  }
}