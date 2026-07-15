// src/trading/controller/ChartTradeBridge.ts

import { DrawingEngine } from "../../components/chart/DrawingEngine";
import {
  CHART_TOOL_COMPLETED_EVENT,
  type ChartToolCompletionEvent,
} from "../../components/chart/interaction/ChartTool";
import type {
  ChartDrawing,
  LongPositionDrawing,
} from "../../components/chart/DrawingTypes";
import { TradeEngine } from "../engine/TradeEngine";

function isLongPosition(drawing: ChartDrawing): drawing is LongPositionDrawing {
  return drawing.type === "longPosition";
}

function getNewestLongPosition(
  drawings: ChartDrawing[],
): LongPositionDrawing | null {
  for (let index = drawings.length - 1; index >= 0; index -= 1) {
    const drawing = drawings[index];
    if (isLongPosition(drawing)) return drawing;
  }

  return null;
}

function getSelectedLongPosition(
  drawings: ChartDrawing[],
  selectedDrawingId: string | null,
): LongPositionDrawing | null {
  if (!selectedDrawingId) return null;

  const drawing = drawings.find((item) => item.id === selectedDrawingId);
  return drawing && isLongPosition(drawing) ? drawing : null;
}

function getActiveLongPosition(
  drawings: ChartDrawing[],
  selectedDrawingId: string | null,
): LongPositionDrawing | null {
  return (
    getSelectedLongPosition(drawings, selectedDrawingId) ??
    getNewestLongPosition(drawings)
  );
}

