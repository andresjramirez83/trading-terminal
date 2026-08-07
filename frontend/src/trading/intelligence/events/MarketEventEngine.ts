// src/trading/intelligence/events/MarketEventEngine.ts

/**
 * Converts sequential MarketContextSnapshot values into a deterministic,
 * reusable timeline of meaningful market events.
 *
 * The engine does not generate entries or trading signals. It records how the
 * market evolved so Narrative, Coach, Decision Center, Replay, Journal,
 * Trading DNA, Scanner, and Auto Trader can all reason from the same sequence.
 */

import type {
  MarketContextComponent,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextMetric,
  MarketContextSnapshot,
  MarketRegime,
  MarketSession,
} from "../types/MarketContextTypes";
import type { IntelligenceRegistryRuntime } from "../core/IntelligenceRegistry";

export type MarketEventCategory =
  | "session"
  | "structure"
  | "liquidity"
  | "vwap"
  | "momentum"
  | "participation"
  | "volatility"
  | "compression"
  | "expansion"
  | "balance"
  | "trend"
  | "fair-value-gap"
  | "objective"
  | "risk"
  | "thesis"
  | "custom";

export type MarketEventType =
  | "session-opened"
  | "session-changed"
  | "liquidity-swept-high"
  | "liquidity-swept-low"
  | "liquidity-reclaimed"
  | "liquidity-failed"
  | "vwap-reclaimed"
  | "vwap-lost"
  | "vwap-crossed-up"
  | "vwap-crossed-down"
  | "break-of-structure-bullish"
  | "break-of-structure-bearish"
  | "change-of-character-bullish"
  | "change-of-character-bearish"
  | "higher-high-confirmed"
  | "higher-low-confirmed"
  | "lower-high-confirmed"
  | "lower-low-confirmed"
  | "trend-started"
  | "trend-strengthened"
  | "trend-weakened"
  | "trend-ended"
  | "compression-started"
  | "compression-strengthened"
  | "compression-released"
  | "expansion-started"
  | "expansion-strengthened"
  | "expansion-faded"
  | "balance-started"
  | "balance-broken-up"
  | "balance-broken-down"
  | "balance-restored"
  | "momentum-expanded-bullish"
  | "momentum-expanded-bearish"
  | "momentum-weakened"
  | "participation-increased"
  | "participation-decreased"
  | "volatility-expanded"
  | "volatility-contracted"
  | "fair-value-gap-created-bullish"
  | "fair-value-gap-created-bearish"
  | "fair-value-gap-mitigated"
  | "fair-value-gap-invalidated"
  | "regime-changed"
  | "direction-changed"
  | "thesis-confirmed"
  | "thesis-weakened"
  | "thesis-invalidated"
  | "objective-reached"
  | "risk-increased"
  | "risk-decreased"
  | "custom";

export type MarketEventImportance = "low" | "medium" | "high" | "critical";
export type MarketEventStatus = "active" | "confirmed" | "resolved" | "invalidated";

