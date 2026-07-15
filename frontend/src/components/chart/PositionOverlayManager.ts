// src/components/chart/PositionOverlayManager.ts

import {
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
} from "lightweight-charts";

import type { PositionProtectionState } from "../../trading/position/PositionProtectionEngine";
import { roundToTick } from "../../trading/pricing/TickSizeManager";

type CandleSeriesApi = ISeriesApi<"Candlestick">;

export type PositionOverlayLevel = "entry" | "stop" | "target";
export type DraggablePositionOverlayLevel = "stop" | "target";

export type PositionOverlaySnapshot = {
  symbol: string;
  hasPosition: boolean;
  entry: number;
  stop: number;
  target: number;
  stopIsLive: boolean;
  targetIsLive: boolean;
  stopOrderId: string | null;
  targetOrderId: string | null;
};

export type PositionOverlayCommit = {
  symbol: string;
  level: DraggablePositionOverlayLevel;
  price: number;
  orderId: string | null;
  isLive: boolean;
};

export type PositionOverlayManagerOptions = {
  hitTolerancePx?: number;
  onCommit?: (
    change: PositionOverlayCommit,
  ) => void | boolean | Promise<void | boolean>;
  onDragStateChange?: (
    dragging: boolean,
    level: DraggablePositionOverlayLevel | null,
  ) => void;
};

type OverlayLineDefinition = {
  level: PositionOverlayLevel;
  price: number;
  title: string;
  color: string;
  lineStyle: LineStyle;
  lineWidth: 1 | 2 | 3 | 4;
};

type ActiveDrag = {
  level: DraggablePositionOverlayLevel;
  originalPrice: number;
  previewPrice: number;
};

const ENTRY_COLOR = "#60a5fa";
const LIVE_STOP_COLOR = "#ef4444";
const LOCAL_STOP_COLOR = "#f59e0b";
const LIVE_TARGET_COLOR = "#22c55e";
const LOCAL_TARGET_COLOR = "#eab308";
const DRAG_COLOR = "#f8fafc";

function safePrice(value: unknown): number {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function cleanSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (Math.abs(value) >= 100) return value.toFixed(2);
  if (Math.abs(value) >= 10) return value.toFixed(3);
  return value.toFixed(4);
}

function buildSnapshot(
  protection: PositionProtectionState | null,
): PositionOverlaySnapshot {
  if (!protection || protection.position.shares <= 0) {
    return {
      symbol: cleanSymbol(protection?.symbol),
      hasPosition: false,
      entry: 0,
      stop: 0,
      target: 0,
      stopIsLive: false,
      targetIsLive: false,
      stopOrderId: null,
      targetOrderId: null,
    };
  }

  return {
    symbol: cleanSymbol(protection.symbol),
    hasPosition: true,
    entry: safePrice(protection.position.entry),
    stop: safePrice(protection.stopPrice || protection.position.stop),
    target: safePrice(protection.targetPrice || protection.position.target),
    stopIsLive: Boolean(protection.stopOrderId),
    targetIsLive: Boolean(protection.targetOrderId),
    stopOrderId: protection.stopOrderId ?? null,
    targetOrderId: protection.targetOrderId ?? null,
  };
}

export class PositionOverlayManager {
  private readonly priceSeries: CandleSeriesApi;
  private readonly hitTolerancePx: number;
  private readonly onCommit?: PositionOverlayManagerOptions["onCommit"];
  private readonly onDragStateChange?: PositionOverlayManagerOptions["onDragStateChange"];

  private entryLine: IPriceLine | null = null;
  private stopLine: IPriceLine | null = null;
  private targetLine: IPriceLine | null = null;
  private activeDrag: ActiveDrag | null = null;
  private committing = false;

  private snapshot: PositionOverlaySnapshot = {
    symbol: "",
    hasPosition: false,
    entry: 0,
    stop: 0,
    target: 0,
    stopIsLive: false,
    targetIsLive: false,
    stopOrderId: null,
    targetOrderId: null,
  };

  constructor(
    priceSeries: CandleSeriesApi,
    options: PositionOverlayManagerOptions = {},
  ) {
    this.priceSeries = priceSeries;
    this.hitTolerancePx = Math.max(4, options.hitTolerancePx ?? 8);
    this.onCommit = options.onCommit;
    this.onDragStateChange = options.onDragStateChange;
  }

