// src/components/chart/analysis/market-objects/MarketObjectRegistry.ts

import type {
  CreateUserDemandZoneInput,
  MarketObject,
  MarketObjectBias,
  MarketObjectConfidenceBand,
  MarketObjectInteraction,
  MarketObjectPriority,
  MarketObjectRegistryEvent,
  MarketObjectRegistrySnapshot,
  MarketObjectRelationship,
  MarketObjectRelationshipType,
  MarketObjectScore,
  MarketObjectSource,
  MarketObjectStatus,
  MarketObjectType,
  MarketObjectUpdate,
  UserDemandZoneMarketObject,
} from "./MarketObjectTypes";

export type MarketObjectRegistryListener = (
  event: MarketObjectRegistryEvent,
  snapshot: MarketObjectRegistrySnapshot,
) => void;

export type MarketObjectQuery = {
  symbol?: string;
  timeframe?: string;
  type?: MarketObjectType | MarketObjectType[];
  source?: MarketObjectSource | MarketObjectSource[];
  bias?: MarketObjectBias | MarketObjectBias[];
  status?: MarketObjectStatus | MarketObjectStatus[];
  active?: boolean;
  drawingId?: string;
};

export type CreateRelationshipInput = {
  id?: string;
  objectId: string;
  relatedObjectId: string;
  type: MarketObjectRelationshipType;
  strength?: MarketObjectScore;
  active?: boolean;
  metadata?: Record<string, unknown>;
};

