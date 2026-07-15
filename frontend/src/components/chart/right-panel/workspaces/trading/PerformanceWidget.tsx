import type { PerformanceSnapshot } from "./TradingTypes";

type PerformanceWidgetProps = {
  symbol: string;
  performance?: PerformanceSnapshot | null;
};

const EMPTY_PERFORMANCE: PerformanceSnapshot = {
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

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function number(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(digits);
}

export default function PerformanceWidget({
  symbol,
  performance,
}: PerformanceWidgetProps) {
  const stats = performance ?? EMPTY_PERFORMANCE;

  const chartItems = [
    { label: "Profit", value: Math.max(0, stats.grossProfit) },
    { label: "Loss", value: Math.max(0, stats.grossLoss) },
    { label: "Net", value: Math.abs(stats.netPnl) },
  ];

  const maxValue = Math.max(...chartItems.map((item) => item.value), 1);

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Analytics</div>
          <div style={styles.title}>Performance</div>
        </div>

        <div style={styles.symbolBadge}>{symbol}</div>
      </div>

      <div style={styles.metrics}>
        <Metric
          label="Net P/L"
          value={money(stats.netPnl)}
          good={stats.netPnl > 0}
          danger={stats.netPnl < 0}
        />
        <Metric
          label="Win Rate"
          value={`${number(stats.winRate)}%`}
          good={stats.winRate > 50}
        />
        <Metric
          label="Profit Factor"
          value={number(stats.profitFactor)}
          good={stats.profitFactor > 1}
          danger={stats.profitFactor > 0 && stats.profitFactor < 1}
        />
        <Metric
          label="Average R"
          value={`${number(stats.averageR)}R`}
          good={stats.averageR > 0}
          danger={stats.averageR < 0}
        />
        <Metric
          label="Expectancy"
          value={money(stats.expectancy)}
          good={stats.expectancy > 0}
          danger={stats.expectancy < 0}
        />
        <Metric label="Closed Trades" value={String(stats.closedTrades)} />
        <Metric
          label="Average Winner"
          value={money(stats.averageWinner)}
          good={stats.averageWinner > 0}
        />
        <Metric
          label="Average Loser"
          value={money(-Math.abs(stats.averageLoser))}
          danger={stats.averageLoser > 0}
        />
        <Metric
          label="Largest Winner"
          value={money(stats.largestWinner)}
          good={stats.largestWinner > 0}
        />
        <Metric
          label="Largest Loser"
          value={money(stats.largestLoser)}
          danger={stats.largestLoser < 0}
        />
      </div>

      <div style={styles.summaryRow}>
        <Summary label="Total" value={stats.totalTrades} />
        <Summary label="Open" value={stats.openTrades} />
        <Summary label="Wins" value={stats.wins} good />
        <Summary label="Losses" value={stats.losses} danger />
      </div>

      <div style={styles.curveCard}>
        <div style={styles.curveHeader}>
          <span>Realized Performance</span>
          <strong
            style={{
              color:
                stats.netPnl > 0
                  ? "#22c55e"
                  : stats.netPnl < 0
                    ? "#ef4444"
                    : "#e5e7eb",
            }}
          >
            {money(stats.netPnl)}
          </strong>
        </div>

        <div style={styles.chart}>
          {chartItems.map((item) => {
            const height = Math.max(8, (item.value / maxValue) * 74);

            return (
              <div key={item.label} style={styles.barWrap}>
                <div style={styles.barTrack}>
                  <div style={{ ...styles.bar, height }} />
                </div>
                <span>{item.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {stats.closedTrades === 0 && (
        <div style={styles.empty}>
          Performance will populate after the first closed trade is matched to
          its Alpaca fills.
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  good,
  danger,
}: {
  label: string;
  value: string;
  good?: boolean;
  danger?: boolean;
}) {
  return (
    <div style={styles.metric}>
      <span>{label}</span>
      <strong
        style={{
          color: good ? "#22c55e" : danger ? "#ef4444" : "#e5e7eb",
        }}
      >
        {value}
      </strong>
    </div>
  );
}

function Summary({
  label,
  value,
  good,
  danger,
}: {
  label: string;
  value: number;
  good?: boolean;
  danger?: boolean;
}) {
  return (
    <div style={styles.summary}>
      <span>{label}</span>
      <strong
        style={{
          color: good ? "#22c55e" : danger ? "#ef4444" : "#e5e7eb",
        }}
      >
        {value}
      </strong>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid rgba(148, 163, 184, 0.22)",
    borderRadius: 18,
    background:
      "linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(2, 6, 23, 0.96))",
    padding: 14,
    boxShadow: "0 20px 50px rgba(0,0,0,.22)",
  },
  top: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
  },
  kicker: {
    fontSize: 10,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.9,
  },
  title: {
    fontSize: 16,
    fontWeight: 900,
  },
  symbolBadge: {
    border: "1px solid rgba(96,165,250,.4)",
    background: "rgba(37,99,235,.15)",
    color: "#bfdbfe",
    borderRadius: 999,
    padding: "5px 10px",
    fontSize: 11,
    fontWeight: 900,
    height: "fit-content",
  },
  metrics: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  metric: {
    display: "grid",
    gap: 3,
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(15,23,42,.72)",
    borderRadius: 12,
    padding: "9px 10px",
    fontSize: 11,
    color: "#94a3b8",
  },
  summaryRow: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 7,
    marginTop: 10,
  },
  summary: {
    display: "grid",
    justifyItems: "center",
    gap: 3,
    border: "1px solid rgba(148,163,184,.14)",
    background: "rgba(15,23,42,.6)",
    borderRadius: 10,
    padding: "8px 5px",
    color: "#64748b",
    fontSize: 9,
    fontWeight: 800,
  },
  curveCard: {
    marginTop: 12,
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(2,6,23,.55)",
    borderRadius: 14,
    padding: 10,
  },
  curveHeader: {
    display: "flex",
    justifyContent: "space-between",
    color: "#94a3b8",
    fontSize: 11,
    marginBottom: 10,
  },
  chart: {
    height: 105,
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 10,
    alignItems: "end",
  },
  barWrap: {
    display: "grid",
    gap: 6,
    justifyItems: "center",
    color: "#64748b",
    fontSize: 10,
    fontWeight: 800,
  },
  barTrack: {
    height: 78,
    width: "100%",
    borderRadius: 999,
    background: "rgba(15,23,42,.9)",
    border: "1px solid rgba(148,163,184,.12)",
    display: "flex",
    alignItems: "end",
    overflow: "hidden",
  },
  bar: {
    width: "100%",
    borderRadius: 999,
    background: "linear-gradient(180deg, #22c55e, #2563eb)",
  },
  empty: {
    marginTop: 10,
    border: "1px dashed rgba(148,163,184,.22)",
    borderRadius: 12,
    padding: 10,
    color: "#64748b",
    fontSize: 10,
    lineHeight: 1.35,
    textAlign: "center",
  },
};