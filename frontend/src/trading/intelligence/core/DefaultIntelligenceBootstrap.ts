// src/trading/intelligence/core/DefaultIntelligenceBootstrap.ts

/**
 * Creates the default Trading OS intelligence pipeline.
 *
 * Execution order:
 *   Market Context
 *     -> Market Events
 *     -> Market Memory
 *     -> Trading Decision
 *     -> Narrative
 *     -> Coach
 *
 * Market memory is isolated by symbol and timeframe so live charts, Replay,
 * Practice Center, scanners, and journals never contaminate one another.
 */

import { AITradingCoachEngine } from "../coach/AITradingCoachEngine";
import { TradingDecisionEngine } from "../evaluators/TradingDecisionEngine";
import { BalanceContextEvaluator } from "../evaluators/BalanceContextEvaluator";
import { CompressionContextEvaluator } from "../evaluators/CompressionContextEvaluator";
import { EntryQualityContextEvaluator } from "../evaluators/EntryQualityContextEvaluator";
import { FairValueGapContextEvaluator } from "../evaluators/FairValueGapContextEvaluator";
import { LiquidityContextEvaluator } from "../evaluators/LiquidityContextEvaluator";
import { MarketRegimeContextEvaluator } from "../evaluators/MarketRegimeContextEvaluator";
import { MomentumContextEvaluator } from "../evaluators/MomentumContextEvaluator";
import { ParticipationContextEvaluator } from "../evaluators/ParticipationContextEvaluator";
import { RiskContextEvaluator } from "../evaluators/RiskContextEvaluator";
import { SessionContextEvaluator } from "../evaluators/SessionContextEvaluator";
import { TrendContextEvaluator } from "../evaluators/TrendContextEvaluator";
import { VolatilityContextEvaluator } from "../evaluators/VolatilityContextEvaluator";
import { VWAPContextEvaluator } from "../evaluators/VWAPContextEvaluator";
import {
  MarketEventEngine,
  type MarketEvent,
  type MarketEventCategory,
  type MarketEventImportance,
  type MarketEventTimeline,
} from "../events/MarketEventEngine";
import {
  MarketMemoryEngine,
  type MarketMemoryEngineResult,
} from "../../memory/MarketMemoryEngine";
import type {
  MarketEventCategory as MemoryEventCategory,
  MarketMemoryEvent,
} from "../../memory/MarketMemoryTypes";
import type {
  MarketRegime as MemoryRegime,
} from "../../memory/RegimeTracker";
import type {
  SessionBias,
  TradingSession,
} from "../../memory/SessionMemory";
import {
  MarketContextEngine,
  type MarketContextEngineOptions,
} from "../MarketContextEngine";
import type {
  MarketContextDirection,
  MarketContextSnapshot,
  MarketRegime,
  MarketSession,
} from "../types/MarketContextTypes";
import { MarketNarrativeEngine } from "../../narrative/MarketNarrativeEngine";
import {
  IntelligenceRegistry,
  type IntelligenceRegistration,
  type IntelligenceRegistryOptions,
  type IntelligenceRegistryRuntime,
} from "./IntelligenceRegistry";
import {
  MasterIntelligenceEngine,
  type MasterIntelligenceEngineOptions,
} from "./MasterIntelligenceEngine";

export interface DefaultIntelligenceBootstrapOptions {
  registry?: IntelligenceRegistry;
  registryOptions?: IntelligenceRegistryOptions;
  masterOptions?: Omit<MasterIntelligenceEngineOptions, "registry">;
  marketContextOptions?: Omit<MarketContextEngineOptions, "evaluators">;
  replaceExisting?: boolean;
  marketMemoryMaxEvents?: number;
  marketMemoryMaxRegimeHistory?: number;
}

export interface DefaultIntelligencePipeline {
  registry: IntelligenceRegistry;
  master: MasterIntelligenceEngine;
  contextEngine: MarketContextEngine;
  eventEngine: MarketEventEngine;
  memoryEngines: ReadonlyMap<string, MarketMemoryEngine>;
  decisionEngine: TradingDecisionEngine;
  narrativeEngine: MarketNarrativeEngine;
  coachEngine: AITradingCoachEngine;
  getMemoryEngine(symbol: string, timeframe: string): MarketMemoryEngine | undefined;
  clearMemory(symbol?: string, timeframe?: string): void;
}

