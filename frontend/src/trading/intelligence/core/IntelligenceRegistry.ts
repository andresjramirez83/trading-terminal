// src/trading/intelligence/core/IntelligenceRegistry.ts

/**
 * Central dependency registry for the Trading OS intelligence subsystem.
 *
 * The registry keeps MasterIntelligenceEngine decoupled from concrete market
 * evaluators, decision engines, narrative engines, coaches, journal analyzers,
 * and future plugins. Registrations can be filtered by mode and consumer,
 * ordered deterministically, enabled or disabled at runtime, and validated for
 * missing or circular dependencies.
 */

import type { IntelligenceContext } from "./IntelligenceContext";
import type {
  IntelligenceConsumer,
  IntelligenceMode,
  MarketIntelligenceReport,
} from "./IntelligenceTypes";

export type IntelligenceRegistrationKind =
  | "context-evaluator"
  | "event-engine"
  | "memory-engine"
  | "decision-engine"
  | "narrative-engine"
  | "coach-engine"
  | "execution-evaluator"
  | "journal-analyzer"
  | "dna-analyzer"
  | "auto-trader"
  | "report-enricher"
  | "service";

export type IntelligenceRegistrationStatus =
  | "registered"
  | "enabled"
  | "disabled"
  | "failed";

export interface IntelligenceRegistryMetadata {
  displayName?: string;
  description?: string;
  version?: string;
  owner?: string;
  tags?: readonly string[];
  [key: string]: unknown;
}

export interface IntelligenceRegistryRuntime {
  context: IntelligenceContext;
  report?: MarketIntelligenceReport;
  signal?: AbortSignal;
  registry: IntelligenceRegistry;
  shared: Map<string, unknown>;
}

export interface IntelligenceRegistryComponent<TResult = unknown> {
  readonly id?: string;
  evaluate?(runtime: IntelligenceRegistryRuntime): TResult | Promise<TResult>;
  execute?(runtime: IntelligenceRegistryRuntime): TResult | Promise<TResult>;
  initialize?(registry: IntelligenceRegistry): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface IntelligenceRegistration<TComponent = unknown> {
  id: string;
  kind: IntelligenceRegistrationKind;
  component: TComponent;
  enabled?: boolean;
  priority?: number;
  required?: boolean;
  dependencies?: readonly string[];
  modes?: readonly IntelligenceMode[];
  consumers?: readonly IntelligenceConsumer[];
  metadata?: IntelligenceRegistryMetadata;
}

export interface ResolvedIntelligenceRegistration<TComponent = unknown>
  extends Omit<
    IntelligenceRegistration<TComponent>,
    "enabled" | "priority" | "required" | "dependencies" | "metadata"
  > {
  enabled: boolean;
  priority: number;
  required: boolean;
  dependencies: readonly string[];
  metadata: Readonly<IntelligenceRegistryMetadata>;
  status: IntelligenceRegistrationStatus;
  registeredAt: number;
  sequence: number;
  error?: string;
}

export interface IntelligenceRegistryQuery {
  ids?: readonly string[];
  kinds?: readonly IntelligenceRegistrationKind[];
  mode?: IntelligenceMode;
  consumer?: IntelligenceConsumer;
  enabledOnly?: boolean;
  includeFailed?: boolean;
  tags?: readonly string[];
}

export interface IntelligenceRegistrySnapshot {
  version: number;
  generatedAt: number;
  total: number;
  enabled: number;
  disabled: number;
  failed: number;
  registrations: readonly IntelligenceRegistrySnapshotItem[];
}

export interface IntelligenceRegistrySnapshotItem {
  id: string;
  kind: IntelligenceRegistrationKind;
  enabled: boolean;
  required: boolean;
  priority: number;
  dependencies: readonly string[];
  modes?: readonly IntelligenceMode[];
  consumers?: readonly IntelligenceConsumer[];
  status: IntelligenceRegistrationStatus;
  metadata: Readonly<IntelligenceRegistryMetadata>;
  registeredAt: number;
  error?: string;
}

export interface IntelligenceRegistryValidationIssue {
  code:
    | "missing-dependency"
    | "circular-dependency"
    | "disabled-required-dependency"
    | "failed-required-registration";
  registrationId: string;
  dependencyId?: string;
  message: string;
}

export interface IntelligenceRegistryValidationResult {
  valid: boolean;
  errors: IntelligenceRegistryValidationIssue[];
  warnings: IntelligenceRegistryValidationIssue[];
}

export interface IntelligenceRegistryOptions {
  allowReplacement?: boolean;
  initializeOnRegister?: boolean;
  now?: () => number;
}

export interface IntelligenceRegistrationOptions {
  replace?: boolean;
  initialize?: boolean;
}

export type IntelligenceRegistryListener = (
  event: IntelligenceRegistryEvent,
) => void;

export type IntelligenceRegistryEvent =
  | {
      type: "registered" | "replaced" | "unregistered";
      id: string;
      registration?: ResolvedIntelligenceRegistration;
    }
  | {
      type: "enabled" | "disabled" | "failed";
      id: string;
      registration: ResolvedIntelligenceRegistration;
    }
  | {
      type: "cleared";
      ids: readonly string[];
    };

const REGISTRY_SNAPSHOT_VERSION = 1;

function normalizeId(value: string): string {
  return value.trim();
}

function normalizePriority(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 100;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function freezeArray<T>(values: readonly T[] | undefined): readonly T[] | undefined {
  return values ? Object.freeze([...values]) : undefined;
}

function copyMetadata(
  metadata: IntelligenceRegistryMetadata | undefined,
): Readonly<IntelligenceRegistryMetadata> {
  const copy: IntelligenceRegistryMetadata = { ...(metadata ?? {}) };
  if (metadata?.tags) copy.tags = Object.freeze(uniqueStrings(metadata.tags));
  return Object.freeze(copy);
}

function matchesAny<T>(value: T, allowed: readonly T[] | undefined): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(value);
}

function hasAllTags(
  metadata: Readonly<IntelligenceRegistryMetadata>,
  requiredTags: readonly string[] | undefined,
): boolean {
  if (!requiredTags || requiredTags.length === 0) return true;
  const tags = new Set(metadata.tags ?? []);
  return requiredTags.every((tag) => tags.has(tag));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown registry error";
}

export class IntelligenceRegistryError extends Error {
  public readonly code: string;
  public readonly registrationId?: string;

