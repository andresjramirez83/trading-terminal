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
export type DraggablePositionOverlayLevel = "entry" | "stop" | "target";

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
  entryIsLive?: boolean;
  entryOrderId?: string | null;
};

export type PositionOverlayCommit = {
  symbol: string;
  level: DraggablePositionOverlayLevel;
  price: number;
  orderId: string | null;
  isLive: boolean;
};

export type PositionOverlayManagerOptions = {
  container?: HTMLDivElement;
  hitTolerancePx?: number;
  onCommit?: (
    change: PositionOverlayCommit,
  ) => void | boolean | Promise<void | boolean>;
  onDragStateChange?: (
    dragging: boolean,
    level: DraggablePositionOverlayLevel | null,
  ) => void;
  onCancelOrder?: (orderId: string) => void | boolean | Promise<void | boolean>;
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

type PendingPrice = {
  price: number;
  expiresAt: number;
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
  private readonly onCancelOrder?: PositionOverlayManagerOptions["onCancelOrder"];

  private entryLine: IPriceLine | null = null;
  private stopLine: IPriceLine | null = null;
  private targetLine: IPriceLine | null = null;
  private rewardShade: HTMLDivElement | null = null;
  private riskShade: HTMLDivElement | null = null;
  private orderControls: HTMLDivElement | null = null;
  private animationFrame: number | null = null;
  private activeDrag: ActiveDrag | null = null;
  private committing = false;
  private pendingPrices: Partial<Record<DraggablePositionOverlayLevel, PendingPrice>> = {};

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
    entryIsLive: false,
    entryOrderId: null,
  };

  constructor(
    priceSeries: CandleSeriesApi,
    options: PositionOverlayManagerOptions = {},
  ) {
    this.priceSeries = priceSeries;
    this.hitTolerancePx = Math.max(8, options.hitTolerancePx ?? 14);
    this.onCommit = options.onCommit;
    this.onDragStateChange = options.onDragStateChange;
    this.onCancelOrder = options.onCancelOrder;

    if (options.container) {
      this.rewardShade = this.createShade(options.container, "rgba(34,197,94,.14)");
      this.riskShade = this.createShade(options.container, "rgba(239,68,68,.14)");
      this.orderControls = this.createOrderControls(options.container);
      this.startShadeLoop();
    }
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

    this.applyPendingPrices(next);

    if (this.activeDrag) {
      next[this.activeDrag.level] = this.activeDrag.previewPrice;
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

  updateWorkingOrder(order: {
    id: string;
    symbol: string;
    entry: number;
    stop: number;
    target: number;
    stopOrderId?: string | null;
    targetOrderId?: string | null;
  } | null): void {
    if (!order || safePrice(order.entry) <= 0) {
      this.update(null);
      return;
    }

    const next: PositionOverlaySnapshot = {
      symbol: cleanSymbol(order.symbol),
      hasPosition: true,
      entry: safePrice(order.entry),
      stop: safePrice(order.stop),
      target: safePrice(order.target),
      stopIsLive: Boolean(order.stopOrderId),
      targetIsLive: Boolean(order.targetOrderId),
      stopOrderId: order.stopOrderId ?? null,
      targetOrderId: order.targetOrderId ?? null,
      entryIsLive: true,
      entryOrderId: order.id,
    };

    this.applyPendingPrices(next);

    if (this.activeDrag) {
      next[this.activeDrag.level] = this.activeDrag.previewPrice;
    }

    this.snapshot = next;
    this.render();
  }

  hitTest(y: number): DraggablePositionOverlayLevel | null {
    if (!this.snapshot.hasPosition || this.committing) return null;

    const candidates: Array<{
      level: DraggablePositionOverlayLevel;
      price: number;
    }> = [
      ...(this.snapshot.entryIsLive
        ? [{ level: "entry" as const, price: this.snapshot.entry }]
        : []),
      ...(this.snapshot.stopOrderId || !this.snapshot.entryIsLive
        ? [{ level: "stop" as const, price: this.snapshot.stop }]
        : []),
      ...(this.snapshot.targetOrderId || !this.snapshot.entryIsLive
        ? [{ level: "target" as const, price: this.snapshot.target }]
        : []),
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

    const originalPrice = this.snapshot[level];

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

    this.snapshot = { ...this.snapshot, [this.activeDrag.level]: roundedPrice };

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
        level === "entry"
          ? this.snapshot.entryOrderId ?? null
          : level === "stop"
          ? this.snapshot.stopOrderId
          : this.snapshot.targetOrderId,
      isLive:
        level === "entry"
          ? Boolean(this.snapshot.entryIsLive)
          : level === "stop"
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
      if (accepted) {
        this.pendingPrices[level] = {
          price,
          // Alpaca replaces an order asynchronously and may return one or two
          // stale open-order snapshots before the replacement is visible.
          // Keep the confirmed replacement price on screen during that window.
          expiresAt: Date.now() + 30_000,
        };
      }
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
    this.hideShades();
  }

  destroy(): void {
    this.cancelDrag();
    this.clear();
    if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.rewardShade?.remove();
    this.riskShade?.remove();
    this.orderControls?.remove();
    this.rewardShade = null;
    this.riskShade = null;
    this.orderControls = null;

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
      entryIsLive: false,
      entryOrderId: null,
    };
  }

  private restorePrice(
    level: DraggablePositionOverlayLevel,
    price: number,
  ): void {
    this.snapshot = { ...this.snapshot, [level]: price };
  }

  private applyPendingPrices(snapshot: PositionOverlaySnapshot): void {
    const now = Date.now();

    for (const level of ["entry", "stop", "target"] as const) {
      const pending = this.pendingPrices[level];
      if (!pending) continue;

      if (Math.abs(snapshot[level] - pending.price) < 0.000001) {
        delete this.pendingPrices[level];
      } else if (now < pending.expiresAt) {
        snapshot[level] = pending.price;
      } else {
        delete this.pendingPrices[level];
      }
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

    this.renderShades();
  }

  private buildEntryDefinition(
    snapshot: PositionOverlaySnapshot,
  ): OverlayLineDefinition | null {
    if (snapshot.entry <= 0) return null;

    return {
      level: "entry",
      price: snapshot.entry,
      title: `${this.activeDrag?.level === "entry" ? "MOVE ORDER" : snapshot.entryIsLive ? "ORDER" : "ENTRY"} ${formatPrice(snapshot.entry)}`,
      color: this.activeDrag?.level === "entry" ? DRAG_COLOR : snapshot.entryIsLive ? "#facc15" : ENTRY_COLOR,
      lineStyle: this.activeDrag?.level === "entry" ? LineStyle.Dotted : LineStyle.Solid,
      lineWidth: this.activeDrag?.level === "entry" ? 3 : 2,
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
      title: `${dragging ? "MOVE STOP" : snapshot.entryIsLive ? "STOP" : snapshot.stopIsLive ? "LIVE STOP" : "LOCAL STOP"} ${formatPrice(
        snapshot.stop,
      )}`,
      color: dragging
        ? DRAG_COLOR
        : snapshot.entryIsLive
          ? LIVE_STOP_COLOR
        : snapshot.stopIsLive
          ? LIVE_STOP_COLOR
          : LOCAL_STOP_COLOR,
      lineStyle: dragging
        ? LineStyle.Dotted
        : snapshot.entryIsLive
          ? LineStyle.Dashed
        : snapshot.stopIsLive
          ? LineStyle.Solid
          : LineStyle.Dashed,
      lineWidth: dragging ? 3 : snapshot.entryIsLive || snapshot.stopIsLive ? 2 : 1,
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
      title: `${dragging ? "MOVE TARGET" : snapshot.entryIsLive ? "TARGET" : snapshot.targetIsLive ? "LIVE TARGET" : "LOCAL TARGET"} ${formatPrice(
        snapshot.target,
      )}`,
      color: dragging
        ? DRAG_COLOR
        : snapshot.entryIsLive
          ? LIVE_TARGET_COLOR
        : snapshot.targetIsLive
          ? LIVE_TARGET_COLOR
          : LOCAL_TARGET_COLOR,
      lineStyle: dragging
        ? LineStyle.Dotted
        : snapshot.entryIsLive
          ? LineStyle.Dashed
        : snapshot.targetIsLive
          ? LineStyle.Solid
          : LineStyle.Dashed,
      lineWidth: dragging ? 3 : snapshot.entryIsLive || snapshot.targetIsLive ? 2 : 1,
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

  private createShade(container: HTMLDivElement, color: string): HTMLDivElement {
    const shade = document.createElement("div");
    shade.style.position = "absolute";
    shade.style.left = "0";
    shade.style.right = "64px";
    shade.style.background = color;
    shade.style.pointerEvents = "none";
    shade.style.zIndex = "2";
    shade.style.display = "none";
    container.appendChild(shade);
    return shade;
  }

  private startShadeLoop(): void {
    const frame = () => {
      this.renderShades();
      this.animationFrame = requestAnimationFrame(frame);
    };
    this.animationFrame = requestAnimationFrame(frame);
  }

  private renderShades(): void {
    if (!this.snapshot.hasPosition || this.snapshot.entry <= 0) {
      this.hideShades();
      return;
    }

    this.placeShade(this.rewardShade, this.snapshot.entry, this.snapshot.target);
    this.placeShade(this.riskShade, this.snapshot.entry, this.snapshot.stop);
    this.placeOrderControls();
  }

  private placeShade(shade: HTMLDivElement | null, first: number, second: number): void {
    if (!shade || first <= 0 || second <= 0) {
      if (shade) shade.style.display = "none";
      return;
    }

    const firstY = this.priceSeries.priceToCoordinate(first);
    const secondY = this.priceSeries.priceToCoordinate(second);
    if (firstY == null || secondY == null) {
      shade.style.display = "none";
      return;
    }

    shade.style.top = `${Math.min(firstY, secondY)}px`;
    shade.style.height = `${Math.max(1, Math.abs(secondY - firstY))}px`;
    shade.style.display = "block";
  }

  private hideShades(): void {
    if (this.rewardShade) this.rewardShade.style.display = "none";
    if (this.riskShade) this.riskShade.style.display = "none";
    if (this.orderControls) this.orderControls.style.display = "none";
  }

  private createOrderControls(container: HTMLDivElement): HTMLDivElement {
    const controls = document.createElement("div");
    controls.dataset.positionOrderControls = "true";
    controls.style.position = "absolute";
    controls.style.right = "70px";
    controls.style.zIndex = "12";
    controls.style.display = "none";
    controls.style.alignItems = "center";
    controls.style.gap = "4px";
    controls.style.transform = "translateY(-50%)";
    controls.style.pointerEvents = "auto";

    const drag = document.createElement("button");
    drag.type = "button";
    drag.textContent = "↕ Drag order";
    drag.title = "Drag to change the working order price";
    drag.style.cssText = "height:24px;padding:0 8px;border:1px solid #facc15;border-radius:4px;background:#29220a;color:#fde047;font:600 11px Inter,system-ui;cursor:ns-resize";
    drag.addEventListener("pointerdown", (event) => {
      if (!this.snapshot.entryIsLive || this.committing) return;
      const y = this.priceSeries.priceToCoordinate(this.snapshot.entry);
      if (y == null || !this.beginDrag(y)) return;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.title = "Cancel this working order";
    cancel.style.cssText = "height:24px;padding:0 8px;border:1px solid #ef4444;border-radius:4px;background:#301315;color:#fca5a5;font:700 11px Inter,system-ui;cursor:pointer";
    cancel.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    cancel.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const orderId = this.snapshot.entryOrderId;
      if (!this.snapshot.entryIsLive || !orderId || !this.onCancelOrder) return;
      cancel.disabled = true;
      cancel.textContent = "Canceling…";
      try {
        const result = await this.onCancelOrder(orderId);
        if (result !== false) this.clear();
      } finally {
        cancel.disabled = false;
        cancel.textContent = "Cancel";
      }
    });

    controls.append(drag, cancel);
    container.appendChild(controls);
    return controls;
  }

  private placeOrderControls(): void {
    const controls = this.orderControls;
    if (!controls || !this.snapshot.entryIsLive || !this.snapshot.entryOrderId) {
      if (controls) controls.style.display = "none";
      return;
    }

    const y = this.priceSeries.priceToCoordinate(this.snapshot.entry);
    if (y == null) {
      controls.style.display = "none";
      return;
    }

    controls.style.top = `${y}px`;
    controls.style.display = "flex";
  }
}
