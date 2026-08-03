import type { ChartState } from "../ChartState";
import type { DecisionCenterState } from "./DecisionCenterTypes";
import type { MarketIntelligenceReport } from "../../../trading/intelligence/core/IntelligenceTypes";
import type {
  MarketContextComponent,
  MarketContextDirection,
  MarketContextMetric,
} from "../../../trading/intelligence/types/MarketContextTypes";

import { calculateTradeReadiness } from "../analysis/decision/TradeReadinessEngine";
import { buildStudySnapshot } from "../analysis/decision/snapshot/StudySnapshotBuilder";

import { buildTrendStrength } from "../analysis/decision/TrendStrengthEngine";
import { buildBalance } from "../analysis/decision/BalanceEngine";
import { buildEntryQuality } from "../analysis/decision/EntryQualityEngine";
import { buildRisk } from "../analysis/decision/RiskEngine";
import { buildDecisionEngine } from "../analysis/decision/DecisionEngine";

function clampScore(value: unknown, fallback = 50): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(100, value)))
    : fallback;
}

function percent(value: unknown, fallback = 50): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampScore(value <= 1 ? value * 100 : value, fallback);
}

function formatPrice(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return value.toFixed(value >= 10 ? 2 : 4);
}

function formatDistance(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return value.toFixed(value >= 10 ? 2 : 4);
}

function formatRR(value?: number): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "--";
  return `${value.toFixed(2)}R`;
}

function formatVolume(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "--";

  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;

  return String(Math.round(value));
}

function getTone(value: boolean | undefined): "good" | "warn" | "bad" {
  if (value === true) return "good";
  if (value === false) return "bad";
  return "warn";
}

function toneFromScore(score: number): "good" | "warn" | "bad" {
  if (score >= 70) return "good";
  if (score >= 45) return "warn";
  return "bad";
}

function directionLabel(direction: MarketContextDirection): string {
  if (direction === "bullish") return "Bullish";
  if (direction === "bearish") return "Bearish";
  return "Neutral";
}

function findComponent(
  report: MarketIntelligenceReport,
  ids: string[],
): MarketContextComponent | undefined {
  return report.context.components.find(
    (component) =>
      ids.includes(component.id) || ids.includes(String(component.category)),
  );
}

function componentScore(
  component: MarketContextComponent | undefined,
  fallback: number,
): number {
  return clampScore(
    component?.normalizedScore ?? component?.score,
    fallback,
  );
}

function metricNumber(
  component: MarketContextComponent | undefined,
  keys: string[],
  fallback: number,
): number {
  if (!component) return fallback;

  const normalizedKeys = keys.map((key) => key.toLowerCase());

  const metric = component.metrics.find((candidate) => {
    const key = candidate.key.toLowerCase();
    const label = candidate.label.toLowerCase();
    return normalizedKeys.some(
      (needle) => key === needle || key.includes(needle) || label.includes(needle),
    );
  });

  return metricValue(metric, fallback);
}

function metricValue(metric: MarketContextMetric | undefined, fallback: number): number {
  if (!metric) return fallback;
  if (typeof metric.score === "number" && Number.isFinite(metric.score)) {
    return clampScore(metric.score, fallback);
  }
  if (typeof metric.value === "number" && Number.isFinite(metric.value)) {
    return clampScore(metric.value, fallback);
  }
  return fallback;
}

function actionFromReport(
  report: MarketIntelligenceReport,
): DecisionCenterState["ai"]["action"] {
  switch (report.decision.action) {
    case "strong-long":
    case "long":
      return "BUY";

    case "watch-long":
      return "WATCH LONG";

    case "strong-short":
    case "short":
      return "SELL";

    case "watch-short":
      return "WATCH SHORT";

    case "avoid":
      return "AVOID";

    case "wait":
    default:
      return "WAIT";
  }
}

