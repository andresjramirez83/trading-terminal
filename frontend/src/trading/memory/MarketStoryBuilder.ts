/**
 * MarketStoryBuilder.ts
 *
 * Converts market events into a concise narrative shared by the
 * Decision Center, Journal, Replay, and AI Coach.
 */

import type { MarketMemoryEvent } from "./MarketMemoryTypes";

export interface MarketStory {
  headline: string;
  summary: string;
  bullishThesis: string;
  bearishThesis: string;
  keyEvents: string[];
  confidence: number;
}

type StoryDirection = "bullish" | "bearish" | "neutral";

function eventDirection(event: MarketMemoryEvent): StoryDirection {
  const metadataDirection = event.metadata?.direction;

  if (
    metadataDirection === "bullish" ||
    metadataDirection === "bearish" ||
    metadataDirection === "neutral"
  ) {
    return metadataDirection;
  }

  const text = [
    event.type,
    event.title,
    ...event.implications,
  ]
    .join(" ")
    .toLowerCase();

  if (
    text.includes("lower-low") ||
    text.includes("lower low") ||
    text.includes("lower-high") ||
    text.includes("lower high") ||
    text.includes("bearish") ||
    text.includes("vwap lost") ||
    text.includes("liquidity-swept-high")
  ) {
    return "bearish";
  }

  if (
    text.includes("higher-high") ||
    text.includes("higher high") ||
    text.includes("higher-low") ||
    text.includes("higher low") ||
    text.includes("bullish") ||
    text.includes("vwap reclaimed") ||
    text.includes("liquidity-swept-low")
  ) {
    return "bullish";
  }

  return "neutral";
}

function latestDirectionalStructure(
  events: readonly MarketMemoryEvent[],
): MarketMemoryEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.category === "structure" &&
        eventDirection(event) !== "neutral",
    );
}

function structureThesis(
  events: readonly MarketMemoryEvent[],
  direction: Exclude<StoryDirection, "neutral">,
): string | undefined {
  const latestStructure = latestDirectionalStructure(events);
  if (!latestStructure || eventDirection(latestStructure) !== direction) {
    return undefined;
  }

  const structureEvents = events.filter(
    (event) =>
      event.category === "structure" &&
      eventDirection(event) === direction,
  );
  const recentTypes = structureEvents
    .slice(-8)
    .map((event) => event.type.toLowerCase());

  if (direction === "bearish") {
    const hasLowerLow = recentTypes.some((type) =>
      type.includes("lower-low"),
    );
    const hasLowerHigh = recentTypes.some((type) =>
      type.includes("lower-high"),
    );
    const hasBearishBreak = recentTypes.some(
      (type) =>
        type.includes("break-of-structure-bearish") ||
        type.includes("change-of-character-bearish"),
    );

    if (hasLowerLow && hasLowerHigh) {
      return "Sellers control market structure with confirmed lower highs and lower lows, supporting downside continuation.";
    }
    if (hasLowerLow || hasBearishBreak) {
      return "Bearish structure is confirmed by a downside structure break / lower low, supporting further downside while the latest lower high holds.";
    }
    return "Sellers currently control the active market-structure sequence.";
  }

  const hasHigherHigh = recentTypes.some((type) =>
    type.includes("higher-high"),
  );
  const hasHigherLow = recentTypes.some((type) =>
    type.includes("higher-low"),
  );
  const hasBullishBreak = recentTypes.some(
    (type) =>
      type.includes("break-of-structure-bullish") ||
      type.includes("change-of-character-bullish"),
  );

  if (hasHigherHigh && hasHigherLow) {
    return "Buyers control market structure with confirmed higher highs and higher lows, supporting upside continuation.";
  }
  if (hasHigherHigh || hasBullishBreak) {
    return "Bullish structure is confirmed by an upside structure break / higher high, supporting further upside while the latest higher low holds.";
  }
  return "Buyers currently control the active market-structure sequence.";
}

export class MarketStoryBuilder {
  build(events: readonly MarketMemoryEvent[]): MarketStory {
    const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);

    const keyEvents = ordered.map(
      (event) =>
        `${new Date(event.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })} - ${event.title}`,
    );

    const avgConfidence =
      ordered.length === 0
        ? 0
        : ordered.reduce((sum, event) => sum + event.confidence, 0) /
          ordered.length;

    const summary =
      ordered.length === 0
        ? "No significant market events have been recorded."
        : ordered.map((event) => event.description || event.title).join(" ");

    const activeStructure = latestDirectionalStructure(ordered);
    const activeStructureDirection = activeStructure
      ? eventDirection(activeStructure)
      : "neutral";

    const bullishStructure = structureThesis(ordered, "bullish");
    const bearishStructure = structureThesis(ordered, "bearish");

    const latestDirectionalEvent = [...ordered]
      .reverse()
      .find((event) => eventDirection(event) !== "neutral");
    const latestDirection = latestDirectionalEvent
      ? eventDirection(latestDirectionalEvent)
      : "neutral";

    const bullish =
      bullishStructure ??
      (activeStructureDirection === "bearish"
        ? "Bullish structure is not currently in control; buyers need to reclaim the protected lower high before the bearish sequence is invalidated."
        : latestDirection === "bullish"
          ? "Buyers have recent evidence supporting upside continuation."
          : "No strong bullish evidence has developed.");

    const bearish =
      bearishStructure ??
      (activeStructureDirection === "bullish"
        ? "Bearish structure is not currently in control; sellers need to break the protected higher low before a bearish sequence is confirmed."
        : latestDirection === "bearish"
          ? "Sellers have recent evidence supporting downside continuation."
          : "No strong bearish evidence has developed.");

    const headline =
      ordered.length > 0
        ? ordered[ordered.length - 1].title
        : "Waiting for Market Context";

    return {
      headline,
      summary,
      bullishThesis: bullish,
      bearishThesis: bearish,
      keyEvents,
      confidence: Number(avgConfidence.toFixed(2)),
    };
  }
}

export default MarketStoryBuilder;
