// src/trading/intelligence/evaluators/SessionContextEvaluator.ts

import type {
  EvidencePolarity,
  EvidenceValue,
  MarketContextComponent,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextMetric,
  MarketContextReason,
  MarketContextStatus,
} from "../types/MarketContextTypes";
import type {
  MarketContextEvaluation,
  MarketContextEvaluator,
  MarketContextEvaluatorContext,
} from "../MarketContextEngine";
import {
  buildScoredContext,
  clampConfidence,
  clampScore,
  directionFromSignedScore,
  scoreEvidence,
} from "../scoring/MarketContextScoring";

export type SessionPhase =
  | "overnight"
  | "premarket"
  | "open"
  | "opening-range"
  | "morning"
  | "midday"
  | "afternoon"
  | "power-hour"
  | "after-hours"
  | "closed"
  | "unknown";

export interface SessionContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;
  phase?: SessionPhase;

  sessionOpen?: number;
  sessionHigh?: number;
  sessionLow?: number;
  previousClose?: number;
  previousHigh?: number;
  previousLow?: number;

  premarketHigh?: number;
  premarketLow?: number;
  overnightHigh?: number;
  overnightLow?: number;

  openingRangeHigh?: number;
  openingRangeLow?: number;
  firstHourHigh?: number;
  firstHourLow?: number;

  aboveSessionOpen?: boolean;
  belowSessionOpen?: boolean;
  abovePreviousClose?: boolean;
  belowPreviousClose?: boolean;

  premarketHighBroken?: boolean;
  premarketLowBroken?: boolean;
  overnightHighBroken?: boolean;
  overnightLowBroken?: boolean;
  openingRangeHighBroken?: boolean;
  openingRangeLowBroken?: boolean;
  firstHourHighBroken?: boolean;
  firstHourLowBroken?: boolean;

  premarketHighReclaimed?: boolean;
  premarketLowReclaimed?: boolean;
  overnightHighReclaimed?: boolean;
  overnightLowReclaimed?: boolean;
  openingRangeHighReclaimed?: boolean;
  openingRangeLowReclaimed?: boolean;

  gapUp?: boolean;
  gapDown?: boolean;
  gapFilled?: boolean;
  gapHolding?: boolean;

  openingDriveBullish?: boolean;
  openingDriveBearish?: boolean;
  openingReversalBullish?: boolean;
  openingReversalBearish?: boolean;

  lunchChopRisk?: boolean;
  powerHourExpansion?: boolean;
  extendedHoursThin?: boolean;

  minutesFromOpen?: number;
  minutesToClose?: number;
  sessionRange?: number;
  sessionRangePct?: number;
  gapPct?: number;

  metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (finite(value)) return value;
  }
  return undefined;
}

function directionValue(value: unknown): MarketContextDirection | undefined {
  return value === "bullish" || value === "bearish" || value === "neutral"
    ? value
    : undefined;
}

function phaseValue(value: unknown): SessionPhase | undefined {
  return value === "overnight" ||
    value === "premarket" ||
    value === "open" ||
    value === "opening-range" ||
    value === "morning" ||
    value === "midday" ||
    value === "afternoon" ||
    value === "power-hour" ||
    value === "after-hours" ||
    value === "closed" ||
    value === "unknown"
    ? value
    : undefined;
}

function statusFromPhase(
  phase: SessionPhase | undefined,
  confidence: number,
): MarketContextStatus {
  if (phase === "closed") return "inactive";
  if (phase === "unknown") return "pending";
  return confidence >= 0.65 ? "confirmed" : "forming";
}

function createReason(evidence: MarketContextEvidence): MarketContextReason {
  return {
    id: `reason_${evidence.id}`,
    text: evidence.reason,
    category: evidence.category,
    polarity: evidence.polarity,
    importance: clampScore(Math.abs(evidence.scoreImpact)),
    confidence: clampConfidence(evidence.confidence),
    evidenceIds: [evidence.id],
  };
}

