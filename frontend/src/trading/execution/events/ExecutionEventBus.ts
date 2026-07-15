// src/trading/execution/events/ExecutionEventBus.ts

import type {
  ExecutionEvent,
  ExecutionEventFilter,
  ExecutionEventListener,
  ExecutionEventSource,
  ExecutionEventType,
} from "./ExecutionEventTypes";

type ListenerRegistration = {
  listener: ExecutionEventListener;
  filter?: ExecutionEventFilter;
};

const MAX_EVENT_HISTORY = 500;

function matchesFilter(
  event: ExecutionEvent,
  filter?: ExecutionEventFilter,
): boolean {
  if (!filter) return true;

  if (
    filter.types &&
    filter.types.length > 0 &&
    !filter.types.includes(event.type)
  ) {
    return false;
  }

  if (
    filter.sources &&
    filter.sources.length > 0 &&
    !filter.sources.includes(event.source)
  ) {
    return false;
  }

  if (
    filter.modes &&
    filter.modes.length > 0 &&
    !filter.modes.includes(event.mode)
  ) {
    return false;
  }

  return true;
}

export class ExecutionEventBus {
  private listeners = new Set<ListenerRegistration>();
  private history: ExecutionEvent[] = [];

  emit<TType extends ExecutionEventType>(
    event: ExecutionEvent<TType>,
  ): void {
    this.history.push(event);

    if (this.history.length > MAX_EVENT_HISTORY) {
      this.history.splice(
        0,
        this.history.length - MAX_EVENT_HISTORY,
      );
    }

    for (const registration of this.listeners) {
      if (!matchesFilter(event, registration.filter)) continue;

      try {
        registration.listener(event);
      } catch (error) {
        console.error(
          "[ExecutionEventBus] listener failed",
          error,
        );
      }
    }
  }

  subscribe(
    listener: ExecutionEventListener,
    filter?: ExecutionEventFilter,
  ): () => void {
    const registration: ListenerRegistration = {
      listener,
      filter,
    };

    this.listeners.add(registration);

    return () => {
      this.listeners.delete(registration);
    };
  }

  subscribeToType<TType extends ExecutionEventType>(
    type: TType,
    listener: ExecutionEventListener<TType>,
  ): () => void {
    return this.subscribe(
      listener as ExecutionEventListener,
      { types: [type] },
    );
  }

  subscribeToSource(
    source: ExecutionEventSource,
    listener: ExecutionEventListener,
  ): () => void {
    return this.subscribe(listener, {
      sources: [source],
    });
  }

  getHistory(filter?: ExecutionEventFilter): ExecutionEvent[] {
    return this.history
      .filter((event) => matchesFilter(event, filter))
      .map((event) => ({ ...event }));
  }

  clearHistory(): void {
    this.history = [];
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  destroy(): void {
    this.clearListeners();
    this.clearHistory();
  }
}

let sharedExecutionEventBus: ExecutionEventBus | null = null;

export function getSharedExecutionEventBus(): ExecutionEventBus {
  if (!sharedExecutionEventBus) {
    sharedExecutionEventBus = new ExecutionEventBus();
  }

  return sharedExecutionEventBus;
}

export function resetSharedExecutionEventBus(): void {
  sharedExecutionEventBus?.destroy();
  sharedExecutionEventBus = null;
}