export interface MarketEvent {
  id: string;
  symbol: string;
  timeframe: string;
  tradingDate?: string;
  timestamp: number;
  barIndex?: number;
  sequence: number;
  category: MarketEventCategory;
  type: MarketEventType;
  title: string;
  description: string;
  direction: MarketContextDirection;
  importance: MarketEventImportance;
  status: MarketEventStatus;
  confidence: number;
  score: number;
  price?: number;
  level?: number;
  previousValue?: string | number | boolean | null;
  currentValue?: string | number | boolean | null;
  sourceSnapshotId: string;
  sourceComponentIds: string[];
  evidenceIds: string[];
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface MarketEventTimeline {
  id: string;
  symbol: string;
  timeframe: string;
  tradingDate?: string;
  createdAt: number;
  updatedAt: number;
  firstTimestamp: number;
  lastTimestamp: number;
  latestSnapshotId: string;
  events: MarketEvent[];
  activeEventIds: string[];
  dominantDirection: MarketContextDirection;
  currentRegime: MarketRegime;
  currentSession: MarketSession;
  sequenceSummary: string[];
  tags: string[];
}

export interface MarketEventEngineInput {
  current: MarketContextSnapshot;
  previous?: MarketContextSnapshot | null;
  timeline?: MarketEventTimeline | null;
}

export interface MarketEventEngineOptions {
  now?: () => number;
  maxEvents?: number;
  minimumConfidence?: number;
  minimumScoreChange?: number;
  dedupeWindowBars?: number;
}

export interface MarketEventContribution {
  timeline: MarketEventTimeline;
  newEvents: MarketEvent[];
  resolvedEventIds: string[];
  tags: string[];
  metadata: Record<string, unknown>;
}

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MIN_CONFIDENCE = 0.45;
const DEFAULT_SCORE_CHANGE = 0.12;
const DEFAULT_DEDUPE_WINDOW = 2;

const COMPONENT_IDS = {
  structure: ["market-structure", "structure"],
  liquidity: ["liquidity"],
  vwap: ["vwap"],
  momentum: ["momentum"],
  participation: ["participation", "volume"],
  volatility: ["volatility"],
  compression: ["compression"],
  balance: ["balance"],
  trend: ["trend"],
  fvg: ["fair-value-gap", "fvg", "ifvg"],
  risk: ["risk"],
} as const;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeScore(value: unknown, fallback = 0.5): number {
  if (!finite(value)) return fallback;
  return clamp01(value > 1 ? value / 100 : value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function titleCase(value: string): string {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function eventId(snapshot: MarketContextSnapshot, type: MarketEventType, sequence: number): string {
  return [snapshot.symbol, snapshot.timeframe, snapshot.timestamp, type, sequence]
    .join(":")
    .replace(/[^a-zA-Z0-9:_-]/g, "_");
}

function findComponent(
  snapshot: MarketContextSnapshot,
  ids: readonly string[],
): MarketContextComponent | undefined {
  return snapshot.components.find(
    (component) => ids.includes(component.id) || ids.includes(String(component.category)),
  );
}

function allMetrics(snapshot: MarketContextSnapshot): MarketContextMetric[] {
  return [...snapshot.metrics, ...snapshot.components.flatMap((component) => component.metrics)];
}

function metric(snapshot: MarketContextSnapshot, keys: readonly string[]): unknown {
  return allMetrics(snapshot).find((item) => keys.includes(item.key))?.value;
}

function metricNumber(snapshot: MarketContextSnapshot, keys: readonly string[]): number | undefined {
  const value = metric(snapshot, keys);
  return finite(value) ? value : undefined;
}

function metricBoolean(snapshot: MarketContextSnapshot, keys: readonly string[]): boolean | undefined {
  const value = metric(snapshot, keys);
  return typeof value === "boolean" ? value : undefined;
}

function componentScore(snapshot: MarketContextSnapshot, ids: readonly string[]): number {
  const component = findComponent(snapshot, ids);
  if (!component) return 0.5;
  return normalizeScore(component.normalizedScore, normalizeScore(component.score));
}

function componentConfidence(snapshot: MarketContextSnapshot, ids: readonly string[]): number {
  const component = findComponent(snapshot, ids);
  return component ? normalizeScore(component.confidence) : normalizeScore(snapshot.confidence);
}

function hasTag(snapshot: MarketContextSnapshot, ...tags: string[]): boolean {
  const available = new Set(
    [
      ...snapshot.tags,
      ...snapshot.components.flatMap((component) => component.tags),
      ...snapshot.evidence.map((item) => item.id),
      ...snapshot.evidence.map((item) => item.label),
    ].map((value) => value.toLowerCase()),
  );
  return tags.some((tag) => available.has(tag.toLowerCase()));
}

function evidenceFor(
  snapshot: MarketContextSnapshot,
  phrases: readonly string[],
): MarketContextEvidence[] {
  const normalized = phrases.map((phrase) => phrase.toLowerCase());
  return snapshot.evidence.filter((item) => {
    const text = `${item.id} ${item.label} ${item.reason}`.toLowerCase();
    return normalized.some((phrase) => text.includes(phrase));
  });
}

function importanceFromConfidence(confidence: number, structural = false): MarketEventImportance {
  if (structural && confidence >= 0.85) return "critical";
  if (confidence >= 0.78) return "high";
  if (confidence >= 0.58) return "medium";
  return "low";
}

function directionFromRegime(regime: MarketRegime): MarketContextDirection {
  if (regime.includes("uptrend") || regime.startsWith("bullish") || regime === "breakout") {
    return "bullish";
  }
  if (regime.includes("downtrend") || regime.startsWith("bearish") || regime === "breakdown") {
    return "bearish";
  }
  return "neutral";
}

interface EventDraft {
  category: MarketEventCategory;
  type: MarketEventType;
  title: string;
  description: string;
  direction: MarketContextDirection;
  confidence: number;
  score?: number;
  importance?: MarketEventImportance;
  status?: MarketEventStatus;
  price?: number;
  level?: number;
  previousValue?: string | number | boolean | null;
  currentValue?: string | number | boolean | null;
  sourceComponentIds?: string[];
  evidenceIds?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

function buildEvent(
  snapshot: MarketContextSnapshot,
  sequence: number,
  draft: EventDraft,
): MarketEvent {
  const confidence = clamp01(draft.confidence);
  return {
    id: eventId(snapshot, draft.type, sequence),
    symbol: snapshot.symbol,
    timeframe: snapshot.timeframe,
    tradingDate: snapshot.tradingDate,
    timestamp: snapshot.timestamp,
    barIndex: snapshot.barIndex,
    sequence,
    category: draft.category,
    type: draft.type,
    title: draft.title,
    description: draft.description,
    direction: draft.direction,
    importance: draft.importance ?? importanceFromConfidence(confidence),
    status: draft.status ?? "confirmed",
    confidence,
    score: clamp01(draft.score ?? confidence),
    price: draft.price,
    level: draft.level,
    previousValue: draft.previousValue,
    currentValue: draft.currentValue,
    sourceSnapshotId: snapshot.id,
    sourceComponentIds: unique(draft.sourceComponentIds ?? []),
    evidenceIds: unique(draft.evidenceIds ?? []),
    tags: unique(draft.tags ?? []),
    metadata: { ...(draft.metadata ?? {}) },
  };
}

function detectSessionEvents(current: MarketContextSnapshot, previous?: MarketContextSnapshot | null): EventDraft[] {
  if (!previous) {
    return [{
      category: "session",
      type: "session-opened",
      title: `${titleCase(current.session)} Session Active`,
      description: `The ${titleCase(current.session)} session is now the active market session.`,
      direction: "neutral",
      confidence: 1,
      currentValue: current.session,
      tags: ["session", current.session],
    }];
  }
  if (current.session !== previous.session) {
    return [{
      category: "session",
      type: "session-changed",
      title: `Session Changed to ${titleCase(current.session)}`,
      description: `Market context transitioned from ${titleCase(previous.session)} to ${titleCase(current.session)}.`,
      direction: "neutral",
      confidence: 1,
      previousValue: previous.session,
      currentValue: current.session,
      tags: ["session-transition", current.session],
    }];
  }
  return [];
}

function detectRegimeEvents(current: MarketContextSnapshot, previous?: MarketContextSnapshot | null): EventDraft[] {
  if (!previous || current.regime.regime === previous.regime.regime) return [];
  const direction = directionFromRegime(current.regime.regime);
  const confidence = normalizeScore(current.regime.confidence);
  return [{
    category: "trend",
    type: "regime-changed",
    title: `Regime Changed to ${titleCase(current.regime.regime)}`,
    description: `The market regime changed from ${titleCase(previous.regime.regime)} to ${titleCase(current.regime.regime)}.`,
    direction,
    confidence,
    importance: importanceFromConfidence(confidence, true),
    previousValue: previous.regime.regime,
    currentValue: current.regime.regime,
    evidenceIds: current.regime.supportingEvidenceIds,
    tags: ["regime-change", current.regime.family, current.regime.regime],
  }];
}

function detectDirectionEvents(current: MarketContextSnapshot, previous?: MarketContextSnapshot | null): EventDraft[] {
  if (!previous || current.direction === previous.direction) return [];
  return [{
    category: "thesis",
    type: "direction-changed",
    title: `Market Direction Shifted ${titleCase(current.direction)}`,
    description: `The aggregate market direction changed from ${titleCase(previous.direction)} to ${titleCase(current.direction)}.`,
    direction: current.direction,
    confidence: normalizeScore(current.confidence),
    importance: "high",
    previousValue: previous.direction,
    currentValue: current.direction,
    evidenceIds: current.evidence.map((item) => item.id),
    tags: ["direction-change", current.direction],
  }];
}

function detectStructureEvents(current: MarketContextSnapshot, previous?: MarketContextSnapshot | null): EventDraft[] {
  const structure = current.input?.structure;
  const prior = previous?.input?.structure;
  const confidence = componentConfidence(current, COMPONENT_IDS.structure);
  const evidence = evidenceFor(current, ["break of structure", "change of character", "higher high", "higher low", "lower high", "lower low"]);
  const evidenceIds = evidence.map((item) => item.id);
  const drafts: EventDraft[] = [];

  if (structure?.breakOfStructure && !prior?.breakOfStructure) {
    const direction = structure.direction ?? current.direction;
    drafts.push({
      category: "structure",
      type: direction === "bearish" ? "break-of-structure-bearish" : "break-of-structure-bullish",
      title: `${titleCase(direction)} Break of Structure`,
      description: `${titleCase(direction)} market structure confirmed a break beyond the prior structural boundary.`,
      direction,
      confidence,
      importance: "critical",
      sourceComponentIds: ["market-structure"],
      evidenceIds,
      tags: ["structure", "break-of-structure", direction],
    });
  }

  if (structure?.changeOfCharacter && !prior?.changeOfCharacter) {
    const direction = structure.direction ?? current.direction;
    drafts.push({
      category: "structure",
      type: direction === "bearish" ? "change-of-character-bearish" : "change-of-character-bullish",
      title: `${titleCase(direction)} Change of Character`,
      description: `Price behavior shifted toward a ${direction} structural sequence.`,
      direction,
      confidence,
      importance: "high",
      sourceComponentIds: ["market-structure"],
      evidenceIds,
      tags: ["structure", "change-of-character", direction],
    });
  }

  const confirmations: Array<[boolean | undefined, boolean | undefined, MarketEventType, string, MarketContextDirection]> = [
    [structure?.higherHighs, prior?.higherHighs, "higher-high-confirmed", "Higher High Confirmed", "bullish"],
    [structure?.higherLows, prior?.higherLows, "higher-low-confirmed", "Higher Low Confirmed", "bullish"],
    [structure?.lowerHighs, prior?.lowerHighs, "lower-high-confirmed", "Lower High Confirmed", "bearish"],
    [structure?.lowerLows, prior?.lowerLows, "lower-low-confirmed", "Lower Low Confirmed", "bearish"],
  ];

  for (const [active, wasActive, type, title, direction] of confirmations) {
    if (active && !wasActive) {
      drafts.push({
        category: "structure",
        type,
        title,
        description: `${title} within the current market structure sequence.`,
        direction,
        confidence,
        sourceComponentIds: ["market-structure"],
        evidenceIds,
        tags: ["structure", type],
      });
    }
  }

  /**
   * higherHighs/lowerLows are regime flags in ChartState: once a bearish
   * sequence is active, lowerLows stays true. Detect changes in the protected
   * swing prices too so every newly confirmed LL/LH (or HH/HL) can become a
   * fresh intelligence event instead of only the first one in the sequence.
   */
  if (prior) {
    const levelChanged = (
      currentLevel: number | undefined,
      previousLevel: number | undefined,
      comparison: "higher" | "lower",
    ): boolean => {
      if (!finite(currentLevel) || !finite(previousLevel)) return false;
      const epsilon = Math.max(1e-8, Math.abs(previousLevel) * 1e-8);
      return comparison === "higher"
        ? currentLevel > previousLevel + epsilon
        : currentLevel < previousLevel - epsilon;
    };

    const repeatedConfirmations: Array<{
      active: boolean | undefined;
      wasActive: boolean | undefined;
      currentLevel: number | undefined;
      previousLevel: number | undefined;
      comparison: "higher" | "lower";
      type: MarketEventType;
      title: string;
      direction: MarketContextDirection;
    }> = [
      {
        active: structure?.higherHighs,
        wasActive: prior?.higherHighs,
        currentLevel: structure?.lastSwingHigh,
        previousLevel: prior?.lastSwingHigh,
        comparison: "higher",
        type: "higher-high-confirmed",
        title: "Higher High Confirmed",
        direction: "bullish",
      },
      {
        active: structure?.higherLows,
        wasActive: prior?.higherLows,
        currentLevel: structure?.lastSwingLow,
        previousLevel: prior?.lastSwingLow,
        comparison: "higher",
        type: "higher-low-confirmed",
        title: "Higher Low Confirmed",
        direction: "bullish",
      },
      {
        active: structure?.lowerHighs,
        wasActive: prior?.lowerHighs,
        currentLevel: structure?.lastSwingHigh,
        previousLevel: prior?.lastSwingHigh,
        comparison: "lower",
        type: "lower-high-confirmed",
        title: "Lower High Confirmed",
        direction: "bearish",
      },
      {
        active: structure?.lowerLows,
        wasActive: prior?.lowerLows,
        currentLevel: structure?.lastSwingLow,
        previousLevel: prior?.lastSwingLow,
        comparison: "lower",
        type: "lower-low-confirmed",
        title: "Lower Low Confirmed",
        direction: "bearish",
      },
    ];

    for (const item of repeatedConfirmations) {
      if (
        item.active &&
        item.wasActive &&
        levelChanged(
          item.currentLevel,
          item.previousLevel,
          item.comparison,
        )
      ) {
        drafts.push({
          category: "structure",
          type: item.type,
          title: item.title,
          description: `${item.title} at ${item.currentLevel?.toFixed(2)} within the active ${item.direction} market structure sequence.`,
          direction: item.direction,
          confidence,
          importance: "high",
          price: item.currentLevel,
          level: item.currentLevel,
          previousValue: item.previousLevel,
          currentValue: item.currentLevel,
          sourceComponentIds: ["market-structure"],
          evidenceIds,
          tags: ["structure", item.type, item.direction, "new-swing"],
        });
      }
    }
  }

  return drafts;
}

function detectVwapEvents(current: MarketContextSnapshot, previous?: MarketContextSnapshot | null): EventDraft[] {
  if (!previous) return [];
  const currentPrice = current.input?.price.last ?? current.input?.price.close;
  const previousPrice = previous.input?.price.last ?? previous.input?.price.close;
  const currentVwap = current.input?.indicators.vwap ?? metricNumber(current, ["vwap", "session-vwap"]);
  const previousVwap = previous.input?.indicators.vwap ?? metricNumber(previous, ["vwap", "session-vwap"]);
  if (![currentPrice, previousPrice, currentVwap, previousVwap].every(finite)) return [];

  const wasAbove = (previousPrice as number) >= (previousVwap as number);
  const isAbove = (currentPrice as number) >= (currentVwap as number);
  if (wasAbove === isAbove) return [];

  const confidence = componentConfidence(current, COMPONENT_IDS.vwap);
  const reclaimed = isAbove;
  return [{
    category: "vwap",
    type: reclaimed ? "vwap-reclaimed" : "vwap-lost",
    title: reclaimed ? "VWAP Reclaimed" : "VWAP Lost",
    description: reclaimed
      ? "Price crossed back above VWAP, signaling renewed acceptance above session value."
      : "Price crossed below VWAP, signaling loss of acceptance above session value.",
    direction: reclaimed ? "bullish" : "bearish",
    confidence,
    importance: confidence >= 0.75 ? "high" : "medium",
    price: currentPrice as number,
    level: currentVwap as number,
    sourceComponentIds: ["vwap"],
    evidenceIds: evidenceFor(current, ["vwap"]).map((item) => item.id),
    tags: ["vwap", reclaimed ? "reclaim" : "loss"],
  }];
}

function detectLiquidityEvents(current: MarketContextSnapshot, previous?: MarketContextSnapshot | null): EventDraft[] {
  const drafts: EventDraft[] = [];
  const confidence = componentConfidence(current, COMPONENT_IDS.liquidity);
  const evidence = evidenceFor(current, ["liquidity", "sweep", "reclaim", "failed"]);
  const currentTags = new Set([
    ...current.tags,
    ...findComponent(current, COMPONENT_IDS.liquidity)?.tags ?? [],
  ].map((tag) => tag.toLowerCase()));
  const previousTags = new Set([
    ...(previous?.tags ?? []),
    ...(findComponent(previous ?? current, COMPONENT_IDS.liquidity)?.tags ?? []),
  ].map((tag) => tag.toLowerCase()));

  const addOnNewTag = (
    tags: readonly string[],
    type: MarketEventType,
    title: string,
    description: string,
    direction: MarketContextDirection,
  ) => {
    const active = tags.some((tag) => currentTags.has(tag));
    const wasActive = tags.some((tag) => previousTags.has(tag));
    if (active && !wasActive) {
      drafts.push({
        category: "liquidity",
        type,
        title,
        description,
        direction,
        confidence,
        importance: "high",
        sourceComponentIds: ["liquidity"],
        evidenceIds: evidence.map((item) => item.id),
        tags: ["liquidity", ...tags],
      });
    }
  };

  addOnNewTag(
    ["liquidity-sweep-high", "high-sweep", "buy-side-sweep"],
    "liquidity-swept-high",
    "Buy-Side Liquidity Swept",
    "Price traded through a prior high and consumed buy-side liquidity.",
    "bearish",
  );
  addOnNewTag(
    ["liquidity-sweep-low", "low-sweep", "sell-side-sweep"],
    "liquidity-swept-low",
    "Sell-Side Liquidity Swept",
    "Price traded through a prior low and consumed sell-side liquidity.",
    "bullish",
  );
  addOnNewTag(
    ["liquidity-reclaimed", "sweep-reclaimed"],
    "liquidity-reclaimed",
    "Liquidity Sweep Reclaimed",
    "Price reclaimed the swept level, confirming rejection beyond liquidity.",
    current.direction,
  );
  addOnNewTag(
    ["liquidity-failed", "sweep-failed"],
    "liquidity-failed",
    "Liquidity Reclaim Failed",
    "Price failed to hold the reclaimed liquidity level.",
    current.direction === "bullish" ? "bearish" : "bullish",
  );

  return drafts;
}

function detectComponentTransitions(
  current: MarketContextSnapshot,
  previous: MarketContextSnapshot | null | undefined,
  minimumScoreChange: number,
): EventDraft[] {
  if (!previous) return [];
  const drafts: EventDraft[] = [];

  const transition = (
    ids: readonly string[],
    category: MarketEventCategory,
    risingType: MarketEventType,
    fallingType: MarketEventType,
    risingTitle: string,
    fallingTitle: string,
    risingDirection: MarketContextDirection,
    fallingDirection: MarketContextDirection,
  ) => {
    const currentScore = componentScore(current, ids);
    const priorScore = componentScore(previous, ids);
    const change = currentScore - priorScore;
    if (Math.abs(change) < minimumScoreChange) return;
    const rising = change > 0;
    const confidence = componentConfidence(current, ids);
    drafts.push({
      category,
      type: rising ? risingType : fallingType,
      title: rising ? risingTitle : fallingTitle,
      description: `${rising ? risingTitle : fallingTitle}; component strength changed from ${Math.round(priorScore * 100)} to ${Math.round(currentScore * 100)}.`,
      direction: rising ? risingDirection : fallingDirection,
      confidence,
      score: Math.min(1, Math.abs(change) + confidence * 0.5),
      previousValue: Math.round(priorScore * 100),
      currentValue: Math.round(currentScore * 100),
      sourceComponentIds: [...ids],
      tags: [category, rising ? "strengthening" : "weakening"],
      metadata: { scoreChange: change },
    });
  };

  transition(COMPONENT_IDS.momentum, "momentum", "momentum-expanded-bullish", "momentum-weakened", "Momentum Expanded", "Momentum Weakened", current.direction, "neutral");
  transition(COMPONENT_IDS.participation, "participation", "participation-increased", "participation-decreased", "Participation Increased", "Participation Decreased", current.direction, "neutral");
  transition(COMPONENT_IDS.volatility, "volatility", "volatility-expanded", "volatility-contracted", "Volatility Expanded", "Volatility Contracted", current.direction, "neutral");
  transition(COMPONENT_IDS.compression, "compression", "compression-strengthened", "compression-released", "Compression Strengthened", "Compression Released", "neutral", current.direction);
  transition(COMPONENT_IDS.trend, "trend", "trend-strengthened", "trend-weakened", "Trend Strengthened", "Trend Weakened", current.direction, "neutral");
  transition(COMPONENT_IDS.risk, "risk", "risk-increased", "risk-decreased", "Trade Risk Increased", "Trade Risk Decreased", "neutral", "neutral");

  return drafts;
}

function detectStateTransitions(current: MarketContextSnapshot, previous?: MarketContextSnapshot | null): EventDraft[] {
  if (!previous) return [];
  const drafts: EventDraft[] = [];
  const currentRegime = current.regime.regime;
  const priorRegime = previous.regime.regime;
  const confidence = normalizeScore(current.regime.confidence);

  const isCompression = currentRegime === "compression" || current.regime.family === "compression";
  const wasCompression = priorRegime === "compression" || previous.regime.family === "compression";
  if (isCompression && !wasCompression) {
    drafts.push({
      category: "compression",
      type: "compression-started",
      title: "Compression Started",
      description: "Price action entered a tighter, lower-expansion state.",
      direction: "neutral",
      confidence,
      tags: ["compression", "forming"],
    });
  }
  if (!isCompression && wasCompression) {
    drafts.push({
      category: "compression",
      type: "compression-released",
      title: "Compression Released",
      description: "Price exited compression and began resolving into a broader move.",
      direction: current.direction,
      confidence,
      importance: "high",
      tags: ["compression", "release"],
    });
  }

  const isExpansion = current.regime.family === "expansion" || ["breakout", "breakdown", "bullish-expansion", "bearish-expansion"].includes(currentRegime);
  const wasExpansion = previous.regime.family === "expansion" || ["breakout", "breakdown", "bullish-expansion", "bearish-expansion"].includes(priorRegime);
  if (isExpansion && !wasExpansion) {
    drafts.push({
      category: "expansion",
      type: "expansion-started",
      title: `${titleCase(current.direction)} Expansion Started`,
      description: "Range and directional movement expanded beyond the prior market state.",
      direction: current.direction,
      confidence,
      importance: "high",
      tags: ["expansion", current.direction],
    });
  }
  if (!isExpansion && wasExpansion) {
    drafts.push({
      category: "expansion",
      type: "expansion-faded",
      title: "Expansion Faded",
      description: "The prior expansion lost strength and transitioned into a different state.",
      direction: "neutral",
      confidence,
      tags: ["expansion", "faded"],
    });
  }

  const isBalance = current.regime.family === "range" || currentRegime === "range";
  const wasBalance = previous.regime.family === "range" || priorRegime === "range";
  if (isBalance && !wasBalance) {
    drafts.push({
      category: "balance",
      type: "balance-started",
      title: "Balanced Auction Started",
      description: "Price transitioned into a two-sided auction with reduced directional control.",
      direction: "neutral",
      confidence,
      tags: ["balance", "range"],
    });
  }
  if (!isBalance && wasBalance && currentRegime === "breakout") {
    drafts.push({
      category: "balance",
      type: "balance-broken-up",
      title: "Balance Broke Higher",
      description: "Price accepted above the prior balanced range.",
      direction: "bullish",
      confidence,
      importance: "high",
      tags: ["balance-break", "bullish"],
    });
  }
  if (!isBalance && wasBalance && currentRegime === "breakdown") {
    drafts.push({
      category: "balance",
      type: "balance-broken-down",
      title: "Balance Broke Lower",
      description: "Price accepted below the prior balanced range.",
      direction: "bearish",
      confidence,
      importance: "high",
      tags: ["balance-break", "bearish"],
    });
  }

  return drafts;
}

function detectFvgEvents(current: MarketContextSnapshot, previous?: MarketContextSnapshot | null): EventDraft[] {
  const drafts: EventDraft[] = [];
  const currentComponent = findComponent(current, COMPONENT_IDS.fvg);
  const previousComponent = previous ? findComponent(previous, COMPONENT_IDS.fvg) : undefined;
  const currentTags = new Set((currentComponent?.tags ?? []).map((tag) => tag.toLowerCase()));
  const previousTags = new Set((previousComponent?.tags ?? []).map((tag) => tag.toLowerCase()));
  const confidence = currentComponent ? normalizeScore(currentComponent.confidence) : normalizeScore(current.confidence);
  const evidenceIds = currentComponent?.evidence.map((item) => item.id) ?? [];

  const add = (
    candidates: readonly string[],
    type: MarketEventType,
    title: string,
    description: string,
    direction: MarketContextDirection,
  ) => {
    if (candidates.some((tag) => currentTags.has(tag)) && !candidates.some((tag) => previousTags.has(tag))) {
      drafts.push({
        category: "fair-value-gap",
        type,
        title,
        description,
        direction,
        confidence,
        sourceComponentIds: [currentComponent?.id ?? "fair-value-gap"],
        evidenceIds,
        tags: ["fvg", ...candidates],
      });
    }
  };

  add(["bullish-fvg-created", "bullish-fvg", "bullish-ifvg"], "fair-value-gap-created-bullish", "Bullish Fair Value Gap Created", "Bullish displacement left an imbalance below current price.", "bullish");
  add(["bearish-fvg-created", "bearish-fvg", "bearish-ifvg"], "fair-value-gap-created-bearish", "Bearish Fair Value Gap Created", "Bearish displacement left an imbalance above current price.", "bearish");
  add(["fvg-mitigated", "mitigated"], "fair-value-gap-mitigated", "Fair Value Gap Mitigated", "Price revisited and partially or fully filled the active imbalance.", "neutral");
  add(["fvg-invalidated", "ifvg-failed", "invalidated"], "fair-value-gap-invalidated", "Fair Value Gap Invalidated", "Price invalidated the active imbalance thesis.", "neutral");

  return drafts;
}

function isDuplicate(
  existing: readonly MarketEvent[],
  draft: EventDraft,
  current: MarketContextSnapshot,
  dedupeWindowBars: number,
): boolean {
  return existing.some((event) => {
    if (event.type !== draft.type || event.direction !== draft.direction) return false;
    if (finite(current.barIndex) && finite(event.barIndex)) {
      return Math.abs((current.barIndex as number) - (event.barIndex as number)) <= dedupeWindowBars;
    }
    return event.timestamp === current.timestamp;
  });
}

function summarize(events: readonly MarketEvent[], limit = 8): string[] {
  return events
    .slice(-limit)
    .map((event) => event.title);
}

function activeEventIds(events: readonly MarketEvent[]): string[] {
  return events
    .filter((event) => event.status === "active" || event.status === "confirmed")
    .slice(-30)
    .map((event) => event.id);
}

function resolveDominantDirection(events: readonly MarketEvent[], fallback: MarketContextDirection): MarketContextDirection {
  const recent = events.slice(-20);
  let bullish = 0;
  let bearish = 0;
  for (const event of recent) {
    const weight = event.score * event.confidence * (event.importance === "critical" ? 1.5 : event.importance === "high" ? 1.25 : 1);
    if (event.direction === "bullish") bullish += weight;
    if (event.direction === "bearish") bearish += weight;
  }
  if (Math.abs(bullish - bearish) < 0.35) return fallback;
  return bullish > bearish ? "bullish" : "bearish";
}

function isMarketContextSnapshot(
  value: unknown,
): value is MarketContextSnapshot {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<MarketContextSnapshot>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.symbol === "string" &&
    typeof candidate.timeframe === "string" &&
    typeof candidate.timestamp === "number" &&
    Array.isArray(candidate.components) &&
    Array.isArray(candidate.metrics) &&
    Array.isArray(candidate.evidence) &&
    Array.isArray(candidate.tags)
  );
}

function extractContextFromSharedValue(
  value: unknown,
): MarketContextSnapshot | null {
  if (isMarketContextSnapshot(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;

  const candidates = [
    record.context,
    record.snapshot,
    record.current,
    record.marketContext,
    record.result,
  ];

  for (const candidate of candidates) {
    if (isMarketContextSnapshot(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCurrentContext(
  runtime: IntelligenceRegistryRuntime,
): MarketContextSnapshot | null {
  if (isMarketContextSnapshot(runtime.report?.context)) {
    return runtime.report.context;
  }

  const preferredKeys = [
    "market-context",
    "market-context:current",
    "market-context-engine",
    "market-context-snapshot",
    "context",
  ];

  for (const key of preferredKeys) {
    const context = extractContextFromSharedValue(
      runtime.shared.get(key),
    );

    if (context) {
      return context;
    }
  }

  /**
   * Registration runtimes commonly store a component's contribution under
   * its registration id. Search every shared value as a final safe fallback
   * so the event engine is not coupled to one hard-coded storage key.
   */
  for (const value of runtime.shared.values()) {
    const context = extractContextFromSharedValue(value);

    if (context) {
      return context;
    }
  }

  return null;
}

function extractRuntimeInput(
  runtime: IntelligenceRegistryRuntime,
): MarketEventEngineInput {
  const current = resolveCurrentContext(runtime);

  if (!current) {
    throw new Error(
      "MarketEventEngine could not locate the current MarketContextSnapshot in runtime.report or runtime.shared.",
    );
  }

  const previous = runtime.shared.get("market-context:previous");
  const timeline = runtime.shared.get("market-events:timeline");

  return {
    current,
    previous: isMarketContextSnapshot(previous)
      ? previous
      : null,
    timeline:
      timeline && typeof timeline === "object"
        ? (timeline as MarketEventTimeline)
        : null,
  };
}

export class MarketEventEngine {
  public readonly id = "market-event-engine";

  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly minimumConfidence: number;
  private readonly minimumScoreChange: number;
  private readonly dedupeWindowBars: number;

  public constructor(options: MarketEventEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEvents = Math.max(25, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
    this.minimumConfidence = clamp01(options.minimumConfidence ?? DEFAULT_MIN_CONFIDENCE);
    this.minimumScoreChange = clamp01(options.minimumScoreChange ?? DEFAULT_SCORE_CHANGE);
    this.dedupeWindowBars = Math.max(0, Math.floor(options.dedupeWindowBars ?? DEFAULT_DEDUPE_WINDOW));
  }

  public build(input: MarketEventEngineInput): MarketEventContribution {
    const { current, previous } = input;
    const existing = input.timeline?.events ?? [];

    const drafts: EventDraft[] = [
      ...detectSessionEvents(current, previous),
      ...detectRegimeEvents(current, previous),
      ...detectDirectionEvents(current, previous),
      ...detectStructureEvents(current, previous),
      ...detectVwapEvents(current, previous),
      ...detectLiquidityEvents(current, previous),
      ...detectComponentTransitions(current, previous, this.minimumScoreChange),
      ...detectStateTransitions(current, previous),
      ...detectFvgEvents(current, previous),
    ];

    const accepted = drafts
      .filter((draft) => draft.confidence >= this.minimumConfidence)
      .filter((draft) => !isDuplicate(existing, draft, current, this.dedupeWindowBars));

    const newEvents = accepted.map((draft, index) =>
      buildEvent(current, existing.length + index + 1, draft),
    );

    const combined = [...existing, ...newEvents].slice(-this.maxEvents);
    const now = this.now();
    const firstTimestamp = combined[0]?.timestamp ?? current.timestamp;
    const tags = unique([
      ...combined.slice(-30).flatMap((event) => event.tags),
      current.regime.family,
      current.regime.regime,
      current.direction,
      current.session,
    ]);

    const timeline: MarketEventTimeline = {
      id: input.timeline?.id ?? `${current.symbol}:${current.timeframe}:${current.tradingDate ?? "session"}`,
      symbol: current.symbol,
      timeframe: current.timeframe,
      tradingDate: current.tradingDate,
      createdAt: input.timeline?.createdAt ?? now,
      updatedAt: now,
      firstTimestamp,
      lastTimestamp: current.timestamp,
      latestSnapshotId: current.id,
      events: combined,
      activeEventIds: activeEventIds(combined),
      dominantDirection: resolveDominantDirection(combined, current.direction),
      currentRegime: current.regime.regime,
      currentSession: current.session,
      sequenceSummary: summarize(combined),
      tags,
    };

    return {
      timeline,
      newEvents,
      resolvedEventIds: [],
      tags: ["market-events", ...newEvents.flatMap((event) => event.tags)],
      metadata: {
        eventCount: timeline.events.length,
        newEventCount: newEvents.length,
        latestEventId: newEvents.at(-1)?.id,
        latestSnapshotId: current.id,
      },
    };
  }

  public evaluate(runtime: IntelligenceRegistryRuntime): MarketEventContribution {
    const input = extractRuntimeInput(runtime);
    const result = this.build(input);

    runtime.shared.set("market-events:timeline", result.timeline);
    runtime.shared.set("market-events:latest", result.newEvents);

    /**
     * Save the exact context used during this evaluation. runtime.report may
     * not exist yet while registry components are executing.
     */
    runtime.shared.set("market-context:previous", input.current);

    return result;
  }
}

export function createMarketEventEngine(
  options: MarketEventEngineOptions = {},
): MarketEventEngine {
  return new MarketEventEngine(options);
}

export default MarketEventEngine;
