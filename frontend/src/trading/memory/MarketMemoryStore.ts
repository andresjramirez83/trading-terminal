/**
 * MarketMemoryStore.ts
 *
 * In-memory event store for the Trading OS Market Memory subsystem.
 * Keeps a chronological market timeline, active sequences, and session state.
 */

import type {
  MarketMemoryEvent,
  MarketMemorySnapshot,
  MarketMemoryStoreContract,
  MarketSequence,
  SessionMemory,
} from "./MarketMemoryTypes";

export interface MarketMemoryStoreOptions {
  symbol: string;
  timeframe: string;
  maxEvents?: number;
  session?: SessionMemory;
}

const DEFAULT_MAX_EVENTS = 2_000;

const DEFAULT_SESSION: SessionMemory = {
  session: "rth",
  bias: "neutral",
  objectives: [],
};

function cloneEvent(event: MarketMemoryEvent): MarketMemoryEvent {
  return {
    ...event,
    implications: [...event.implications],
    dependsOn: event.dependsOn ? [...event.dependsOn] : undefined,
    metadata: event.metadata ? { ...event.metadata } : undefined,
  };
}

function cloneSequence(sequence: MarketSequence): MarketSequence {
  return {
    ...sequence,
    eventIds: [...sequence.eventIds],
  };
}

function cloneSession(session: SessionMemory): SessionMemory {
  return {
    ...session,
    objectives: [...session.objectives],
  };
}

export class MarketMemoryStore implements MarketMemoryStoreContract {
  private readonly symbol: string;
  private readonly timeframe: string;
  private readonly maxEvents: number;

  private events: MarketMemoryEvent[] = [];
  private eventIds = new Set<string>();
  private activeSequences = new Map<string, MarketSequence>();
  private session: SessionMemory;

  public constructor(options: MarketMemoryStoreOptions) {
    const symbol = options.symbol.trim().toUpperCase();
    const timeframe = options.timeframe.trim();

    if (!symbol) {
      throw new Error("MarketMemoryStore requires a symbol.");
    }

    if (!timeframe) {
      throw new Error("MarketMemoryStore requires a timeframe.");
    }

    this.symbol = symbol;
    this.timeframe = timeframe;
    this.maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
    this.session = cloneSession(options.session ?? DEFAULT_SESSION);
  }

  public addEvent(event: MarketMemoryEvent): void {
    this.validateEvent(event);

    if (this.eventIds.has(event.id)) {
      return;
    }

    const normalized: MarketMemoryEvent = {
      ...cloneEvent(event),
      symbol: this.symbol,
      timeframe: this.timeframe,
      importance: this.clamp(event.importance, 0, 100),
      confidence: this.clamp(event.confidence, 0, 1),
    };

    this.events.push(normalized);
    this.eventIds.add(normalized.id);

    this.events.sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }

