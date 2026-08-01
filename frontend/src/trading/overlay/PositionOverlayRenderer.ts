// src/trading/overlay/PositionOverlayRenderer.ts

import {
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
} from "lightweight-charts";

import type { PositionOverlayState } from "./PositionOverlayTypes";

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function price(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "--";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export class PositionOverlayRenderer {
  private priceSeries: ISeriesApi<"Candlestick">;
  private container: HTMLDivElement;
  private entryLine: IPriceLine | null = null;
  private stopLine: IPriceLine | null = null;
  private targetLines = new Map<string, IPriceLine>();
  private card: HTMLDivElement;
  private state: PositionOverlayState | null = null;

  constructor(
    priceSeries: ISeriesApi<"Candlestick">,
    container: HTMLDivElement,
  ) {
    this.priceSeries = priceSeries;
    this.container = container;

    this.card = document.createElement("div");
    this.card.style.position = "absolute";
    this.card.style.top = "12px";
    this.card.style.right = "76px";
    this.card.style.zIndex = "9";
    this.card.style.minWidth = "178px";
    this.card.style.padding = "10px 12px";
    this.card.style.border = "1px solid rgba(148,163,184,.28)";
    this.card.style.borderRadius = "8px";
    this.card.style.background = "rgba(10,13,17,.90)";
    this.card.style.boxShadow = "0 8px 24px rgba(0,0,0,.28)";
    this.card.style.backdropFilter = "blur(6px)";
    this.card.style.pointerEvents = "none";
    this.card.style.fontFamily =
      "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    this.card.style.display = "none";

    this.container.appendChild(this.card);
  }

  update(state: PositionOverlayState): void {
    this.state = state;

    if (!state.visible) {
      this.clearLines();
      this.card.style.display = "none";
      return;
    }

    this.renderEntry(state);
    this.renderStop(state);
    this.renderTargets(state);
    this.renderCard(state);
  }

  destroy(): void {
    this.clearLines();
    this.card.remove();
    this.state = null;
  }

  private renderEntry(state: PositionOverlayState): void {
    if (state.entryPrice <= 0) {
      if (this.entryLine) {
        this.priceSeries.removePriceLine(this.entryLine);
        this.entryLine = null;
      }
      return;
    }

    const options = {
      price: state.entryPrice,
      color: "#facc15",
      lineWidth: 2 as const,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `${state.kind === "order" ? "ORDER" : "ENTRY"} ${price(state.entryPrice)}`,
    };

    if (this.entryLine) {
      this.entryLine.applyOptions(options);
    } else {
      this.entryLine = this.priceSeries.createPriceLine(options);
    }
  }

  private renderStop(state: PositionOverlayState): void {
    if (state.stopPrice <= 0) {
      if (this.stopLine) {
        this.priceSeries.removePriceLine(this.stopLine);
        this.stopLine = null;
      }
      return;
    }

    const options = {
      price: state.stopPrice,
      color: "#ef4444",
      lineWidth: 2 as const,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `STOP ${price(state.stopPrice)}`,
    };

    if (this.stopLine) {
      this.stopLine.applyOptions(options);
    } else {
      this.stopLine = this.priceSeries.createPriceLine(options);
    }
  }

  private renderTargets(state: PositionOverlayState): void {
    const activeIds = new Set(state.targets.map((target) => target.id));

    for (const [id, line] of this.targetLines) {
      if (activeIds.has(id)) continue;
      this.priceSeries.removePriceLine(line);
      this.targetLines.delete(id);
    }

    for (const target of state.targets) {
      const options = {
        price: target.price,
        color: "#22c55e",
        lineWidth: 2 as const,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${target.label.toUpperCase()} ${price(target.price)}`,
      };

      const existing = this.targetLines.get(target.id);

      if (existing) {
        existing.applyOptions(options);
      } else {
        this.targetLines.set(
          target.id,
          this.priceSeries.createPriceLine(options),
        );
      }
    }
  }

  private renderCard(state: PositionOverlayState): void {
    if (state.kind === "order") {
      const sideLabel = state.side === "long" ? "BUY" : "SELL";

      this.card.style.display = "block";
      this.card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:7px">
          <strong style="font-size:12px;letter-spacing:.08em;color:#f8fafc">${state.symbol} ${sideLabel} ORDER</strong>
          <span style="font-size:10px;text-transform:uppercase;color:#facc15">${state.status}</span>
        </div>
        <div style="font-size:18px;font-weight:800;color:#facc15">${price(state.entryPrice)}</div>
        <div style="height:1px;background:rgba(148,163,184,.18);margin:8px 0"></div>
        <div style="display:grid;grid-template-columns:auto auto;justify-content:space-between;gap:4px 14px;font-size:11px;color:#cbd5e1">
          <span>Shares</span><strong>${state.quantity.toLocaleString()}</strong>
          <span>Status</span><strong>Working</strong>
        </div>
      `;
      return;
    }

    const positive = state.unrealizedPnL >= 0;
    const pnlColor = positive ? "#86efac" : "#fca5a5";
    const sideLabel = state.side === "long" ? "LONG" : "SHORT";

    this.card.style.display = "block";
    this.card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:7px">
        <strong style="font-size:12px;letter-spacing:.08em;color:#f8fafc">${state.symbol} ${sideLabel}</strong>
        <span style="font-size:10px;text-transform:uppercase;color:#94a3b8">${state.status}</span>
      </div>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">
        <strong style="font-size:20px;color:${pnlColor}">${money(state.unrealizedPnL)}</strong>
        <strong style="font-size:14px;color:${pnlColor}">${state.currentR >= 0 ? "+" : ""}${state.currentR.toFixed(2)}R</strong>
      </div>
      <div style="margin-top:3px;font-size:11px;color:${pnlColor}">
        ${state.percentPnL >= 0 ? "+" : ""}${state.percentPnL.toFixed(2)}%
      </div>
      <div style="height:1px;background:rgba(148,163,184,.18);margin:8px 0"></div>
      <div style="display:grid;grid-template-columns:auto auto;justify-content:space-between;gap:4px 14px;font-size:11px;color:#cbd5e1">
        <span>Shares</span><strong>${state.quantity.toLocaleString()}</strong>
        <span>Entry</span><strong>${price(state.entryPrice)}</strong>
        <span>Last</span><strong>${price(state.currentPrice)}</strong>
      </div>
    `;
  }

  private clearLines(): void {
    if (this.entryLine) {
      this.priceSeries.removePriceLine(this.entryLine);
      this.entryLine = null;
    }

    if (this.stopLine) {
      this.priceSeries.removePriceLine(this.stopLine);
      this.stopLine = null;
    }

    for (const line of this.targetLines.values()) {
      this.priceSeries.removePriceLine(line);
    }

    this.targetLines.clear();
  }
}
