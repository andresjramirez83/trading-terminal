import type { QuickOrderEstimate, QuickOrderState } from "./TradingTypes";

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function calculateQuickOrderEstimate(
  order: QuickOrderState,
  currentPrice: number
): QuickOrderEstimate {
  const price =
    order.orderType === "limit" && order.limitPrice > 0
      ? order.limitPrice
      : currentPrice;

  const safePrice = price > 0 ? price : 0;

  const estimatedShares =
    order.sizingMode === "shares"
      ? Math.max(0, Math.floor(order.shares))
      : safePrice > 0
        ? Math.max(0, Math.floor(order.dollars / safePrice))
        : 0;

  const estimatedCost = estimatedShares * safePrice;

  const riskPerShare =
    order.bracketEnabled && order.bracketStop > 0 && safePrice > 0
      ? Math.abs(safePrice - order.bracketStop)
      : 0;

  const rewardPerShare =
    order.bracketEnabled && order.bracketTarget > 0 && safePrice > 0
      ? Math.abs(order.bracketTarget - safePrice)
      : 0;

  const totalRisk = riskPerShare * estimatedShares;
  const totalReward = rewardPerShare * estimatedShares;

  const rMultiple = totalRisk > 0 ? totalReward / totalRisk : 0;

  return {
    estimatedShares: safeNumber(estimatedShares),
    estimatedCost: safeNumber(estimatedCost),
    riskPerShare: safeNumber(riskPerShare),
    totalRisk: safeNumber(totalRisk),
    rewardPerShare: safeNumber(rewardPerShare),
    totalReward: safeNumber(totalReward),
    rMultiple: safeNumber(rMultiple),
  };
}