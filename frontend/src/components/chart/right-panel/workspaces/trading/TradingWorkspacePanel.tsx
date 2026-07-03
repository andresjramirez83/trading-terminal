import { useState, type CSSProperties } from "react";
import AccountWidget from "./AccountWidget";
import QuickOrderWidget from "./QuickOrderWidget";
import TradePlanWidget from "./TradePlanWidget";
import CurrentPositionWidget from "./CurrentPositionWidget";
import OpenOrdersWidget from "./OpenOrdersWidget";
import AutoTradeWidget from "./AutoTradeWidget";
import TradeJournalWidget from "./TradeJournalWidget";
import PerformanceWidget from "./PerformanceWidget";
import { useTradingWorkspaceStore } from "./TradingWorkspaceStore";

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

export default function TradingWorkspacePanel({
  symbol,
  currentPrice,
}: TradingWorkspacePanelProps) {
  const [activeTab, setActiveTab] = useState<TradingTab>("quick");

  const safeSymbol = symbol || "—";
  const safePrice = Number.isFinite(currentPrice) ? currentPrice : 0;
  const store = useTradingWorkspaceStore(safeSymbol, safePrice);

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
              onChange={store.updateTradePlan}
              onSendToOrder={store.syncPlanToOrder}
              onSendToPosition={store.syncPlanToPosition}
            />
          )}
        </div>
      </section>

      <CurrentPositionWidget
        position={store.currentPosition}
        stats={store.currentPositionStats}
        currentPrice={safePrice}
        onChange={store.updateCurrentPosition}
        onMoveStopToBreakEven={store.moveStopToBreakEven}
      />

      <OpenOrdersWidget
        orders={store.openOrders}
        onCancelOrder={store.cancelOpenOrder}
        onFillOrder={store.fillOpenOrder}
      />

      <PerformanceWidget symbol={safeSymbol} />

      <TradeJournalWidget trades={store.journalTrades} />
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