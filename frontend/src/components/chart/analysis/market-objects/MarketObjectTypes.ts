// src/components/chart/analysis/market-objects/MarketObjectTypes.ts

import type { Time } from "lightweight-charts";

/**
 * Identifies the kind of market information represented by an object.
 *
 * This union is intentionally broader than the first implementation so new
 * object producers can join the intelligence system without changing the
 * registry contract.
 */
export type MarketObjectType =
  | "demandZone"
  | "supplyZone"
  | "fairValueGap"
  | "trendline"
  | "support"
  | "resistance"
  | "liquidityPool"
  | "previousDayHigh"
  | "previousDayLow"
  | "premarketHigh"
  | "premarketLow"
  | "sessionHigh"
  | "sessionLow"
  | "vwap"
  | "swingHigh"
  | "swingLow"
  | "marketStructureLeg"
  | "newsCatalyst"
  | "customZone";

/** Describes who created the object. */
export type MarketObjectSource = "user" | "engine" | "system";

/** Directional meaning of an object when one exists. */
export type MarketObjectBias = "bullish" | "bearish" | "neutral";

/**
 * Lifecycle state shared by every market object.
 *
 * Not every object uses every state. Object-specific lifecycle details are
 * stored in `lifecycleStage`.
 */
export type MarketObjectStatus =
  | "registered"
  | "inactive"
  | "approaching"
  | "watching"
  | "touched"
  | "responding"
  | "confirmed"
  | "weakened"
  | "broken"
  | "consumed"
  | "invalidated"
  | "archived";

/** Object-specific lifecycle description. */
export type MarketObjectLifecycleStage =
  | "fresh"
  | "untouched"
  | "firstTouch"
  | "multipleTouches"
  | "partiallyFilled"
  | "fullyFilled"
  | "rejected"
  | "accepted"
  | "swept"
  | "closeBroken"
  | "retestPending"
  | "retested"
  | "flipConfirmed"
  | "expired"
  | "custom";

/** Importance used by the Attention Engine to prioritize nearby objects. */
export type MarketObjectPriority = "low" | "normal" | "high" | "critical";

/** Human-readable confidence band derived from a normalized score. */
export type MarketObjectConfidenceBand =
  | "veryLow"
  | "low"
  | "moderate"
  | "high"
  | "veryHigh";

/** Shared price/time coordinate. */
export type MarketObjectPoint = {
  time: Time;
  price: number;
};

/** Price range shared by zones and horizontal areas. */
export type MarketObjectPriceRange = {
  low: number;
  high: number;
};

/** Time range used by bounded objects. */
export type MarketObjectTimeRange = {
  startTime: Time;
  endTime?: Time;
  extendRight?: boolean;
};

/** Zone geometry used by demand, supply, FVG, liquidity, and custom zones. */
export type MarketObjectZoneGeometry = MarketObjectPriceRange &
  MarketObjectTimeRange;

/** Line geometry used by trendlines and projected levels. */
export type MarketObjectLineGeometry = {
  start: MarketObjectPoint;
  end: MarketObjectPoint;
  extendLeft?: boolean;
  extendRight?: boolean;
};

/** Horizontal level geometry used by session and reference levels. */
export type MarketObjectLevelGeometry = {
  price: number;
  startTime?: Time;
  endTime?: Time;
  extendRight?: boolean;
};

/** Geometry supported by the first Market Object framework. */
export type MarketObjectGeometry =
  | {
      kind: "zone";
      zone: MarketObjectZoneGeometry;
    }
  | {
      kind: "line";
      line: MarketObjectLineGeometry;
    }
  | {
      kind: "level";
      level: MarketObjectLevelGeometry;
    }
  | {
      kind: "event";
      time: Time;
      price?: number;
    };

/**
 * Normalized score from 0 through 100.
 * The Registry should clamp external values before storing them.
 */
export type MarketObjectScore = number;

/**
 * Demand/supply quality components.
 *
 * ATR is intentionally excluded. The zone is evaluated by its structural
 * origin, displacement character, freshness, relationships, location, and
 * live reaction.
 */
