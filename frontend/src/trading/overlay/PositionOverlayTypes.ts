// src/trading/overlay/PositionOverlayTypes.ts

import type { TradeDirection, TradeStatus } from "../engine/TradeTypes";

export type PositionOverlayTarget = {
  id: string;
  price: number;
  label: string;
};

export type PositionOverlayState = {
  tradeId: string | null;
  symbol: string;
  side: TradeDirection;
  status: TradeStatus | "idle";
  visible: boolean;

  entryPrice: number;
  stopPrice: number;
  targets: PositionOverlayTarget[];

  quantity: number;
  currentPrice: number;

  unrealizedPnL: number;
  percentPnL: number;
  riskPerShare: number;
  currentR: number;
};

export const EMPTY_POSITION_OVERLAY: PositionOverlayState = {
  tradeId: null,
  symbol: "",
  side: "long",
  status: "idle",
  visible: false,

  entryPrice: 0,
  stopPrice: 0,
  targets: [],

  quantity: 0,
  currentPrice: 0,

  unrealizedPnL: 0,
  percentPnL: 0,
  riskPerShare: 0,
  currentR: 0,
};