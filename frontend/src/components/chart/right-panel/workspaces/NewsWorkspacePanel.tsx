import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchSymbolIntelligence,
  type SymbolIntelligenceAlert,
  type SymbolIntelligenceFiling,
  type SymbolIntelligenceNewsItem,
  type SymbolIntelligenceResponse,
} from "../../../../services/api";

type Props = {
  symbol: string;
};

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section
      style={{
        borderRadius: 9,
        border: "1px solid rgba(255,255,255,.08)",
        background: "rgba(17,24,39,.72)",
        padding: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 900, letterSpacing: ".08em", color: "#94a3b8" }}>
          {title.toUpperCase()}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function openExternal(url?: string | null) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function alertTone(alert: SymbolIntelligenceAlert) {
  if (alert.severity === "critical") {
    return { border: "rgba(248,113,113,.5)", background: "rgba(127,29,29,.22)", color: "#fecaca" };
  }
  if (alert.severity === "high") {
    return { border: "rgba(251,191,36,.4)", background: "rgba(120,53,15,.18)", color: "#fde68a" };
  }
  return { border: "rgba(96,165,250,.3)", background: "rgba(30,64,175,.12)", color: "#bfdbfe" };
}

function NewsRow({ item }: { item: SymbolIntelligenceNewsItem }) {
  const clickable = Boolean(item.url);
  return (
    <button
      type="button"
      onClick={() => openExternal(item.url)}
      disabled={!clickable}
      style={{
        width: "100%",
        textAlign: "left",
        border: "none",
        borderTop: "1px solid rgba(255,255,255,.06)",
        background: "transparent",
        color: "#e5e7eb",
        padding: "9px 0",
        cursor: clickable ? "pointer" : "default",
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 900,
            letterSpacing: ".04em",
            color:
              item.category === "offering"
                ? "#fca5a5"
                : item.category === "earnings"
                  ? "#fde68a"
                  : item.category === "catalyst"
                    ? "#86efac"
                    : "#93c5fd",
          }}
        >
          {(item.category || "news").toUpperCase()}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#64748b", whiteSpace: "nowrap" }}>
          {formatTime(item.created_at)}
        </span>
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.35, fontWeight: 800 }}>{item.headline || "Untitled news item"}</div>
      {item.summary && (
        <div
          style={{
            marginTop: 4,
            fontSize: 10,
            lineHeight: 1.4,
            color: "#94a3b8",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {item.summary}
        </div>
      )}
    </button>
  );
}

function FilingRow({ item }: { item: SymbolIntelligenceFiling }) {
  const important = item.category === "offering" || item.category === "earnings" || item.category === "material_event";
  return (
    <button
      type="button"
      onClick={() => openExternal(item.url)}
      disabled={!item.url}
      style={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: "58px 1fr auto",
        gap: 8,
        alignItems: "center",
        border: "none",
        borderTop: "1px solid rgba(255,255,255,.06)",
        background: "transparent",
        padding: "8px 0",
        color: "#e5e7eb",
        textAlign: "left",
        cursor: item.url ? "pointer" : "default",
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 900, color: important ? "#fde68a" : "#93c5fd" }}>{item.form}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.description || item.category || "SEC filing"}
        </div>
        <div style={{ marginTop: 2, fontSize: 9, color: "#64748b" }}>{item.filing_date || "—"}</div>
      </div>
      <div style={{ fontSize: 11, color: "#64748b" }}>↗</div>
    </button>
  );
}

