export type TradeSide = "buy" | "sell";
export type PositionSide = "long" | "short";
export type OrderType = "market" | "limit" | "stop";
export type SizingMode = "shares" | "dollars";

export type TradingAccount = {
  buyingPower: number;
  cash: number;
  portfolioValue: number;
  dayPnl: number;
  dayPnlPct: number;
};

export type TradePlanState = {
  symbol: string;
  side: PositionSide;
  entry: number;
  target: number;
  stop: number;
  shares: number;
};

export type QuickOrderState = {
  symbol: string;
  side: TradeSide;
  sizingMode: SizingMode;
  shares: number;
  dollars: number;
  orderType: OrderType;
  limitPrice: number;
  stopPrice: number;
  extendedHours: boolean;
  bracketEnabled: boolean;
  bracketTarget: number;
  bracketStop: number;
};

export type CurrentPositionState = {
  symbol: string;
  side: PositionSide;
  shares: number;
  entry: number;
  target: number;
  stop: number;
};

export type QuickOrderEstimate = {
  estimatedShares: number;
  estimatedCost: number;
  riskPerShare: number;
  totalRisk: number;
  rewardPerShare: number;
  totalReward: number;
  rMultiple: number;
};

export type TradePlanStats = {
  activeEntry: number;
  riskPerShare: number;
  rewardPerShare: number;
  totalRisk: number;
  totalReward: number;
  rMultiple: number;
};

export type CurrentPositionStats = {
  activeEntry: number;
  pnlPerShare: number;
  unrealizedPnl: number;
  riskPerShare: number;
  currentR: number;
  progressToTarget: number;
};

export type OpenOrderStatus = "open" | "pending" | "accepted";

export type OpenOrderState = {
  id: string;
  symbol: string;
  side: TradeSide;
  type: OrderType | "bracket";
  shares: number;
  limitPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  status: OpenOrderStatus;
  createdAt: string;
};

export type JournalExitReason =
  | "target"
  | "stop"
  | "manual"
  | "scale-out"
  | "mock-fill";

export type JournalTradeState = {
  id: string;
  date: string;
  time: string;
  symbol: string;
  strategy: string;
  side: TradeSide;
  shares: number;
  entry: number;
  exit: number;
  target: number;
  stop: number;
  exitReason: JournalExitReason;
  holdTime: string;
  grossPnl: number;
  netPnl: number;
  rMultiple: number;
  notes: string;
};