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

export class MarketStoryBuilder {
  build(events: readonly MarketMemoryEvent[]): MarketStory {
    const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);

    const keyEvents = ordered.map(
      (e) => `${new Date(e.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${e.title}`
    );

    const avgConfidence =
      ordered.length === 0
        ? 0
        : ordered.reduce((sum, e) => sum + e.confidence, 0) / ordered.length;

    const summary =
      ordered.length === 0
        ? "No significant market events have been recorded."
        : ordered.map((e) => e.description || e.title).join(" ");

    const bullish =
      ordered.some((e) => e.type.toLowerCase().includes("reclaim")) ||
      ordered.some((e) => e.type.toLowerCase().includes("bull"))
        ? "Buyers have recently improved market structure."
        : "No strong bullish evidence has developed.";

    const bearish =
      ordered.some((e) => e.type.toLowerCase().includes("loss")) ||
      ordered.some((e) => e.type.toLowerCase().includes("bear"))
        ? "Sellers currently have evidence supporting downside continuation."
        : "No strong bearish evidence has developed.";

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
