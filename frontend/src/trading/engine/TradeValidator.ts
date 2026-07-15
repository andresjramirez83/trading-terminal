// src/trading/engine/TradeValidator.ts

import type { TradeObject, TradeValidationResult } from "./TradeTypes";

function isFiniteNumber(value: unknown): boolean {
  return Number.isFinite(Number(value));
}

export function validateTrade(trade: TradeObject): TradeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!String(trade.symbol || "").trim()) errors.push("Symbol is required.");
  if (!trade.id) errors.push("Trade id is required.");

  if (trade.entry != null && !isFiniteNumber(trade.entry)) errors.push("Entry must be a valid number.");
  if (trade.stop != null && !isFiniteNumber(trade.stop)) errors.push("Stop must be a valid number.");

  for (const target of trade.targets) {
    if (!isFiniteNumber(target.price)) errors.push("Target must be a valid number.");
    if (!isFiniteNumber(target.quantityPercent)) warnings.push("Target quantity percent should be valid.");
  }

  if (trade.entry != null && trade.stop != null) {
    if (trade.direction === "long" && Number(trade.stop) >= Number(trade.entry)) {
      warnings.push("Long stop should usually be below entry.");
    }

    if (trade.direction === "short" && Number(trade.stop) <= Number(trade.entry)) {
      warnings.push("Short stop should usually be above entry.");
    }
  }

  const primaryTarget = trade.targets[0]?.price;
  if (trade.entry != null && primaryTarget != null) {
    if (trade.direction === "long" && Number(primaryTarget) <= Number(trade.entry)) {
      warnings.push("Long target should usually be above entry.");
    }

    if (trade.direction === "short" && Number(primaryTarget) >= Number(trade.entry)) {
      warnings.push("Short target should usually be below entry.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
