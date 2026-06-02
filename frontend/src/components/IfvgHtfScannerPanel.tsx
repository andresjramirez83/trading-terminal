import { useEffect, useMemo, useRef, useState } from "react";
import { runIfvgHtfScanner } from "../services/api";
import type { ScannerV2Response, ScannerV2Row } from "../types/market";

type Props = {
  selectedSymbol: string;
  onSelectSymbol: (symbol: string, row?: ScannerV2Row) => void;
  compact?: boolean;
};

function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(digits);
}

function statusStyle(status?: string | null) {
  const value = String(status || "").toLowerCase();
  if (value.includes("bounce")) return { color: "#86efac", border: "rgba(34,197,94,0.35)", background: "rgba(22,101,52,0.25)" };
  if (value.includes("retest")) return { color: "#fde68a", border: "rgba(245,158,11,0.35)", background: "rgba(146,64,14,0.25)" };
  if (value.includes("failure")) return { color: "#fecaca", border: "rgba(248,113,113,0.35)", background: "rgba(127,29,29,0.25)" };
  if (value.includes("approach")) return { color: "#bfdbfe", border: "rgba(59,130,246,0.35)", background: "rgba(30,64,175,0.22)" };
  return { color: "#cbd5e1", border: "rgba(148,163,184,0.25)", background: "rgba(51,65,85,0.20)" };
}


function phaseStyle(phase?: string | null) {
  const value = String(phase || "").toUpperCase();
  if (value === "TRIGGERED") return { color: "#022c22", border: "rgba(16,185,129,0.70)", background: "#34d399" };
  if (value === "READY") return { color: "#022c22", border: "rgba(16,185,129,0.60)", background: "#6ee7b7" };
  if (value === "ARMED") return { color: "#eff6ff", border: "rgba(96,165,250,0.55)", background: "rgba(37,99,235,0.70)" };
  if (value === "EARLY") return { color: "#022c22", border: "rgba(16,185,129,0.60)", background: "#34d399" };
  if (value === "CONFIRMED") return { color: "#eff6ff", border: "rgba(96,165,250,0.55)", background: "rgba(37,99,235,0.85)" };
  if (value === "EXTENDED") return { color: "#451a03", border: "rgba(245,158,11,0.65)", background: "#fbbf24" };
  if (value === "FAILED") return { color: "#fee2e2", border: "rgba(248,113,113,0.55)", background: "rgba(153,27,27,0.85)" };
  return { color: "#cbd5e1", border: "rgba(148,163,184,0.25)", background: "rgba(51,65,85,0.30)" };
}

function phaseHint(phase?: string | null): string {
  const value = String(phase || "").toUpperCase();
  if (value === "TRIGGERED") return "5m close confirmed — entry ready";
  if (value === "READY") return "15m retest — waiting for 5m close";
  if (value === "ARMED") return "15m setup armed";
  if (value === "EARLY") return "Best RR window";
  if (value === "CONFIRMED") return "Valid, waiting for 5m trigger";
  if (value === "EXTENDED") return "Late — avoid chasing";
  if (value === "FAILED") return "Invalidated";
  return "Watching";
}

function normalizeRows(data: ScannerV2Response | null): ScannerV2Row[] {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return rows.filter((row) => row?.symbol).slice(0, 40);
}

