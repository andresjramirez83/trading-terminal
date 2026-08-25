import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../../../../services/api";

type BookLevel = {
  price: number;
  size: number;
  orders: number;
};

type Wall = {
  price: number;
  size: number;
  orders: number;
  level: number;
} | null;

type BreakoutMetrics = {
  bid_stacking_pct?: number;
  bid_pulling_pct?: number;
  ask_pulling_pct?: number;
  ask_stacking_pct?: number;
  top5_imbalance_momentum?: number;
  top10_imbalance_momentum?: number;
  book_pressure_change?: number;
  aggressive_buy_volume_5s?: number;
  aggressive_sell_volume_5s?: number;
  trade_pressure_5s?: number;
  ticker_prints_5s?: number;
  ask_absorption_score?: number;
  upside_liquidity_ratio?: number | null;
  upside_path_thin?: boolean;
  bid_wall_moved_up?: boolean;
  ask_wall_moved_down?: boolean;
  spread_pct?: number;
};

type BreakoutContext = {
  score: number;
  label: string;
  ready: boolean;
  confidence: number;
  lookback_seconds: number;
  history_span_seconds: number;
  signals: string[];
  cautions: string[];
  metrics: BreakoutMetrics;
  coach?: {
    headline?: string;
    summary?: string;
    research_only?: boolean;
  };
};

type Level2Snapshot = {
  type: "level2";
  provider: string;
  symbol: string;
  name?: string;
  order_book_type?: string;
  received_at: number;
  server_bid_time?: string;
  server_ask_time?: string;
  depth: {
    bid_levels: number;
    ask_levels: number;
  };
  best_bid: number | null;
  best_ask: number | null;
  spread: number | null;
  mid: number | null;
  bids: BookLevel[];
  asks: BookLevel[];
  analytics: {
    top5_bid_size: number;
    top5_ask_size: number;
    top5_imbalance: number | null;
    top10_bid_size: number;
    top10_ask_size: number;
    top10_imbalance: number | null;
    top20_bid_size: number;
    top20_ask_size: number;
    top20_imbalance: number | null;
    book_pressure: number;
    bid_wall: Wall;
    ask_wall: Wall;
  } & BreakoutMetrics;
  breakout?: BreakoutContext;
};

type ConnectionState = "connecting" | "connected" | "error" | "closed";

function resolveLevel2WsUrl(symbol: string): string {
  const apiBase = API_BASE.replace(/\/$/, "");
  let wsBase = apiBase;

  if (/^https?:\/\//i.test(apiBase)) {
    wsBase = apiBase.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  } else if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const path = apiBase.startsWith("/") ? apiBase : `/${apiBase}`;
    wsBase = `${protocol}//${window.location.host}${path}`;
  }

  return `${wsBase}/level2/ws?symbol=${encodeURIComponent(symbol)}`;
}

function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  if (value < 1) return value.toFixed(4);
  return value.toFixed(2);
}

function formatSize(value: number | null | undefined): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

function formatRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 999) return "999x+";
  return `${value.toFixed(2)}x`;
}

