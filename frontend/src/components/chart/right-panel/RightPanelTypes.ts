export type RightPanelWorkspace =
  | "chart"
  | "trade"
  | "watchlists"
  | "scanner"
  | "news"
  | "level2";

export type ReadinessStatus = "bullish" | "neutral" | "bearish";

export interface TradeReadinessItem {
  label: string;
  status: ReadinessStatus;
}

export interface TradeReadinessData {
  score: number;
  items: TradeReadinessItem[];
}