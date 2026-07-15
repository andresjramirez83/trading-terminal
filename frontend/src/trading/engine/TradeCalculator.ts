// src/trading/engine/TradeCalculator.ts

import type {
  TradeDirection,
  TradeMetrics,
  TradeObject,
  TradeSizingMode,
  TradeTarget,
} from "./TradeTypes";

const EMPTY_METRICS: TradeMetrics = {
  riskPerShare: 0,
  rewardPerShare: 0,
  riskPercent: 0,
  rewardPercent: 0,
  riskAmount: 0,
  rewardAmount: 0,
  rr: 0,
  positionValue: 0,
  estimatedShares: 0,
};

function finite(value: unknown): number | null {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function getPrimaryTarget(targets: TradeTarget[]): number | null {
  const target = targets.find((item) => Number.isFinite(Number(item.price))) ?? null;
  return target ? Number(target.price) : null;
}

export function calculateRiskPerShare(
  direction: TradeDirection,
  entry: number | null,
  stop: number | null,
): number {
  const safeEntry = finite(entry);
  const safeStop = finite(stop);
  if (safeEntry == null || safeStop == null) return 0;

  if (direction === "long") return Math.max(0, safeEntry - safeStop);
  return Math.max(0, safeStop - safeEntry);
}

export function calculateRewardPerShare(
  direction: TradeDirection,
  entry: number | null,
  target: number | null,
): number {
  const safeEntry = finite(entry);
  const safeTarget = finite(target);
  if (safeEntry == null || safeTarget == null) return 0;

  if (direction === "long") return Math.max(0, safeTarget - safeEntry);
  return Math.max(0, safeEntry - safeTarget);
}

export function estimateShares(params: {
  entry: number | null;
  riskPerShare: number;
  sizingMode: TradeSizingMode;
  shares: number | null;
  dollarAmount: number | null;
  riskAmount: number | null;
}): number {
  const entry = finite(params.entry);
  const explicitShares = finite(params.shares);
  const dollarAmount = finite(params.dollarAmount);
  const riskAmount = finite(params.riskAmount);

  if (params.sizingMode === "shares" && explicitShares != null) {
    return Math.max(0, Math.floor(explicitShares));
  }

  if (params.sizingMode === "dollars" && entry != null && entry > 0 && dollarAmount != null) {
    return Math.max(0, Math.floor(dollarAmount / entry));
  }

  if (params.sizingMode === "risk" && params.riskPerShare > 0 && riskAmount != null) {
    return Math.max(0, Math.floor(riskAmount / params.riskPerShare));
  }

  if (explicitShares != null) return Math.max(0, Math.floor(explicitShares));
  return 0;
}

export function calculateTradeMetrics(trade: Pick<TradeObject,
  | "direction"
  | "entry"
  | "stop"
  | "targets"
  | "sizingMode"
  | "shares"
  | "dollarAmount"
  | "riskAmount"
>): TradeMetrics {
  const entry = finite(trade.entry);
  const target = getPrimaryTarget(trade.targets);

  if (entry == null || entry <= 0) return { ...EMPTY_METRICS };

  const riskPerShare = calculateRiskPerShare(trade.direction, entry, trade.stop);
  const rewardPerShare = calculateRewardPerShare(trade.direction, entry, target);
  const rr = riskPerShare > 0 ? rewardPerShare / riskPerShare : 0;
  const riskPercent = riskPerShare > 0 ? (riskPerShare / entry) * 100 : 0;
  const rewardPercent = rewardPerShare > 0 ? (rewardPerShare / entry) * 100 : 0;
  const estimatedShares = estimateShares({
    entry,
    riskPerShare,
    sizingMode: trade.sizingMode,
    shares: trade.shares,
    dollarAmount: trade.dollarAmount,
    riskAmount: trade.riskAmount,
  });

  return {
    riskPerShare,
    rewardPerShare,
    riskPercent,
    rewardPercent,
    riskAmount: estimatedShares * riskPerShare,
    rewardAmount: estimatedShares * rewardPerShare,
    rr,
    positionValue: estimatedShares * entry,
    estimatedShares,
  };
}

export function formatTradePrice(value: number | null | undefined): string {
  const safe = finite(value);
  if (safe == null) return "--";
  if (Math.abs(safe) >= 100) return safe.toFixed(2);
  if (Math.abs(safe) >= 10) return safe.toFixed(3);
  return safe.toFixed(4);
}
