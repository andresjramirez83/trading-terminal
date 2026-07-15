import type { AlpacaMode } from "../../../services/api";
import type {
  CurrentPositionState,
  FilledOrderState,
  OpenOrderState,
  PerformanceSnapshot,
  TradeHistoryEntry,
  TradingAccount,
} from "../../../components/chart/right-panel/workspaces/trading/TradingTypes";

export type TradeConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error";

export type TradeExecutionStatus = "idle" | "loading" | "success" | "error";

export type TradeExecutionAction =
  | "idle"
  | "refreshing"
  | "submitting-order"
  | "canceling-order"
  | "modifying-order"
  | "closing-position"
  | "flattening-positions";

export type TradeExecutionSnapshot = {
  mode: AlpacaMode;
  connectionStatus: TradeConnectionStatus;
  status: TradeExecutionStatus;
  action: TradeExecutionAction;
  loading: boolean;
  lastError: string | null;
  lastMessage: string | null;

  account: TradingAccount;
  positions: CurrentPositionState[];
  openOrders: OpenOrderState[];
  filledOrders: FilledOrderState[];
  tradeHistory: TradeHistoryEntry[];
  performance: PerformanceSnapshot;

  rawAccount: any | null;
  rawPositions: any[];
  rawOpenOrders: any[];
  rawClosedOrders: any[];
  rawFilledOrders: any[];

  updatedAt: number | null;
  refreshCount: number;
};

export type TradeExecutionListener = (
  snapshot: TradeExecutionSnapshot,
) => void;

export type SubmitQuickOrderResult = {
  ok: boolean;
  order?: any;
  error?: string;
};

export type ClosePositionOptions = {
  extendedHours?: boolean;
};

export type FlattenPositionsResult = {
  ok: boolean;
  results: SubmitQuickOrderResult[];
  error?: string;
};

export const EMPTY_TRADING_ACCOUNT: TradingAccount = {
  buyingPower: 0,
  cash: 0,
  portfolioValue: 0,
  dayPnl: 0,
  dayPnlPct: 0,
};

export const EMPTY_PERFORMANCE_SNAPSHOT: PerformanceSnapshot = {
  totalTrades: 0,
  closedTrades: 0,
  openTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  grossProfit: 0,
  grossLoss: 0,
  netPnl: 0,
  profitFactor: 0,
  expectancy: 0,
  averageWinner: 0,
  averageLoser: 0,
  averageR: 0,
  largestWinner: 0,
  largestLoser: 0,
};