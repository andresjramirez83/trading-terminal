import { useState, type CSSProperties } from "react";
import AccountWidget from "./AccountWidget";
import QuickOrderWidget from "./QuickOrderWidget";
import TradePlanWidget from "./TradePlanWidget";
import CurrentPositionWidget from "./CurrentPositionWidget";
import OpenOrdersWidget from "./OpenOrdersWidget";
import FilledOrdersWidget from "./FilledOrdersWidget";
import AutoTradeWidget from "./AutoTradeWidget";
import TradeJournalWidget from "./TradeJournalWidget";
import PerformanceWidget from "./PerformanceWidget";
import { useTradeEngineStore } from "../../../../../trading/hooks/useTradeEngineStore";
import { useTradeHistoryStore } from "../../../../../trading/hooks/useTradeHistoryStore";

type TradingTab = "quick" | "auto" | "plan";

type TradingWorkspacePanelProps = {
  symbol: string;
  currentPrice: number;
};

const TABS: { id: TradingTab; label: string }[] = [
  { id: "quick", label: "Quick Trade" },
  { id: "auto", label: "Auto Trade" },
  { id: "plan", label: "Plan Trade" },
];

function formatTime(value: number | null): string {
  if (!value) return "—";

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getConnectionLabel(status: string): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Error";
    default:
      return "Disconnected";
  }
}

function getActionLabel(action: string): string {
  switch (action) {
    case "refreshing":
      return "Refreshing Alpaca";
    case "submitting-order":
      return "Submitting Order";
    case "canceling-order":
      return "Canceling Order";
    case "modifying-order":
      return "Modifying Order";
    case "closing-position":
      return "Closing Position";
    case "flattening-positions":
      return "Flattening Positions";
    default:
      return "Idle";
  }
}