export default function NewsWorkspacePanel({ symbol }: Props) {
  const safeSymbol = symbol.trim().toUpperCase();
  const [data, setData] = useState<SymbolIntelligenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (forceRefresh = false) => {
      if (!safeSymbol) return;
      setLoading(true);
      try {
        const next = await fetchSymbolIntelligence(safeSymbol, { forceRefresh });
        setData(next);
        setError(null);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Symbol intelligence unavailable");
      } finally {
        setLoading(false);
      }
    },
    [safeSymbol],
  );

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(false), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const earningsToday = data?.earnings?.today ?? null;
  const earningsNews = data?.earnings?.latest_news ?? null;
  const earningsFiling = data?.earnings?.latest_periodic_filing ?? null;
  const sourceErrors = useMemo(() => {
    if (!data) return [];
    const entries = Object.entries(data.sources) as Array<
      [string, { ok: boolean; error?: string | null } | undefined]
    >;
    return entries
      .filter(([, source]) => source && !source.ok && source.error)
      .map(([name, source]) => `${name.replace(/_/g, " ")}: ${source?.error}`);
  }, [data]);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "2px 1px",
        }}
      >
        <div>
          <div style={{ fontSize: 10, color: "#64748b", fontWeight: 800 }}>SYMBOL INTELLIGENCE</div>
          <div style={{ marginTop: 2, fontSize: 18, color: "#f8fafc", fontWeight: 900 }}>{safeSymbol || "—"}</div>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          style={{
            border: "1px solid rgba(148,163,184,.2)",
            borderRadius: 7,
            background: "#111827",
            color: "#cbd5e1",
            padding: "6px 9px",
            fontSize: 10,
            fontWeight: 800,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.55 : 1,
          }}
        >
          {loading ? "Updating…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ border: "1px solid rgba(248,113,113,.35)", borderRadius: 8, background: "rgba(127,29,29,.18)", padding: 9, color: "#fecaca", fontSize: 10 }}>
          {error}
        </div>
      )}

      {data?.alerts.map((alert, index) => {
        const tone = alertTone(alert);
        return (
          <div
            key={`${alert.type}-${index}`}
            style={{ border: `1px solid ${tone.border}`, background: tone.background, borderRadius: 8, padding: 9, color: tone.color }}
          >
            <div style={{ fontSize: 10, fontWeight: 900 }}>{alert.title}</div>
            {alert.detail && <div style={{ marginTop: 3, fontSize: 9, lineHeight: 1.4, opacity: 0.88 }}>{alert.detail}</div>}
          </div>
        );
      })}

      <Card title="Halt Status">
        {data?.active_halt ? (
          <div style={{ border: "1px solid rgba(248,113,113,.4)", background: "rgba(127,29,29,.18)", borderRadius: 7, padding: 9 }}>
            <div style={{ color: "#fecaca", fontSize: 13, fontWeight: 900 }}>
              HALTED {data.active_halt.reason_code ? `— ${data.active_halt.reason_code}` : ""}
            </div>
            <div style={{ marginTop: 4, color: "#fca5a5", fontSize: 10 }}>{data.active_halt.reason || "Trading halted"}</div>
            <div style={{ marginTop: 5, color: "#94a3b8", fontSize: 9 }}>
              {data.active_halt.halt_date || ""} {data.active_halt.halt_time || ""} ET
            </div>
          </div>
        ) : (
          <div style={{ color: "#86efac", fontSize: 11, fontWeight: 800 }}>No active Nasdaq halt found.</div>
        )}
      </Card>

      <Card title="Earnings / Results">
        {earningsToday || earningsNews || earningsFiling ? (
          <div style={{ display: "grid", gap: 7 }}>
            {earningsToday && (
              <div style={{ border: "1px solid rgba(251,191,36,.35)", background: "rgba(120,53,15,.15)", borderRadius: 7, padding: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 900, color: "#fde68a" }}>EARNINGS TODAY</div>
                <div style={{ marginTop: 4, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <div>
                    <div style={{ fontSize: 8, color: "#64748b", fontWeight: 800 }}>TIME</div>
                    <div style={{ marginTop: 2, fontSize: 10, color: "#e5e7eb", fontWeight: 800 }}>{earningsToday.time || "Not supplied"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 8, color: "#64748b", fontWeight: 800 }}>EPS FORECAST</div>
                    <div style={{ marginTop: 2, fontSize: 10, color: "#e5e7eb", fontWeight: 800 }}>{earningsToday.eps_forecast || "—"}</div>
                  </div>
                </div>
                {earningsToday.fiscal_quarter_ending && (
                  <div style={{ marginTop: 5, fontSize: 9, color: "#94a3b8" }}>Fiscal quarter ending {earningsToday.fiscal_quarter_ending}</div>
                )}
              </div>
            )}
            {earningsNews && (
              <button
                type="button"
                onClick={() => openExternal(earningsNews.url)}
                style={{ border: "none", background: "transparent", padding: 0, textAlign: "left", color: "#e5e7eb", cursor: earningsNews.url ? "pointer" : "default" }}
              >
                <div style={{ fontSize: 9, fontWeight: 900, color: "#fde68a" }}>LATEST EARNINGS NEWS</div>
                <div style={{ marginTop: 3, fontSize: 11, fontWeight: 800, lineHeight: 1.35 }}>{earningsNews.headline}</div>
                <div style={{ marginTop: 3, fontSize: 9, color: "#64748b" }}>{formatTime(earningsNews.created_at)}</div>
              </button>
            )}
            {earningsFiling && (
              <div style={{ borderTop: "1px solid rgba(255,255,255,.06)", paddingTop: 7, fontSize: 10, color: "#94a3b8" }}>
                Latest periodic SEC filing: <strong style={{ color: "#e5e7eb" }}>{earningsFiling.form}</strong> on {earningsFiling.filing_date || "—"}
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: "#64748b", fontSize: 10, lineHeight: 1.45 }}>
            No earnings-related headline or recent periodic filing detected in the current feed.
          </div>
        )}
      </Card>

      <Card title={`Company News (${data?.news.length ?? 0})`}>
        {data?.news.length ? (
          <div>{data.news.map((item, index) => <NewsRow key={item.id || `${item.created_at}-${index}`} item={item} />)}</div>
        ) : (
          <div style={{ color: "#64748b", fontSize: 10 }}>{loading ? "Loading headlines…" : "No recent headlines found."}</div>
        )}
      </Card>

      <Card title={`SEC Filings (${data?.filings.length ?? 0})`}>
        {data?.filings.length ? (
          <div>{data.filings.map((item, index) => <FilingRow key={item.accession_number || `${item.form}-${index}`} item={item} />)}</div>
        ) : (
          <div style={{ color: "#64748b", fontSize: 10 }}>No SEC filings loaded for this symbol.</div>
        )}
      </Card>

      {sourceErrors.length > 0 && (
        <Card title="Feed Status">
          <div style={{ display: "grid", gap: 5 }}>
            {sourceErrors.map((message) => (
              <div key={message} style={{ color: "#94a3b8", fontSize: 9, lineHeight: 1.4 }}>{message}</div>
            ))}
          </div>
        </Card>
      )}

      <div style={{ padding: "0 2px 8px", color: "#475569", fontSize: 9, lineHeight: 1.35 }}>
        News refreshes every 30s while this workspace is open. Nasdaq halts are server-cached for 60s; SEC filings for 5m. Chart rendering never waits on these feeds.
      </div>
    </div>
  );
}
