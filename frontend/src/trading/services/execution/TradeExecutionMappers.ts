import type {
  CurrentPositionState,
  FilledOrderState,
  OpenOrderState,
  QuickOrderEstimate,
  QuickOrderState,
  TradingAccount,
} from "../../../components/chart/right-panel/workspaces/trading/TradingTypes";

export function toNumber(value: unknown): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

export function cleanSymbol(symbol: string): string {
  return String(symbol || "").trim().toUpperCase();
}

export function roundShares(value: number): number {
  return Math.max(0, Math.floor(toNumber(value)));
}

export function getOrderCreatedAt(order: any): string {
  const raw =
    order?.created_at ??
    order?.submitted_at ??
    order?.updated_at ??
    order?.filled_at ??
    null;

  if (!raw) return "—";

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(raw);

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getOrderDateTime(order: any): string {
  const raw =
    order?.filled_at ??
    order?.created_at ??
    order?.submitted_at ??
    order?.updated_at ??
    null;

  if (!raw) return "—";

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(raw);

  return `${date.toLocaleDateString([], {
    month: "short",
    day: "2-digit",
    year: "numeric",
  })} ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function normalizeOrderType(order: any): OpenOrderState["type"] {
  const orderClass = String(order?.order_class ?? "").toLowerCase();
  const type = String(order?.type ?? "market").toLowerCase();

  if (orderClass === "bracket" || orderClass === "oco" || orderClass === "oto") {
    return "bracket";
  }

  if (type === "limit") return "limit";
  if (type === "stop") return "stop";
  return "market";
}

function normalizeOpenOrderStatus(order: any): OpenOrderState["status"] {
  const status = String(order?.status ?? "")
    .trim()
    .toLowerCase();

  if (
    ["new", "accepted", "accepted_for_bidding", "held"].includes(status)
  ) {
    return "accepted";
  }

  if (
    ["pending_new", "pending_replace", "pending_cancel", "partially_filled"].includes(
      status,
    )
  ) {
    return "pending";
  }

  return "open";
}

export function findNestedTarget(order: any): number | undefined {
  const legs = Array.isArray(order?.legs) ? order.legs : [];

  for (const leg of legs) {
    const type = String(leg?.type ?? "").toLowerCase();
    const limitPrice = toNumber(leg?.limit_price);

    if (limitPrice > 0 && type === "limit") {
      return limitPrice;
    }
  }

  const takeProfit = toNumber(order?.take_profit?.limit_price);
  return takeProfit > 0 ? takeProfit : undefined;
}

export function findNestedStop(order: any): number | undefined {
  const legs = Array.isArray(order?.legs) ? order.legs : [];

  for (const leg of legs) {
    const type = String(leg?.type ?? "").toLowerCase();
    const stopPrice = toNumber(leg?.stop_price);

    if (stopPrice > 0 || type === "stop") {
      return stopPrice > 0 ? stopPrice : undefined;
    }
  }

  const stopLoss = toNumber(order?.stop_loss?.stop_price);
  return stopLoss > 0 ? stopLoss : undefined;
}

export function normalizeAccount(raw: any): TradingAccount {
  const portfolioValue = toNumber(raw?.portfolio_value);
  const lastEquity = toNumber(raw?.last_equity);
  const equity = toNumber(raw?.equity);
  const dayPnl = equity > 0 && lastEquity > 0 ? equity - lastEquity : 0;
  const dayPnlPct = lastEquity > 0 ? (dayPnl / lastEquity) * 100 : 0;

  return {
    buyingPower: toNumber(raw?.buying_power),
    cash: toNumber(raw?.cash),
    portfolioValue,
    dayPnl,
    dayPnlPct,
  };
}

export function normalizePosition(raw: any): CurrentPositionState {
  const qty = toNumber(raw?.qty);
  const avgEntry = toNumber(raw?.avg_entry_price);

  return {
    symbol: cleanSymbol(raw?.symbol),
    side: qty >= 0 ? "long" : "short",
    shares: Math.abs(qty),
    entry: avgEntry,
    target: 0,
    stop: 0,
  };
}

export function normalizeOpenOrder(raw: any): OpenOrderState {
  const qty = toNumber(raw?.qty);
  const limitPrice = toNumber(raw?.limit_price);
  const stopPrice = toNumber(raw?.stop_price) || findNestedStop(raw);
  const targetPrice = findNestedTarget(raw);

  return {
    id: String(raw?.id ?? crypto.randomUUID()),
    symbol: cleanSymbol(raw?.symbol),
    side: String(raw?.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy",
    type: normalizeOrderType(raw),
    shares: Math.abs(qty),
    limitPrice: limitPrice > 0 ? limitPrice : undefined,
    stopPrice: stopPrice && stopPrice > 0 ? stopPrice : undefined,
    targetPrice: targetPrice && targetPrice > 0 ? targetPrice : undefined,
    status: normalizeOpenOrderStatus(raw),
    createdAt: getOrderCreatedAt(raw),
  };
}

export function normalizeFilledOrder(raw: any): FilledOrderState {
  const filledQty = toNumber(raw?.filled_qty) || toNumber(raw?.qty);
  const averageFillPrice =
    toNumber(raw?.filled_avg_price) ||
    toNumber(raw?.average_fill_price) ||
    toNumber(raw?.limit_price);

  const limitPrice = toNumber(raw?.limit_price);
  const stopPrice = toNumber(raw?.stop_price) || findNestedStop(raw);
  const targetPrice = findNestedTarget(raw);

  return {
    id: String(raw?.id ?? crypto.randomUUID()),
    orderId: String(raw?.id ?? ""),
    symbol: cleanSymbol(raw?.symbol),
    side: String(raw?.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy",
    shares: Math.abs(filledQty),
    type: normalizeOrderType(raw),
    averageFillPrice,
    limitPrice: limitPrice > 0 ? limitPrice : undefined,
    stopPrice: stopPrice && stopPrice > 0 ? stopPrice : undefined,
    targetPrice: targetPrice && targetPrice > 0 ? targetPrice : undefined,
    // Keep broker timestamps as ISO strings. Formatting them here loses the
    // timezone offset and can move a Pacific-time trade onto the wrong
    // calendar day when Journal/AI Coach parses it later.
    filledAt: String(
      raw?.filled_at ??
        raw?.updated_at ??
        raw?.created_at ??
        raw?.submitted_at ??
        "",
    ),
    submittedAt: raw?.submitted_at ? String(raw.submitted_at) : undefined,
    status: "filled",
    raw,
  };
}

export function isFilledOrder(raw: any): boolean {
  const status = String(raw?.status ?? "").toLowerCase();
  const filledQty = toNumber(raw?.filled_qty);
  const avgPrice =
    toNumber(raw?.filled_avg_price) ||
    toNumber(raw?.average_fill_price);

  return status === "filled" || (filledQty > 0 && avgPrice > 0);
}

export function validateQuickOrder(
  order: QuickOrderState,
  estimate: QuickOrderEstimate,
): string | null {
  const symbol = cleanSymbol(order.symbol);

  if (!symbol || symbol === "—") return "Symbol is required.";
  if (estimate.estimatedShares <= 0) return "Estimated shares must be greater than 0.";

  if (order.orderType === "limit" && order.limitPrice <= 0) {
    return "Limit price is required for limit orders.";
  }

  if (order.orderType === "stop") {
    return "Standalone stop orders are not wired yet. Use market or limit for now.";
  }

  if (order.bracketEnabled) {
    if (order.bracketTarget <= 0 && order.bracketStop <= 0) {
      return "Bracket order needs a target or stop.";
    }

    if (order.bracketTarget > 0 && order.bracketStop > 0) {
      if (order.side === "buy" && order.bracketTarget <= order.bracketStop) {
        return "For long brackets, target must be above stop.";
      }

      if (order.side === "sell" && order.bracketTarget >= order.bracketStop) {
        return "For short brackets, target must be below stop.";
      }
    }
  }

  return null;
}