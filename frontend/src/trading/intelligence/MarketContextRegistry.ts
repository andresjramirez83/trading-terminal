/**
 * MarketContextRegistry.ts
 * Registry for Market Intelligence evaluators.
 */

import type {
  MarketContextSnapshot,
} from "./types/MarketContextTypes";

export interface MarketContextEvaluator {
  readonly id: string;
  readonly name: string;
  evaluate(snapshot: MarketContextSnapshot): MarketContextSnapshot;
}

export class MarketContextRegistry {
  private readonly evaluators = new Map<string, MarketContextEvaluator>();

  register(evaluator: MarketContextEvaluator): void {
    this.evaluators.set(evaluator.id, evaluator);
  }

  unregister(id: string): void {
    this.evaluators.delete(id);
  }

  clear(): void {
    this.evaluators.clear();
  }

  getAll(): MarketContextEvaluator[] {
    return [...this.evaluators.values()];
  }

  run(snapshot: MarketContextSnapshot): MarketContextSnapshot {
    let current = snapshot;
    for (const evaluator of this.evaluators.values()) {
      current = evaluator.evaluate(current);
    }
    return current;
  }
}