  getSnapshot(): PositionOverlaySnapshot {
    return { ...this.snapshot };
  }

  isDragging(): boolean {
    return this.activeDrag !== null;
  }

  getDraggingLevel(): DraggablePositionOverlayLevel | null {
    return this.activeDrag?.level ?? null;
  }

  update(protection: PositionProtectionState | null): void {
    const next = buildSnapshot(protection);

    if (this.activeDrag) {
      if (this.activeDrag.level === "stop") {
        next.stop = this.activeDrag.previewPrice;
      } else {
        next.target = this.activeDrag.previewPrice;
      }
    }

    this.snapshot = next;

    if (!next.hasPosition) {
      this.cancelDrag();
      this.clear();
      this.snapshot = next;
      return;
    }

    this.render();
  }

  hitTest(y: number): DraggablePositionOverlayLevel | null {
    if (!this.snapshot.hasPosition || this.committing) return null;

    const candidates: Array<{
      level: DraggablePositionOverlayLevel;
      price: number;
    }> = [
      { level: "stop", price: this.snapshot.stop },
      { level: "target", price: this.snapshot.target },
    ];

    let best:
      | {
          level: DraggablePositionOverlayLevel;
          distance: number;
        }
      | undefined;

    for (const candidate of candidates) {
      if (candidate.price <= 0) continue;

      const coordinate = this.priceSeries.priceToCoordinate(candidate.price);
      if (coordinate == null) continue;

      const distance = Math.abs(coordinate - y);
      if (distance > this.hitTolerancePx) continue;

      if (!best || distance < best.distance) {
        best = {
          level: candidate.level,
          distance,
        };
      }
    }

    return best?.level ?? null;
  }

  beginDrag(y: number): boolean {
    if (this.activeDrag || this.committing) return false;

    const level = this.hitTest(y);
    if (!level) return false;

    const originalPrice =
      level === "stop" ? this.snapshot.stop : this.snapshot.target;

    if (originalPrice <= 0) return false;

    this.activeDrag = {
      level,
      originalPrice,
      previewPrice: originalPrice,
    };

    this.onDragStateChange?.(true, level);
    this.render();
    return true;
  }

  moveDrag(y: number): boolean {
    if (!this.activeDrag || this.committing) return false;

    const price = this.priceSeries.coordinateToPrice(y);
    const roundedPrice = roundToTick(safePrice(price));

    if (roundedPrice <= 0) return false;

    this.activeDrag.previewPrice = roundedPrice;

    if (this.activeDrag.level === "stop") {
      this.snapshot = {
        ...this.snapshot,
        stop: roundedPrice,
      };
    } else {
      this.snapshot = {
        ...this.snapshot,
        target: roundedPrice,
      };
    }

    this.render();
    return true;
  }

  async endDrag(): Promise<boolean> {
    if (!this.activeDrag || this.committing) return false;

    const drag = this.activeDrag;
    const level = drag.level;
    const price = drag.previewPrice;

    const change: PositionOverlayCommit = {
      symbol: this.snapshot.symbol,
      level,
      price,
      orderId:
        level === "stop"
          ? this.snapshot.stopOrderId
          : this.snapshot.targetOrderId,
      isLive:
        level === "stop"
          ? this.snapshot.stopIsLive
          : this.snapshot.targetIsLive,
    };

    this.committing = true;
    this.activeDrag = null;
    this.onDragStateChange?.(false, null);

    try {
      const result = await this.onCommit?.(change);
      const accepted = result !== false;

      this.restorePrice(level, accepted ? price : drag.originalPrice);
      return accepted;
    } catch (error) {
      console.error("[PositionOverlayManager] drag commit failed", error);
      this.restorePrice(level, drag.originalPrice);
      return false;
    } finally {
      this.committing = false;
      this.render();
    }
  }

  cancelDrag(): void {
    if (!this.activeDrag) return;

    const drag = this.activeDrag;
    this.activeDrag = null;
    this.restorePrice(drag.level, drag.originalPrice);
    this.onDragStateChange?.(false, null);
    this.render();
  }