const DEFAULT_AWARENESS_PERCENT = 0.25;
const MAX_INTERACTIONS_PER_OBJECT = 250;

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function clampScore(value: number): MarketObjectScore {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function confidenceBand(score: number): MarketObjectConfidenceBand {
  if (score >= 85) return "veryHigh";
  if (score >= 70) return "high";
  if (score >= 45) return "moderate";
  if (score >= 25) return "low";
  return "veryLow";
}

function normalizePriority(priority: MarketObjectPriority | undefined): MarketObjectPriority {
  return priority ?? "normal";
}

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeZoneBounds(low: number, high: number): { low: number; high: number } {
  const normalizedLow = Math.min(Number(low), Number(high));
  const normalizedHigh = Math.max(Number(low), Number(high));

  if (!Number.isFinite(normalizedLow) || !Number.isFinite(normalizedHigh)) {
    throw new Error("MarketObjectRegistry: zone bounds must be finite numbers.");
  }

  return { low: normalizedLow, high: normalizedHigh };
}

function assertIdentity(object: MarketObject): void {
  if (!object.id.trim()) {
    throw new Error("MarketObjectRegistry: object id is required.");
  }

  if (!object.symbol.trim()) {
    throw new Error(`MarketObjectRegistry: symbol is required for ${object.id}.`);
  }

  if (!object.timeframe.trim()) {
    throw new Error(`MarketObjectRegistry: timeframe is required for ${object.id}.`);
  }
}

function normalizeObject<T extends MarketObject>(object: T): T {
  assertIdentity(object);

  const normalized = deepClone(object);
  normalized.scoring.quality = clampScore(normalized.scoring.quality);
  normalized.scoring.health = clampScore(normalized.scoring.health);
  normalized.scoring.confidence = clampScore(normalized.scoring.confidence);
  normalized.scoring.confidenceBand = confidenceBand(normalized.scoring.confidence);
  normalized.scoring.priority = normalizePriority(normalized.scoring.priority);
  normalized.awareness.threshold = Math.max(0, Number(normalized.awareness.threshold) || 0);
  normalized.relationshipIds = Array.from(new Set(normalized.relationshipIds));
  normalized.memory.interactions = normalized.memory.interactions
    .slice(-MAX_INTERACTIONS_PER_OBJECT)
    .map((interaction) => deepClone(interaction));

  return normalized;
}

export class MarketObjectRegistry {
  private readonly objects = new Map<string, MarketObject>();
  private readonly relationships = new Map<string, MarketObjectRelationship>();
  private readonly listeners = new Set<MarketObjectRegistryListener>();
  private updatedAt = Date.now();

  subscribe(listener: MarketObjectRegistryListener, emitCurrent = false): () => void {
    this.listeners.add(listener);

    if (emitCurrent) {
      listener(
        {
          type: "registryCleared",
        },
        this.getSnapshot(),
      );
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  add<T extends MarketObject>(object: T): T {
    if (this.objects.has(object.id)) {
      throw new Error(`MarketObjectRegistry: object ${object.id} already exists.`);
    }

    const normalized = normalizeObject(object);
    this.objects.set(normalized.id, normalized);
    this.touchRegistry();
    this.emit({ type: "objectAdded", object: deepClone(normalized) });
    return deepClone(normalized);
  }

  upsert<T extends MarketObject>(object: T): T {
    const existing = this.objects.get(object.id);
    if (!existing) return this.add(object);

    const normalized = normalizeObject(object);
    this.objects.set(normalized.id, normalized);
    this.touchRegistry();
    this.emit({
      type: "objectUpdated",
      object: deepClone(normalized),
      previous: deepClone(existing),
    });
    return deepClone(normalized);
  }

  createUserDemandZone(input: CreateUserDemandZoneInput): UserDemandZoneMarketObject {
    const bounds = normalizeZoneBounds(input.low, input.high);
    const now = Date.now();
    const id = input.id ?? `market_object_${input.drawingId}`;

    const object: UserDemandZoneMarketObject = {
      id,
      type: "demandZone",
      source: "user",
      bias: "bullish",
      symbol: input.symbol.trim().toUpperCase(),
      timeframe: input.timeframe.trim(),
      status: "registered",
      lifecycleStage: "fresh",
      active: true,
      geometry: {
        kind: "zone",
        zone: {
          low: bounds.low,
          high: bounds.high,
          startTime: input.startTime,
          endTime: input.endTime,
          extendRight: input.extendRight ?? true,
        },
      },
      scoring: {
        quality: 50,
        health: 100,
        confidence: 50,
        confidenceBand: "moderate",
        priority: "normal",
        zoneQuality: {
          structure: 50,
          displacement: 50,
          freshness: 100,
          imbalanceRelationship: 50,
          volumeSupport: null,
          location: 50,
          reaction: null,
        },
      },
      awareness: {
        enabled: input.awareness?.enabled ?? true,
        mode: input.awareness?.mode ?? "percent",
        threshold:
          input.awareness?.threshold ?? DEFAULT_AWARENESS_PERCENT,
        proximity: input.awareness?.proximity,
      },
      memory: {
        touchCount: 0,
        rejectionCount: 0,
        successfulRetestCount: 0,
        failedRetestCount: 0,
        interactions: [],
      },
      relationshipIds: [],
      evidence: [],
      createdAt: now,
      updatedAt: now,
      createdTime: input.startTime,
      updatedTime: input.endTime ?? input.startTime,
      presentation: input.presentation,
      metadata: {
        drawingId: input.drawingId,
        name: input.metadata?.name,
        notes: input.metadata?.notes,
        protectedLow: input.metadata?.protectedLow,
        originCandleTime: input.metadata?.originCandleTime,
        structureBreakPrice: input.metadata?.structureBreakPrice,
        structureBreakTime: input.metadata?.structureBreakTime,
        hasBullishFvgRelationship:
          input.metadata?.hasBullishFvgRelationship,
        isFresh: true,
        userConfirmedType: true,
      },
    };

    return this.upsert(object);
  }

  get<T extends MarketObject = MarketObject>(id: string): T | null {
    const object = this.objects.get(id);
    return object ? (deepClone(object) as T) : null;
  }

  has(id: string): boolean {
    return this.objects.has(id);
  }

  find(query: MarketObjectQuery = {}): MarketObject[] {
    const types = asArray(query.type);
    const sources = asArray(query.source);
    const biases = asArray(query.bias);
    const statuses = asArray(query.status);

    return Array.from(this.objects.values())
      .filter((object) => {
        if (query.symbol && object.symbol !== query.symbol.trim().toUpperCase()) {
          return false;
        }
        if (query.timeframe && object.timeframe !== query.timeframe.trim()) {
          return false;
        }
        if (types && !types.includes(object.type)) return false;
        if (sources && !sources.includes(object.source)) return false;
        if (biases && !biases.includes(object.bias)) return false;
        if (statuses && !statuses.includes(object.status)) return false;
        if (query.active !== undefined && object.active !== query.active) return false;
        if (
          query.drawingId &&
          String(object.metadata?.drawingId ?? "") !== query.drawingId
        ) {
          return false;
        }
        return true;
      })
      .map((object) => deepClone(object));
  }

  findByDrawingId(drawingId: string): MarketObject | null {
    return this.find({ drawingId })[0] ?? null;
  }

  update<TMetadata extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    patch: MarketObjectUpdate<TMetadata>,
  ): MarketObject<TMetadata> | null {
    const existing = this.objects.get(id) as MarketObject<TMetadata> | undefined;
    if (!existing) return null;

    const next = normalizeObject({
      ...deepClone(existing),
      ...deepClone(patch),
      geometry: patch.geometry
        ? deepClone(patch.geometry)
        : deepClone(existing.geometry),
      scoring: patch.scoring
        ? deepClone(patch.scoring)
        : deepClone(existing.scoring),
      awareness: patch.awareness
        ? deepClone(patch.awareness)
        : deepClone(existing.awareness),
      memory: patch.memory
        ? deepClone(patch.memory)
        : deepClone(existing.memory),
      metadata: patch.metadata
        ? deepClone(patch.metadata)
        : deepClone(existing.metadata),
      updatedAt: Date.now(),
    } as MarketObject<TMetadata>);

    this.objects.set(id, next);
    this.touchRegistry();
    this.emit({
      type: "objectUpdated",
      object: deepClone(next),
      previous: deepClone(existing),
    });
    return deepClone(next);
  }

  recordInteraction(id: string, interaction: MarketObjectInteraction): MarketObject | null {
    const existing = this.objects.get(id);
    if (!existing) return null;

    const interactions = [
      ...existing.memory.interactions,
      deepClone(interaction),
    ].slice(-MAX_INTERACTIONS_PER_OBJECT);

    return this.update(id, {
      memory: {
        ...existing.memory,
        interactions,
      },
      updatedTime: interaction.time,
    });
  }

  remove(id: string): boolean {
    const existing = this.objects.get(id);
    if (!existing) return false;

    for (const relationshipId of [...existing.relationshipIds]) {
      this.removeRelationship(relationshipId);
    }

    for (const relationship of Array.from(this.relationships.values())) {
      if (
        relationship.objectId === id ||
        relationship.relatedObjectId === id
      ) {
        this.removeRelationship(relationship.id);
      }
    }

    this.objects.delete(id);
    this.touchRegistry();
    this.emit({ type: "objectRemoved", objectId: id });
    return true;
  }

  removeByDrawingId(drawingId: string): number {
    const matches = this.find({ drawingId });
    let removed = 0;

    for (const object of matches) {
      if (this.remove(object.id)) removed += 1;
    }

    return removed;
  }

  clear(symbol?: string, timeframe?: string): number {
    const matches = this.find({ symbol, timeframe });
    for (const object of matches) {
      this.remove(object.id);
    }

    this.touchRegistry();
    this.emit({ type: "registryCleared", symbol, timeframe });
    return matches.length;
  }

  addRelationship(input: CreateRelationshipInput): MarketObjectRelationship {
    if (!this.objects.has(input.objectId)) {
      throw new Error(
        `MarketObjectRegistry: source object ${input.objectId} does not exist.`,
      );
    }

    if (!this.objects.has(input.relatedObjectId)) {
      throw new Error(
        `MarketObjectRegistry: related object ${input.relatedObjectId} does not exist.`,
      );
    }

    const now = Date.now();
    const relationship: MarketObjectRelationship = {
      id: input.id ?? makeId("market_relationship"),
      objectId: input.objectId,
      relatedObjectId: input.relatedObjectId,
      type: input.type,
      strength: clampScore(input.strength ?? 50),
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ? deepClone(input.metadata) : undefined,
    };

    this.relationships.set(relationship.id, relationship);
    this.attachRelationshipId(relationship.objectId, relationship.id);
    this.attachRelationshipId(relationship.relatedObjectId, relationship.id);
    this.touchRegistry();
    this.emit({
      type: "relationshipAdded",
      relationship: deepClone(relationship),
    });
    return deepClone(relationship);
  }

  removeRelationship(id: string): boolean {
    const relationship = this.relationships.get(id);
    if (!relationship) return false;

    this.relationships.delete(id);
    this.detachRelationshipId(relationship.objectId, id);
    this.detachRelationshipId(relationship.relatedObjectId, id);
    this.touchRegistry();
    this.emit({ type: "relationshipRemoved", relationshipId: id });
    return true;
  }

  getRelationshipsForObject(objectId: string): MarketObjectRelationship[] {
    return Array.from(this.relationships.values())
      .filter(
        (relationship) =>
          relationship.objectId === objectId ||
          relationship.relatedObjectId === objectId,
      )
      .map((relationship) => deepClone(relationship));
  }

  getSnapshot(symbol?: string, timeframe?: string): MarketObjectRegistrySnapshot {
    const objects = this.find({ symbol, timeframe });
    const objectIds = new Set(objects.map((object) => object.id));
    const relationships = Array.from(this.relationships.values())
      .filter(
        (relationship) =>
          objectIds.has(relationship.objectId) &&
          objectIds.has(relationship.relatedObjectId),
      )
      .map((relationship) => deepClone(relationship));

    return {
      objects,
      relationships,
      activeObjectIds: objects
        .filter((object) => object.active)
        .map((object) => object.id),
      watchingObjectIds: objects
        .filter(
          (object) =>
            object.status === "approaching" || object.status === "watching",
        )
        .map((object) => object.id),
      updatedAt: this.updatedAt,
    };
  }

  private attachRelationshipId(objectId: string, relationshipId: string): void {
    const object = this.objects.get(objectId);
    if (!object || object.relationshipIds.includes(relationshipId)) return;

    this.objects.set(
      objectId,
      normalizeObject({
        ...object,
        relationshipIds: [...object.relationshipIds, relationshipId],
        updatedAt: Date.now(),
      }),
    );
  }

  private detachRelationshipId(objectId: string, relationshipId: string): void {
    const object = this.objects.get(objectId);
    if (!object) return;

    this.objects.set(
      objectId,
      normalizeObject({
        ...object,
        relationshipIds: object.relationshipIds.filter(
          (candidate) => candidate !== relationshipId,
        ),
        updatedAt: Date.now(),
      }),
    );
  }

  private touchRegistry(): void {
    this.updatedAt = Date.now();
  }

  private emit(event: MarketObjectRegistryEvent): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(deepClone(event), snapshot);
    }
  }
}

export const marketObjectRegistry = new MarketObjectRegistry();
