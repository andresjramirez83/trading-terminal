/**
 * MarketMemoryEngine.ts
 *
 * Orchestrates persistent market memory for the Trading OS.
 *
 * It receives normalized market events, stores them chronologically,
 * updates session memory, tracks regime changes, detects event sequences,
 * and produces a shared human-readable market story.
 */

import type {
  MarketMemoryEvent,
  MarketMemorySnapshot,
  MarketSequence,
  SessionMemory as SessionMemoryState,
} from "./MarketMemoryTypes";
import {
  MarketMemoryStore,
  type MarketMemoryStoreOptions,
} from "./MarketMemoryStore";
import {
  SessionMemory,
  type SessionMemorySnapshot,
  type SessionKeyLevels,
  type SessionBias,
  type TradingSession,
} from "./SessionMemory";
import {
  RegimeTracker,
  type MarketRegime,
  type RegimeSnapshot,
} from "./RegimeTracker";
import {
  EventSequenceAnalyzer,
  type SequenceMatch,
  type SequenceRule,
} from "./EventSequenceAnalyzer";
import {
  MarketStoryBuilder,
  type MarketStory,
} from "./MarketStoryBuilder";

export interface MarketMemoryEngineOptions {
  symbol: string;
  timeframe: string;
  maxEvents?: number;
  maxRegimeHistory?: number;
  initialSession?: SessionMemoryState;
  sequenceRules?: readonly SequenceRule[];
}

export interface MarketMemoryEngineInput {
  events?: readonly MarketMemoryEvent[];
  session?: TradingSession;
  sessionBias?: SessionBias;
  sessionObjectives?: readonly string[];
  keyLevels?: Partial<SessionKeyLevels>;
  regime?: {
    value: MarketRegime;
    confidence: number;
    reason: string;
  };
  timestamp?: number;
}

export interface MarketMemoryEngineResult {
  symbol: string;
  timeframe: string;
  generatedAt: number;
  memory: MarketMemorySnapshot;
  session: SessionMemorySnapshot;
  regime: RegimeSnapshot;
  sequences: SequenceMatch[];
  story: MarketStory;
  latestEvent?: MarketMemoryEvent;
}

export interface MarketMemoryEngineExport {
  version: 1;
  exportedAt: number;
  memory: MarketMemorySnapshot;
  session: SessionMemorySnapshot;
  regime: RegimeSnapshot;
}

function cloneEvent(event: MarketMemoryEvent): MarketMemoryEvent {
  return {
    ...event,
    implications: [...event.implications],
    dependsOn: event.dependsOn ? [...event.dependsOn] : undefined,
    metadata: event.metadata ? { ...event.metadata } : undefined,
  };
}

function normalizeTimestamp(timestamp?: number): number {
  return Number.isFinite(timestamp) ? (timestamp as number) : Date.now();
}

export class MarketMemoryEngine {
  private readonly symbol: string;
  private readonly timeframe: string;

  private readonly store: MarketMemoryStore;
  private readonly sessionMemory: SessionMemory;
  private readonly regimeTracker: RegimeTracker;
  private readonly sequenceAnalyzer: EventSequenceAnalyzer;
  private readonly storyBuilder: MarketStoryBuilder;

  public constructor(options: MarketMemoryEngineOptions) {
    const symbol = options.symbol.trim().toUpperCase();
    const timeframe = options.timeframe.trim();

    if (!symbol) {
      throw new Error("MarketMemoryEngine requires a symbol.");
    }

    if (!timeframe) {
      throw new Error("MarketMemoryEngine requires a timeframe.");
    }

    this.symbol = symbol;
    this.timeframe = timeframe;

    const storeOptions: MarketMemoryStoreOptions = {
      symbol,
      timeframe,
      maxEvents: options.maxEvents,
      session: options.initialSession,
    };

    this.store = new MarketMemoryStore(storeOptions);
    this.sessionMemory = new SessionMemory(
      options.initialSession
        ? {
            session: options.initialSession.session,
            bias: options.initialSession.bias,
            objectives: [...options.initialSession.objectives],
          }
        : undefined,
    );
    this.regimeTracker = new RegimeTracker(options.maxRegimeHistory);
    this.sequenceAnalyzer = new EventSequenceAnalyzer();
    this.storyBuilder = new MarketStoryBuilder();

    for (const rule of options.sequenceRules ?? []) {
      this.sequenceAnalyzer.registerRule(rule);
    }
  }