  clear(): void {
    this.entryLine = this.removeLine(this.entryLine);
    this.stopLine = this.removeLine(this.stopLine);
    this.targetLine = this.removeLine(this.targetLine);
  }

  destroy(): void {
    this.cancelDrag();
    this.clear();

    this.snapshot = {
      symbol: "",
      hasPosition: false,
      entry: 0,
      stop: 0,
      target: 0,
      stopIsLive: false,
      targetIsLive: false,
      stopOrderId: null,
      targetOrderId: null,
    };
  }

  private restorePrice(
    level: DraggablePositionOverlayLevel,
    price: number,
  ): void {
    if (level === "stop") {
      this.snapshot = {
        ...this.snapshot,
        stop: price,
      };
    } else {
      this.snapshot = {
        ...this.snapshot,
        target: price,
      };
    }
  }

  private render(): void {
    this.entryLine = this.syncLine(
      this.entryLine,
      this.buildEntryDefinition(this.snapshot),
    );

    this.stopLine = this.syncLine(
      this.stopLine,
      this.buildStopDefinition(this.snapshot),
    );

    this.targetLine = this.syncLine(
      this.targetLine,
      this.buildTargetDefinition(this.snapshot),
    );
  }

  private buildEntryDefinition(
    snapshot: PositionOverlaySnapshot,
  ): OverlayLineDefinition | null {
    if (snapshot.entry <= 0) return null;

    return {
      level: "entry",
      price: snapshot.entry,
      title: `ENTRY ${formatPrice(snapshot.entry)}`,
      color: ENTRY_COLOR,
      lineStyle: LineStyle.Solid,
      lineWidth: 2,
    };
  }

  private buildStopDefinition(
    snapshot: PositionOverlaySnapshot,
  ): OverlayLineDefinition | null {
    if (snapshot.stop <= 0) return null;

    const dragging = this.activeDrag?.level === "stop";

    return {
      level: "stop",
      price: snapshot.stop,
      title: `${dragging ? "MOVE STOP" : snapshot.stopIsLive ? "LIVE STOP" : "LOCAL STOP"} ${formatPrice(
        snapshot.stop,
      )}`,
      color: dragging
        ? DRAG_COLOR
        : snapshot.stopIsLive
          ? LIVE_STOP_COLOR
          : LOCAL_STOP_COLOR,
      lineStyle: dragging
        ? LineStyle.Dotted
        : snapshot.stopIsLive
          ? LineStyle.Solid
          : LineStyle.Dashed,
      lineWidth: dragging ? 3 : snapshot.stopIsLive ? 2 : 1,
    };
  }

  private buildTargetDefinition(
    snapshot: PositionOverlaySnapshot,
  ): OverlayLineDefinition | null {
    if (snapshot.target <= 0) return null;

    const dragging = this.activeDrag?.level === "target";

    return {
      level: "target",
      price: snapshot.target,
      title: `${dragging ? "MOVE TARGET" : snapshot.targetIsLive ? "LIVE TARGET" : "LOCAL TARGET"} ${formatPrice(
        snapshot.target,
      )}`,
      color: dragging
        ? DRAG_COLOR
        : snapshot.targetIsLive
          ? LIVE_TARGET_COLOR
          : LOCAL_TARGET_COLOR,
      lineStyle: dragging
        ? LineStyle.Dotted
        : snapshot.targetIsLive
          ? LineStyle.Solid
          : LineStyle.Dashed,
      lineWidth: dragging ? 3 : snapshot.targetIsLive ? 2 : 1,
    };
  }

  private syncLine(
    currentLine: IPriceLine | null,
    definition: OverlayLineDefinition | null,
  ): IPriceLine | null {
    if (!definition) {
      return this.removeLine(currentLine);
    }

    const options = {
      price: definition.price,
      color: definition.color,
      lineWidth: definition.lineWidth,
      lineStyle: definition.lineStyle,
      axisLabelVisible: true,
      title: definition.title,
    };

    if (currentLine) {
      currentLine.applyOptions(options);
      return currentLine;
    }

    return this.priceSeries.createPriceLine(options);
  }

  private removeLine(line: IPriceLine | null): null {
    if (line) {
      try {
        this.priceSeries.removePriceLine(line);
      } catch {
        // The chart or series may already be disposing. Treat removal as done.
      }
    }

    return null;
  }
}