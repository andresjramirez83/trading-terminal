import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  fetchAlpacaPositions,
  placeAlpacaOrder,
  type AlpacaMode,
  type AlpacaOrderClass,
  type AlpacaOrderType,
  type AlpacaSide,
} from "../services/api";

export type OrderTemplate =
  | "buy_only"
  | "buy_target"
  | "buy_stop"
  | "bracket"
  | "sell_close"
  | "flatten";

type Props = {
  open: boolean;
  initialTemplate?: OrderTemplate;
  initialSymbol?: string;
  onClose: () => void;
};

type SizeMode = "dollars" | "shares";
type PositionDirection = "long" | "short" | "flat";

type PositionSnapshot = {
  qty: number;
  side: PositionDirection;
  avgEntryPrice: number;
  marketValue: number;
};

const EMPTY_POSITION: PositionSnapshot = {
  qty: 0,
  side: "flat",
  avgEntryPrice: 0,
  marketValue: 0,
};

function toNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function formatPositionDirection(side: PositionDirection): string {
  if (side === "long") return "Long";
  if (side === "short") return "Short";
  return "Flat";
}

function normalizePosition(raw: any): PositionSnapshot {
  if (!raw) return EMPTY_POSITION;

  const qtyValue = Number(raw.qty ?? raw.position_qty ?? 0);
  const absQty = Number.isFinite(qtyValue) ? Math.abs(qtyValue) : 0;

  let side: PositionDirection = "flat";

  if (qtyValue > 0) side = "long";
  else if (qtyValue < 0) side = "short";
  else if (raw.side === "long") side = "long";
  else if (raw.side === "short") side = "short";

  return {
    qty: absQty,
    side,
    avgEntryPrice: Number(raw.avg_entry_price ?? 0) || 0,
    marketValue: Number(raw.market_value ?? 0) || 0,
  };
}

function defaultTemplateTitle(template: OrderTemplate): string {
  switch (template) {
    case "buy_only":
      return "Buy Only";
    case "buy_target":
      return "Buy + Target";
    case "buy_stop":
      return "Buy + Stop";
    case "bracket":
      return "Bracket";
    case "sell_close":
      return "Sell to Close";
    case "flatten":
      return "Flatten Position";
    default:
      return "Quick Order";
  }
}