export type ZoneQualityBreakdown = {
  structure: MarketObjectScore;
  displacement: MarketObjectScore;
  freshness: MarketObjectScore;
  imbalanceRelationship: MarketObjectScore;
  volumeSupport: MarketObjectScore | null;
  location: MarketObjectScore;
  reaction: MarketObjectScore | null;
};

/** Shared scoring information for all object types. */
export type MarketObjectScoring = {
  quality: MarketObjectScore;
  health: MarketObjectScore;
  confidence: MarketObjectScore;
  confidenceBand: MarketObjectConfidenceBand;
  priority: MarketObjectPriority;
  zoneQuality?: ZoneQualityBreakdown;
};

/** Current distance and proximity state calculated by the Attention Engine. */
export type MarketObjectProximity = {
  /** Current market price used for the calculation. */
  currentPrice: number;

  /** Absolute price distance to the nearest edge or projected line value. */
  distancePrice: number;

  /** Percentage distance from current price. */
  distancePercent: number;

  /** True when price is currently inside or touching the object. */
  isInside: boolean;

  /** True when the object is inside its configured awareness radius. */
  isWithinAwarenessRadius: boolean;

  /** Normalized 0-100 approach progress; 100 means touching/inside. */
  approachProgress: number;

  /** Optional side from which price is approaching. */
  approachSide?: "above" | "below" | "inside";

  evaluatedAt: number;
};

/**
 * Configures when an object should begin receiving active attention.
 * Percent and fixed-price thresholds avoid tying demand zones to ATR.
 */
export type MarketObjectAwareness = {
  enabled: boolean;
  mode: "percent" | "price";
  threshold: number;
  proximity?: MarketObjectProximity;
};

/** Events emitted as price interacts with an object. */
export type MarketObjectInteractionType =
  | "registered"
  | "approachStarted"
  | "approachUpdated"
  | "entered"
  | "touched"
  | "wickRejected"
  | "bodyRejected"
  | "bullishClose"
  | "bearishClose"
  | "closedAbove"
  | "closedBelow"
  | "volumeExpanded"
  | "structureHeld"
  | "structureFailed"
  | "retestStarted"
  | "retestConfirmed"
  | "leftObject"
  | "invalidated"
  | "archived";

/** A single remembered interaction with the market object. */
export type MarketObjectInteraction = {
  id: string;
  type: MarketObjectInteractionType;
  time: Time;
  price?: number;
  barIndex?: number;
  confidenceDelta?: number;
  note?: string;
  metadata?: Record<string, unknown>;
  recordedAt: number;
};

/** Rolling object memory used by reasoning and replay learning. */
export type MarketObjectMemory = {
  touchCount: number;
  rejectionCount: number;
  successfulRetestCount: number;
  failedRetestCount: number;
  lastTouchedTime?: Time;
  lastReactionTime?: Time;
  maxPenetrationPercent?: number;
  interactions: MarketObjectInteraction[];
};

/** Relationship categories between two registered market objects. */
export type MarketObjectRelationshipType =
  | "contains"
  | "inside"
  | "overlaps"
  | "intersects"
  | "near"
  | "above"
  | "below"
  | "createdBy"
  | "createdWith"
  | "protects"
  | "targets"
  | "confirms"
  | "conflictsWith"
  | "invalidates"
  | "flippedFrom";

