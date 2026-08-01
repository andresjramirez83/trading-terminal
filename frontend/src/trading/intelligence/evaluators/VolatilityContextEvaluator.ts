// src/trading/intelligence/evaluators/VolatilityContextEvaluator.ts

import type {
  MarketContextComponent,
  MarketContextEvidence,
  MarketContextMetric,
  MarketContextReason,
} from "../types/MarketContextTypes";
import type {
  MarketContextEvaluation,
  MarketContextEvaluator,
  MarketContextEvaluatorContext,
} from "../MarketContextEngine";

export class VolatilityContextEvaluator implements MarketContextEvaluator {
  readonly id = "volatility";
  readonly categories = ["volatility"] as const;

  evaluate(context: MarketContextEvaluatorContext): MarketContextEvaluation | null {
    const indicators: any = context.input.indicators ?? {};

    const atr = indicators.atr;
    const atrPct = indicators.atrPercent ?? indicators.atrPct;
    const compression = indicators.compression;
    const expansion = indicators.expansion;

    const evidence: MarketContextEvidence[] = [];
    const reasons: MarketContextReason[] = [];
    const metrics: MarketContextMetric[] = [];
    const tags: string[] = [];

    if (typeof atr === "number") {
      metrics.push({
        key: "volatility.atr",
        label: "ATR",
        category: "volatility",
        value: atr,
        unit: "price",
        confidence: 0.8,
        timestamp: context.input.timestamp,
      } as any);
    }

    if (typeof atrPct === "number") {
      metrics.push({
        key: "volatility.atrPct",
        label: "ATR %",
        category: "volatility",
        value: atrPct,
        unit: "%",
        confidence: 0.8,
        timestamp: context.input.timestamp,
      } as any);
    }

    if (compression === true) {
      tags.push("compression");
      evidence.push({
        id: "volatility-compression",
        category: "volatility",
        label: "Compression",
        reason: "Price is compressing and energy may be building.",
        polarity: "neutral",
        severity: "supporting",
        weight: 1,
        scoreImpact: 18,
        confidence: 0.8,
        source: this.id,
        timeframe: context.input.timeframe,
        timestamp: context.input.timestamp,
      } as any);
    }

    if (expansion === true) {
      tags.push("expansion");
      evidence.push({
        id: "volatility-expansion",
        category: "volatility",
        label: "Expansion",
        reason: "Price is expanding with elevated volatility.",
        polarity: "positive",
        severity: "supporting",
        weight: 1,
        scoreImpact: 20,
        confidence: 0.8,
        source: this.id,
        timeframe: context.input.timeframe,
        timestamp: context.input.timestamp,
      } as any);
    }

    if (!metrics.length && !evidence.length) return null;

    const component: MarketContextComponent = {
      id: "volatility",
      category: "volatility",
      label: "Volatility",
      summary: compression ? "Market is compressing." : expansion ? "Market is expanding." : "Normal volatility.",
      status: "confirmed",
      score: expansion ? 75 : compression ? 55 : 50,
      normalizedScore: expansion ? 75 : compression ? 55 : 50,
      confidence: 0.8,
      direction: "neutral",
      reasons,
      evidence,
      metrics,
      tags,
      updatedAt: context.now,
    } as any;

    return {
      components: [component],
      evidence,
      reasons,
      metrics,
      tags,
    };
  }
}

export default VolatilityContextEvaluator;