function requireContext(runtime: IntelligenceRegistryRuntime): MarketContextSnapshot {
  const reportContext = runtime.report?.context;
  if (reportContext) return reportContext;

  const contextContribution = runtime.shared.get("market-context-engine") as
    | { context?: MarketContextSnapshot }
    | undefined;

  if (contextContribution?.context) {
    return contextContribution.context;
  }

  throw new Error("Trading intelligence requires a market context snapshot.");
}

function memoryKey(symbol: string, timeframe: string): string {
  return `${symbol.trim().toUpperCase()}::${timeframe.trim()}`;
}

function mapImportance(importance: MarketEventImportance): number {
  switch (importance) {
    case "critical":
      return 100;
    case "high":
      return 80;
    case "medium":
      return 55;
    case "low":
    default:
      return 30;
  }
}

function mapCategory(category: MarketEventCategory): MemoryEventCategory {
  switch (category) {
    case "structure":
      return "structure";
    case "liquidity":
      return "liquidity";
    case "vwap":
      return "vwap";
    case "fair-value-gap":
      return "fvg";
    case "session":
      return "session";
    case "momentum":
      return "momentum";
    case "participation":
      return "participation";
    case "volatility":
    case "compression":
    case "expansion":
      return "volatility";
    case "balance":
    case "trend":
    case "objective":
    case "risk":
    case "thesis":
    case "custom":
    default:
      return "custom";
  }
}

function directionImplication(direction: MarketContextDirection): string {
  if (direction === "bullish") {
    return "Supports the bullish market thesis.";
  }

  if (direction === "bearish") {
    return "Supports the bearish market thesis.";
  }

  return "Adds neutral context and may require further confirmation.";
}

function toMemoryEvent(event: MarketEvent): MarketMemoryEvent {
  return {
    id: event.id,
    symbol: event.symbol,
    timeframe: event.timeframe,
    timestamp: event.timestamp,
    category: mapCategory(event.category),
    type: event.type,
    title: event.title,
    description: event.description,
    importance: mapImportance(event.importance),
    confidence: Math.min(1, Math.max(0, event.confidence)),
    implications: [
      directionImplication(event.direction),
      ...(event.status === "invalidated"
        ? ["The prior thesis associated with this event is invalidated."]
        : []),
    ],
    metadata: {
      ...event.metadata,
      direction: event.direction,
      status: event.status,
      score: event.score,
      price: event.price,
      level: event.level,
      sequence: event.sequence,
      tradingDate: event.tradingDate,
      barIndex: event.barIndex,
      sourceSnapshotId: event.sourceSnapshotId,
      sourceComponentIds: [...event.sourceComponentIds],
      evidenceIds: [...event.evidenceIds],
      tags: [...event.tags],
      levelName:
        typeof event.metadata.levelName === "string"
          ? event.metadata.levelName
          : undefined,
    },
  };
}

function mapSession(session: MarketSession): TradingSession {
  switch (session) {
    case "overnight":
      return "overnight";
    case "premarket":
      return "premarket";
    case "after-hours":
      return "afterhours";
    case "regular":
    case "closed":
    case "unknown":
    default:
      return "rth";
  }
}

function mapBias(direction: MarketContextDirection): SessionBias {
  return direction;
}

function mapRegime(regime: MarketRegime): MemoryRegime {
  switch (regime) {
    case "strong-uptrend":
    case "uptrend":
    case "bullish-pullback":
      return "uptrend";
    case "strong-downtrend":
    case "downtrend":
    case "bearish-pullback":
      return "downtrend";
    case "bullish-expansion":
    case "bearish-expansion":
    case "breakout":
    case "breakdown":
    case "volatile":
      return "expansion";
    case "compression":
    case "low-volatility":
      return "compression";
    case "range":
      return "balanced";
    case "transition":
    case "unknown":
    default:
      return "unknown";
  }
}