export default function QuickOrderModal({
  open,
  initialTemplate = "buy_only",
  initialSymbol = "AAPL",
  onClose,
}: Props) {
  const [template, setTemplate] = useState<OrderTemplate>(initialTemplate);
  const [symbol, setSymbol] = useState(initialSymbol.toUpperCase());
  const [mode, setMode] = useState<AlpacaMode>("paper");

  const [sizeMode, setSizeMode] = useState<SizeMode>("dollars");
  const [tradeAmount, setTradeAmount] = useState("2000");
  const [sharesInput, setSharesInput] = useState("100");
  const [closeQuantity, setCloseQuantity] = useState("");

  const [orderType, setOrderType] = useState<AlpacaOrderType>("limit");
  const [entryPrice, setEntryPrice] = useState("3.43");
  const [targetPrice, setTargetPrice] = useState("3.90");
  const [stopPrice, setStopPrice] = useState("");

  const [position, setPosition] = useState<PositionSnapshot>(EMPTY_POSITION);
  const [loadingPosition, setLoadingPosition] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const primaryInputRef = useRef<HTMLInputElement | null>(null);

  const cleanedSymbol = useMemo(() => symbol.trim().toUpperCase(), [symbol]);

  useEffect(() => {
    if (!open) return;

    const nextSymbol =
      (initialSymbol || localStorage.getItem("activeSymbol") || "AAPL")
        .trim()
        .toUpperCase();

    setTemplate(initialTemplate);
    setSymbol(nextSymbol);
    setSubmitting(false);
    setError("");

    const timer = window.setTimeout(() => {
      primaryInputRef.current?.focus();
      primaryInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [open, initialTemplate, initialSymbol]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !cleanedSymbol) {
      setPosition(EMPTY_POSITION);
      return;
    }

    let cancelled = false;

    async function loadPosition() {
      try {
        setLoadingPosition(true);
        const rows = await fetchAlpacaPositions(mode);
        const match = Array.isArray(rows)
          ? rows.find(
              (row: any) =>
                String(row.symbol ?? "")
                  .trim()
                  .toUpperCase() === cleanedSymbol
            )
          : null;

        if (!cancelled) {
          const normalized = normalizePosition(match);
          setPosition(normalized);

          if (
            (template === "sell_close" || template === "flatten") &&
            normalized.qty > 0
          ) {
            setCloseQuantity(String(normalized.qty));
          }
        }
      } catch {
        if (!cancelled) {
          setPosition(EMPTY_POSITION);
        }
      } finally {
        if (!cancelled) {
          setLoadingPosition(false);
        }
      }
    }

    loadPosition();

    return () => {
      cancelled = true;
    };
  }, [open, cleanedSymbol, mode, template]);

  const isBuyTemplate =
    template === "buy_only" ||
    template === "buy_target" ||
    template === "buy_stop" ||
    template === "bracket";

  const isSellCloseTemplate = template === "sell_close";
  const isFlattenTemplate = template === "flatten";

  const showTarget =
    template === "buy_target" || template === "bracket";
  const showStop =
    template === "buy_stop" || template === "bracket";

  const entry = toNumber(entryPrice);
  const target = toNumber(targetPrice);
  const stop = toNumber(stopPrice);
  const dollars = toNumber(tradeAmount);
  const directShares = Math.floor(toNumber(sharesInput));
  const requestedCloseQty = Math.floor(toNumber(closeQuantity));

  const calculatedBuyShares = useMemo(() => {
    if (!isBuyTemplate) return 0;

    if (sizeMode === "shares") {
      return Math.max(0, directShares);
    }

    if (entry <= 0 || dollars <= 0) return 0;
    return Math.max(0, Math.floor(dollars / entry));
  }, [isBuyTemplate, sizeMode, directShares, entry, dollars]);

  const calculatedCloseQty = useMemo(() => {
    if (!isSellCloseTemplate) return 0;
    if (position.side !== "long" || position.qty <= 0) return 0;
    if (requestedCloseQty <= 0) return 0;
    return Math.min(position.qty, requestedCloseQty);
  }, [isSellCloseTemplate, position, requestedCloseQty]);

  const estimatedCost = calculatedBuyShares * entry;
  const estimatedExitValue = calculatedBuyShares * target;
  const estimatedProfit = estimatedExitValue - estimatedCost;

  const riskPerShare = showStop ? Math.max(0, entry - stop) : 0;
  const rewardPerShare = showTarget ? Math.max(0, target - entry) : 0;
  const estimatedRisk = calculatedBuyShares * riskPerShare;
  const estimatedReward = calculatedBuyShares * rewardPerShare;

  const rrRatio =
    riskPerShare > 0 && rewardPerShare > 0
      ? rewardPerShare / riskPerShare
      : null;

  if (!open) return null;

  async function submitOrder(request: {
    qty: number;
    side: AlpacaSide;
    type: AlpacaOrderType;
    limitPrice?: number;
    orderClass?: AlpacaOrderClass;
    takeProfitPrice?: number;
    stopLossPrice?: number;
  }) {
    await placeAlpacaOrder({
      symbol: cleanedSymbol,
      qty: request.qty,
      side: request.side,
      type: request.type,
      mode,
      limit_price: request.type === "limit" ? request.limitPrice : undefined,
      time_in_force: "day",
      extended_hours: false,
      order_class: request.orderClass,
      take_profit:
        request.takeProfitPrice && request.takeProfitPrice > 0
          ? { limit_price: request.takeProfitPrice }
          : undefined,
      stop_loss:
        request.stopLossPrice && request.stopLossPrice > 0
          ? { stop_price: request.stopLossPrice }
          : undefined,
    });

    localStorage.setItem("activeSymbol", cleanedSymbol);
  }

  const handleFlatten = async () => {
    if (!cleanedSymbol) {
      setError("Enter a symbol.");
      return;
    }

    if (position.qty <= 0 || position.side === "flat") {
      setError("No open position to flatten for this symbol.");
      return;
    }

    try {
      setSubmitting(true);
      setError("");

      const flattenSide: AlpacaSide =
        position.side === "long" ? "sell" : "buy";

      await submitOrder({
        qty: position.qty,
        side: flattenSide,
        type: "market",
      });

      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to flatten position.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!cleanedSymbol) {
      setError("Enter a symbol.");
      return;
    }

    try {
      setSubmitting(true);
      setError("");

      if (isFlattenTemplate) {
        await handleFlatten();
        return;
      }

      if (isBuyTemplate) {
        if (calculatedBuyShares <= 0) {
          setError("Enter a valid trade amount or share quantity.");
          return;
        }

        if (orderType === "limit" && entry <= 0) {
          setError("Enter a valid entry price.");
          return;
        }

        const wantsTarget = showTarget && target > 0;
        const wantsStop = showStop && stop > 0;

        if (showTarget && !wantsTarget) {
          setError("Enter a valid target price.");
          return;
        }

        if (showStop && !wantsStop) {
          setError("Enter a valid stop price.");
          return;
        }

        if (wantsTarget && orderType === "limit" && target <= entry) {
          setError("Target price must be above your entry price for a long order.");
          return;
        }

        if (wantsStop && orderType === "limit" && stop >= entry) {
          setError("Stop price must be below your entry price for a long order.");
          return;
        }

        const orderClass: AlpacaOrderClass | undefined =
          wantsTarget && wantsStop
            ? "bracket"
            : wantsTarget || wantsStop
            ? "oto"
            : undefined;

        await submitOrder({
          qty: calculatedBuyShares,
          side: "buy",
          type: orderType,
          limitPrice: entry,
          orderClass,
          takeProfitPrice: wantsTarget ? target : undefined,
          stopLossPrice: wantsStop ? stop : undefined,
        });

        onClose();
        return;
      }

      if (isSellCloseTemplate) {
        if (position.side !== "long" || position.qty <= 0) {
          setError("Sell to Close only works when you are long this symbol.");
          return;
        }

        if (calculatedCloseQty <= 0) {
          setError("Enter a valid close quantity.");
          return;
        }

        if (orderType === "limit" && entry <= 0) {
          setError("Enter a valid exit price.");
          return;
        }

        await submitOrder({
          qty: calculatedCloseQty,
          side: "sell",
          type: orderType,
          limitPrice: entry,
        });

        onClose();
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to place order.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const entryLabel = isSellCloseTemplate
    ? orderType === "limit"
      ? "Exit Price (Limit)"
      : "Reference Exit Price"
    : orderType === "limit"
    ? "Entry Price (Limit)"
    : "Reference Entry Price";

  const submitLabel = isFlattenTemplate
    ? "Flatten Now"
    : isSellCloseTemplate
    ? "Submit Sell to Close"
    : "Submit Buy";

  return (
    <div onMouseDown={onClose} style={overlayStyle}>
      <div onMouseDown={(e) => e.stopPropagation()} style={modalStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: 23, fontWeight: 800 }}>
              {defaultTemplateTitle(template)}
            </div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>
              Alt+B buy only · Alt+T buy+target · Alt+L buy+stop · Alt+R bracket
            </div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>
              Alt+S sell to close · Alt+X flatten
            </div>
          </div>

          <div
            style={{
              ...badgeStyle,
              background:
                mode === "paper"
                  ? "rgba(34,197,94,0.16)"
                  : "rgba(239,68,68,0.18)",
              border:
                mode === "paper"
                  ? "1px solid rgba(34,197,94,0.45)"
                  : "1px solid rgba(239,68,68,0.45)",
            }}
          >
            {mode.toUpperCase()}
          </div>
        </div>

        <div style={scrollBodyStyle}>
          <div style={bodyStyle}>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Order Setup</label>
              <select
                value={template}
                onChange={(e) =>
                  setTemplate(e.target.value as OrderTemplate)
                }
                style={fieldStyle}
              >
                <option value="buy_only">Buy Only</option>
                <option value="buy_target">Buy + Target</option>
                <option value="buy_stop">Buy + Stop</option>
                <option value="bracket">Bracket</option>
                <option value="sell_close">Sell to Close</option>
                <option value="flatten">Flatten Position</option>
              </select>
            </div>

            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Symbol</label>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="AAPL"
                style={fieldStyle}
              />
            </div>

            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Account Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as AlpacaMode)}
                style={fieldStyle}
              >
                <option value="paper">Paper</option>
                <option value="live">Live</option>
              </select>
            </div>

            <div style={positionCardStyle}>
              <div style={positionTitleStyle}>Current Position</div>
              <div style={summaryRowStyle}>
                <span>Status</span>
                <strong>
                  {loadingPosition
                    ? "Loading..."
                    : `${formatPositionDirection(position.side)}${
                        position.qty > 0 ? ` ${position.qty} shares` : ""
                      }`}
                </strong>
              </div>
              <div style={summaryRowStyle}>
                <span>Avg Entry</span>
                <strong>
                  {position.avgEntryPrice > 0
                    ? `$${fmtMoney(position.avgEntryPrice)}`
                    : "—"}
                </strong>
              </div>
              <div style={summaryRowStyle}>
                <span>Market Value</span>
                <strong>
                  {position.marketValue !== 0
                    ? `$${fmtMoney(position.marketValue)}`
                    : "—"}
                </strong>
              </div>

              {position.qty > 0 ? (
                <button
                  type="button"
                  onClick={handleFlatten}
                  disabled={submitting || loadingPosition}
                  style={flattenButtonStyle}
                >
                  Flatten Position Now
                </button>
              ) : null}
            </div>

            {isBuyTemplate ? (
              <>
                <div style={fieldGroupStyle}>
                  <label style={labelStyle}>Position Size</label>
                  <div style={toggleRowStyle}>
                    <button
                      type="button"
                      onClick={() => setSizeMode("dollars")}
                      style={{
                        ...toggleButtonStyle,
                        background:
                          sizeMode === "dollars" ? "#4ea1ff" : "#132847",
                        border:
                          sizeMode === "dollars"
                            ? "1px solid #76b7ff"
                            : "1px solid rgba(255,255,255,0.12)",
                      }}
                    >
                      Dollars ($)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSizeMode("shares")}
                      style={{
                        ...toggleButtonStyle,
                        background:
                          sizeMode === "shares" ? "#4ea1ff" : "#132847",
                        border:
                          sizeMode === "shares"
                            ? "1px solid #76b7ff"
                            : "1px solid rgba(255,255,255,0.12)",
                      }}
                    >
                      Shares
                    </button>
                  </div>
                </div>

                {sizeMode === "dollars" ? (
                  <div style={fieldGroupStyle}>
                    <label style={labelStyle}>Trade Amount ($)</label>
                    <input
                      ref={primaryInputRef}
                      type="number"
                      min="0"
                      step="0.01"
                      value={tradeAmount}
                      onChange={(e) => setTradeAmount(e.target.value)}
                      placeholder="2000"
                      style={fieldStyle}
                    />
                  </div>
                ) : (
                  <div style={fieldGroupStyle}>
                    <label style={labelStyle}>Quantity (Shares)</label>
                    <input
                      ref={primaryInputRef}
                      type="number"
                      min="1"
                      step="1"
                      value={sharesInput}
                      onChange={(e) => setSharesInput(e.target.value)}
                      placeholder="100"
                      style={fieldStyle}
                    />
                  </div>
                )}
              </>
            ) : null}

            {isSellCloseTemplate ? (
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Close Quantity</label>
                <input
                  ref={primaryInputRef}
                  type="number"
                  min="1"
                  step="1"
                  value={closeQuantity}
                  onChange={(e) => setCloseQuantity(e.target.value)}
                  placeholder={position.qty > 0 ? String(position.qty) : "0"}
                  style={fieldStyle}
                />
              </div>
            ) : null}

            {!isFlattenTemplate ? (
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Order Type</label>
                <select
                  value={orderType}
                  onChange={(e) =>
                    setOrderType(e.target.value as AlpacaOrderType)
                  }
                  style={fieldStyle}
                >
                  <option value="market">Market</option>
                  <option value="limit">Limit</option>
                </select>
              </div>
            ) : null}

            {(isBuyTemplate || (isSellCloseTemplate && orderType === "limit")) ? (
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>{entryLabel}</label>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={entryPrice}
                  onChange={(e) => setEntryPrice(e.target.value)}
                  placeholder={isSellCloseTemplate ? "Exit price" : "3.43"}
                  style={fieldStyle}
                />
              </div>
            ) : null}

            {showTarget ? (
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Target Price (Take Profit)</label>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={targetPrice}
                  onChange={(e) => setTargetPrice(e.target.value)}
                  placeholder="3.90"
                  style={fieldStyle}
                />
              </div>
            ) : null}

            {showStop ? (
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Stop Price (Stop Loss)</label>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={stopPrice}
                  onChange={(e) => setStopPrice(e.target.value)}
                  placeholder="Optional"
                  style={fieldStyle}
                />
              </div>
            ) : null}

            {isBuyTemplate ? (
              <div style={summaryCardStyle}>
                <div style={summaryTitleStyle}>Trade Summary</div>

                <div style={summaryRowStyle}>
                  <span>Position Size</span>
                  <strong>{calculatedBuyShares} shares</strong>
                </div>

                <div style={summaryRowStyle}>
                  <span>Est. Cost</span>
                  <strong>${fmtMoney(estimatedCost)}</strong>
                </div>

                {showTarget ? (
                  <>
                    <div style={summaryRowStyle}>
                      <span>Est. Exit Value</span>
                      <strong>${fmtMoney(estimatedExitValue)}</strong>
                    </div>

                    <div style={summaryRowStyle}>
                      <span>Est. Profit</span>
                      <strong
                        style={{
                          color:
                            estimatedProfit >= 0 ? "#4ade80" : "#f87171",
                        }}
                      >
                        ${fmtMoney(estimatedProfit)}
                      </strong>
                    </div>
                  </>
                ) : null}

                {showTarget || showStop ? (
                  <>
                    <div style={summaryDividerStyle} />

                    <div style={summaryRowStyle}>
                      <span>Risk / Share</span>
                      <strong>
                        {riskPerShare > 0 ? `$${fmtMoney(riskPerShare)}` : "—"}
                      </strong>
                    </div>

                    <div style={summaryRowStyle}>
                      <span>Reward / Share</span>
                      <strong>
                        {rewardPerShare > 0
                          ? `$${fmtMoney(rewardPerShare)}`
                          : "—"}
                      </strong>
                    </div>

                    <div style={summaryRowStyle}>
                      <span>Est. Risk</span>
                      <strong>
                        {estimatedRisk > 0 ? `$${fmtMoney(estimatedRisk)}` : "—"}
                      </strong>
                    </div>

                    <div style={summaryRowStyle}>
                      <span>Est. Reward</span>
                      <strong>
                        {estimatedReward > 0
                          ? `$${fmtMoney(estimatedReward)}`
                          : "—"}
                      </strong>
                    </div>

                    <div style={summaryRowStyle}>
                      <span>R:R Ratio</span>
                      <strong>{fmtRatio(rrRatio)}</strong>
                    </div>
                  </>
                ) : null}

                {(template === "buy_target" ||
                  template === "buy_stop" ||
                  template === "bracket") ? (
                  <div style={noteStyle}>
                    This will submit a linked Alpaca order: target-only and
                    stop-only use OTO, while target + stop uses a true bracket.
                    After the entry fills, Alpaca manages the attached exit order(s).
                  </div>
                ) : null}
              </div>
            ) : null}

            {isSellCloseTemplate ? (
              <div style={summaryCardStyle}>
                <div style={summaryTitleStyle}>Close Summary</div>
                <div style={summaryRowStyle}>
                  <span>Current Long Position</span>
                  <strong>{position.side === "long" ? `${position.qty} shares` : "—"}</strong>
                </div>
                <div style={summaryRowStyle}>
                  <span>Close Quantity</span>
                  <strong>{calculatedCloseQty || "—"}</strong>
                </div>
                <div style={noteStyle}>
                  Sell to Close only reduces or exits an existing long position.
                  It does not send a short order.
                </div>
              </div>
            ) : null}

            {isFlattenTemplate ? (
              <div style={summaryCardStyle}>
                <div style={summaryTitleStyle}>Emergency Flatten</div>
                <div style={summaryRowStyle}>
                  <span>Position to Close</span>
                  <strong>
                    {position.qty > 0
                      ? `${formatPositionDirection(position.side)} ${position.qty} shares`
                      : "No open position"}
                  </strong>
                </div>
                <div style={noteStyle}>
                  Flatten sends a market order in the opposite direction of the
                  current position so your symbol goes back to zero shares.
                </div>
              </div>
            ) : null}

            {error ? <div style={errorStyle}>{error}</div> : null}
          </div>
        </div>

        <div style={footerStyle}>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              ...actionButtonStyle,
              background: "#2b3d5c",
              border: "1px solid rgba(255,255,255,0.14)",
            }}
          >
            Cancel
          </button>

          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              ...actionButtonStyle,
              background:
                isFlattenTemplate || isSellCloseTemplate
                  ? "#c62828"
                  : "#0f9f13",
              border: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            {submitting ? "Submitting..." : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.58)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 99999,
  padding: 12,
};