  public constructor(code: string, message: string, registrationId?: string) {
    super(message);
    this.name = "IntelligenceRegistryError";
    this.code = code;
    this.registrationId = registrationId;
  }
}

export class IntelligenceRegistry {
  private readonly registrations = new Map<
    string,
    ResolvedIntelligenceRegistration
  >();

  private readonly listeners = new Set<IntelligenceRegistryListener>();
  private readonly initializedRegistrationIds = new Set<string>();
  private readonly allowReplacement: boolean;
  private readonly initializeOnRegister: boolean;
  private readonly now: () => number;
  private sequence = 0;

  public constructor(options: IntelligenceRegistryOptions = {}) {
    this.allowReplacement = options.allowReplacement ?? false;
    this.initializeOnRegister = options.initializeOnRegister ?? false;
    this.now = options.now ?? Date.now;
  }

  public get size(): number {
    return this.registrations.size;
  }

  public has(id: string): boolean {
    return this.registrations.has(normalizeId(id));
  }

  public get<TComponent = unknown>(
    id: string,
  ): ResolvedIntelligenceRegistration<TComponent> | undefined {
    return this.registrations.get(normalizeId(id)) as
      | ResolvedIntelligenceRegistration<TComponent>
      | undefined;
  }

  public require<TComponent = unknown>(
    id: string,
  ): ResolvedIntelligenceRegistration<TComponent> {
    const registration = this.get<TComponent>(id);
    if (!registration) {
      throw new IntelligenceRegistryError(
        "registration-not-found",
        `Intelligence registration "${id}" was not found.`,
        id,
      );
    }
    return registration;
  }

  public getComponent<TComponent = unknown>(id: string): TComponent | undefined {
    return this.get<TComponent>(id)?.component;
  }

  public requireComponent<TComponent = unknown>(id: string): TComponent {
    return this.require<TComponent>(id).component;
  }