function readEventTimeline(
  runtime: IntelligenceRegistryRuntime,
): MarketEventTimeline | undefined {
  const direct = runtime.shared.get("market-events:timeline");
  if (direct && typeof direct === "object") {
    return direct as MarketEventTimeline;
  }

  const eventContribution = runtime.shared.get("market-event-engine") as
    | { timeline?: MarketEventTimeline }
    | undefined;

  return eventContribution?.timeline;
}

function createMemoryComponent(
  engines: Map<string, MarketMemoryEngine>,
  options: DefaultIntelligenceBootstrapOptions,
) {
  return {
    id: "market-memory-engine",

    evaluate(runtime: IntelligenceRegistryRuntime) {
      const context = requireContext(runtime);
      const timeline = readEventTimeline(runtime);
      const key = memoryKey(context.symbol, context.timeframe);

      let engine = engines.get(key);
      if (!engine) {
        engine = new MarketMemoryEngine({
          symbol: context.symbol,
          timeframe: context.timeframe,
          maxEvents: options.marketMemoryMaxEvents,
          maxRegimeHistory: options.marketMemoryMaxRegimeHistory,
          initialSession: {
            session: mapSession(context.session),
            bias: mapBias(context.direction),
            objectives: [],
          },
        });
        engines.set(key, engine);
      }

      const newEventsRaw = runtime.shared.get("market-events:latest");
      const newEvents = Array.isArray(newEventsRaw)
        ? (newEventsRaw as MarketEvent[]).map(toMemoryEvent)
        : [];

      const result: MarketMemoryEngineResult = engine.evaluate({
        events: newEvents,
        session: mapSession(context.session),
        sessionBias: mapBias(context.direction),
        regime: {
          value: mapRegime(context.regime.regime),
          confidence: context.regime.confidence,
          reason: `Market context classified the regime as ${context.regime.regime}.`,
        },
        timestamp: context.timestamp,
      });

      runtime.shared.set("market-memory:engine", engine);
      runtime.shared.set("market-memory:result", result);
      runtime.shared.set("market-memory:snapshot", result.memory);
      runtime.shared.set("market-memory:story", result.story);

      return {
        memory: result,
        tags: [
          "market-memory",
          `memory-events:${result.memory.events.length}`,
          `memory-regime:${result.regime.current}`,
        ],
        metadata: {
          marketMemoryKey: key,
          marketMemoryEventCount: result.memory.events.length,
          marketMemorySequenceCount: result.sequences.length,
          marketMemoryRegime: result.regime.current,
          marketMemoryStoryHeadline: result.story.headline,
          marketEventTimelineCount: timeline?.events.length ?? 0,
        },
      };
    },

    dispose() {
      engines.clear();
    },
  };
}

