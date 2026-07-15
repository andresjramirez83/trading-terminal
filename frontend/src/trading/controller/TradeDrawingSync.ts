// src/trading/controller/TradeDrawingSync.ts

import { DrawingEngine } from "../../components/chart/DrawingEngine";
import { TradeEngine } from "../engine/TradeEngine";
import type { TradeEvent } from "../engine/TradeEvents";
import type { TradeObject } from "../engine/TradeTypes";

function positivePrice(value: unknown): number | null {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

function getPrimaryTarget(trade: TradeObject): number | null {
  return positivePrice(trade.targets[0]?.price);
}

export class TradeDrawingSync {
  private unsubscribeTrades: (() => void) | null = null;
  private syncing = false;

  constructor(
    private readonly drawingEngine: DrawingEngine,
    private readonly tradeEngine: TradeEngine,
  ) {}

  attach(): void {
    if (this.unsubscribeTrades) return;

    this.unsubscribeTrades = this.tradeEngine.events.subscribe((event) => {
      if (this.syncing) return;
      this.handleTradeEvent(event);
    });
  }

  detach(): void {
    this.unsubscribeTrades?.();
    this.unsubscribeTrades = null;
  }

  private handleTradeEvent(event: TradeEvent): void {
    if (event.type === "trade-created" || event.type === "trade-updated") {
      this.syncTradeToDrawing(event);
      return;
    }

    if (event.type === "trade-selected") {
      this.selectLinkedDrawing(event);
      return;
    }

    if (event.type === "trade-deleted") {
      this.removeLinkedDrawing(event);
      return;
    }

    if (event.type === "registry-reset") {
      this.syncing = true;
      try {
        this.drawingEngine.selectDrawing(null);
      } finally {
        this.syncing = false;
      }
    }
  }

  private syncTradeToDrawing(event: TradeEvent): void {
    const trade = event.trade;
    if (!trade) return;

    const entry = positivePrice(trade.entry);
    const stop = positivePrice(trade.stop);
    const target = getPrimaryTarget(trade);

    // Do not invent missing prices while the user is still filling in the
    // Trade Plan. Creation begins only after all three levels are valid.
    if (entry == null || stop == null || target == null) return;

    this.syncing = true;

    try {
      if (trade.links.drawingId) {
        const updatedDrawing =
          this.drawingEngine.updateLongPositionFromTrade({
            tradeId: trade.id,
            entry,
            stop,
            target,
          });

        if (updatedDrawing) {
          return;
        }
      }

      // This DrawingEngine does not expose createLongPositionFromTrade().
      // A Trade Engine event must also never create a second drawing after the
      // user completes a chart-created Long Position.
      //
      // Chart-created drawings are linked by ChartTradeBridge. When a trade
      // has no valid drawing link, leave the chart unchanged.
      return;
    } finally {
      this.syncing = false;
    }
  }

  private selectLinkedDrawing(event: TradeEvent): void {
    const trade = event.trade;
    const drawingId = trade?.links.drawingId;

    // Do not clear a valid chart selection merely because a newly-created or
    // temporarily edited trade has not received its drawing link yet.
    if (!drawingId) return;

    this.syncing = true;
    try {
      this.drawingEngine.selectDrawing(drawingId);
    } finally {
      this.syncing = false;
    }
  }

  private removeLinkedDrawing(event: TradeEvent): void {
    const drawingId = event.previousTrade?.links.drawingId;
    if (!drawingId) return;

    this.syncing = true;
    try {
      this.drawingEngine.removeDrawing(drawingId);
    } finally {
      this.syncing = false;
    }
  }
}