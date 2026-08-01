/**
 * SessionMemory.ts
 *
 * Tracks session-specific market memory for the Trading OS.
 * This class centralizes session identity, bias, objectives, and key levels.
 */

import type { SessionMemory as SessionMemoryState } from "./MarketMemoryTypes";

export type TradingSession =
  | "overnight"
  | "premarket"
  | "rth"
  | "afterhours";

export type SessionBias = "bullish" | "bearish" | "neutral";

export interface SessionKeyLevels {
  overnightHigh?: number;
  overnightLow?: number;
  premarketHigh?: number;
  premarketLow?: number;
  openingRangeHigh?: number;
  openingRangeLow?: number;
  initialBalanceHigh?: number;
  initialBalanceLow?: number;
  previousDayHigh?: number;
  previousDayLow?: number;
  previousClose?: number;
  vwap?: number;
}

export interface SessionMemorySnapshot extends SessionMemoryState {
  startedAt?: number;
  updatedAt: number;
  keyLevels: SessionKeyLevels;
  acceptedAbove: string[];
  acceptedBelow: string[];
  rejectedLevels: string[];
  significantEvents: string[];
}

export interface SessionTransition {
  previous: TradingSession;
  current: TradingSession;
  timestamp: number;
}

const DEFAULT_STATE: SessionMemorySnapshot = {
  session: "rth",
  bias: "neutral",
  objectives: [],
  updatedAt: 0,
  keyLevels: {},
  acceptedAbove: [],
  acceptedBelow: [],
  rejectedLevels: [],
  significantEvents: [],
};

function cloneLevels(levels: SessionKeyLevels): SessionKeyLevels {
  return { ...levels };
}

function cloneSnapshot(snapshot: SessionMemorySnapshot): SessionMemorySnapshot {
  return {
    ...snapshot,
    objectives: [...snapshot.objectives],
    keyLevels: cloneLevels(snapshot.keyLevels),
    acceptedAbove: [...snapshot.acceptedAbove],
    acceptedBelow: [...snapshot.acceptedBelow],
    rejectedLevels: [...snapshot.rejectedLevels],
    significantEvents: [...snapshot.significantEvents],
  };
}

function uniquePush(target: string[], value: string, maxItems: number): string[] {
  const normalized = value.trim();

  if (!normalized) {
    return target;
  }

  const next = target.filter((item) => item !== normalized);
  next.push(normalized);

  return next.slice(Math.max(0, next.length - maxItems));
}

export class SessionMemory {
  private state: SessionMemorySnapshot;
  private readonly maxRememberedItems: number;

  public constructor(
    initial?: Partial<SessionMemorySnapshot>,
    maxRememberedItems = 100,
  ) {
    this.maxRememberedItems = Math.max(1, maxRememberedItems);
    this.state = {
      ...cloneSnapshot(DEFAULT_STATE),
      ...initial,
      objectives: initial?.objectives ? [...initial.objectives] : [],
      keyLevels: initial?.keyLevels ? cloneLevels(initial.keyLevels) : {},
      acceptedAbove: initial?.acceptedAbove
        ? [...initial.acceptedAbove]
        : [],
      acceptedBelow: initial?.acceptedBelow
        ? [...initial.acceptedBelow]
        : [],
      rejectedLevels: initial?.rejectedLevels
        ? [...initial.rejectedLevels]
        : [],
      significantEvents: initial?.significantEvents
        ? [...initial.significantEvents]
        : [],
      updatedAt: initial?.updatedAt ?? Date.now(),
    };
  }

  public transition(
    nextSession: TradingSession,
    timestamp = Date.now(),
  ): SessionTransition | undefined {
    if (this.state.session === nextSession) {
      this.touch(timestamp);
      return undefined;
    }

    const transition: SessionTransition = {
      previous: this.state.session,
      current: nextSession,
      timestamp,
    };

    this.state = {
      ...this.state,
      session: nextSession,
      startedAt: timestamp,
      updatedAt: timestamp,
      objectives: [],
      acceptedAbove: [],
      acceptedBelow: [],
      rejectedLevels: [],
      significantEvents: [],
    };

    return transition;
  }