export async function createDefaultIntelligencePipeline(
  options: DefaultIntelligenceBootstrapOptions = {},
): Promise<DefaultIntelligencePipeline> {
  const registry =
    options.registry ??
    new IntelligenceRegistry({
      allowReplacement: options.replaceExisting ?? false,
      ...options.registryOptions,
    });

  const contextEngine = new MarketContextEngine({
    ...options.marketContextOptions,
    evaluators: [
      new TrendContextEvaluator(),
      new MomentumContextEvaluator(),
      new VolatilityContextEvaluator(),
      new ParticipationContextEvaluator(),
      new LiquidityContextEvaluator(),
      new VWAPContextEvaluator(),
      new FairValueGapContextEvaluator(),
      new CompressionContextEvaluator(),
      new BalanceContextEvaluator(),
      new EntryQualityContextEvaluator(),
      new RiskContextEvaluator(),
      new SessionContextEvaluator(),
      new MarketRegimeContextEvaluator(),
    ],
  });

  const eventEngine = new MarketEventEngine();
  const memoryEngines = new Map<string, MarketMemoryEngine>();
  const memoryComponent = createMemoryComponent(memoryEngines, options);
  const decisionEngine = new TradingDecisionEngine();
  const narrativeEngine = new MarketNarrativeEngine();
  const coachEngine = new AITradingCoachEngine();

  const contextComponent = {
    id: "market-context-engine",
    evaluate(runtime: IntelligenceRegistryRuntime) {
      const result = contextEngine.build(runtime.context.contextRequest);
      return {
        context: result.snapshot,
        contextDelta: result.delta,
        warnings: result.warnings,
        metadata: {
          marketContextProcessingTimeMs: result.processingTimeMs,
        },
      };
    },
  };

  const decisionComponent = {
    id: "trading-decision-engine",
    evaluate(runtime: IntelligenceRegistryRuntime) {
      const decision = decisionEngine.evaluate({
        context: requireContext(runtime),
        preferredDirection: runtime.context.preferredDirection,
        minimumConfidence: runtime.context.minimumConfidence,
        minimumTradeScore: runtime.context.minimumTradeScore,
        metadata: runtime.context.metadata as Record<string, unknown>,
      });

      return {
        decision,
        evidence: decision.evidence,
        reasons: decision.reasons,
        metrics: decision.metrics,
        tags: decision.tags,
      };
    },
  };

  const registrations: IntelligenceRegistration[] = [
    {
      id: contextComponent.id,
      kind: "context-evaluator",
      component: contextComponent,
      required: true,
      priority: 100,
      metadata: {
        displayName: "Market Context Engine",
        description: "Builds the normalized market context snapshot.",
        version: "1.0.0",
      },
    },
    {
      id: eventEngine.id,
      kind: "event-engine",
      component: eventEngine,
      required: true,
      priority: 200,
      dependencies: [contextComponent.id],
      metadata: {
        displayName: "Market Event Engine",
        description: "Converts context changes into a reusable event timeline.",
        version: "1.0.0",
      },
    },
    {
      id: memoryComponent.id,
      kind: "memory-engine",
      component: memoryComponent,
      required: true,
      priority: 250,
      dependencies: [contextComponent.id, eventEngine.id],
      metadata: {
        displayName: "Market Memory Engine",
        description:
          "Maintains isolated event memory, session state, regime history, sequences, and market story by symbol and timeframe.",
        version: "1.0.0",
      },
    },
    {
      id: decisionComponent.id,
      kind: "decision-engine",
      component: decisionComponent,
      required: true,
      priority: 300,
      dependencies: [
        contextComponent.id,
        eventEngine.id,
        memoryComponent.id,
      ],
      metadata: {
        displayName: "Trading Decision Engine",
        description: "Builds the directional trade decision from market context.",
        version: "1.0.0",
      },
    },
    {
      id: narrativeEngine.id,
      kind: "narrative-engine",
      component: narrativeEngine,
      required: false,
      priority: 400,
      dependencies: [
        contextComponent.id,
        eventEngine.id,
        memoryComponent.id,
        decisionComponent.id,
      ],
      metadata: {
        displayName: "Market Narrative Engine",
        description: "Explains the market story, objectives, and triggers.",
        version: "1.0.0",
      },
    },
    {
      id: coachEngine.id,
      kind: "coach-engine",
      component: coachEngine,
      required: false,
      priority: 500,
      dependencies: [
        contextComponent.id,
        eventEngine.id,
        memoryComponent.id,
        decisionComponent.id,
        narrativeEngine.id,
      ],
      metadata: {
        displayName: "AI Trading Coach",
        description: "Provides process, behavior, risk, and execution coaching.",
        version: "1.0.0",
      },
    },
  ];

  await registry.registerMany(registrations, {
    replace: options.replaceExisting ?? false,
    initialize: false,
  });

  const master = new MasterIntelligenceEngine({
    ...options.masterOptions,
    registry,
  });

  return {
    registry,
    master,
    contextEngine,
    eventEngine,
    memoryEngines,
    decisionEngine,
    narrativeEngine,
    coachEngine,

    getMemoryEngine(symbol: string, timeframe: string) {
      return memoryEngines.get(memoryKey(symbol, timeframe));
    },

    clearMemory(symbol?: string, timeframe?: string) {
      if (!symbol && !timeframe) {
        for (const engine of memoryEngines.values()) {
          engine.reset();
        }
        memoryEngines.clear();
        return;
      }

      if (!symbol || !timeframe) {
        throw new Error(
          "clearMemory requires both symbol and timeframe, or neither.",
        );
      }

      const key = memoryKey(symbol, timeframe);
      memoryEngines.get(key)?.reset();
      memoryEngines.delete(key);
    },
  };
}