  public async register<TComponent>(
    input: IntelligenceRegistration<TComponent>,
    options: IntelligenceRegistrationOptions = {},
  ): Promise<ResolvedIntelligenceRegistration<TComponent>> {
    const id = normalizeId(input.id);
    if (!id) {
      throw new IntelligenceRegistryError(
        "invalid-registration-id",
        "An intelligence registration requires a non-empty id.",
      );
    }

    if (!input.component) {
      throw new IntelligenceRegistryError(
        "missing-component",
        `Intelligence registration "${id}" requires a component.`,
        id,
      );
    }

    const existing = this.registrations.get(id);
    const replace = options.replace ?? this.allowReplacement;

    if (existing && !replace) {
      throw new IntelligenceRegistryError(
        "duplicate-registration",
        `Intelligence registration "${id}" already exists.`,
        id,
      );
    }

    if (existing) {
      await this.disposeRegistration(existing);
      this.initializedRegistrationIds.delete(existing.id);
    }

    const enabled = input.enabled ?? true;
    const registration: ResolvedIntelligenceRegistration<TComponent> = {
      id,
      kind: input.kind,
      component: input.component,
      enabled,
      priority: normalizePriority(input.priority),
      required: input.required ?? false,
      dependencies: Object.freeze(uniqueStrings(input.dependencies)),
      modes: freezeArray(input.modes),
      consumers: freezeArray(input.consumers),
      metadata: copyMetadata(input.metadata),
      status: enabled ? "enabled" : "disabled",
      registeredAt: this.now(),
      sequence: ++this.sequence,
    };

    this.registrations.set(id, registration);

    const shouldInitialize = options.initialize ?? this.initializeOnRegister;
    if (shouldInitialize) {
      try {
        await this.initializeRegistration(registration);
      } catch (error) {
        this.markFailed(id, error);
        throw new IntelligenceRegistryError(
          "registration-initialization-failed",
          `Failed to initialize intelligence registration "${id}": ${toErrorMessage(error)}`,
          id,
        );
      }
    }

    this.emit({
      type: existing ? "replaced" : "registered",
      id,
      registration,
    });

    return registration;
  }

  public async registerMany(
    registrations: readonly IntelligenceRegistration[],
    options: IntelligenceRegistrationOptions = {},
  ): Promise<ResolvedIntelligenceRegistration[]> {
    const results: ResolvedIntelligenceRegistration[] = [];
    for (const registration of registrations) {
      results.push(await this.register(registration, options));
    }
    return results;
  }

  public async unregister(id: string): Promise<boolean> {
    const normalizedId = normalizeId(id);
    const registration = this.registrations.get(normalizedId);
    if (!registration) return false;

    await this.disposeRegistration(registration);
    this.initializedRegistrationIds.delete(normalizedId);
    this.registrations.delete(normalizedId);
    this.emit({ type: "unregistered", id: normalizedId, registration });
    return true;
  }

  public enable(id: string): ResolvedIntelligenceRegistration {
    return this.setEnabled(id, true);
  }

  public disable(id: string): ResolvedIntelligenceRegistration {
    return this.setEnabled(id, false);
  }

  public setEnabled(
    id: string,
    enabled: boolean,
  ): ResolvedIntelligenceRegistration {
    const current = this.require(id);
    if (current.enabled === enabled && current.status !== "failed") return current;

    const updated: ResolvedIntelligenceRegistration = {
      ...current,
      enabled,
      status: enabled ? "enabled" : "disabled",
      error: undefined,
    };

    this.registrations.set(current.id, updated);
    this.emit({
      type: enabled ? "enabled" : "disabled",
      id: current.id,
      registration: updated,
    });
    return updated;
  }

  public markFailed(
    id: string,
    error: unknown,
  ): ResolvedIntelligenceRegistration {
    const current = this.require(id);
    const updated: ResolvedIntelligenceRegistration = {
      ...current,
      status: "failed",
      error: toErrorMessage(error),
    };
    this.registrations.set(current.id, updated);
    this.emit({ type: "failed", id: current.id, registration: updated });
    return updated;
  }

  public list(
    query: IntelligenceRegistryQuery = {},
  ): ResolvedIntelligenceRegistration[] {
    const ids = query.ids ? new Set(query.ids.map(normalizeId)) : null;
    const kinds = query.kinds ? new Set(query.kinds) : null;
    const enabledOnly = query.enabledOnly ?? false;
    const includeFailed = query.includeFailed ?? false;

    return [...this.registrations.values()]
      .filter((registration) => {
        if (ids && !ids.has(registration.id)) return false;
        if (kinds && !kinds.has(registration.kind)) return false;
        if (enabledOnly && !registration.enabled) return false;
        if (!includeFailed && registration.status === "failed") return false;
        if (query.mode && !matchesAny(query.mode, registration.modes)) return false;
        if (
          query.consumer &&
          !matchesAny(query.consumer, registration.consumers)
        ) {
          return false;
        }
        return hasAllTags(registration.metadata, query.tags);
      })
      .sort(this.compareRegistrations);
  }