function formatSigned(value: number | null | undefined, suffix = ""): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}${suffix}`;
}

function pressureLabel(value: number): string {
  if (value >= 20) return "BULLISH";
  if (value <= -20) return "BEARISH";
  return "NEUTRAL";
}

function pressureColor(value: number): string {
  if (value >= 20) return "#22c55e";
  if (value <= -20) return "#ef4444";
  return "#cbd5e1";
}

function breakoutColor(score: number, ready: boolean): string {
  if (!ready) return "#f59e0b";
  if (score >= 70) return "#22c55e";
  if (score >= 50) return "#84cc16";
  if (score >= 30) return "#f59e0b";
  return "#ef4444";
}

function Metric({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ color: valueColor || "#e5e7eb", fontWeight: 800, textAlign: "right" }}>{value}</span>
    </div>
  );
}

function SignalList({ items, tone }: { items: string[]; tone: "positive" | "caution" }) {
  if (!items.length) return null;
  const color = tone === "positive" ? "#86efac" : "#fca5a5";
  const marker = tone === "positive" ? "↑" : "!";
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {items.map((item) => (
        <div key={item} style={{ display: "flex", gap: 6, color, fontSize: 10, lineHeight: 1.35 }}>
          <span style={{ fontWeight: 900 }}>{marker}</span>
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

function BookRow({ level, side, maxSize }: { level: BookLevel; side: "bid" | "ask"; maxSize: number }) {
  const pct = maxSize > 0 ? Math.min(100, Math.max(2, (level.size / maxSize) * 100)) : 0;
  const isBid = side === "bid";
  const fill = isBid ? "rgba(34,197,94,.16)" : "rgba(239,68,68,.16)";
  const priceColor = isBid ? "#4ade80" : "#f87171";

  return (
    <div
      style={{
        position: "relative",
        height: 22,
        display: "grid",
        gridTemplateColumns: "1fr 1fr 44px",
        alignItems: "center",
        padding: "0 6px",
        overflow: "hidden",
        borderBottom: "1px solid rgba(148,163,184,.055)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 0,
          width: `${pct}%`,
          background: fill,
          pointerEvents: "none",
        }}
      />
      <span style={{ position: "relative", color: priceColor, fontSize: 11, fontWeight: 800 }}>
        {formatPrice(level.price)}
      </span>
      <span style={{ position: "relative", color: "#e5e7eb", fontSize: 11, textAlign: "right" }}>
        {formatSize(level.size)}
      </span>
      <span style={{ position: "relative", color: "#64748b", fontSize: 10, textAlign: "right" }}>
        {level.orders > 0 ? level.orders : ""}
      </span>
    </div>
  );
}

export default function Level2WorkspacePanel({ symbol }: { symbol: string }) {
  const [snapshot, setSnapshot] = useState<Level2Snapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string>("");
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const reconnectRef = useRef<number | null>(null);

  useEffect(() => {
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let attempts = 0;

    setSnapshot(null);
    setConnection("connecting");
    setError("");

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      const ws = new WebSocket(resolveLevel2WsUrl(cleanSymbol));
      socket = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempts = 0;
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const payload = JSON.parse(String(event.data || "{}"));
          if (payload?.type === "level2") {
            setSnapshot(payload as Level2Snapshot);
            setLastUpdate(Date.now());
            setConnection("connected");
            setError("");
          } else if (payload?.type === "level2_status") {
            setConnection("connected");
            setError("");
          } else if (payload?.type === "level2_error") {
            setConnection("error");
            setError(String(payload.error || "Level 2 connection error"));
          }
        } catch {
          // Ignore malformed payloads; the next valid snapshot will replace it.
        }
      };

      ws.onerror = () => {
        if (!disposed) setConnection("error");
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnection((current) => (current === "error" ? current : "closed"));
        attempts += 1;
        const delay = Math.min(8_000, 1_000 + attempts * 750);
        reconnectRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectRef.current != null) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      socket?.close();
    };
  }, [symbol]);

  const shownAsks = useMemo(() => (snapshot?.asks || []).slice(0, 12).reverse(), [snapshot]);
  const shownBids = useMemo(() => (snapshot?.bids || []).slice(0, 12), [snapshot]);
  const maxVisibleSize = useMemo(() => {
    return Math.max(1, ...shownAsks.map((row) => row.size), ...shownBids.map((row) => row.size));
  }, [shownAsks, shownBids]);

  const connectionColor = connection === "connected" ? "#22c55e" : connection === "error" ? "#ef4444" : "#f59e0b";
  const pressure = snapshot?.analytics.book_pressure ?? 0;
  const breakout = snapshot?.breakout;
  const breakoutScore = breakout?.score ?? 0;
  const breakoutReady = breakout?.ready ?? false;
  const breakoutTone = breakoutColor(breakoutScore, breakoutReady);
  const metrics = breakout?.metrics || {};

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          border: "1px solid rgba(148,163,184,.14)",
          borderRadius: 10,
          background: "rgba(15,23,42,.48)",
          padding: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ color: "#f8fafc", fontSize: 13, fontWeight: 900 }}>{symbol.toUpperCase()} LEVEL 2</div>
            <div style={{ color: "#64748b", fontSize: 10, marginTop: 2 }}>Moomoo OpenD · 60-level capable</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: connectionColor, fontSize: 10, fontWeight: 800 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: connectionColor }} />
            {connection.toUpperCase()}
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 9, padding: 8, borderRadius: 7, background: "rgba(127,29,29,.24)", color: "#fecaca", fontSize: 10, lineHeight: 1.45 }}>
            {error}
          </div>
        )}
      </div>

      {snapshot && (
        <>
          {breakout && (
            <div
              style={{
                border: `1px solid ${breakoutTone}55`,
                borderRadius: 10,
                background: `${breakoutTone}0d`,
                padding: 10,
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <div>
                  <div style={{ color: "#f8fafc", fontSize: 11, fontWeight: 900 }}>BREAKOUT PRESSURE</div>
                  <div style={{ color: "#64748b", fontSize: 9, marginTop: 2 }}>
                    Dynamic Level 2 · ~{breakout.lookback_seconds.toFixed(0)}s lookback · research only
                  </div>
                </div>
                <div style={{ color: breakoutTone, fontSize: 11, fontWeight: 900, textAlign: "right" }}>
                  {breakout.label}<br />
                  <span style={{ fontSize: 16 }}>{breakoutScore.toFixed(0)}/100</span>
                </div>
              </div>

              <div style={{ height: 7, borderRadius: 999, background: "rgba(148,163,184,.14)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.max(2, breakoutScore)}%`, background: breakoutTone, transition: "width 140ms linear" }} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 10px" }}>
                <Metric label="Bid Stack" value={formatSigned(metrics.bid_stacking_pct, "%")} valueColor="#4ade80" />
                <Metric label="Ask Pull" value={formatSigned(metrics.ask_pulling_pct, "%")} valueColor="#4ade80" />
                <Metric label="Pressure Δ" value={formatSigned(metrics.book_pressure_change)} />
                <Metric label="Top-5 Momentum" value={formatSigned(metrics.top5_imbalance_momentum, "x")} />
                <Metric label="Agg Buy 5s" value={formatSize(metrics.aggressive_buy_volume_5s)} valueColor="#4ade80" />
                <Metric label="Agg Sell 5s" value={formatSize(metrics.aggressive_sell_volume_5s)} valueColor="#f87171" />
                <Metric label="Tape Pressure" value={formatSigned(metrics.trade_pressure_5s, "%")} />
                <Metric label="Ask Absorption" value={metrics.ask_absorption_score == null ? "—" : `${metrics.ask_absorption_score.toFixed(0)}/100`} />
                <Metric label="Bid Wall Rising" value={metrics.bid_wall_moved_up ? "YES" : "No"} valueColor={metrics.bid_wall_moved_up ? "#4ade80" : undefined} />
                <Metric label="Upside Path" value={metrics.upside_path_thin ? "THIN" : "Normal"} valueColor={metrics.upside_path_thin ? "#4ade80" : undefined} />
              </div>

              <SignalList items={breakout.signals || []} tone="positive" />
              <SignalList items={breakout.cautions || []} tone="caution" />

              <div style={{ borderTop: "1px solid rgba(148,163,184,.12)", paddingTop: 7 }}>
                <div style={{ color: "#93c5fd", fontSize: 9, fontWeight: 900, letterSpacing: 0.6 }}>AI COACH · L2 BREAKOUT</div>
                <div style={{ color: "#cbd5e1", fontSize: 10, lineHeight: 1.45, marginTop: 4 }}>
                  {breakout.coach?.summary || "Waiting for breakout behavior analysis."}
                </div>
              </div>
            </div>
          )}

          <div
            style={{
              border: "1px solid rgba(148,163,184,.14)",
              borderRadius: 10,
              background: "rgba(15,23,42,.48)",
              padding: 10,
              display: "grid",
              gap: 7,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ color: "#f8fafc", fontSize: 11, fontWeight: 900 }}>BOOK INTELLIGENCE</span>
              <span style={{ color: pressureColor(pressure), fontSize: 10, fontWeight: 900 }}>
                {pressureLabel(pressure)} {pressure > 0 ? "+" : ""}{pressure.toFixed(1)}
              </span>
            </div>
            <Metric label="Best Bid / Ask" value={`${formatPrice(snapshot.best_bid)} / ${formatPrice(snapshot.best_ask)}`} />
            <Metric label="Spread" value={snapshot.spread == null ? "—" : `$${formatPrice(snapshot.spread)}`} />
            <Metric label="Top 5 Imbalance" value={formatRatio(snapshot.analytics.top5_imbalance)} />
            <Metric label="Top 10 Imbalance" value={formatRatio(snapshot.analytics.top10_imbalance)} />
            <Metric label="Top 20 Imbalance" value={formatRatio(snapshot.analytics.top20_imbalance)} />
            <Metric
              label="Bid Wall"
              value={snapshot.analytics.bid_wall ? `${formatPrice(snapshot.analytics.bid_wall.price)} · ${formatSize(snapshot.analytics.bid_wall.size)}` : "—"}
              valueColor="#4ade80"
            />
            <Metric
              label="Ask Wall"
              value={snapshot.analytics.ask_wall ? `${formatPrice(snapshot.analytics.ask_wall.price)} · ${formatSize(snapshot.analytics.ask_wall.size)}` : "—"}
              valueColor="#f87171"
            />
          </div>

          <div style={{ border: "1px solid rgba(148,163,184,.14)", borderRadius: 10, overflow: "hidden", background: "rgba(2,6,23,.62)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 44px", padding: "6px", color: "#64748b", fontSize: 9, fontWeight: 900, borderBottom: "1px solid rgba(148,163,184,.12)" }}>
              <span>PRICE</span>
              <span style={{ textAlign: "right" }}>SIZE</span>
              <span style={{ textAlign: "right" }}>ORD</span>
            </div>

            {shownAsks.map((level, index) => (
              <BookRow key={`ask-${level.price}-${index}`} level={level} side="ask" maxSize={maxVisibleSize} />
            ))}

            <div
              style={{
                height: 38,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                alignItems: "center",
                padding: "0 7px",
                borderTop: "1px solid rgba(148,163,184,.12)",
                borderBottom: "1px solid rgba(148,163,184,.12)",
                background: "rgba(15,23,42,.88)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <div>
                <div style={{ color: "#f87171", fontSize: 12, fontWeight: 900 }}>{formatPrice(snapshot.best_ask)}</div>
                <div style={{ color: "#64748b", fontSize: 9 }}>ASK</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#4ade80", fontSize: 12, fontWeight: 900 }}>{formatPrice(snapshot.best_bid)}</div>
                <div style={{ color: "#64748b", fontSize: 9 }}>BID</div>
              </div>
            </div>

            {shownBids.map((level, index) => (
              <BookRow key={`bid-${level.price}-${index}`} level={level} side="bid" maxSize={maxVisibleSize} />
            ))}

            <div style={{ padding: "7px", display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: 9 }}>
              <span>{snapshot.depth.bid_levels} bid / {snapshot.depth.ask_levels} ask levels received</span>
              <span>{lastUpdate ? new Date(lastUpdate).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : ""}</span>
            </div>
          </div>
        </>
      )}

      {!snapshot && connection !== "error" && (
        <div style={{ padding: 18, textAlign: "center", color: "#64748b", fontSize: 11 }}>
          Waiting for the Moomoo order book…
        </div>
      )}
    </div>
  );
}