function buildLegacyDecisionCenterState(
  chartState?: ChartState | null,
): DecisionCenterState {
  const snapshot = buildStudySnapshot(chartState);

  const tradeReadiness = calculateTradeReadiness({ snapshot });

  const trendStrength = buildTrendStrength(snapshot);
  const balance = buildBalance(snapshot);
  const entryQuality = buildEntryQuality(snapshot, trendStrength, balance);
  const risk = buildRisk(snapshot, trendStrength, entryQuality);
  const ai = buildDecisionEngine(trendStrength, balance, entryQuality, risk);

  const emaBullish =
    snapshot.ema.ema9 != null &&
    snapshot.ema.ema20 != null &&
    snapshot.ema.ema9 > snapshot.ema.ema20;

  const aboveVwap =
    snapshot.vwap.value != null &&
    (snapshot.price ?? 0) > snapshot.vwap.value;

  const vwapSlope = snapshot.vwap.slope ?? 0;

  const structureScore = snapshot.structure.strength ?? 50;

  let structureSubtitle = "Neutral Structure";
  let structureTone: "good" | "warn" | "bad" = "warn";

  if (structureScore >= 75) {
    structureSubtitle = "Strong Bullish Structure";
    structureTone = "good";
  } else if (structureScore >= 60) {
    structureSubtitle = "Bullish Structure";
    structureTone = "good";
  } else if (structureScore <= 25) {
    structureSubtitle = "Strong Bearish Structure";
    structureTone = "bad";
  } else if (structureScore <= 40) {
    structureSubtitle = "Bearish Structure";
    structureTone = "bad";
  } else if (snapshot.structure.trend === "bullish") {
    structureSubtitle = "Early Bullish Structure";
  } else if (snapshot.structure.trend === "bearish") {
    structureSubtitle = "Early Bearish Structure";
  }

  const structureBadge = snapshot.structure.bos
    ? "BOS"
    : snapshot.structure.choch
      ? "CHoCH"
      : "Watch";

  return {
    tradeReadiness: {
      score: tradeReadiness.percent,
      status: tradeReadiness.status,
      items: tradeReadiness.signals.map((signal) => ({
        label: signal.label,
        tone: signal.tone,
      })),
    },

    performance: [
      {
        label: "EMA Trend",
        value: emaBullish ? "Bullish" : "Not Bullish",
        tone: getTone(emaBullish),
      },
      {
        label: "VWAP",
        value: aboveVwap ? "Above" : "Below",
        tone: getTone(aboveVwap),
      },
      {
        label: "ATR",
        value: snapshot.atr.expanding ? "Expanding" : "Normal",
        tone: snapshot.atr.expanding ? "good" : "warn",
      },
      {
        label: "Volume",
        value:
          snapshot.volume.relative != null
            ? `${snapshot.volume.relative.toFixed(2)}x Avg`
            : "--",
        tone:
          snapshot.volume.relative != null && snapshot.volume.relative >= 1.2
            ? "good"
            : "warn",
      },
    ],

    compression: {
      score: snapshot.compression.score ?? 0,
      subtitle: snapshot.compression.breaking
        ? "Breaking Pressure"
        : "Compression Watch",
      badge: snapshot.compression.breaking ? "Break" : "Watch",
      tone: snapshot.compression.breaking ? "good" : "warn",
    },

    structure: {
      score: structureScore,
      subtitle: structureSubtitle,
      badge: structureBadge,
      tone: structureTone,
    },

    momentum: {
      score: snapshot.momentum.score ?? 50,
      status: snapshot.momentum.status ?? "Neutral",
      direction: snapshot.momentum.direction ?? "neutral",
      ema: snapshot.momentum.emaMomentum ?? 50,
      vwap: snapshot.momentum.vwapMomentum ?? 50,
      candle: snapshot.momentum.candleMomentum ?? 50,
      volume: snapshot.momentum.volumeMomentum ?? 50,
      atr: snapshot.momentum.atrMomentum ?? 50,
      increasing: snapshot.momentum.increasing ?? false,
      fading: snapshot.momentum.fading ?? false,
    },

    vwap: {
      priceVsVwap: aboveVwap ? "Above" : "Below",
      priceVsVwapTone: getTone(aboveVwap),
      slope:
        vwapSlope > 0
          ? "Rising"
          : vwapSlope < 0
            ? "Falling"
            : "Flat",
      slopeTone:
        vwapSlope > 0
          ? "good"
          : vwapSlope < 0
            ? "bad"
            : "warn",
      reclaim: aboveVwap && vwapSlope >= 0 ? "Confirmed" : "Waiting",
      reclaimTone: aboveVwap && vwapSlope >= 0 ? "good" : "warn",
    },

    stats: {
      range:
        chartState?.lastBar != null
          ? formatPrice(chartState.lastBar.high - chartState.lastBar.low)
          : "--",
      volume: formatVolume(snapshot.volume.current),
      atr: formatPrice(snapshot.atr.value),
      rr: risk.expectedRR,
    },

    keyStats: {
      price: snapshot.price,
      range:
        chartState?.lastBar != null
          ? chartState.lastBar.high - chartState.lastBar.low
          : undefined,
      volume: snapshot.volume.current,
      atr: snapshot.atr.value,
      vwapDistance:
        snapshot.price != null && snapshot.vwap.value != null
          ? snapshot.price - snapshot.vwap.value
          : undefined,
      rr: risk.expectedRR,
    },

    trendStrength,
    balance,
    entryQuality,
    risk,
    ai,
  };
}