  public resolve(
    query: IntelligenceRegistryQuery = {},
  ): ResolvedIntelligenceRegistration[] {
    const selected = this.list({ ...query, enabledOnly: true });
    const selectedIds = new Set(selected.map((item) => item.id));

    for (const registration of [...selected]) {
      this.collectDependencies(registration, selectedIds, query);
    }

    const registrations = [...selectedIds]
      .map((id) => this.require(id))
      .filter((registration) => registration.enabled)
      .filter((registration) => registration.status !== "failed");

    return this.topologicalSort(registrations);
  }

  public resolveForContext(
    context: IntelligenceContext,
    kinds?: readonly IntelligenceRegistrationKind[],
  ): ResolvedIntelligenceRegistration[] {
    return this.resolve({
      kinds,
      mode: context.mode,
      consumer: context.consumer,
      enabledOnly: true,
    });
  }

  public validate(
    query: IntelligenceRegistryQuery = {},
  ): IntelligenceRegistryValidationResult {
    const errors: IntelligenceRegistryValidationIssue[] = [];
    const warnings: IntelligenceRegistryValidationIssue[] = [];
    const registrations = this.list({ ...query, includeFailed: true });
    const selectedIds = new Set(registrations.map((item) => item.id));

    for (const registration of registrations) {
      if (registration.required && registration.status === "failed") {
        errors.push({
          code: "failed-required-registration",
          registrationId: registration.id,
          message: `Required registration "${registration.id}" is in a failed state.`,
        });
      }

      for (const dependencyId of registration.dependencies) {
        const dependency = this.registrations.get(dependencyId);
        if (!dependency) {
          const issue: IntelligenceRegistryValidationIssue = {
            code: "missing-dependency",
            registrationId: registration.id,
            dependencyId,
            message: `Registration "${registration.id}" depends on missing registration "${dependencyId}".`,
          };
          (registration.required ? errors : warnings).push(issue);
          continue;
        }

        if (!dependency.enabled && registration.required) {
          errors.push({
            code: "disabled-required-dependency",
            registrationId: registration.id,
            dependencyId,
            message: `Required registration "${registration.id}" depends on disabled registration "${dependencyId}".`,
          });
        }

        if (!selectedIds.has(dependencyId) && query.ids) {
          warnings.push({
            code: "missing-dependency",
            registrationId: registration.id,
            dependencyId,
            message: `Dependency "${dependencyId}" is outside the requested registry selection.`,
          });
        }
      }
    }

    try {
      this.topologicalSort(registrations);
    } catch (error) {
      errors.push({
        code: "circular-dependency",
        registrationId:
          error instanceof IntelligenceRegistryError && error.registrationId
            ? error.registrationId
            : "registry",
        message: toErrorMessage(error),
      });
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  public snapshot(): IntelligenceRegistrySnapshot {
    const registrations = this.list({ includeFailed: true });
    return {
      version: REGISTRY_SNAPSHOT_VERSION,
      generatedAt: this.now(),
      total: registrations.length,
      enabled: registrations.filter((item) => item.enabled).length,
      disabled: registrations.filter((item) => !item.enabled).length,
      failed: registrations.filter((item) => item.status === "failed").length,
      registrations: registrations.map((registration) => ({
        id: registration.id,
        kind: registration.kind,
        enabled: registration.enabled,
        required: registration.required,
        priority: registration.priority,
        dependencies: registration.dependencies,
        modes: registration.modes,
        consumers: registration.consumers,
        status: registration.status,
        metadata: registration.metadata,
        registeredAt: registration.registeredAt,
        error: registration.error,
      })),
    };
  }

  public subscribe(listener: IntelligenceRegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async initializeAll(
    query: IntelligenceRegistryQuery = {},
  ): Promise<void> {
    for (const registration of this.resolve(query)) {
      try {
        await this.initializeRegistration(registration);
      } catch (error) {
        this.markFailed(registration.id, error);
        if (registration.required) throw error;
      }
    }
  }

  public async clear(): Promise<void> {
    const registrations = [...this.registrations.values()].sort((a, b) =>
      this.compareRegistrations(b, a),
    );
    const ids = registrations.map((item) => item.id);

    for (const registration of registrations) {
      await this.disposeRegistration(registration);
    }

    this.registrations.clear();
    this.initializedRegistrationIds.clear();
    this.emit({ type: "cleared", ids });
  }

  private collectDependencies(
    registration: ResolvedIntelligenceRegistration,
    selectedIds: Set<string>,
    query: IntelligenceRegistryQuery,
  ): void {
    for (const dependencyId of registration.dependencies) {
      const dependency = this.registrations.get(dependencyId);
      if (!dependency) {
        if (registration.required) {
          throw new IntelligenceRegistryError(
            "missing-dependency",
            `Required registration "${registration.id}" depends on missing registration "${dependencyId}".`,
            registration.id,
          );
        }
        continue;
      }

      if (!dependency.enabled || dependency.status === "failed") {
        if (registration.required) {
          throw new IntelligenceRegistryError(
            "unavailable-dependency",
            `Required registration "${registration.id}" depends on unavailable registration "${dependencyId}".`,
            registration.id,
          );
        }
        continue;
      }

      if (query.mode && !matchesAny(query.mode, dependency.modes)) continue;
      if (
        query.consumer &&
        !matchesAny(query.consumer, dependency.consumers)
      ) {
        continue;
      }

      if (!selectedIds.has(dependencyId)) {
        selectedIds.add(dependencyId);
        this.collectDependencies(dependency, selectedIds, query);
      }
    }
  }

  private topologicalSort(
    registrations: readonly ResolvedIntelligenceRegistration[],
  ): ResolvedIntelligenceRegistration[] {
    const byId = new Map(registrations.map((item) => [item.id, item]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const result: ResolvedIntelligenceRegistration[] = [];

    const visit = (registration: ResolvedIntelligenceRegistration): void => {
      if (visited.has(registration.id)) return;
      if (visiting.has(registration.id)) {
        throw new IntelligenceRegistryError(
          "circular-dependency",
          `Circular intelligence dependency detected at "${registration.id}".`,
          registration.id,
        );
      }

      visiting.add(registration.id);

      const dependencies = registration.dependencies
        .map((id) => byId.get(id))
        .filter(
          (item): item is ResolvedIntelligenceRegistration => Boolean(item),
        )
        .sort(this.compareRegistrations);

      for (const dependency of dependencies) visit(dependency);

      visiting.delete(registration.id);
      visited.add(registration.id);
      result.push(registration);
    };

    for (const registration of [...registrations].sort(
      this.compareRegistrations,
    )) {
      visit(registration);
    }

    return result;
  }

  private readonly compareRegistrations = (
    left: ResolvedIntelligenceRegistration,
    right: ResolvedIntelligenceRegistration,
  ): number => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return left.id.localeCompare(right.id);
  };

  private async initializeRegistration(
    registration: ResolvedIntelligenceRegistration,
  ): Promise<void> {
    if (this.initializedRegistrationIds.has(registration.id)) return;

    const component = registration.component as IntelligenceRegistryComponent;
    if (typeof component.initialize === "function") {
      await component.initialize(this);
    }

    this.initializedRegistrationIds.add(registration.id);
  }

  private async disposeRegistration(
    registration: ResolvedIntelligenceRegistration,
  ): Promise<void> {
    const component = registration.component as IntelligenceRegistryComponent;
    if (typeof component.dispose === "function") await component.dispose();
  }

  private emit(event: IntelligenceRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Registry listeners are observational and must never interrupt runtime.
      }
    }
  }
}

export function createIntelligenceRegistry(
  registrations: readonly IntelligenceRegistration[] = [],
  options: IntelligenceRegistryOptions = {},
): IntelligenceRegistry {
  const registry = new IntelligenceRegistry(options);

  // Registration is normally synchronous unless a component initializes. This
  // helper intentionally skips initialization so it can remain synchronous.
  for (const input of registrations) {
    void registry.register(input, { initialize: false });
  }

  return registry;
}

