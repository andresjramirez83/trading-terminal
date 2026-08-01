/**
 * EventSequenceAnalyzer.ts
 *
 * Detects meaningful sequences of market events.
 */

import type {
  MarketMemoryEvent,
  MarketSequence,
} from "./MarketMemoryTypes";

export interface SequenceRule {
  id: string;
  name: string;
  eventTypes: string[];
  minConfidence?: number;
}

export interface SequenceMatch {
  sequence: MarketSequence;
  matchedEvents: MarketMemoryEvent[];
}

export class EventSequenceAnalyzer {
  private readonly rules = new Map<string, SequenceRule>();

  registerRule(rule: SequenceRule): void {
    this.rules.set(rule.id, { ...rule });
  }

  unregisterRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  clearRules(): void {
    this.rules.clear();
  }

  analyze(events: readonly MarketMemoryEvent[]): SequenceMatch[] {
    const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const results: SequenceMatch[] = [];

    for (const rule of this.rules.values()) {
      const matched: MarketMemoryEvent[] = [];
      let cursor = 0;

      for (const requiredType of rule.eventTypes) {
        while (cursor < ordered.length) {
          const event = ordered[cursor++];
          const minConfidence = rule.minConfidence ?? 0;

          if (
            event.type === requiredType &&
            event.confidence >= minConfidence
          ) {
            matched.push(event);
            break;
          }
        }
      }

      if (matched.length === rule.eventTypes.length) {
        const avgConfidence =
          matched.reduce((s, e) => s + e.confidence, 0) / matched.length;

        results.push({
          sequence: {
            id: rule.id,
            name: rule.name,
            active: true,
            completed: true,
            confidence: avgConfidence,
            eventIds: matched.map((e) => e.id),
          },
          matchedEvents: matched,
        });
      }
    }

    return results;
  }
}

export default EventSequenceAnalyzer;