export default function IfvgHtfScannerPanel({ selectedSymbol, onSelectSymbol, compact = false }: Props) {
  const [data, setData] = useState<ScannerV2Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState("");
  const [maxSymbols, setMaxSymbols] = useState(25);
  const [minVolume, setMinVolume] = useState(250000);
  const lastRunRef = useRef(0);

  const rows = useMemo(() => normalizeRows(data), [data]);

  async function refresh(force = false) {
    const now = Date.now();
    if (!force && now - lastRunRef.current < 10_000) return;
    lastRunRef.current = now;
    setLoading(true);
    setError("");
    try {
      const result = await runIfvgHtfScanner({
        max_symbols: maxSymbols,
        min_price: 0.5,
        max_price: 20,
        min_volume: minVolume,
        timeframes: "15m",
        trigger_timeframe: "5m",
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "IFVG HTF scanner failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh(false);
    }, 60_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, maxSymbols, minVolume]);

  return (
    <div
      style={{
        border: "1px solid rgba(96,165,250,0.22)",
        background: "rgba(7,23,49,0.70)",
        borderRadius: 12,
        padding: compact ? 10 : 12,
        color: "white",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 0.2 }}>15m Bullish IFVG → 5m Entry</div>
          <div style={{ fontSize: 10, opacity: 0.62 }}>15m setup · 5m close confirmation · separate from runner list</div>
        </div>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={loading}
          style={{
            border: "1px solid rgba(96,165,250,0.35)",
            background: loading ? "rgba(51,65,85,0.7)" : "rgba(37,99,235,0.82)",
            color: "#eff6ff",
            borderRadius: 8,
            padding: "6px 8px",
            fontSize: 11,
            fontWeight: 800,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Scan..." : "Refresh"}
        </button>
      </div>

      {!compact ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <label style={{ fontSize: 10, opacity: 0.75 }}>
            Max rows
            <input
              value={maxSymbols}
              onChange={(e) => setMaxSymbols(Math.max(5, Math.min(50, Number(e.target.value) || 25)))}
              type="number"
              min={5}
              max={50}
              style={{ width: "100%", marginTop: 4, boxSizing: "border-box", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "#071731", color: "white", padding: "7px 8px" }}
            />
          </label>
          <label style={{ fontSize: 10, opacity: 0.75 }}>
            Min vol
            <input
              value={minVolume}
              onChange={(e) => setMinVolume(Math.max(0, Number(e.target.value) || 0))}
              type="number"
              step={50000}
              style={{ width: "100%", marginTop: 4, boxSizing: "border-box", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "#071731", color: "white", padding: "7px 8px" }}
            />
          </label>
        </div>
      ) : null}

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: 0.78, marginBottom: 8 }}>
        <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
        Auto refresh 60s
      </label>

      {error ? (
        <div style={{ border: "1px solid rgba(248,113,113,0.28)", color: "#fecaca", background: "rgba(127,29,29,0.20)", borderRadius: 8, padding: 8, fontSize: 11, marginBottom: 8 }}>
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div style={{ border: "1px dashed rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.62)", borderRadius: 8, padding: 10, fontSize: 12 }}>
          No active HTF IFVG setups yet.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 7, maxHeight: compact ? 260 : 360, overflow: "auto" }}>
          {rows.map((row, index) => {
            const active = row.symbol === selectedSymbol;
            const chip = statusStyle(row.ifvg_status);
            const phase = String(row.ifvg_phase || "WATCH").toUpperCase();
            const phaseChip = phaseStyle(phase);
            return (
              <button
                key={`${row.symbol}-${row.timeframe}-${index}`}
                type="button"
                onClick={() => onSelectSymbol(row.symbol, row)}
                title={phaseHint(phase)}
                style={{
                  textAlign: "left",
                  padding: "9px 10px",
                  borderRadius: 10,
                  border: active ? "1px solid #60a5fa" : "1px solid rgba(255,255,255,0.08)",
                  background: active ? "rgba(30,64,175,0.45)" : "rgba(2,8,23,0.35)",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontWeight: 900 }}>{row.symbol}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <div style={{ fontSize: 10, border: `1px solid ${phaseChip.border}`, background: phaseChip.background, color: phaseChip.color, borderRadius: 999, padding: "2px 7px", fontWeight: 900 }}>
                      {phase}
                    </div>
                    <div style={{ fontSize: 10, border: `1px solid ${chip.border}`, background: chip.background, color: chip.color, borderRadius: 999, padding: "2px 7px", fontWeight: 800 }}>
                      {row.timeframe || "HTF"} · {String(row.ifvg_status || "watch").replace(/_/g, " ")}
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 5, fontSize: 10, color: phase === "EXTENDED" ? "#fde68a" : phase === "FAILED" ? "#fecaca" : "rgba(219,234,254,0.82)", fontWeight: 700 }}>
                  {phaseHint(phase)}
                </div>
                <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 10, opacity: 0.82 }}>
                  <div>Score: <strong>{fmt(row.ifvg_score ?? (row as any).score, 1)}</strong></div>
                  <div>Dist: <strong>{fmt(row.distance_to_zone_pct, 2)}%</strong></div>
                  <div>Zone: <strong>{fmt(row.zone_low, 2)}-{fmt(row.zone_high, 2)}</strong></div>
                  <div>Dir: <strong>{row.ifvg_direction || "-"}</strong></div>
                  <div>Entry: <strong>{fmt((row as any).entry_price, 2)}</strong></div>
                  <div>Trig: <strong>{String((row as any).trigger_status || "wait").replace(/_/g, " ")}</strong></div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
