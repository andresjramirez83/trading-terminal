// src/trading/controller/TradeController.ts

import { DrawingEngine } from "../../components/chart/DrawingEngine";
import { TradeEngine } from "../engine/TradeEngine";
import { LivePositionTradeSync } from "../position/LivePositionTradeSync";
import { ChartTradeBridge } from "./ChartTradeBridge";
import { TradeDrawingSync } from "./TradeDrawingSync";

export class TradeController {
  private readonly chartBridge: ChartTradeBridge;
  private readonly drawingSync: TradeDrawingSync;
  private readonly livePositionSync: LivePositionTradeSync;
  private attached = false;

  constructor(
    private readonly drawingEngine: DrawingEngine,
    private readonly tradeEngine: TradeEngine,
  ) {
    this.chartBridge = new ChartTradeBridge(drawingEngine, tradeEngine);
    this.drawingSync = new TradeDrawingSync(drawingEngine, tradeEngine);
    this.livePositionSync = new LivePositionTradeSync(tradeEngine);
  }

  attach(): void {
    if (this.attached) return;

    this.chartBridge.attach();
    this.drawingSync.attach();
    this.livePositionSync.attach();
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;

    this.livePositionSync.detach();
    this.drawingSync.detach();
    this.chartBridge.detach();
    this.attached = false;
  }

  clear(): void {
    this.chartBridge.runMuted(() => {
      this.drawingEngine.clear();
      this.tradeEngine.clear();
    });
  }

  destroy(): void {
    this.detach();
    this.tradeEngine.destroy();
  }

  getTradeEngine(): TradeEngine {
    return this.tradeEngine;
  }

  getDrawingEngine(): DrawingEngine {
    return this.drawingEngine;
  }
}