function readSessionInput(
  context: MarketContextEvaluatorContext,
): SessionContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = context.input.indicators.custom ?? {};
  const nestedMetadata: Record<string, unknown> = isRecord(metadata.session)
    ? metadata.session
    : {};
  const nestedCustom: Record<string, unknown> = isRecord(custom.session)
    ? custom.session
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[`session${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`session${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    metadata[key] ??
    custom[key];

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score")),
    confidence: numberValue(read("confidence")),
    phase: phaseValue(read("phase")),

    sessionOpen: numberValue(read("sessionOpen")),
    sessionHigh: numberValue(read("sessionHigh")),
    sessionLow: numberValue(read("sessionLow")),
    previousClose: numberValue(read("previousClose")),
    previousHigh: numberValue(read("previousHigh")),
    previousLow: numberValue(read("previousLow")),

    premarketHigh: numberValue(read("premarketHigh")),
    premarketLow: numberValue(read("premarketLow")),
    overnightHigh: numberValue(read("overnightHigh")),
    overnightLow: numberValue(read("overnightLow")),

    openingRangeHigh: numberValue(read("openingRangeHigh")),
    openingRangeLow: numberValue(read("openingRangeLow")),
    firstHourHigh: numberValue(read("firstHourHigh")),
    firstHourLow: numberValue(read("firstHourLow")),

    aboveSessionOpen: booleanValue(read("aboveSessionOpen")),
    belowSessionOpen: booleanValue(read("belowSessionOpen")),
    abovePreviousClose: booleanValue(read("abovePreviousClose")),
    belowPreviousClose: booleanValue(read("belowPreviousClose")),

    premarketHighBroken: booleanValue(read("premarketHighBroken")),
    premarketLowBroken: booleanValue(read("premarketLowBroken")),
    overnightHighBroken: booleanValue(read("overnightHighBroken")),
    overnightLowBroken: booleanValue(read("overnightLowBroken")),
    openingRangeHighBroken: booleanValue(read("openingRangeHighBroken")),
    openingRangeLowBroken: booleanValue(read("openingRangeLowBroken")),
    firstHourHighBroken: booleanValue(read("firstHourHighBroken")),
    firstHourLowBroken: booleanValue(read("firstHourLowBroken")),

    premarketHighReclaimed: booleanValue(read("premarketHighReclaimed")),
    premarketLowReclaimed: booleanValue(read("premarketLowReclaimed")),
    overnightHighReclaimed: booleanValue(read("overnightHighReclaimed")),
    overnightLowReclaimed: booleanValue(read("overnightLowReclaimed")),
    openingRangeHighReclaimed: booleanValue(read("openingRangeHighReclaimed")),
    openingRangeLowReclaimed: booleanValue(read("openingRangeLowReclaimed")),

    gapUp: booleanValue(read("gapUp")),
    gapDown: booleanValue(read("gapDown")),
    gapFilled: booleanValue(read("gapFilled")),
    gapHolding: booleanValue(read("gapHolding")),

    openingDriveBullish: booleanValue(read("openingDriveBullish")),
    openingDriveBearish: booleanValue(read("openingDriveBearish")),
    openingReversalBullish: booleanValue(read("openingReversalBullish")),
    openingReversalBearish: booleanValue(read("openingReversalBearish")),

    lunchChopRisk: booleanValue(read("lunchChopRisk")),
    powerHourExpansion: booleanValue(read("powerHourExpansion")),
    extendedHoursThin: booleanValue(read("extendedHoursThin")),

    minutesFromOpen: numberValue(read("minutesFromOpen")),
    minutesToClose: numberValue(read("minutesToClose")),
    sessionRange: numberValue(read("sessionRange")),
    sessionRangePct: numberValue(read("sessionRangePct")),
    gapPct: numberValue(read("gapPct")),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class SessionContextEvaluator implements MarketContextEvaluator {
  readonly id = "session";
  readonly categories = ["session", "structure", "risk"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readSessionInput(context);
    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const confidence = clampConfidence(input.confidence ?? 0.7);
    const price = context.input.bar.close;

    const addEvidence = (
      id: string,
      label: string,
      reason: string,
      polarity: EvidencePolarity,
      scoreImpact: number,
      value?: EvidenceValue,
      category: MarketContextEvidence["category"] = "session",
    ): void => {
      evidence.push({
        id,
        category,
        label,
        reason,
        polarity,
        severity: polarity === "negative" ? "warning" : "supporting",
        weight: 1,
        scoreImpact,
        confidence,
        value,
        source: this.id,
        timeframe: context.input.timeframe,
        timestamp: context.input.timestamp,
      });
    };

    const aboveSessionOpen =
      input.aboveSessionOpen ||
      (finite(input.sessionOpen) && price > input.sessionOpen);

    const belowSessionOpen =
      input.belowSessionOpen ||
      (finite(input.sessionOpen) && price < input.sessionOpen);

    const abovePreviousClose =
      input.abovePreviousClose ||
      (finite(input.previousClose) && price > input.previousClose);

    const belowPreviousClose =
      input.belowPreviousClose ||
      (finite(input.previousClose) && price < input.previousClose);

    if (aboveSessionOpen && abovePreviousClose) {
      addEvidence(
        "session_above_open_and_close",
        "Above session open and prior close",
        "Price is holding above both the session open and previous close.",
        "positive",
        16,
        price,
      );
    }

    if (belowSessionOpen && belowPreviousClose) {
      addEvidence(
        "session_below_open_and_close",
        "Below session open and prior close",
        "Price is holding below both the session open and previous close.",
        "negative",
        16,
        price,
      );
    }

    if (input.openingDriveBullish) {
      addEvidence(
        "session_bullish_opening_drive",
        "Bullish opening drive",
        "Buyers established immediate directional control after the open.",
        "positive",
        22,
        true,
        "structure",
      );
    }

    if (input.openingDriveBearish) {
      addEvidence(
        "session_bearish_opening_drive",
        "Bearish opening drive",
        "Sellers established immediate directional control after the open.",
        "negative",
        22,
        true,
        "structure",
      );
    }

    if (input.openingReversalBullish) {
      addEvidence(
        "session_bullish_opening_reversal",
        "Bullish opening reversal",
        "Early selling failed and buyers reclaimed the opening move.",
        "positive",
        24,
        true,
        "structure",
      );
    }

    if (input.openingReversalBearish) {
      addEvidence(
        "session_bearish_opening_reversal",
        "Bearish opening reversal",
        "Early buying failed and sellers reclaimed the opening move.",
        "negative",
        24,
        true,
        "structure",
      );
    }

    if (input.premarketHighBroken) {
      addEvidence(
        "session_pmh_break",
        "Premarket high broken",
        "Price broke above the premarket high.",
        "positive",
        18,
        input.premarketHigh,
        "structure",
      );
    }

    if (input.premarketLowBroken) {
      addEvidence(
        "session_pml_break",
        "Premarket low broken",
        "Price broke below the premarket low.",
        "negative",
        18,
        input.premarketLow,
        "structure",
      );
    }

    if (input.overnightHighBroken) {
      addEvidence(
        "session_onh_break",
        "Overnight high broken",
        "Price broke above the overnight high.",
        "positive",
        16,
        input.overnightHigh,
        "liquidity",
      );
    }

    if (input.overnightLowBroken) {
      addEvidence(
        "session_onl_break",
        "Overnight low broken",
        "Price broke below the overnight low.",
        "negative",
        16,
        input.overnightLow,
        "liquidity",
      );
    }

    if (input.openingRangeHighBroken) {
      addEvidence(
        "session_orh_break",
        "Opening range high broken",
        "Price broke above the opening range high.",
        "positive",
        20,
        input.openingRangeHigh,
        "entry-quality",
      );
    }

    if (input.openingRangeLowBroken) {
      addEvidence(
        "session_orl_break",
        "Opening range low broken",
        "Price broke below the opening range low.",
        "negative",
        20,
        input.openingRangeLow,
        "entry-quality",
      );
    }

    if (input.firstHourHighBroken) {
      addEvidence(
        "session_first_hour_high_break",
        "First-hour high broken",
        "Price expanded above the first-hour high.",
        "positive",
        18,
        input.firstHourHigh,
        "entry-quality",
      );
    }

    if (input.firstHourLowBroken) {
      addEvidence(
        "session_first_hour_low_break",
        "First-hour low broken",
        "Price expanded below the first-hour low.",
        "negative",
        18,
        input.firstHourLow,
        "entry-quality",
      );
    }

    if (
      input.premarketHighReclaimed ||
      input.overnightHighReclaimed ||
      input.openingRangeHighReclaimed
    ) {
      addEvidence(
        "session_high_reclaimed",
        "Upper session level reclaimed",
        "Price reclaimed a key upper session level after trading below it.",
        "positive",
        20,
        true,
        "liquidity",
      );
    }

    if (
      input.premarketLowReclaimed ||
      input.overnightLowReclaimed ||
      input.openingRangeLowReclaimed
    ) {
      addEvidence(
        "session_low_reclaimed",
        "Lower session level reclaimed",
        "Price reclaimed a key lower session level after trading below it.",
        "positive",
        22,
        true,
        "liquidity",
      );
    }

    if (input.gapUp && input.gapHolding) {
      addEvidence(
        "session_gap_up_holding",
        "Gap up holding",
        "Price is maintaining acceptance above the previous close.",
        "positive",
        16,
        input.gapPct,
      );
    }

    if (input.gapDown && input.gapHolding) {
      addEvidence(
        "session_gap_down_holding",
        "Gap down holding",
        "Price is maintaining acceptance below the previous close.",
        "negative",
        16,
        input.gapPct,
      );
    }

    if (input.gapFilled) {
      addEvidence(
        "session_gap_filled",
        "Gap filled",
        "Price returned to the previous close and neutralized the opening gap.",
        "neutral",
        12,
        true,
      );
    }

    if (input.lunchChopRisk || input.phase === "midday") {
      addEvidence(
        "session_midday_chop",
        "Midday chop risk",
        "Midday conditions often carry lower participation and increased rotation.",
        "neutral",
        18,
        true,
        "risk",
      );
    }

    if (input.powerHourExpansion) {
      addEvidence(
        "session_power_hour_expansion",
        "Power-hour expansion",
        "Late-session participation is expanding directional movement.",
        input.direction === "bearish" ? "negative" : "positive",
        16,
        true,
      );
    }

    if (input.extendedHoursThin) {
      addEvidence(
        "session_thin_extended_hours",
        "Thin extended-hours liquidity",
        "Extended-hours liquidity is thin, increasing slippage and false-break risk.",
        "neutral",
        20,
        true,
        "risk",
      );
    }

    const addMetric = (
      key: string,
      label: string,
      value: number | string,
      unit?: string,
      category: MarketContextMetric["category"] = "session",
    ): void => {
      metrics.push({
        key,
        label,
        category,
        value,
        unit,
        confidence,
        timestamp: context.input.timestamp,
      });
    };

    if (input.phase) {
      addMetric("session.phase", "Session phase", input.phase);
    }
    if (finite(input.sessionOpen)) {
      addMetric("session.open", "Session open", input.sessionOpen, "price");
    }
    if (finite(input.sessionHigh)) {
      addMetric("session.high", "Session high", input.sessionHigh, "price");
    }
    if (finite(input.sessionLow)) {
      addMetric("session.low", "Session low", input.sessionLow, "price");
    }
    if (finite(input.previousClose)) {
      addMetric(
        "session.previousClose",
        "Previous close",
        input.previousClose,
        "price",
      );
    }
    if (finite(input.previousHigh)) {
      addMetric(
        "session.previousHigh",
        "Previous high",
        input.previousHigh,
        "price",
      );
    }
    if (finite(input.previousLow)) {
      addMetric(
        "session.previousLow",
        "Previous low",
        input.previousLow,
        "price",
      );
    }
    if (finite(input.premarketHigh)) {
      addMetric(
        "session.premarketHigh",
        "Premarket high",
        input.premarketHigh,
        "price",
      );
    }
    if (finite(input.premarketLow)) {
      addMetric(
        "session.premarketLow",
        "Premarket low",
        input.premarketLow,
        "price",
      );
    }
    if (finite(input.overnightHigh)) {
      addMetric(
        "session.overnightHigh",
        "Overnight high",
        input.overnightHigh,
        "price",
      );
    }
    if (finite(input.overnightLow)) {
      addMetric(
        "session.overnightLow",
        "Overnight low",
        input.overnightLow,
        "price",
      );
    }
    if (finite(input.openingRangeHigh)) {
      addMetric(
        "session.openingRangeHigh",
        "Opening range high",
        input.openingRangeHigh,
        "price",
      );
    }
    if (finite(input.openingRangeLow)) {
      addMetric(
        "session.openingRangeLow",
        "Opening range low",
        input.openingRangeLow,
        "price",
      );
    }
    if (finite(input.firstHourHigh)) {
      addMetric(
        "session.firstHourHigh",
        "First-hour high",
        input.firstHourHigh,
        "price",
      );
    }
    if (finite(input.firstHourLow)) {
      addMetric(
        "session.firstHourLow",
        "First-hour low",
        input.firstHourLow,
        "price",
      );
    }
    if (finite(input.minutesFromOpen)) {
      addMetric(
        "session.minutesFromOpen",
        "Minutes from open",
        input.minutesFromOpen,
        "minutes",
      );
    }
    if (finite(input.minutesToClose)) {
      addMetric(
        "session.minutesToClose",
        "Minutes to close",
        input.minutesToClose,
        "minutes",
      );
    }
    if (finite(input.sessionRange)) {
      addMetric(
        "session.range",
        "Session range",
        input.sessionRange,
        "price",
      );
    }
    if (finite(input.sessionRangePct)) {
      addMetric(
        "session.rangePct",
        "Session range",
        input.sessionRangePct,
        "%",
      );
    }
    if (finite(input.gapPct)) {
      addMetric("session.gapPct", "Opening gap", input.gapPct, "%");
    }

    if (
      evidence.length === 0 &&
      metrics.length === 0 &&
      !finite(input.score) &&
      !input.direction
    ) {
      return null;
    }

    const signedImpact = evidence.reduce((total, item) => {
      if (item.polarity === "positive") {
        return total + item.scoreImpact * item.weight * item.confidence;
      }
      if (item.polarity === "negative") {
        return total - item.scoreImpact * item.weight * item.confidence;
      }
      return total;
    }, 0);

    const direction =
      input.direction ?? directionFromSignedScore(signedImpact);

    const evidenceScore = scoreEvidence(evidence);

    const rawScore = finite(input.score)
      ? input.score
      : direction === "neutral"
        ? evidenceScore.score
        : clampScore(50 + Math.min(50, Math.abs(signedImpact)));

    const scored = buildScoredContext({
      score: rawScore,
      confidence:
        input.confidence ?? evidenceScore.confidence ?? confidence,
      direction,
    });

    const reasons = evidence.map(createReason);

    const component: MarketContextComponent = {
      id: "session",
      category: "session",
      label: "Session Context",
      summary:
        input.phase === "midday"
          ? "Midday conditions increase chop risk and reduce directional reliability."
          : input.phase === "power-hour"
            ? "Power hour may increase participation and directional expansion."
            : direction === "bullish"
              ? "Session structure favors bullish continuation."
              : direction === "bearish"
                ? "Session structure favors bearish continuation."
                : "Session direction is mixed or rotational.",
      status: statusFromPhase(input.phase, scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "session.score",
          label: "Session context score",
          category: "session",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "session",
        direction,
        input.phase ?? "",
        input.openingDriveBullish ? "bullish-opening-drive" : "",
        input.openingDriveBearish ? "bearish-opening-drive" : "",
        input.lunchChopRisk ? "midday-chop-risk" : "",
        input.powerHourExpansion ? "power-hour-expansion" : "",
        input.extendedHoursThin ? "thin-extended-hours" : "",
        input.gapUp ? "gap-up" : "",
        input.gapDown ? "gap-down" : "",
        input.gapFilled ? "gap-filled" : "",
      ].filter(Boolean),
      updatedAt: context.now,
    };

    return {
      components: [component],
      evidence,
      reasons,
      metrics: component.metrics,
      tags: component.tags,
    };
  }
}

export default SessionContextEvaluator;