/** Connection between this object and another object in the Registry. */
export type MarketObjectRelationship = {
  id: string;
  objectId: string;
  relatedObjectId: string;
  type: MarketObjectRelationshipType;
  strength: MarketObjectScore;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

/** Evidence presented to the Why/Reasoning Engine. */
export type MarketObjectEvidence = {
  id: string;
  label: string;
  description?: string;
  direction: "supports" | "opposes" | "neutral";
  weight: number;
  confidence: MarketObjectScore;
  sourceObjectId?: string;
  createdAt: number;
};

/** Action the object suggests the engine should watch for next. */
export type MarketObjectWatchCondition = {
  id: string;
  label: string;
  description?: string;
  status: "pending" | "satisfied" | "failed" | "cancelled";
  required: boolean;
  satisfiedAt?: number;
};

/** User-facing explanation generated from an object's current state. */
export type MarketObjectExplanation = {
  headline: string;
  summary: string;
  reason?: string;
  waitingFor: MarketObjectWatchCondition[];
  evidence: MarketObjectEvidence[];
  updatedAt: number;
};

/** Rendering metadata remains optional so intelligence is not tied to UI. */
export type MarketObjectPresentation = {
  label?: string;
  color?: string;
  fillColor?: string;
  lineWidth?: 1 | 2 | 3 | 4;
  visible?: boolean;
  showLabel?: boolean;
};

/**
 * Base contract stored by the Market Object Registry.
 *
 * Object-specific information belongs in `metadata`, while shared behavior
 * remains strongly typed here.
 */
export type MarketObject<TMetadata extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  type: MarketObjectType;
  source: MarketObjectSource;
  bias: MarketObjectBias;

  symbol: string;
  timeframe: string;

  status: MarketObjectStatus;
  lifecycleStage: MarketObjectLifecycleStage;
  active: boolean;

  geometry: MarketObjectGeometry;
  scoring: MarketObjectScoring;
  awareness: MarketObjectAwareness;
  memory: MarketObjectMemory;

  relationshipIds: string[];
  evidence: MarketObjectEvidence[];
  explanation?: MarketObjectExplanation;

  createdAt: number;
  updatedAt: number;
  createdTime?: Time;
  updatedTime?: Time;
  createdBarIndex?: number;
  updatedBarIndex?: number;

  expiresAt?: number;
  invalidatedAt?: number;
  archivedAt?: number;

  presentation?: MarketObjectPresentation;
  metadata: TMetadata;
};

/** Metadata for the first intelligent manually drawn demand-zone object. */
export type UserDemandZoneMetadata = {
  drawingId: string;
  name?: string;
  notes?: string;
  protectedLow?: number;
  originCandleTime?: Time;
  structureBreakPrice?: number;
  structureBreakTime?: Time;
  hasBullishFvgRelationship?: boolean;
  isFresh: boolean;
  userConfirmedType: true;
};

/** First concrete Market Object used by the implementation. */
export type UserDemandZoneMarketObject = MarketObject<UserDemandZoneMetadata> & {
  type: "demandZone";
  source: "user";
  bias: "bullish";
  geometry: {
    kind: "zone";
    zone: MarketObjectZoneGeometry;
  };
};

/** Input used when creating a new manually drawn demand zone. */
export type CreateUserDemandZoneInput = {
  id?: string;
  drawingId: string;
  symbol: string;
  timeframe: string;
  low: number;
  high: number;
  startTime: Time;
  endTime?: Time;
  extendRight?: boolean;
  awareness?: Partial<MarketObjectAwareness>;
  presentation?: MarketObjectPresentation;
  metadata?: Partial<Omit<UserDemandZoneMetadata, "drawingId" | "isFresh" | "userConfirmedType">>;
};

/** Patch accepted by the Registry when an object's state changes. */
export type MarketObjectUpdate<TMetadata extends Record<string, unknown> = Record<string, unknown>> = Partial<
  Omit<MarketObject<TMetadata>, "id" | "type" | "source" | "symbol" | "timeframe" | "createdAt">
>;

/** Snapshot exposed to Analysis, Attention, Reasoning, and UI consumers. */
export type MarketObjectRegistrySnapshot = {
  objects: MarketObject[];
  relationships: MarketObjectRelationship[];
  activeObjectIds: string[];
  watchingObjectIds: string[];
  updatedAt: number;
};

/** Registry events allow existing engines and widgets to subscribe safely. */
export type MarketObjectRegistryEvent =
  | {
      type: "objectAdded";
      object: MarketObject;
    }
  | {
      type: "objectUpdated";
      object: MarketObject;
      previous: MarketObject;
    }
  | {
      type: "objectRemoved";
      objectId: string;
    }
  | {
      type: "relationshipAdded";
      relationship: MarketObjectRelationship;
    }
  | {
      type: "relationshipRemoved";
      relationshipId: string;
    }
  | {
      type: "registryCleared";
      symbol?: string;
      timeframe?: string;
    };