  public evaluate(
    input: MarketMemoryEngineInput = {},
  ): MarketMemoryEngineResult {
    const timestamp = normalizeTimestamp(input.timestamp);

    if (input.session) {
      const transition = this.sessionMemory.transition(
        input.session,
        timestamp,
      );

      if (transition) {
        this.store.updateSession(
          {
            session: input.session,
            objectives: [],
          },
        );
      }
    }

    if (input.sessionBias) {
      this.sessionMemory.setBias(input.sessionBias, timestamp);
      this.store.updateSession({
        bias: input.sessionBias,
      });
    }

    if (input.sessionObjectives) {
      this.sessionMemory.setObjectives(
        input.sessionObjectives,
        timestamp,
      );
      this.store.updateSession({
        objectives: [...input.sessionObjectives],
      });
    }

    if (input.keyLevels) {
      this.sessionMemory.updateKeyLevels(
        input.keyLevels,
        timestamp,
      );
    }

    if (input.regime) {
      this.regimeTracker.update(
        input.regime.value,
        input.regime.confidence,
        input.regime.reason,
        timestamp,
      );
    }

    if (input.events?.length) {
      const normalizedEvents = input.events.map((event) =>
        this.normalizeEvent(event),
      );

      this.store.addEvents(normalizedEvents);

      for (const event of normalizedEvents) {
        if (event.importance >= 70) {
          this.sessionMemory.recordSignificantEvent(
            event.id,
            event.timestamp,
          );
        }

        this.applyEventToSessionMemory(event);
      }
    }

    const memory = this.store.getSnapshot();
    const sequences = this.sequenceAnalyzer.analyze(memory.events);

    this.synchronizeSequences(sequences);

    const synchronizedMemory = this.store.getSnapshot();
    const story = this.storyBuilder.build(
      synchronizedMemory.events,
    );

    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      generatedAt: timestamp,
      memory: synchronizedMemory,
      session: this.sessionMemory.getSnapshot(),
      regime: this.regimeTracker.getSnapshot(),
      sequences,
      story,
      latestEvent: this.store.getLatestEvent(),
    };
  }

  public ingestEvents(
    events: readonly MarketMemoryEvent[],
    timestamp = Date.now(),
  ): MarketMemoryEngineResult {
    return this.evaluate({
      events,
      timestamp,
    });
  }

  public registerSequenceRule(rule: SequenceRule): void {
    this.sequenceAnalyzer.registerRule(rule);
  }

  public unregisterSequenceRule(ruleId: string): void {
    this.sequenceAnalyzer.unregisterRule(ruleId);
    this.store.removeSequence(ruleId);
  }

  public getSnapshot(): MarketMemoryEngineResult {
    const memory = this.store.getSnapshot();
    const sequences = this.sequenceAnalyzer.analyze(memory.events);

    this.synchronizeSequences(sequences);

    const synchronizedMemory = this.store.getSnapshot();

    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      generatedAt: Date.now(),
      memory: synchronizedMemory,
      session: this.sessionMemory.getSnapshot(),
      regime: this.regimeTracker.getSnapshot(),
      sequences,
      story: this.storyBuilder.build(
        synchronizedMemory.events,
      ),
      latestEvent: this.store.getLatestEvent(),
    };
  }

  public exportState(): MarketMemoryEngineExport {
    const snapshot = this.getSnapshot();

    return {
      version: 1,
      exportedAt: Date.now(),
      memory: snapshot.memory,
      session: snapshot.session,
      regime: snapshot.regime,
    };
  }

  public restoreState(
    exported: MarketMemoryEngineExport,
  ): void {
    if (exported.version !== 1) {
      throw new Error(
        `Unsupported MarketMemoryEngine export version: ${String(exported.version)}`,
      );
    }

    this.store.restore(exported.memory);
    this.sessionMemory.restore(exported.session);

    this.regimeTracker.reset();

    for (const observation of exported.regime.history) {
      this.regimeTracker.update(
        observation.regime,
        observation.confidence,
        observation.reason,
        observation.timestamp,
      );
    }

    if (
      exported.regime.history.length === 0 &&
      exported.regime.current !== "unknown"
    ) {
      this.regimeTracker.update(
        exported.regime.current,
        exported.regime.confidence,
        "Restored market regime.",
        exported.regime.updatedAt || Date.now(),
      );
    }
  }

  public reset(
    session: TradingSession = "rth",
    timestamp = Date.now(),
  ): void {
    this.store.clear();
    this.sessionMemory.reset(session, timestamp);
    this.regimeTracker.reset();
  }

  public get eventCount(): number {
    return this.store.size;
  }

  private normalizeEvent(
    event: MarketMemoryEvent,
  ): MarketMemoryEvent {
    return {
      ...cloneEvent(event),
      symbol: this.symbol,
      timeframe: this.timeframe,
      importance: this.clamp(event.importance, 0, 100),
      confidence: this.clamp(event.confidence, 0, 1),
    };
  }

  private synchronizeSequences(
    matches: readonly SequenceMatch[],
  ): void {
    const matchedIds = new Set<string>();

    for (const match of matches) {
      matchedIds.add(match.sequence.id);
      this.store.upsertSequence(match.sequence);
    }

    for (const sequence of this.store.getSequences()) {
      if (!matchedIds.has(sequence.id)) {
        this.store.removeSequence(sequence.id);
      }
    }
  }

  private applyEventToSessionMemory(
    event: MarketMemoryEvent,
  ): void {
    const normalizedType = event.type
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    const levelName = this.readLevelName(event);

    if (
      normalizedType.includes("acceptance_above") ||
      normalizedType.includes("accepted_above")
    ) {
      this.sessionMemory.recordAcceptanceAbove(
        levelName ?? event.title,
        event.timestamp,
      );
      return;
    }

    if (
      normalizedType.includes("acceptance_below") ||
      normalizedType.includes("accepted_below")
    ) {
      this.sessionMemory.recordAcceptanceBelow(
        levelName ?? event.title,
        event.timestamp,
      );
      return;
    }

    if (
      normalizedType.includes("rejection") ||
      normalizedType.includes("rejected")
    ) {
      this.sessionMemory.recordRejection(
        levelName ?? event.title,
        event.timestamp,
      );
    }
  }

  private readLevelName(
    event: MarketMemoryEvent,
  ): string | undefined {
    const metadataLevel = event.metadata?.levelName;

    return typeof metadataLevel === "string" &&
      metadataLevel.trim()
      ? metadataLevel.trim()
      : undefined;
  }

  private clamp(
    value: number,
    minimum: number,
    maximum: number,
  ): number {
    if (!Number.isFinite(value)) {
      return minimum;
    }

    return Math.min(maximum, Math.max(minimum, value));
  }
}

export default MarketMemoryEngine;
