// src/trading/overlay/PositionOverlayRenderer.ts

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

/**
 * Informational card only.
 *
 * Interactive entry/stop/target chart lines are owned exclusively by
 * components/chart/PositionOverlayManager. Keeping price-line creation out of
 * this legacy renderer prevents a broker snapshot from drawing a second stale
 * order/entry line while a protected-order replacement is in flight.
 */
export class PositionOverlayRenderer {
  private card: HTMLDivElement;
  private state: PositionOverlayState | null = null;

  constructor(container: HTMLDivElement) {
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

    container.appendChild(this.card);
  }

  update(state: PositionOverlayState): void {
    this.state = state;

    if (!state.visible) {
      this.card.style.display = "none";
      return;
    }

    this.renderCard(state);
  }

  destroy(): void {
    this.card.remove();
    this.state = null;
  }

  private renderCard(state: PositionOverlayState): void {
    if (state.kind === "order") {
      // Working orders are rendered and controlled by PositionOverlayManager.
      // Do not let the legacy renderer re-introduce a second order UI.
      this.card.style.display = "none";
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
}
