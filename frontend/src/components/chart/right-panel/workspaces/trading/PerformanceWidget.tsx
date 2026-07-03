type PerformanceWidgetProps = {
  symbol: string;
};

const MOCK_EQUITY = [
  { label: "Mon", value: 0 },
  { label: "Tue", value: 180 },
  { label: "Wed", value: 95 },
  { label: "Thu", value: 410 },
  { label: "Fri", value: 685 },
];

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export default function PerformanceWidget({ symbol }: PerformanceWidgetProps) {
  const maxValue = Math.max(...MOCK_EQUITY.map((item) => item.value), 1);

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
        <Metric label="Win Rate" value="62.5%" good />
        <Metric label="Profit Factor" value="2.14" good />
        <Metric label="Average R" value="1.18R" good />
        <Metric label="Average Winner" value={money(248)} good />
        <Metric label="Average Loser" value={money(-92)} danger />
        <Metric label="Best Strategy" value="6/7 Sweep" />
        <Metric label="Best Time" value="6:45 AM" />
        <Metric label="Best Weekday" value="Tuesday" />
      </div>

      <div style={styles.curveCard}>
        <div style={styles.curveHeader}>
          <span>Equity Curve</span>
          <strong>{money(MOCK_EQUITY[MOCK_EQUITY.length - 1].value)}</strong>
        </div>

        <div style={styles.chart}>
          {MOCK_EQUITY.map((item) => {
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
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: 8,
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
};