// src/trading/intelligence/integration/MarketObjectMemoryAdapter.ts

import type { Time } from "lightweight-charts";

import type {
  MarketIntelligenceResult,
  MarketObjectEvaluation,
} from "../../../components/chart/analysis/market-objects/MarketIntelligenceEngine";
import type {
  MarketObject,
  MarketObjectInteractionType,
} from "../../../components/chart/analysis/market-objects/MarketObjectTypes";
import type { MarketMemoryEvent } from "../../memory/MarketMemoryTypes";

type InteractionDescription = {
  title: string;
  description: string;
  importance: number;
};

function timeToTimestamp(time: Time): number {
  if (typeof time === "number") return time * 1000;
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  return Date.UTC(time.year, time.month - 1, time.day);
}

function objectName(object: MarketObject): string {
  if (object.presentation?.label) return object.presentation.label;

  const names: Partial<Record<MarketObject["type"], string>> = {
    demandZone: "Demand zone",
    supplyZone: "Supply zone",
    fairValueGap: "Fair value gap",
    trendline: "Trendline",
    support: "Support",
    resistance: "Resistance",
    liquidityPool: "Liquidity pool",
    previousDayHigh: "Previous day high",
    previousDayLow: "Previous day low",
    premarketHigh: "Premarket high",
    premarketLow: "Premarket low",
    sessionHigh: "Session high",
    sessionLow: "Session low",
    vwap: "VWAP",
    swingHigh: "Swing high",
    swingLow: "Swing low",
    marketStructureLeg: "Market structure",
    newsCatalyst: "News catalyst",
    customZone: "Custom zone",
  };

  return names[object.type] ?? object.type;
}

function interactionDescription(
  type: MarketObjectInteractionType,
  name: string,
): InteractionDescription {
  switch (type) {
    case "approachStarted":
      return {
        title: `${name} approaching`,
        description: `Price entered the awareness range of the ${name.toLowerCase()}.`,
        importance: 35,
      };
    case "entered":
      return {
        title: `${name} entered`,
        description: `Price moved inside the ${name.toLowerCase()}.`,
        importance: 65,
      };
    case "touched":
      return {
        title: `${name} touched`,
        description: `Price tested the ${name.toLowerCase()}.`,
        importance: 60,
      };
    case "wickRejected":
      return {
        title: `${name} rejected`,
        description: `Price wicked into the ${name.toLowerCase()} and rejected it.`,
        importance: 75,
      };
    case "bodyRejected":
      return {
        title: `${name} strongly rejected`,
        description: `Price traded into the ${name.toLowerCase()} and closed back outside it.`,
        importance: 82,
      };
    case "retestConfirmed":
      return {
        title: `${name} retest confirmed`,
        description: `The ${name.toLowerCase()} held during its retest.`,
        importance: 88,
      };
    case "structureHeld":
      return {
        title: `${name} held`,
        description: `Market structure held at the ${name.toLowerCase()}.`,
        importance: 85,
      };
    case "structureFailed":
      return {
        title: `${name} failed`,
        description: `Market structure failed at the ${name.toLowerCase()}.`,
        importance: 90,
      };
    case "invalidated":
      return {
        title: `${name} invalidated`,
        description: `Price closed through the ${name.toLowerCase()}, invalidating it.`,
        importance: 95,
      };
    case "leftObject":
      return {
        title: `${name} exited`,
        description: `Price moved out of the ${name.toLowerCase()}.`,
        importance: 45,
      };
    default:
      return {
        title: `${name} updated`,
        description: `The ${name.toLowerCase()} recorded a ${type} interaction.`,
        importance: 40,
      };
  }
}

function categoryForObject(
  object: MarketObject,
): MarketMemoryEvent["category"] {
  switch (object.type) {
    case "fairValueGap":
      return "fvg";
    case "liquidityPool":
    case "previousDayHigh":
    case "previousDayLow":
    case "premarketHigh":
    case "premarketLow":
    case "sessionHigh":
    case "sessionLow":
      return "liquidity";
    case "vwap":
      return "vwap";
    case "swingHigh":
    case "swingLow":
    case "marketStructureLeg":
    case "trendline":
    case "support":
    case "resistance":
    case "demandZone":
    case "supplyZone":
      return "structure";
    default:
      return "custom";
  }
}

function implications(
  object: MarketObject,
  interaction: MarketObjectInteractionType,
): string[] {
  const values: string[] = [];

  if (object.bias === "bullish") {
    values.push("Supports the bullish thesis while the object remains valid.");
  } else if (object.bias === "bearish") {
    values.push("Supports the bearish thesis while the object remains valid.");
  } else {
    values.push("Provides a neutral reference level for confirmation.");
  }

  if (interaction === "invalidated" || interaction === "structureFailed") {
    values.push("The prior thesis associated with this object is no longer valid.");
  }

  return values;
}

function buildEvent(
  result: MarketIntelligenceResult,
  evaluation: MarketObjectEvaluation,
  object: MarketObject,
  interaction: MarketObjectInteractionType,
  interactionIndex: number,
): MarketMemoryEvent {
  const name = objectName(object);
  const copy = interactionDescription(interaction, name);
  const timestamp = timeToTimestamp(result.time);

  return {
    id: [
      "market-object",
      result.symbol,
      result.timeframe,
      object.id,
      interaction,
      timestamp,
      interactionIndex,
    ].join(":"),
    symbol: result.symbol,
    timeframe: result.timeframe,
    timestamp,
    category: categoryForObject(object),
    type: `market-object:${interaction}`,
    title: copy.title,
    description: copy.description,
    importance: copy.importance,
    confidence: Math.max(0, Math.min(1, object.scoring.confidence / 100)),
    implications: implications(object, interaction),
    metadata: {
      source: "market-object-intelligence",
      objectId: object.id,
      objectType: object.type,
      objectSource: object.source,
      objectBias: object.bias,
      objectStatus: object.status,
      lifecycleStage: object.lifecycleStage,
      interaction,
      price: result.price,
      distancePrice: evaluation.proximity.distancePrice,
      distancePercent: evaluation.proximity.distancePercent,
      approachProgress: evaluation.proximity.approachProgress,
      isInside: evaluation.proximity.isInside,
      quality: object.scoring.quality,
      health: object.scoring.health,
      priority: object.scoring.priority,
    },
  };
}

/** Converts newly detected object interactions into main Market Memory events. */
export function marketObjectResultToMemoryEvents(
  result: MarketIntelligenceResult,
): MarketMemoryEvent[] {
  const objectsById = new Map(
    result.snapshot.objects.map((object) => [object.id, object]),
  );
  const events: MarketMemoryEvent[] = [];

  for (const evaluation of result.evaluations) {
    const object = objectsById.get(evaluation.objectId);
    if (!object) continue;

    evaluation.interactions.forEach((interaction, index) => {
      events.push(buildEvent(result, evaluation, object, interaction, index));
    });
  }

  return events;
}

export default marketObjectResultToMemoryEvents;
