// src/trading/engine/TradeTypes.ts

export type TradeDirection = "long" | "short";

export type TradeSource = "manual" | "auto" | "replay" | "scanner";

export type TradeMode = "paper" | "live" | "practice";

export type TradeStatus =
  | "draft"
  | "ready"
  | "submitted"
  | "accepted"
  | "partially_filled"
  | "filled"
  | "managing"
  | "closed"
  | "cancelled"
  | "rejected";

export type TradeSizingMode = "shares" | "dollars" | "risk";

export type TradeTarget = {
  id: string;
  price: number;
  quantityPercent: number;
  label?: string;
};

export type TradeFill = {
  id: string;
  orderId?: string;
  side: "buy" | "sell";
  price: number;
  shares: number;
  timestamp: string;
};

export type TradeDecisionSnapshot = {
  score?: number;
  grade?: string;
  trend?: number;
  momentum?: number;
  balance?: number;
  compression?: number;
  entryQuality?: number;
  risk?: number;
  raw?: unknown;
  capturedAt: string;
};

export type TradeLinks = {
  drawingId?: string;
  journalId?: string;
  decisionSnapshotId?: string;
  alpacaOrderIds?: string[];
};

export type TradeMetrics = {
  riskPerShare: number;
  rewardPerShare: number;
  riskPercent: number;
  rewardPercent: number;
  riskAmount: number;
  rewardAmount: number;
  rr: number;
  positionValue: number;
  estimatedShares: number;
};

export type TradeObject = {
  id: string;
  symbol: string;
  timeframe?: string;
  direction: TradeDirection;
  source: TradeSource;
  mode: TradeMode;
  status: TradeStatus;

  entry: number | null;
  stop: number | null;
  targets: TradeTarget[];

  sizingMode: TradeSizingMode;
  shares: number | null;
  dollarAmount: number | null;
  riskAmount: number | null;

  metrics: TradeMetrics;

  notes: string;
  tags: string[];
  strategy?: string;
  setup?: string;

  links: TradeLinks;
  fills: TradeFill[];
  decisionSnapshot?: TradeDecisionSnapshot;

  createdAt: string;
  updatedAt: string;
};

export type TradeCreateInput = {
  symbol: string;
  timeframe?: string;
  direction?: TradeDirection;
  source?: TradeSource;
  mode?: TradeMode;
  status?: TradeStatus;
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
  targets?: Array<Partial<TradeTarget> & { price: number }>;
  sizingMode?: TradeSizingMode;
  shares?: number | null;
  dollarAmount?: number | null;
  riskAmount?: number | null;
  drawingId?: string;
  notes?: string;
  tags?: string[];
  strategy?: string;
  setup?: string;
  decisionSnapshot?: TradeDecisionSnapshot;
};

export type TradeUpdateInput = Partial<
  Pick<
    TradeObject,
    | "symbol"
    | "timeframe"
    | "direction"
    | "source"
    | "mode"
    | "status"
    | "entry"
    | "stop"
    | "targets"
    | "sizingMode"
    | "shares"
    | "dollarAmount"
    | "riskAmount"
    | "notes"
    | "tags"
    | "strategy"
    | "setup"
    | "links"
    | "fills"
    | "decisionSnapshot"
  >
>;

export type TradeValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type TradeWorkspace = {
  symbol?: string;
  timeframe?: string;
};