const modalStyle: CSSProperties = {
  width: "100%",
  maxWidth: 440,
  maxHeight: "calc(100vh - 24px)",
  display: "flex",
  flexDirection: "column",
  background: "#082250",
  color: "#ffffff",
  borderRadius: 18,
  boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
  border: "1px solid rgba(255,255,255,0.08)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  padding: "16px 16px 10px 16px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  flexShrink: 0,
};

const badgeStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
};

const scrollBodyStyle: CSSProperties = {
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

const bodyStyle: CSSProperties = {
  padding: "0 16px 12px 16px",
  display: "grid",
  gap: 10,
};

const fieldGroupStyle: CSSProperties = {
  display: "grid",
  gap: 5,
};

const labelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  opacity: 0.92,
};

const fieldStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "#f4f4f4",
  color: "#111827",
  fontSize: 15,
  boxSizing: "border-box",
};

const toggleRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
};

const toggleButtonStyle: CSSProperties = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 10,
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 700,
};

const positionCardStyle: CSSProperties = {
  background: "#0b2c63",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: 12,
  display: "grid",
  gap: 8,
};

const positionTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
};

const flattenButtonStyle: CSSProperties = {
  marginTop: 4,
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  background: "#c62828",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 800,
};

const summaryCardStyle: CSSProperties = {
  marginTop: 2,
  background: "#0b2c63",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: 12,
  display: "grid",
  gap: 7,
};

const summaryTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  marginBottom: 2,
};

const summaryRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 14,
};

const summaryDividerStyle: CSSProperties = {
  height: 1,
  background: "rgba(255,255,255,0.10)",
  margin: "4px 0",
};

const noteStyle: CSSProperties = {
  marginTop: 4,
  padding: "8px 10px",
  borderRadius: 10,
  background: "rgba(255,255,255,0.06)",
  fontSize: 12,
  lineHeight: 1.4,
  color: "rgba(255,255,255,0.82)",
};

const errorStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(239,68,68,0.14)",
  border: "1px solid rgba(239,68,68,0.35)",
  color: "#fecaca",
  fontSize: 13,
  whiteSpace: "pre-wrap",
};

const footerStyle: CSSProperties = {
  padding: 16,
  paddingTop: 10,
  display: "flex",
  gap: 10,
  flexShrink: 0,
  background: "#082250",
  borderTop: "1px solid rgba(255,255,255,0.06)",
};

const actionButtonStyle: CSSProperties = {
  flex: 1,
  padding: "11px 14px",
  borderRadius: 10,
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 800,
};