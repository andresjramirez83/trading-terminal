import type { ChartState } from "../ChartState";
import type { DecisionCenterState } from "./DecisionCenterTypes";

import { calculateTradeReadiness } from "../analysis/decision/TradeReadinessEngine";
import { buildStudySnapshot } from "../analysis/decision/snapshot/StudySnapshotBuilder";

import { buildTrendStrength } from "../analysis/decision/TrendStrengthEngine";
import { buildBalance } from "../analysis/decision/BalanceEngine";
import { buildEntryQuality } from "../analysis/decision/EntryQualityEngine";
import { buildRisk } from "../analysis/decision/RiskEngine";
import { buildDecisionEngine } from "../analysis/decision/DecisionEngine";

function formatPrice(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return value.toFixed(value >= 10 ? 2 : 4);
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

export function buildDecisionCenterState(
  chartState?: ChartState | null
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
    snapshot.vwap.value != null && snapshot.price > snapshot.vwap.value;

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
      score: snapshot.compression.score,
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
        snapshot.vwap.slope > 0
          ? "Rising"
          : snapshot.vwap.slope < 0
          ? "Falling"
          : "Flat",
      slopeTone:
        snapshot.vwap.slope > 0
          ? "good"
          : snapshot.vwap.slope < 0
          ? "bad"
          : "warn",
      reclaim: aboveVwap && snapshot.vwap.slope >= 0 ? "Confirmed" : "Waiting",
      reclaimTone: aboveVwap && snapshot.vwap.slope >= 0 ? "good" : "warn",
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

    trendStrength,
    balance,
    entryQuality,
    risk,
    ai,
  };
}