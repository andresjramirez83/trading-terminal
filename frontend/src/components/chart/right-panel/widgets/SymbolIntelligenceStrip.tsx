import { useEffect, useMemo, useState } from "react";
import {
  fetchSymbolIntelligence,
  type SymbolIntelligenceResponse,
} from "../../../../services/api";

type Props = {
  symbol: string;
};

function tone(data: SymbolIntelligenceResponse | null): {
  border: string;
  background: string;
  color: string;
} {
  if (data?.active_halt) {
    return {
      border: "rgba(248,113,113,.65)",
      background: "rgba(127,29,29,.24)",
      color: "#fecaca",
    };
  }
  if (data?.alerts.some((alert) => alert.severity === "critical")) {
    return {
      border: "rgba(251,146,60,.55)",
      background: "rgba(124,45,18,.18)",
      color: "#fed7aa",
    };
  }
  return {
    border: "rgba(96,165,250,.22)",
    background: "rgba(30,41,59,.55)",
    color: "#cbd5e1",
  };
}

export default function SymbolIntelligenceStrip({ symbol }: Props) {
  const [data, setData] = useState<SymbolIntelligenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const safeSymbol = symbol.trim().toUpperCase();
    if (!safeSymbol || safeSymbol === "—") return;

    let active = true;
    const load = () => {
      void fetchSymbolIntelligence(safeSymbol)
        .then((next) => {
          if (!active) return;
          setData(next);
          setError(null);
        })
        .catch((nextError) => {
          if (!active) return;
          setError(nextError instanceof Error ? nextError.message : "News unavailable");
        });
    };

    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [symbol]);

  const counts = useMemo(() => {
    const earningsNews = data?.news.filter((item) => item.category === "earnings").length ?? 0;
    const earnings = data?.earnings?.today ? Math.max(1, earningsNews) : earningsNews;
    return {
      news: data?.news.length ?? 0,
      sec: data?.filings.length ?? 0,
      earnings,
    };
  }, [data]);

  const colors = tone(data);
  const haltText = data?.active_halt
    ? `HALTED ${data.active_halt.reason_code ?? ""}`.trim()
    : "NO HALT";

  return (
    <section
      title={error ?? "Symbol news, halt, earnings, and SEC status"}
      style={{
        display: "grid",
        gridTemplateColumns: "1.35fr repeat(3, .8fr)",
        gap: 6,
        alignItems: "center",
        border: `1px solid ${colors.border}`,
        background: colors.background,
        borderRadius: 9,
        padding: "8px 9px",
        color: colors.color,
      }}
    >
      <Metric label="HALT" value={data ? haltText : error ? "OFFLINE" : "CHECKING"} strong={Boolean(data?.active_halt)} />
      <Metric label="NEWS" value={String(counts.news)} />
      <Metric label="EARN" value={String(counts.earnings)} />
      <Metric label="SEC" value={String(counts.sec)} />
    </section>
  );
}

function Metric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 9, color: "#64748b", fontWeight: 800, letterSpacing: ".06em" }}>{label}</div>
      <div
        style={{
          marginTop: 2,
          fontSize: strong ? 11 : 10,
          fontWeight: 900,
          color: strong ? "#fecaca" : "inherit",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
    </div>
  );
}