      return left.id.localeCompare(right.id);
    });

    this.pruneEvents();
  }

  public addEvents(events: readonly MarketMemoryEvent[]): void {
    for (const event of events) {
      this.addEvent(event);
    }
  }

  public getEvent(eventId: string): MarketMemoryEvent | undefined {
    const event = this.events.find((candidate) => candidate.id === eventId);
    return event ? cloneEvent(event) : undefined;
  }

  public getEvents(options?: {
    from?: number;
    to?: number;
    type?: string;
    minimumImportance?: number;
    minimumConfidence?: number;
  }): MarketMemoryEvent[] {
    const from = options?.from ?? Number.NEGATIVE_INFINITY;
    const to = options?.to ?? Number.POSITIVE_INFINITY;
    const minimumImportance = options?.minimumImportance ?? 0;
    const minimumConfidence = options?.minimumConfidence ?? 0;

    return this.events
      .filter((event) => {
        if (event.timestamp < from || event.timestamp > to) {
          return false;
        }

        if (options?.type && event.type !== options.type) {
          return false;
        }

        return (
          event.importance >= minimumImportance &&
          event.confidence >= minimumConfidence
        );
      })
      .map(cloneEvent);
  }

  public getLatestEvent(type?: string): MarketMemoryEvent | undefined {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];

      if (!type || event.type === type) {
        return cloneEvent(event);
      }
    }

    return undefined;
  }

  public upsertSequence(sequence: MarketSequence): void {
    if (!sequence.id.trim()) {
      throw new Error("Market sequence requires an id.");
    }

    if (!sequence.name.trim()) {
      throw new Error("Market sequence requires a name.");
    }

    const normalized: MarketSequence = {
      ...cloneSequence(sequence),
      confidence: this.clamp(sequence.confidence, 0, 1),
    };

    this.activeSequences.set(normalized.id, normalized);
  }

  public completeSequence(sequenceId: string): void {
    const sequence = this.activeSequences.get(sequenceId);

    if (!sequence) {
      return;
    }

    this.activeSequences.set(sequenceId, {
      ...sequence,
      active: false,
      completed: true,
    });
  }

  public removeSequence(sequenceId: string): void {
    this.activeSequences.delete(sequenceId);
  }

  public getSequence(sequenceId: string): MarketSequence | undefined {
    const sequence = this.activeSequences.get(sequenceId);
    return sequence ? cloneSequence(sequence) : undefined;
  }

  public getSequences(): MarketSequence[] {
    return [...this.activeSequences.values()].map(cloneSequence);
  }

  public updateSession(update: Partial<SessionMemory>): void {
    this.session = {
      ...this.session,
      ...update,
      objectives: update.objectives
        ? [...update.objectives]
        : [...this.session.objectives],
    };
  }

  public getSession(): SessionMemory {
    return cloneSession(this.session);
  }

  public getSnapshot(): MarketMemorySnapshot {
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      generatedAt: Date.now(),
      events: this.events.map(cloneEvent),
      activeSequences: [...this.activeSequences.values()].map(cloneSequence),
      session: cloneSession(this.session),
    };
  }

  public restore(snapshot: MarketMemorySnapshot): void {
    if (snapshot.symbol.trim().toUpperCase() !== this.symbol) {
      throw new Error(
        `Cannot restore ${snapshot.symbol} memory into ${this.symbol} store.`,
      );
    }

    if (snapshot.timeframe.trim() !== this.timeframe) {
      throw new Error(
        `Cannot restore ${snapshot.timeframe} memory into ${this.timeframe} store.`,
      );
    }

    this.clear();
    this.session = cloneSession(snapshot.session);

    this.addEvents(snapshot.events);

    for (const sequence of snapshot.activeSequences) {
      this.upsertSequence(sequence);
    }
  }

  public clear(): void {
    this.events = [];
    this.eventIds.clear();
    this.activeSequences.clear();
    this.session = cloneSession(DEFAULT_SESSION);
  }

  public get size(): number {
    return this.events.length;
  }

  private pruneEvents(): void {
    if (this.events.length <= this.maxEvents) {
      return;
    }

    const removeCount = this.events.length - this.maxEvents;
    const removed = this.events.splice(0, removeCount);

    for (const event of removed) {
      this.eventIds.delete(event.id);
    }

    const retainedIds = new Set(this.events.map((event) => event.id));

    for (const [sequenceId, sequence] of this.activeSequences) {
      const retainedEventIds = sequence.eventIds.filter((eventId) =>
        retainedIds.has(eventId),
      );

      if (retainedEventIds.length === 0) {
        this.activeSequences.delete(sequenceId);
        continue;
      }

      if (retainedEventIds.length !== sequence.eventIds.length) {
        this.activeSequences.set(sequenceId, {
          ...sequence,
          eventIds: retainedEventIds,
        });
      }
    }
  }

  private validateEvent(event: MarketMemoryEvent): void {
    if (!event.id.trim()) {
      throw new Error("Market memory event requires an id.");
    }

    if (!Number.isFinite(event.timestamp)) {
      throw new Error(`Invalid timestamp for event ${event.id}.`);
    }

    if (!event.type.trim()) {
      throw new Error(`Event ${event.id} requires a type.`);
    }

    if (!event.title.trim()) {
      throw new Error(`Event ${event.id} requires a title.`);
    }

    if (!Array.isArray(event.implications)) {
      throw new Error(`Event ${event.id} requires an implications array.`);
    }
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) {
      return minimum;
    }

    return Math.min(maximum, Math.max(minimum, value));
  }
}

export default MarketMemoryStore;
