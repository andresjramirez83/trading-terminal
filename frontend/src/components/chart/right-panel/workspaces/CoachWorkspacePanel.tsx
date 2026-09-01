import type { CSSProperties } from "react";
import { useTradeHistoryStore } from "../../../../trading/hooks/useTradeHistoryStore";
import TradeJournalWidget from "./trading/TradeJournalWidget";

type CoachWorkspacePanelProps = {
  symbol: string;
};

export default function CoachWorkspacePanel({
  symbol,
}: CoachWorkspacePanelProps) {
  const historyStore = useTradeHistoryStore();
  const safeSymbol = String(symbol || "—").trim().toUpperCase() || "—";

  return (
    <div style={styles.panel}>
      <section style={styles.headerCard}>
        <div style={styles.headerRow}>
          <div>
            <div style={styles.kicker}>AI Coach Workspace</div>
            <div style={styles.title}>VWAP +3 Coach</div>
          </div>
          <div style={styles.symbolBadge}>{safeSymbol}</div>
        </div>

        <div style={styles.description}>
          Post-trade coaching and VWAP +3 research live here so the Trading tab
          stays focused on execution. Reviews include entry quality, frozen
          target/invalidation, EMA/VWAP trend, market structure, liquidity,
          demand/FVG context, Level 2 research, and post-entry price behavior.
        </div>
      </section>

      <TradeJournalWidget
        trades={historyStore.journalTrades}
        coachReviews={historyStore.vwap3CoachReviews}
        coachStudy={historyStore.vwap3CoachStudy}
        personalSummary={historyStore.vwap3CoachPersonalSummary}
        showCoach
      />
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 2,
    color: "#e5e7eb",
  },
  headerCard: {
    border: "1px solid rgba(96,165,250,.24)",
    borderRadius: 16,
    padding: 12,
    background:
      "linear-gradient(180deg, rgba(30,58,138,.16), rgba(15,23,42,.72))",
  },
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  kicker: {
    fontSize: 10,
    color: "#93c5fd",
    textTransform: "uppercase",
    letterSpacing: 0.9,
    fontWeight: 800,
  },
  title: {
    marginTop: 2,
    fontSize: 18,
    fontWeight: 900,
    color: "#f8fafc",
  },
  symbolBadge: {
    border: "1px solid rgba(96,165,250,.36)",
    background: "rgba(37,99,235,.14)",
    color: "#bfdbfe",
    borderRadius: 999,
    padding: "5px 9px",
    fontSize: 10,
    fontWeight: 900,
  },
  description: {
    marginTop: 9,
    fontSize: 10,
    lineHeight: 1.45,
    color: "#94a3b8",
  },
};
