// src/components/chart/analysis/market-objects/MarketObjectDrawingBridge.ts

import type { Time } from "lightweight-charts";
import type { DrawingEngine } from "../../DrawingEngine";
import type {
  ChartDrawing,
  HorizontalLineDrawing,
  MarketStructureDrawing,
  RectangleDrawing,
  TrendlineDrawing,
} from "../../DrawingTypes";
import {
  marketObjectRegistry,
  type MarketObjectRegistry,
} from "./MarketObjectRegistry";
import type {
  MarketObject,
  MarketObjectBias,
  MarketObjectGeometry,
  MarketObjectType,
} from "./MarketObjectTypes";

export type MarketObjectDrawingWorkspace = {
  symbol: string;
  timeframe: string;
};

const SUPPORTED_TYPES = new Set<ChartDrawing["type"]>([
  "rectangle",
  "trendline",
  "horizontal",
  "marketStructure",
]);

function normalizeWorkspace(
  workspace: MarketObjectDrawingWorkspace,
): MarketObjectDrawingWorkspace {
  return {
    symbol: workspace.symbol.trim().toUpperCase(),
    timeframe: workspace.timeframe.trim(),
  };
}

function drawingObjectId(drawingId: string): string {
  return `market_object_${drawingId}`;
}

function now(): number {
  return Date.now();
}

function presentation(drawing: ChartDrawing): MarketObject["presentation"] {
  return {
    color: drawing.style.color,
    lineWidth: Math.max(1, Math.min(4, Math.round(drawing.style.width))) as
      | 1
      | 2
      | 3
      | 4,
    visible: true,
    showLabel: true,
  };
}

function geometryForRectangle(drawing: RectangleDrawing): MarketObjectGeometry {
  return {
    kind: "zone",
    zone: {
      low: Math.min(drawing.p1.price, drawing.p2.price),
      high: Math.max(drawing.p1.price, drawing.p2.price),
      startTime: Math.min(drawing.p1.time, drawing.p2.time) as Time,
      endTime: Math.max(drawing.p1.time, drawing.p2.time) as Time,
      extendRight: drawing.style.extendRight,
    },
  };
}

function geometryForTrendline(drawing: TrendlineDrawing): MarketObjectGeometry {
  return {
    kind: "line",
    line: {
      start: { time: drawing.p1.time as Time, price: drawing.p1.price },
      end: { time: drawing.p2.time as Time, price: drawing.p2.price },
      extendRight: drawing.style.extendRight,
    },
  };
}

function geometryForHorizontal(drawing: HorizontalLineDrawing): MarketObjectGeometry {
  return {
    kind: "level",
    level: {
      price: drawing.price,
      extendRight: true,
    },
  };
}

function geometryForMarketStructure(
  drawing: MarketStructureDrawing,
): MarketObjectGeometry | null {
  if (drawing.nodes.length < 2) return null;
  const start = drawing.nodes[0];
  const end = drawing.nodes[drawing.nodes.length - 1];

  return {
    kind: "line",
    line: {
      start: { time: start.time as Time, price: start.price },
      end: { time: end.time as Time, price: end.price },
      extendRight: drawing.style.extendRight,
    },
  };
}

function geometryForDrawing(drawing: ChartDrawing): MarketObjectGeometry | null {
  switch (drawing.type) {
    case "rectangle":
      return geometryForRectangle(drawing);
    case "trendline":
      return geometryForTrendline(drawing);
    case "horizontal":
      return geometryForHorizontal(drawing);
    case "marketStructure":
      return geometryForMarketStructure(drawing);
    case "priceRange":
    case "fibonacci":
    case "longPosition":
      return null;
  }
}

function objectIdentity(drawing: ChartDrawing): {
  type: MarketObjectType;
  bias: MarketObjectBias;
} | null {
  switch (drawing.type) {
    case "rectangle":
      return { type: "customZone", bias: "neutral" };
    case "trendline":
      return { type: "trendline", bias: "neutral" };
    case "horizontal":
      return { type: "support", bias: "neutral" };
    case "marketStructure":
      return { type: "marketStructureLeg", bias: "neutral" };
    case "priceRange":
    case "fibonacci":
    case "longPosition":
      return null;
  }
}

function createObject(
  drawing: ChartDrawing,
  workspace: MarketObjectDrawingWorkspace,
  existing: MarketObject | null,
): MarketObject | null {
  const identity = objectIdentity(drawing);
  const geometry = geometryForDrawing(drawing);
  if (!identity || !geometry) return null;

  const timestamp = now();
  return {
    id: existing?.id ?? drawingObjectId(drawing.id),
    type: identity.type,
    source: "user",
    bias: identity.bias,
    symbol: workspace.symbol,
    timeframe: workspace.timeframe,
    status: existing?.status ?? "registered",
    lifecycleStage: existing?.lifecycleStage ?? "fresh",
    active: existing?.active ?? true,
    geometry,
    scoring: existing?.scoring ?? {
      quality: 50,
      health: 100,
      confidence: 50,
      confidenceBand: "moderate",
      priority: "normal",
    },
    awareness: existing?.awareness ?? {
      enabled: true,
      mode: "percent",
      threshold: 0.25,
    },
    memory: existing?.memory ?? {
      touchCount: 0,
      rejectionCount: 0,
      successfulRetestCount: 0,
      failedRetestCount: 0,
      interactions: [],
    },
    relationshipIds: existing?.relationshipIds ?? [],
    evidence: existing?.evidence ?? [],
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    createdTime: existing?.createdTime,
    updatedTime: timestamp as Time,
    presentation: presentation(drawing),
    metadata: {
      ...(existing?.metadata ?? {}),
      drawingId: drawing.id,
      drawingType: drawing.type,
      synchronizedFromDrawing: true,
    },
  };
}

export class MarketObjectDrawingBridge {
  private workspace: MarketObjectDrawingWorkspace;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly drawingEngine: DrawingEngine,
    workspace: MarketObjectDrawingWorkspace,
    private readonly registry: MarketObjectRegistry = marketObjectRegistry,
  ) {
    this.workspace = normalizeWorkspace(workspace);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.drawingEngine.subscribeDrawings((drawings) => {
      this.synchronize(drawings);
    });
  }

  setWorkspace(workspace: MarketObjectDrawingWorkspace): void {
    const previous = this.workspace;
    this.workspace = normalizeWorkspace(workspace);

    if (
      previous.symbol !== this.workspace.symbol ||
      previous.timeframe !== this.workspace.timeframe
    ) {
      this.synchronize([]);
    }
  }

  synchronize(drawings: readonly ChartDrawing[]): void {
    const supported = drawings.filter((drawing) => SUPPORTED_TYPES.has(drawing.type));
    const drawingIds = new Set(supported.map((drawing) => drawing.id));
    const existingObjects = this.registry.find({
      symbol: this.workspace.symbol,
      timeframe: this.workspace.timeframe,
      source: "user",
    });

    for (const object of existingObjects) {
      const drawingId = String(object.metadata?.drawingId ?? "");
      if (
        object.metadata?.synchronizedFromDrawing === true &&
        drawingId &&
        !drawingIds.has(drawingId)
      ) {
        this.registry.remove(object.id);
      }
    }

    for (const drawing of supported) {
      const existing = this.registry.findByDrawingId(drawing.id);
      const object = createObject(drawing, this.workspace, existing);
      if (object) this.registry.upsert(object);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  destroy(): void {
    this.stop();
  }
}

export default MarketObjectDrawingBridge;