  public setBias(bias: SessionBias, timestamp = Date.now()): void {
    this.state = {
      ...this.state,
      bias,
      updatedAt: timestamp,
    };
  }

  public setObjectives(
    objectives: readonly string[],
    timestamp = Date.now(),
  ): void {
    this.state = {
      ...this.state,
      objectives: objectives
        .map((objective) => objective.trim())
        .filter(Boolean),
      updatedAt: timestamp,
    };
  }

  public addObjective(objective: string, timestamp = Date.now()): void {
    this.state = {
      ...this.state,
      objectives: uniquePush(
        this.state.objectives,
        objective,
        this.maxRememberedItems,
      ),
      updatedAt: timestamp,
    };
  }

  public removeObjective(objective: string, timestamp = Date.now()): void {
    this.state = {
      ...this.state,
      objectives: this.state.objectives.filter(
        (candidate) => candidate !== objective,
      ),
      updatedAt: timestamp,
    };
  }

  public updateKeyLevels(
    update: Partial<SessionKeyLevels>,
    timestamp = Date.now(),
  ): void {
    const nextLevels: SessionKeyLevels = {
      ...this.state.keyLevels,
    };

    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) {
        delete nextLevels[key as keyof SessionKeyLevels];
        continue;
      }

      if (!Number.isFinite(value)) {
        throw new Error(`Invalid session level for ${key}.`);
      }

      nextLevels[key as keyof SessionKeyLevels] = value;
    }

    this.state = {
      ...this.state,
      keyLevels: nextLevels,
      updatedAt: timestamp,
    };
  }

  public recordAcceptanceAbove(
    levelName: string,
    timestamp = Date.now(),
  ): void {
    this.state = {
      ...this.state,
      acceptedAbove: uniquePush(
        this.state.acceptedAbove,
        levelName,
        this.maxRememberedItems,
      ),
      acceptedBelow: this.state.acceptedBelow.filter(
        (item) => item !== levelName,
      ),
      rejectedLevels: this.state.rejectedLevels.filter(
        (item) => item !== levelName,
      ),
      updatedAt: timestamp,
    };
  }

  public recordAcceptanceBelow(
    levelName: string,
    timestamp = Date.now(),
  ): void {
    this.state = {
      ...this.state,
      acceptedBelow: uniquePush(
        this.state.acceptedBelow,
        levelName,
        this.maxRememberedItems,
      ),
      acceptedAbove: this.state.acceptedAbove.filter(
        (item) => item !== levelName,
      ),
      rejectedLevels: this.state.rejectedLevels.filter(
        (item) => item !== levelName,
      ),
      updatedAt: timestamp,
    };
  }

  public recordRejection(
    levelName: string,
    timestamp = Date.now(),
  ): void {
    this.state = {
      ...this.state,
      rejectedLevels: uniquePush(
        this.state.rejectedLevels,
        levelName,
        this.maxRememberedItems,
      ),
      updatedAt: timestamp,
    };
  }

  public recordSignificantEvent(
    eventId: string,
    timestamp = Date.now(),
  ): void {
    this.state = {
      ...this.state,
      significantEvents: uniquePush(
        this.state.significantEvents,
        eventId,
        this.maxRememberedItems,
      ),
      updatedAt: timestamp,
    };
  }

  public getSnapshot(): SessionMemorySnapshot {
    return cloneSnapshot(this.state);
  }

  public restore(snapshot: SessionMemorySnapshot): void {
    this.state = cloneSnapshot(snapshot);
  }

  public reset(
    session: TradingSession = "rth",
    timestamp = Date.now(),
  ): void {
    this.state = {
      ...cloneSnapshot(DEFAULT_STATE),
      session,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private touch(timestamp: number): void {
    this.state = {
      ...this.state,
      updatedAt: timestamp,
    };
  }
}

export default SessionMemory;