function finiteNumber(value: unknown): number | null {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function targetPrice(drawing: LongPositionDrawing): number | null {
  return finiteNumber(drawing.target.price);
}

export class ChartTradeBridge {
  private unsubscribeDrawings: (() => void) | null = null;
  private listeningForToolCompletion = false;
  private syncing = false;
  private lastDrawingIds = new Set<string>();

  private readonly handleToolCompletedEvent = (event: Event): void => {
    const completion = (event as CustomEvent<ChartToolCompletionEvent>).detail;
    if (!completion || completion.toolId !== "long-position") return;

    const drawingId = completion.payload?.drawingId;
    if (typeof drawingId !== "string" || drawingId.length === 0) return;

    this.handleLongPositionCompleted(drawingId);
  };

  constructor(
    private readonly drawingEngine: DrawingEngine,
    private readonly tradeEngine: TradeEngine,
  ) {}

  attach(): void {
    if (this.unsubscribeDrawings) return;

    window.addEventListener(
      CHART_TOOL_COMPLETED_EVENT,
      this.handleToolCompletedEvent,
    );
    this.listeningForToolCompletion = true;

    this.unsubscribeDrawings = this.drawingEngine.subscribeDrawings(
      (drawings, reason) => {
        if (this.syncing) return;

        this.syncing = true;
        try {
          this.handleDrawingsChanged(drawings, reason);
        } finally {
          this.syncing = false;
        }
      },
    );
  }

  detach(): void {
    this.unsubscribeDrawings?.();
    this.unsubscribeDrawings = null;

    if (this.listeningForToolCompletion) {
      window.removeEventListener(
        CHART_TOOL_COMPLETED_EVENT,
        this.handleToolCompletedEvent,
      );
      this.listeningForToolCompletion = false;
    }

    this.lastDrawingIds.clear();
  }

  runMuted(action: () => void): void {
    this.syncing = true;
    try {
      action();
    } finally {
      this.syncing = false;
    }
  }

  private handleLongPositionCompleted(drawingId: string): void {
    const drawing = this.drawingEngine
      .getDrawings()
      .find(
        (item): item is LongPositionDrawing =>
          item.id === drawingId && isLongPosition(item),
      );

    if (!drawing) return;

    const tradeId = this.syncLongPositionToTrade(drawing);
    if (!tradeId) return;

    this.drawingEngine.selectDrawing(drawing.id);

    // Publish one final selected-trade event after the drawing has its tradeId
    // and the trade has all three completed prices. The Plan Trade hook listens
    // to this event and updates immediately.
    queueMicrotask(() => {
      const latestTrade = this.tradeEngine.getTrade(tradeId);
      if (!latestTrade) return;

      this.tradeEngine.selectTrade(latestTrade.id);
    });

    this.lastDrawingIds = new Set(
      this.drawingEngine.getDrawings().map((item) => item.id),
    );
  }

  private handleDrawingsChanged(
    drawings: ChartDrawing[],
    reason: string,
  ): void {
    if (reason === "trade-sync") {
      this.lastDrawingIds = new Set(drawings.map((drawing) => drawing.id));
      return;
    }

    if (reason === "select") {
      this.selectActiveTradeFromDrawing();
      this.lastDrawingIds = new Set(drawings.map((drawing) => drawing.id));
      return;
    }

    if (reason === "clear" || drawings.length === 0) {
      this.lastDrawingIds.clear();
      this.tradeEngine.selectTrade(null);
      return;
    }

    if (reason === "remove") {
      this.deleteTradesForRemovedDrawings(drawings);
    }

    if (reason === "duplicate") {
      this.handleDuplicatedLongPosition(drawings);
      this.lastDrawingIds = new Set(
        this.drawingEngine.getDrawings().map((drawing) => drawing.id),
      );
      return;
    }

    // On create, synchronize only the newly-created/selected Long Position.
    // Synchronizing every stored drawing can select an older trade and overwrite
    // the Plan Trade card immediately after the user completes a new drawing.
    if (reason === "create") {
      const selectedDrawingId = this.drawingEngine.getSelectedDrawingId();
      const createdDrawing =
        getSelectedLongPosition(drawings, selectedDrawingId) ??
        drawings.find(
          (drawing): drawing is LongPositionDrawing =>
            isLongPosition(drawing) && !this.lastDrawingIds.has(drawing.id),
        ) ??
        null;

      if (createdDrawing) {
        const tradeId = this.syncLongPositionToTrade(createdDrawing);
        if (tradeId) {
          this.tradeEngine.selectTrade(tradeId);
        }
      }

      this.lastDrawingIds = new Set(
        this.drawingEngine.getDrawings().map((drawing) => drawing.id),
      );
      return;
    }

    for (const drawing of drawings) {
      if (isLongPosition(drawing)) {
        this.syncLongPositionToTrade(drawing);
      }
    }

    this.selectActiveTradeFromDrawing();
    this.lastDrawingIds = new Set(
      this.drawingEngine.getDrawings().map((drawing) => drawing.id),
    );
  }

  private syncLongPositionToTrade(
    drawing: LongPositionDrawing,
  ): string | null {
    const entry = finiteNumber(drawing.entry.price);
    const stop = finiteNumber(drawing.stop.price);
    const target = targetPrice(drawing);

    if (entry == null || stop == null || target == null) {
      return drawing.tradeId ?? null;
    }

    if (drawing.tradeId) {
      const existingTrade = this.tradeEngine.getTrade(drawing.tradeId);

      if (existingTrade) {
        const currentTarget = finiteNumber(existingTrade.targets[0]?.price);

        this.tradeEngine.updateTrade(existingTrade.id, {
          entry,
          stop,
          direction: "long",
          links: {
            ...existingTrade.links,
            drawingId: drawing.id,
          },
        });

        if (currentTarget !== target) {
          this.tradeEngine.updateTarget(existingTrade.id, target);
        }

        return existingTrade.id;
      }
    }

    const workspace = this.tradeEngine.getWorkspace();
    const trade = this.tradeEngine.createTrade({
      symbol: workspace.symbol ?? "SPY",
      timeframe: workspace.timeframe,
      direction: "long",
      source: "manual",
      mode: "paper",
      status: "draft",
      entry,
      stop,
      target,
      drawingId: drawing.id,
      sizingMode: "risk",
      riskAmount: 100,
      shares: 100,
    });

    // Link the original chart drawing to the trade. TradeDrawingSync now
    // recognizes this existing drawing and will not create a second one.
    this.drawingEngine.linkLongPositionToTrade(drawing.id, trade.id);

    const linkedTrade = this.tradeEngine.getTrade(trade.id) ?? trade;
    this.tradeEngine.updateTrade(trade.id, {
      entry,
      stop,
      direction: "long",
      links: {
        ...linkedTrade.links,
        drawingId: drawing.id,
      },
    });

    if (finiteNumber(linkedTrade.targets[0]?.price) !== target) {
      this.tradeEngine.updateTarget(trade.id, target);
    }

    this.tradeEngine.selectTrade(trade.id);
    return trade.id;
  }

  private selectActiveTradeFromDrawing(): void {
    const drawings = this.drawingEngine.getDrawings();
    const selectedDrawingId = this.drawingEngine.getSelectedDrawingId();
    const activeLongPosition = getActiveLongPosition(
      drawings,
      selectedDrawingId,
    );

    if (!activeLongPosition?.tradeId) return;

    this.tradeEngine.selectTrade(activeLongPosition.tradeId);
  }

  private deleteTradesForRemovedDrawings(drawings: ChartDrawing[]): void {
    const currentDrawingIds = new Set(drawings.map((drawing) => drawing.id));

    for (const previousId of this.lastDrawingIds) {
      if (currentDrawingIds.has(previousId)) continue;

      const trade = this.tradeEngine
        .getTrades()
        .find((item) => item.links.drawingId === previousId);

      if (trade) {
        this.tradeEngine.deleteTrade(trade.id);
      }
    }
  }

  private handleDuplicatedLongPosition(drawings: ChartDrawing[]): void {
    const newDrawing = drawings.find(
      (drawing): drawing is LongPositionDrawing => {
        return isLongPosition(drawing) && !this.lastDrawingIds.has(drawing.id);
      },
    );

    if (!newDrawing) {
      this.selectActiveTradeFromDrawing();
      return;
    }

    if (newDrawing.tradeId && this.tradeEngine.getTrade(newDrawing.tradeId)) {
      const tradeId = this.syncLongPositionToTrade(newDrawing);
      if (tradeId) this.tradeEngine.selectTrade(tradeId);
      return;
    }

    const entry = finiteNumber(newDrawing.entry.price);
    const stop = finiteNumber(newDrawing.stop.price);
    const target = finiteNumber(newDrawing.target.price);
    const workspace = this.tradeEngine.getWorkspace();

    const trade = this.tradeEngine.createTrade({
      symbol: workspace.symbol ?? "SPY",
      timeframe: workspace.timeframe,
      direction: "long",
      source: "manual",
      mode: "paper",
      status: "draft",
      entry,
      stop,
      target,
      drawingId: newDrawing.id,
      sizingMode: "risk",
      riskAmount: 100,
      shares: 100,
    });

    this.drawingEngine.linkLongPositionToTrade(newDrawing.id, trade.id);
    this.tradeEngine.selectTrade(trade.id);
  }
}