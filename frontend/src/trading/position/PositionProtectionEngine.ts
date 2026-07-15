// src/trading/position/PositionProtectionEngine.ts

import type {
  CurrentPositionState,
  OpenOrderState,
  PositionSide,
} from "../../components/chart/right-panel/workspaces/trading/TradingTypes";

export type PositionProtectionOrder = {
  id: string;
  symbol: string;
  shares: number;
  price: number;
  kind: "stop" | "target";
  rawOrder: OpenOrderState;
};

export type PositionProtectionState = {
  symbol: string;
  position: CurrentPositionState;
  stopOrder: PositionProtectionOrder | null;
  targetOrder: PositionProtectionOrder | null;
  stopOrderId: string | null;
  targetOrderId: string | null;
  stopPrice: number;
  targetPrice: number;
  breakEvenPrice: number;
  riskPerShare: number;
  rewardPerShare: number;
  totalRisk: number;
  totalReward: number;
  rewardRiskRatio: number;
  hasStop: boolean;
  hasTarget: boolean;
  hasProtection: boolean;
  canMoveStop: boolean;
  canMoveTarget: boolean;
};

export type PositionProtectionMap = Record<string, PositionProtectionState>;

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function getClosingSide(positionSide: PositionSide): "buy" | "sell" {
  return positionSide === "long" ? "sell" : "buy";
}

function isClosingOrder(
  position: CurrentPositionState,
  order: OpenOrderState,
): boolean {
  return (
    cleanSymbol(order.symbol) === cleanSymbol(position.symbol) &&
    order.side === getClosingSide(position.side)
  );
}

function getStopPrice(order: OpenOrderState): number {
  return safeNumber(order.stopPrice);
}

function getTargetPrice(order: OpenOrderState): number {
  return safeNumber(order.targetPrice ?? order.limitPrice);
}

function isStopCandidate(order: OpenOrderState): boolean {
  return getStopPrice(order) > 0;
}

function isTargetCandidate(order: OpenOrderState): boolean {
  return getTargetPrice(order) > 0;
}

function isValidStopForPosition(
  position: CurrentPositionState,
  price: number,
): boolean {
  if (price <= 0 || position.entry <= 0) return price > 0;

  return position.side === "long"
    ? price <= position.entry
    : price >= position.entry;
}

function isValidTargetForPosition(
  position: CurrentPositionState,
  price: number,
): boolean {
  if (price <= 0 || position.entry <= 0) return price > 0;

  return position.side === "long"
    ? price >= position.entry
    : price <= position.entry;
}

function chooseNearestStop(
  position: CurrentPositionState,
  orders: OpenOrderState[],
): OpenOrderState | null {
  const candidates = orders
    .filter((order) => isClosingOrder(position, order))
    .filter(isStopCandidate)
    .filter((order) => isValidStopForPosition(position, getStopPrice(order)));

  if (candidates.length === 0) return null;

  return candidates.reduce((best, candidate) => {
    const bestDistance = Math.abs(position.entry - getStopPrice(best));
    const candidateDistance = Math.abs(
      position.entry - getStopPrice(candidate),
    );

    return candidateDistance < bestDistance ? candidate : best;
  });
}

function chooseNearestTarget(
  position: CurrentPositionState,
  orders: OpenOrderState[],
): OpenOrderState | null {
  const candidates = orders
    .filter((order) => isClosingOrder(position, order))
    .filter(isTargetCandidate)
    .filter((order) =>
      isValidTargetForPosition(position, getTargetPrice(order)),
    );

  if (candidates.length === 0) return null;

  return candidates.reduce((best, candidate) => {
    const bestDistance = Math.abs(position.entry - getTargetPrice(best));
    const candidateDistance = Math.abs(
      position.entry - getTargetPrice(candidate),
    );

    return candidateDistance < bestDistance ? candidate : best;
  });
}