function applyIntelligenceReport(
  base: DecisionCenterState,
  report: MarketIntelligenceReport,
): DecisionCenterState {
  const trend = findComponent(report, ["trend"]);
  const entry = findComponent(report, ["entry-quality", "entry"]);
  const risk = findComponent(report, ["risk"]);
  const structure = findComponent(report, ["market-structure", "structure"]);

  const trendScore = componentScore(trend, report.convictionScore);
  const entryScore = clampScore(report.entry.score, componentScore(entry, 50));
  const riskScore = clampScore(report.risk.score, componentScore(risk, 50));
  const structureScore = componentScore(structure, trendScore);

  const currentPrice =
    report.context.input?.price.last ?? report.context.input?.price.close;
  const stopDistance =
    currentPrice != null && report.risk.stopPrice != null
      ? Math.abs(currentPrice - report.risk.stopPrice)
      : undefined;
  const targetDistance =
    currentPrice != null && report.risk.targetPrice != null
      ? Math.abs(report.risk.targetPrice - currentPrice)
      : undefined;

  const action = actionFromReport(report);
  const confidence = percent(report.decision.confidence, report.marketConfidence);
  const aiTone: "good" | "warn" | "bad" =
    action === "BUY" || action === "SELL"
      ? "good"
      : action === "AVOID"
        ? "bad"
        : "warn";

  const direction = report.direction;
  const buyerScore = clampScore(report.decision.bullishScore, 50);
  const sellerScore = clampScore(report.decision.bearishScore, 50);

  const trendBadge =
    direction === "neutral"
      ? "Neutral"
      : `${directionLabel(direction)} ${report.strength.replace("-", " ")}`;

  const entryBadge = report.entry.approved
    ? `${report.entry.grade} Ready`
    : `${report.entry.grade} Watch`;

  const riskBadge =
    report.risk.level === "low"
      ? "Low Risk"
      : report.risk.level === "moderate"
        ? "Moderate Risk"
        : report.risk.level === "high"
          ? "High Risk"
          : "Extreme Risk";

  const readinessItems = [
    ...report.risk.strengths.slice(0, 2).map((label) => ({
      label,
      tone: "good" as const,
    })),
    ...report.risk.warnings.slice(0, 2).map((label) => ({
      label,
      tone: "warn" as const,
    })),
    ...report.risk.blockers.slice(0, 2).map((label) => ({
      label,
      tone: "bad" as const,
    })),
  ].slice(0, 4);

  return {
    ...base,
    tradeReadiness: {
      score: clampScore(report.tradeScore),
      status: report.recommendation.canTrade
        ? "Ready"
        : report.recommendation.action === "avoid"
          ? "Avoid"
          : "Caution",
      items:
        readinessItems.length > 0
          ? readinessItems
          : [
              {
                label: report.recommendation.summary,
                tone: report.recommendation.canTrade ? "good" : "warn",
              },
            ],
    },
    structure: {
      score: structureScore,
      subtitle:
        structure?.summary ??
        `${directionLabel(direction)} market structure is the directional source of truth.`,
      badge:
        report.context.input?.structure.breakOfStructure
          ? "BOS"
          : report.context.input?.structure.changeOfCharacter
            ? "CHoCH"
            : structure?.status === "confirmed"
              ? "Confirmed"
              : "Watch",
      tone:
        direction === "bullish"
          ? "good"
          : direction === "bearish"
            ? "bad"
            : "warn",
    },
    trendStrength: {
      score: trendScore,
      badge: trendBadge,
      subtitle: trend?.summary ?? report.thesis,
      tone: toneFromScore(trendScore),
      emaAlignment: metricNumber(
        trend,
        ["ema alignment", "ema.alignment", "ema"],
        base.trendStrength.emaAlignment,
      ),
      vwapAlignment: metricNumber(
        trend,
        ["vwap alignment", "vwap.alignment", "vwap"],
        base.trendStrength.vwapAlignment,
      ),
      structureAlignment: structureScore,
      momentumAlignment: metricNumber(
        trend,
        ["momentum alignment", "momentum.alignment", "momentum"],
        base.trendStrength.momentumAlignment,
      ),
      continuationProbability:
        direction === "bullish"
          ? percent(report.probabilities.bullishContinuation)
          : direction === "bearish"
            ? percent(report.probabilities.bearishContinuation)
            : percent(report.probabilities.balance),
    },
    balance: {
      score: base.balance.score,
      vwapZScore: base.balance.vwapZScore,
      badge: base.balance.badge,
      subtitle: base.balance.subtitle,
      tone: base.balance.tone,
      buyers: buyerScore,
      sellers: sellerScore,
      equilibrium: base.balance.equilibrium,
    },
    entryQuality: {
      score: entryScore,
      badge: entryBadge,
      subtitle:
        entry?.summary ??
        report.entry.reasons[0] ??
        "Entry quality is waiting for additional confirmation.",
      tone: toneFromScore(entryScore),
      location: clampScore(report.entry.locationScore),
      confirmation: clampScore(report.entry.confirmationScore),
      timing: clampScore(report.entry.timingScore),
      riskReward: clampScore(report.entry.rewardRiskScore),
    },
    risk: {
      score: riskScore,
      badge: riskBadge,
      subtitle:
        risk?.summary ??
        report.risk.warnings[0] ??
        report.risk.strengths[0] ??
        "Risk conditions are being evaluated.",
      tone: toneFromScore(riskScore),
      stopDistance: formatDistance(stopDistance),
      targetDistance: formatDistance(targetDistance),
      expectedRR: formatRR(report.risk.rewardRiskRatio),
    },
    ai: {
      action,
      confidence,
      reason:
        report.recommendation.summary ||
        report.decision.summary ||
        report.summary,
      tone: aiTone,
    },
    stats: {
      ...base.stats,
      rr: formatRR(report.risk.rewardRiskRatio),
    },
    keyStats: {
      price: currentPrice,
      range: report.context.input?.volatility.range,
      volume: report.context.input?.volume.current,
      atr: report.context.input?.volatility.atr,
      vwapDistance:
        currentPrice != null && report.context.input?.indicators.vwap != null
          ? currentPrice - report.context.input.indicators.vwap
          : undefined,
      rr: formatRR(report.risk.rewardRiskRatio),
    },
  };
}

/**
 * Builds the Decision Center view model.
 *
 * The intelligence report is authoritative whenever it is available. The
 * legacy chart analysis remains only as a safe loading/error fallback while
 * the shared Trading Intelligence Runtime is evaluating.
 */
export function buildDecisionCenterState(
  chartState?: ChartState | null,
  report?: MarketIntelligenceReport | null,
): DecisionCenterState {
  const legacyState = buildLegacyDecisionCenterState(chartState);
  return report ? applyIntelligenceReport(legacyState, report) : legacyState;
}