export default function TradingWorkspacePanel({
  symbol,
  currentPrice,
}: TradingWorkspacePanelProps) {
  const [activeTab, setActiveTab] = useState<TradingTab>("quick");

  const safeSymbol = symbol || "—";
  const safePrice = Number.isFinite(currentPrice) ? currentPrice : 0;
  const store = useTradeEngineStore(safeSymbol, safePrice);
  const historyStore = useTradeHistoryStore();

  const connected = store.connectionStatus === "connected";
  const busy = store.executionLoading;
  const hasError = Boolean(store.executionError);
  const actionLabel = getActionLabel(store.executionAction);
  const connectionLabel = getConnectionLabel(store.connectionStatus);

  const selectedTradeOrderIds = new Set(
    store.selectedTrade?.links.alpacaOrderIds ?? [],
  );

  const activeAlpacaOrderCount = store.openOrders.filter((order) => {
    if (selectedTradeOrderIds.has(order.id)) return true;

    return (
      store.selectedTrade != null &&
      order.symbol.trim().toUpperCase() ===
        store.selectedTrade.symbol.trim().toUpperCase()
    );
  }).length;

  const handleSendPlanToOrder = async () => {
    await store.submitTradePlan();
  };

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <div style={styles.kicker}>Trading Module</div>
          <div style={styles.title}>{safeSymbol}</div>
        </div>

        <div style={styles.priceBox}>
          <div style={styles.priceLabel}>Last</div>
          <div style={styles.price}>
            {safePrice > 0 ? `$${safePrice.toFixed(2)}` : "—"}
          </div>
        </div>
      </div>

      <section style={styles.statusCard}>
        <div style={styles.statusTop}>
          <div>
            <div style={styles.statusLabel}>Execution Hub</div>
            <div style={styles.statusTitle}>
              {busy
                ? actionLabel
                : hasError
                  ? "Action Needed"
                  : connected
                    ? "Alpaca Connected"
                    : connectionLabel}
            </div>
          </div>

          <div
            style={{
              ...styles.statusPill,
              color: busy
                ? "#facc15"
                : hasError
                  ? "#fecaca"
                  : connected
                    ? "#bbf7d0"
                    : "#cbd5e1",
              borderColor: busy
                ? "rgba(250,204,21,.45)"
                : hasError
                  ? "rgba(248,113,113,.45)"
                  : connected
                    ? "rgba(34,197,94,.45)"
                    : "rgba(148,163,184,.25)",
              background: busy
                ? "rgba(250,204,21,.1)"
                : hasError
                  ? "rgba(127,29,29,.18)"
                  : connected
                    ? "rgba(22,163,74,.14)"
                    : "rgba(15,23,42,.8)",
            }}
          >
            {busy
              ? "WORKING"
              : hasError
                ? "ERROR"
                : connected
                  ? "PAPER"
                  : connectionLabel.toUpperCase()}
          </div>
        </div>

        <div style={styles.statusGrid}>
          <StatusMetric label="Connection" value={connectionLabel} />
          <StatusMetric label="Action" value={actionLabel} />
          <StatusMetric
            label="Refreshes"
            value={String(store.executionRefreshCount)}
          />
          <StatusMetric
            label="Updated"
            value={formatTime(store.executionUpdatedAt)}
          />
        </div>

        {store.executionMessage && !store.executionError && (
          <div style={styles.messageGood}>{store.executionMessage}</div>
        )}

        {store.executionError && (
          <div style={styles.messageBad}>{store.executionError}</div>
        )}

        <button
          type="button"
          onClick={store.refreshTradingData}
          disabled={busy}
          style={{
            ...styles.refreshButton,
            opacity: busy ? 0.55 : 1,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Refresh Alpaca
        </button>
      </section>

      <AccountWidget account={store.account} />

      <section style={styles.moduleCard}>
        <div style={styles.tabRow}>
          {TABS.map((tab) => {
            const active = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  ...styles.tabButton,
                  color: active ? "#ffffff" : "#94a3b8",
                  background: active
                    ? "rgba(37, 99, 235, 0.22)"
                    : "rgba(15, 23, 42, 0.65)",
                  borderColor: active
                    ? "rgba(96, 165, 250, 0.55)"
                    : "rgba(148, 163, 184, 0.16)",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div style={styles.moduleBody}>
          {activeTab === "quick" && (
            <QuickOrderWidget
              order={store.quickOrder}
              currentPrice={safePrice}
              onChange={store.updateQuickOrder}
              onSubmit={store.submitQuickOrder}
            />
          )}

          {activeTab === "auto" && <AutoTradeWidget symbol={safeSymbol} />}

          {activeTab === "plan" && (
            <TradePlanWidget
              plan={store.tradePlan}
              stats={store.tradePlanStats}
              currentPrice={safePrice}
              tradeStatus={store.selectedTrade?.status ?? null}
              alpacaOrderCount={activeAlpacaOrderCount}
              executionLoading={store.executionLoading}
              executionMessage={store.executionMessage}
              onChange={store.updateTradePlan}
              onSendToOrder={handleSendPlanToOrder}
              onSendToPosition={store.syncPlanToPosition}
            />
          )}
        </div>
      </section>

      <CurrentPositionWidget
        position={store.currentPosition}
        stats={store.currentPositionStats}
        currentPrice={safePrice}
        protection={store.positionProtection}
        executionLoading={store.executionLoading}
        onChange={store.updateCurrentPosition}
        onMoveStopToBreakEven={store.moveStopToBreakEven}
        onClosePosition={store.closePosition}
        onClosePositionPercent={store.closePositionPercent}
        onFlattenAllPositions={store.flattenAllPositions}
      />

      <OpenOrdersWidget
        orders={store.openOrders}
        onCancelOrder={store.cancelOpenOrder}
        onFillOrder={store.fillOpenOrder}
      />

      <FilledOrdersWidget orders={historyStore.filledOrders} />

      <PerformanceWidget
        symbol={safeSymbol}
        performance={historyStore.performance}
      />

      <TradeJournalWidget trades={historyStore.journalTrades} />
    </div>
  );
}

function StatusMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.statusMetric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 12,
    color: "#e5e7eb",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  kicker: {
    fontSize: 11,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  title: {
    fontSize: 22,
    fontWeight: 800,
  },
  priceBox: {
    textAlign: "right",
    background: "rgba(15, 23, 42, 0.9)",
    border: "1px solid rgba(148, 163, 184, 0.25)",
    borderRadius: 12,
    padding: "8px 10px",
  },
  priceLabel: {
    fontSize: 10,
    color: "#94a3b8",
    textTransform: "uppercase",
  },
  price: {
    fontSize: 16,
    fontWeight: 800,
  },
  statusCard: {
    border: "1px solid rgba(148, 163, 184, 0.22)",
    borderRadius: 16,
    background:
      "linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(2, 6, 23, 0.94))",
    padding: 12,
  },
  statusTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  statusLabel: {
    fontSize: 10,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  statusTitle: {
    fontSize: 15,
    fontWeight: 900,
  },
  statusPill: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 9px",
    fontSize: 10,
    fontWeight: 950,
    whiteSpace: "nowrap",
  },
  statusGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginTop: 10,
  },
  statusMetric: {
    display: "grid",
    gap: 3,
    border: "1px solid rgba(148,163,184,.14)",
    background: "rgba(15,23,42,.72)",
    borderRadius: 11,
    padding: "8px 9px",
    fontSize: 10,
    color: "#94a3b8",
  },
  messageGood: {
    marginTop: 10,
    border: "1px solid rgba(34,197,94,.22)",
    background: "rgba(22,163,74,.1)",
    color: "#bbf7d0",
    borderRadius: 11,
    padding: "8px 10px",
    fontSize: 11,
    lineHeight: 1.35,
  },
  messageBad: {
    marginTop: 10,
    border: "1px solid rgba(248,113,113,.3)",
    background: "rgba(127,29,29,.18)",
    color: "#fecaca",
    borderRadius: 11,
    padding: "8px 10px",
    fontSize: 11,
    lineHeight: 1.35,
  },
  refreshButton: {
    width: "100%",
    marginTop: 10,
    border: "1px solid rgba(96,165,250,.35)",
    background: "rgba(37,99,235,.16)",
    color: "#bfdbfe",
    borderRadius: 12,
    padding: "9px",
    fontSize: 11,
    fontWeight: 900,
  },
  moduleCard: {
    border: "1px solid rgba(148, 163, 184, 0.22)",
    borderRadius: 18,
    background:
      "linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(2, 6, 23, 0.96))",
    padding: 10,
    boxShadow: "0 20px 50px rgba(0,0,0,.22)",
  },
  tabRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 8,
    marginBottom: 10,
  },
  tabButton: {
    border: "1px solid",
    borderRadius: 12,
    padding: "10px 6px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
  moduleBody: {
    display: "grid",
  },
};