function toProtectionOrder(
  order: OpenOrderState | null,
  kind: "stop" | "target",
): PositionProtectionOrder | null {
  if (!order) return null;

  const price = kind === "stop" ? getStopPrice(order) : getTargetPrice(order);

  if (price <= 0) return null;

  return {
    id: order.id,
    symbol: cleanSymbol(order.symbol),
    shares: safeNumber(order.shares),
    price,
    kind,
    rawOrder: order,
  };
}

function calculateRiskPerShare(
  position: CurrentPositionState,
  stopPrice: number,
): number {
  if (position.entry <= 0 || stopPrice <= 0) return 0;

  return position.side === "long"
    ? Math.max(0, position.entry - stopPrice)
    : Math.max(0, stopPrice - position.entry);
}

function calculateRewardPerShare(
  position: CurrentPositionState,
  targetPrice: number,
): number {
  if (position.entry <= 0 || targetPrice <= 0) return 0;

  return position.side === "long"
    ? Math.max(0, targetPrice - position.entry)
    : Math.max(0, position.entry - targetPrice);
}

export class PositionProtectionEngine {
  buildProtection(
    position: CurrentPositionState,
    openOrders: OpenOrderState[],
  ): PositionProtectionState {
    const safePosition: CurrentPositionState = {
      ...position,
      symbol: cleanSymbol(position.symbol),
      shares: Math.max(0, safeNumber(position.shares)),
      entry: safeNumber(position.entry),
      stop: safeNumber(position.stop),
      target: safeNumber(position.target),
    };

    const liveStopOrder = toProtectionOrder(
      chooseNearestStop(safePosition, openOrders),
      "stop",
    );

    const liveTargetOrder = toProtectionOrder(
      chooseNearestTarget(safePosition, openOrders),
      "target",
    );

    const stopPrice = liveStopOrder?.price ?? safePosition.stop;
    const targetPrice = liveTargetOrder?.price ?? safePosition.target;
    const riskPerShare = calculateRiskPerShare(safePosition, stopPrice);
    const rewardPerShare = calculateRewardPerShare(
      safePosition,
      targetPrice,
    );
    const totalRisk = riskPerShare * safePosition.shares;
    const totalReward = rewardPerShare * safePosition.shares;
    const rewardRiskRatio = totalRisk > 0 ? totalReward / totalRisk : 0;

    return {
      symbol: safePosition.symbol,
      position: {
        ...safePosition,
        stop: stopPrice,
        target: targetPrice,
      },
      stopOrder: liveStopOrder,
      targetOrder: liveTargetOrder,
      stopOrderId: liveStopOrder?.id ?? null,
      targetOrderId: liveTargetOrder?.id ?? null,
      stopPrice,
      targetPrice,
      breakEvenPrice: safePosition.entry,
      riskPerShare,
      rewardPerShare,
      totalRisk,
      totalReward,
      rewardRiskRatio,
      hasStop: stopPrice > 0,
      hasTarget: targetPrice > 0,
      hasProtection: stopPrice > 0 && targetPrice > 0,
      canMoveStop: Boolean(liveStopOrder?.id),
      canMoveTarget: Boolean(liveTargetOrder?.id),
    };
  }

  buildProtectionMap(
    positions: CurrentPositionState[],
    openOrders: OpenOrderState[],
  ): PositionProtectionMap {
    return positions.reduce<PositionProtectionMap>((map, position) => {
      const protection = this.buildProtection(position, openOrders);

      if (protection.symbol) {
        map[protection.symbol] = protection;
      }

      return map;
    }, {});
  }

  findProtection(
    symbol: string,
    positions: CurrentPositionState[],
    openOrders: OpenOrderState[],
  ): PositionProtectionState | null {
    const safeSymbol = cleanSymbol(symbol);
    const position = positions.find(
      (item) => cleanSymbol(item.symbol) === safeSymbol,
    );

    if (!position) return null;

    return this.buildProtection(position, openOrders);
  }
}

let sharedPositionProtectionEngine: PositionProtectionEngine | null = null;

export function getSharedPositionProtectionEngine(): PositionProtectionEngine {
  if (!sharedPositionProtectionEngine) {
    sharedPositionProtectionEngine = new PositionProtectionEngine();
  }

  return sharedPositionProtectionEngine;
}