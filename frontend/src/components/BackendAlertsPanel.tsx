import { useEffect, useMemo, useState } from "react";
import {
  fetchBackendAlertsStatus,
  startBackendAlerts,
  stopBackendAlerts,
  updateBackendAlertsConfig,
  sendBackendTestAlert,
  fetchSelectedAlertSymbols,
  saveSelectedAlertSymbols,
  type BackendAlertsConfig,
  type BackendAlertsStatus,
  type BackendAlertResult,
  type BackendAlertSetup,
} from "../services/api";

type Props = {
  selectedSymbol: string;
};

function normalizeSymbol(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z.]/g, "");
}

function normalizeSymbols(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[^A-Za-z.]+/)
        .map((item) => normalizeSymbol(item))
        .filter(Boolean)
    )
  );
}

const TF_OPTIONS = ["1m", "5m", "15m"];
const SETUP_OPTIONS: Array<{ key: BackendAlertSetup; label: string }> = [
  { key: "compression_abs_breakout", label: "Compression + ABS breakout" },
  { key: "failed_breakdown_reclaim", label: "Failed breakdown reclaim" },
  { key: "aggressive_buyers_reclaim", label: "Aggressive buyers reclaim" },
  { key: "bullish_structure_shift", label: "Bullish structure shift" },
  { key: "ifvg_retest", label: "IFVG retest" },
  { key: "ifvg_bounce_confirmed", label: "IFVG bounce confirmed" },
  { key: "ifvg_failure", label: "IFVG failure" },
  { key: "trendline_close_cross", label: "Trendline close/cross" },
  { key: "trendline_near", label: "Near trendline" },
  { key: "projection_touch_cross", label: "Saved projection touch/cross" },
  { key: "vwap_reclaim", label: "VWAP reclaim / near VWAP" },
  { key: "pmh_break", label: "Premarket high break" },
  { key: "rth_high_break", label: "RTH high break" },
  { key: "ah_high_break", label: "After-hours high break" },
];

function normalizeTimeframes(value: unknown, fallback = ["1m"]): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out = raw.map(String).map((x) => x.toLowerCase().trim()).filter((x) => TF_OPTIONS.includes(x));
  return Array.from(new Set(out.length ? out : fallback));
}

function normalizeSetups(value: unknown): BackendAlertSetup[] {
  const all = SETUP_OPTIONS.map((x) => x.key);
  const raw = Array.isArray(value) ? value : [];
  const out = raw.filter((x): x is BackendAlertSetup => all.includes(x as BackendAlertSetup));
  return Array.from(new Set(out.length ? out : all));
}

const DEFAULT_CONFIG: BackendAlertsConfig = {
  symbols: [],
  timeframe: "1m",
  timeframes: ["1m"],
  confluence_mode: "any",
  alert_setups: SETUP_OPTIONS.map((x) => x.key),
  alert_on_prealert: false,
  poll_seconds: 20,
  cooldown_seconds: 300,
  lookback_bars: 6,
  notify_phone: true,
  notify_webhook: false,
  webhook_url: null,
};

export default function BackendAlertsPanel({ selectedSymbol }: Props) {
  const [status, setStatus] = useState<BackendAlertsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [symbolsInput, setSymbolsInput] = useState("");
  const [timeframes, setTimeframes] = useState<string[]>(["1m"]);
  const [confluenceMode, setConfluenceMode] = useState<"any" | "all">("any");
  const [alertSetups, setAlertSetups] = useState<BackendAlertSetup[]>(DEFAULT_CONFIG.alert_setups ?? []);
  const [alertOnPrealert, setAlertOnPrealert] = useState(false);
  const [pollSeconds, setPollSeconds] = useState("20");
  const [cooldownSeconds, setCooldownSeconds] = useState("300");
  const [lookbackBars, setLookbackBars] = useState("6");
  const [notifyPhone, setNotifyPhone] = useState(true);

  const normalizedSelected = useMemo(
    () => normalizeSymbol(selectedSymbol),
    [selectedSymbol]
  );

  const loadStatus = async () => {
    setLoading(true);
    setError("");
    try {
      const [next, selectedSymbolsPayload] = await Promise.all([
        fetchBackendAlertsStatus(),
        fetchSelectedAlertSymbols().catch(() => ({ symbols: [] as string[] })),
      ]);
      setStatus(next);

      // Backend selected-symbols endpoint is the source of truth.
      // Empty means empty. Do not fall back to status/config symbols because
      // stale config/local symbols can re-arm unwanted alerts after refresh.
      const selectedSymbols = Array.isArray(selectedSymbolsPayload.symbols)
        ? selectedSymbolsPayload.symbols
        : [];

      const cfg: BackendAlertsConfig = {
        symbols: selectedSymbols,
        timeframe: next.config?.timeframe ?? next.timeframe ?? DEFAULT_CONFIG.timeframe,
        timeframes: next.config?.timeframes ?? next.timeframes ?? DEFAULT_CONFIG.timeframes,
        confluence_mode: next.config?.confluence_mode ?? next.confluence_mode ?? DEFAULT_CONFIG.confluence_mode,
        alert_setups: next.config?.alert_setups ?? next.alert_setups ?? DEFAULT_CONFIG.alert_setups,
        alert_on_prealert: next.config?.alert_on_prealert ?? next.alert_on_prealert ?? DEFAULT_CONFIG.alert_on_prealert,
        poll_seconds:
          next.config?.poll_seconds ?? next.poll_seconds ?? DEFAULT_CONFIG.poll_seconds,
        cooldown_seconds:
          next.config?.cooldown_seconds ??
          next.cooldown_seconds ??
          DEFAULT_CONFIG.cooldown_seconds,
        lookback_bars:
          next.config?.lookback_bars ?? next.lookback_bars ?? DEFAULT_CONFIG.lookback_bars,
        notify_phone:
          next.config?.notify_phone ?? next.notify_phone ?? DEFAULT_CONFIG.notify_phone,
        notify_webhook:
          next.config?.notify_webhook ??
          next.notify_webhook ??
          DEFAULT_CONFIG.notify_webhook,
        webhook_url:
          next.config?.webhook_url ?? next.webhook_url ?? DEFAULT_CONFIG.webhook_url,
      };

      setSymbolsInput((cfg.symbols ?? []).join(", "));
      try {
        window.localStorage.setItem("backendAlertSelectedSymbols", JSON.stringify(cfg.symbols ?? []));
        window.dispatchEvent(new CustomEvent<string[]>("backend-alert-symbols-change", { detail: cfg.symbols ?? [] }));
      } catch {
        // Backend remains source of truth.
      }
      setTimeframes(normalizeTimeframes(cfg.timeframes ?? cfg.timeframe));
      setConfluenceMode(cfg.confluence_mode === "all" ? "all" : "any");
      setAlertSetups(normalizeSetups(cfg.alert_setups));
      setAlertOnPrealert(Boolean(cfg.alert_on_prealert));
      setPollSeconds(String(cfg.poll_seconds ?? 20));
      setCooldownSeconds(String(cfg.cooldown_seconds ?? 300));
      setLookbackBars(String(cfg.lookback_bars ?? 6));
      setNotifyPhone(Boolean(cfg.notify_phone ?? true));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backend alerts status");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const buildPayload = (): BackendAlertsConfig => {
    const tfs = normalizeTimeframes(timeframes);
    return {
    symbols: normalizeSymbols(symbolsInput),
    timeframe: tfs[0],
    timeframes: tfs,
    confluence_mode: confluenceMode,
    alert_setups: normalizeSetups(alertSetups),
    alert_on_prealert: alertOnPrealert,
    poll_seconds: Math.max(5, Number(pollSeconds) || 20),
    cooldown_seconds: Math.max(30, Number(cooldownSeconds) || 300),
    lookback_bars: Math.max(5, Number(lookbackBars) || 6),
    notify_phone: notifyPhone,
    notify_webhook: false,
    webhook_url: null,
  };
  };

  const toggleTimeframe = (tf: string) => {
    setTimeframes((prev) => {
      const has = prev.includes(tf);
      const next = has ? prev.filter((item) => item !== tf) : [...prev, tf];
      return next.length ? next : prev;
    });
  };

  const toggleSetup = (setup: BackendAlertSetup) => {
    setAlertSetups((prev) => {
      const has = prev.includes(setup);
      const next = has ? prev.filter((item) => item !== setup) : [...prev, setup];
      return next.length ? next : prev;
    });
  };

  const handleSave = async () => {
    setWorking(true);
    setMessage("");
    setError("");

    try {
      const payload = buildPayload();
      await saveSelectedAlertSymbols(payload.symbols);
      await updateBackendAlertsConfig(payload);
      try {
        window.localStorage.setItem("backendAlertSelectedSymbols", JSON.stringify(payload.symbols));
        window.dispatchEvent(new CustomEvent<string[]>("backend-alert-symbols-change", { detail: payload.symbols }));
      } catch {
        // Backend is source of truth; localStorage only syncs open tabs.
      }
      setMessage("Alert config saved.");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save alert config");
    } finally {
      setWorking(false);
    }
  };

  const handleStart = async () => {
    setWorking(true);
    setMessage("");
    setError("");

    try {
      const payload = buildPayload();

      if (!payload.symbols.length) {
        throw new Error("Add at least one alert symbol before starting.");
      }

      await saveSelectedAlertSymbols(payload.symbols);
      await startBackendAlerts(payload);
      try {
        window.localStorage.setItem("backendAlertSelectedSymbols", JSON.stringify(payload.symbols));
        window.dispatchEvent(new CustomEvent<string[]>("backend-alert-symbols-change", { detail: payload.symbols }));
      } catch {
        // Backend is source of truth; localStorage only syncs open tabs.
      }
      setMessage("Backend alerts started.");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start backend alerts");
    } finally {
      setWorking(false);
    }
  };

  const handleStop = async () => {
    setWorking(true);
    setMessage("");
    setError("");

    try {
      await stopBackendAlerts();
      setMessage("Backend alerts stopped.");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop backend alerts");
    } finally {
      setWorking(false);
    }
  };

  const handleAddSelected = () => {
    if (!normalizedSelected) return;

    const next = Array.from(
      new Set([...normalizeSymbols(symbolsInput), normalizedSelected])
    );
    setSymbolsInput(next.join(", "));
  };

  const handleOnlySelected = () => {
    if (!normalizedSelected) return;
    setSymbolsInput(normalizedSelected);
  };

  const handleRemoveSelected = () => {
    if (!normalizedSelected) return;
    const next = normalizeSymbols(symbolsInput).filter(
      (item) => item !== normalizedSelected
    );
    setSymbolsInput(next.join(", "));
  };

  const handleClearSymbols = () => {
    setSymbolsInput("");
  };

  const handleSendTest = async () => {
    setWorking(true);
    setMessage("");
    setError("");

    try {
      await sendBackendTestAlert(
        "Backend Alert Test",
        normalizedSelected
          ? `${normalizedSelected} test alert from trading terminal`
          : "Test alert from trading terminal"
      );
      setMessage("Test phone alert sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send test alert");
    } finally {
      setWorking(false);
    }
  };

  const currentSymbols = normalizeSymbols(symbolsInput);
  const recentResults = Array.isArray(status?.recent_results)
    ? (status?.recent_results as BackendAlertResult[])
    : [];
  const recentTriggered = recentResults.filter((item) => item.triggered);
  const lastTriggered = recentTriggered[0] ?? null;

  return (
    <section
      style={{
        background: "#0a1f44",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 14,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>Backend Alerts</div>
          <div style={{ fontSize: 13, opacity: 0.72 }}>
            Start and stop backend scanning from the UI. Alerts only watch the symbols you choose.
          </div>
        </div>

        <button
          onClick={() => void loadStatus()}
          disabled={loading || working}
          style={secondaryButtonStyle}
        >
          {loading ? "Refreshing..." : "Refresh Status"}
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        <StatusCard
          label="Status"
          value={status?.enabled ? "Running" : "Stopped"}
          accent={status?.enabled ? "#4ade80" : "#f87171"}
        />
        <StatusCard
          label="Selected Symbol"
          value={normalizedSelected || "N/A"}
          accent="#93c5fd"
        />
        <StatusCard
          label="Active Symbols"
          value={String(currentSymbols.length)}
          accent="#facc15"
        />
        <StatusCard
          label="Last Setup"
          value={lastTriggered?.setup ?? "N/A"}
          accent="#c084fc"
        />
      </div>

      {lastTriggered ? (
        <div style={signalCardStyle}>
          <div style={signalHeaderStyle}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800 }}>
                Latest Triggered Signal
              </div>
              <div style={{ fontSize: 12, opacity: 0.72 }}>
                {lastTriggered.symbol ?? "N/A"} · {lastTriggered.timeframe ?? status?.timeframe ?? "1m"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <SignalBadge
                label={String(lastTriggered.phase ?? "none").toUpperCase()}
                color={
                  lastTriggered.phase === "confirmed"
                    ? "#22c55e"
                    : lastTriggered.phase === "prealert"
                    ? "#f59e0b"
                    : "#64748b"
                }
              />
              <SignalBadge
                label={`Score ${formatNumber(lastTriggered.score)}`}
                color="#60a5fa"
              />
            </div>
          </div>

          <div style={{ fontSize: 13, lineHeight: 1.45, opacity: 0.92 }}>
            {lastTriggered.reason || lastTriggered.message || "No reason text provided."}
          </div>

          {!!lastTriggered.features && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 8,
                marginTop: 8,
              }}
            >
              <MiniMetric label="Compression" value={formatNumber(lastTriggered.features.compression_score)} />
              <MiniMetric label="Absorption" value={formatNumber(lastTriggered.features.absorption_score)} />
              <MiniMetric label="RVOL" value={formatNumber(lastTriggered.features.rvol)} />
              <MiniMetric label="Breakout" value={formatNumber(lastTriggered.features.breakout_score)} />
              <MiniMetric label="VWAP" value={formatNumber(lastTriggered.features.vwap_reclaim_score)} />
              <MiniMetric label="Structure" value={formatNumber(lastTriggered.features.structure_shift_score)} />
            </div>
          )}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 6 }}>
        <label style={labelStyle}>Alert Symbols</label>
        <textarea
          value={symbolsInput}
          onChange={(e) => setSymbolsInput(e.target.value.toUpperCase())}
          rows={3}
          placeholder="Type symbols like ENVB, TSLA, KIDZ"
          style={textareaStyle}
        />
        <div style={{ fontSize: 12, opacity: 0.72 }}>
          Only these symbols will be watched by the backend alert loop.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={handleAddSelected} disabled={!normalizedSelected} style={secondaryButtonStyle}>
          Add Selected
        </button>
        <button onClick={handleOnlySelected} disabled={!normalizedSelected} style={secondaryButtonStyle}>
          Alert Only Selected
        </button>
        <button onClick={handleRemoveSelected} disabled={!normalizedSelected} style={secondaryButtonStyle}>
          Remove Selected
        </button>
        <button onClick={handleClearSymbols} style={secondaryButtonStyle}>
          Clear
        </button>
      </div>

      {!!currentSymbols.length && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {currentSymbols.map((item) => (
            <div
              key={item}
              style={{
                padding: "7px 10px",
                borderRadius: 999,
                background: item === normalizedSelected ? "#12396b" : "#071731",
                border:
                  item === normalizedSelected
                    ? "1px solid #4ea1ff"
                    : "1px solid rgba(255,255,255,0.10)",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {item}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          <label style={labelStyle}>Timeframes</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {TF_OPTIONS.map((tf) => (
              <label key={tf} style={chipStyle(timeframes.includes(tf))}>
                <input type="checkbox" checked={timeframes.includes(tf)} onChange={() => toggleTimeframe(tf)} /> {tf}
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <label style={labelStyle}>Alert Mode</label>
          <select value={confluenceMode} onChange={(e) => setConfluenceMode(e.target.value === "all" ? "all" : "any")} style={fieldStyle}>
            <option value="any">Any timeframe</option>
            <option value="all">All timeframes</option>
          </select>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <label style={labelStyle}>Poll Seconds</label>
          <input
            type="number"
            min="5"
            step="1"
            value={pollSeconds}
            onChange={(e) => setPollSeconds(e.target.value)}
            style={fieldStyle}
          />
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <label style={labelStyle}>Cooldown Seconds</label>
          <input
            type="number"
            min="30"
            step="1"
            value={cooldownSeconds}
            onChange={(e) => setCooldownSeconds(e.target.value)}
            style={fieldStyle}
          />
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <label style={labelStyle}>Lookback Bars</label>
          <input
            type="number"
            min="5"
            step="1"
            value={lookbackBars}
            onChange={(e) => setLookbackBars(e.target.value)}
            style={fieldStyle}
          />
        </div>
      </div>


      <div style={{ display: "grid", gap: 8 }}>
        <label style={labelStyle}>Alert Types</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          {SETUP_OPTIONS.map((setup) => (
            <label key={setup.key} style={setupRowStyle}>
              <input type="checkbox" checked={alertSetups.includes(setup.key)} onChange={() => toggleSetup(setup.key)} />
              {setup.label}
            </label>
          ))}
        </div>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <input
          type="checkbox"
          checked={alertOnPrealert}
          onChange={(e) => setAlertOnPrealert(e.target.checked)}
        />
        Include pre-alerts
      </label>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <input
          type="checkbox"
          checked={notifyPhone}
          onChange={(e) => setNotifyPhone(e.target.checked)}
        />
        Send phone alerts with Pushover
      </label>

      {message ? <div style={successBoxStyle}>{message}</div> : null}
      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!!recentResults.length && (
        <div style={resultsTableWrapStyle}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>
            Recent Signal Results
          </div>

          <div style={resultsHeaderStyle}>
            <span>Symbol</span>
            <span>Setup</span>
            <span>Phase</span>
            <span>Score</span>
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            {recentResults.slice(0, 8).map((item, idx) => (
              <div key={`${item.symbol ?? "SYMBOL"}-${idx}`} style={resultRowStyle}>
                <div style={{ fontWeight: 700 }}>{item.symbol ?? "N/A"}</div>
                <div>{item.setup ?? "none"}</div>
                <div style={{ color: phaseColor(item.phase) }}>
                  {item.phase ?? "none"}
                </div>
                <div>{formatNumber(item.score)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={() => void handleSave()} disabled={working} style={secondaryButtonStyle}>
          Save Config
        </button>
        <button onClick={() => void handleStart()} disabled={working} style={primaryButtonStyle}>
          Start Alerts
        </button>
        <button onClick={() => void handleStop()} disabled={working} style={dangerButtonStyle}>
          Stop Alerts
        </button>
        <button onClick={() => void handleSendTest()} disabled={working} style={secondaryButtonStyle}>
          Send Test Alert
        </button>
      </div>
    </section>
  );
}

function StatusCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div
      style={{
        background: "#071731",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: 12,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent }}>{value}</div>
    </div>
  );
}

function SignalBadge({ label, color }: { label: string; color: string }) {
  return (
    <div
      style={{
        padding: "6px 10px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.06)",
        border: `1px solid ${color}`,
        color,
        fontSize: 12,
        fontWeight: 800,
      }}
    >
      {label}
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "#071731",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
        padding: "8px 10px",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.68 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function formatNumber(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : "—";
}

function phaseColor(phase?: string | null): string {
  if (phase === "confirmed") return "#4ade80";
  if (phase === "prealert") return "#f59e0b";
  return "#94a3b8";
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 10px",
    borderRadius: 999,
    background: active ? "#1d4ed8" : "#071731",
    border: active ? "1px solid rgba(96,165,250,0.8)" : "1px solid rgba(255,255,255,0.12)",
    fontSize: 13,
    fontWeight: 800,
    cursor: "pointer",
  };
}

const setupRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 10,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  fontSize: 13,
  fontWeight: 700,
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  opacity: 0.9,
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "#f4f4f4",
  color: "#111827",
  fontSize: 15,
  boxSizing: "border-box",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "#f4f4f4",
  color: "#111827",
  fontSize: 15,
  boxSizing: "border-box",
  resize: "vertical",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "#0f9f13",
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 800,
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "#071731",
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 700,
};

const dangerButtonStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "#c62828",
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 800,
};

const successBoxStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(34,197,94,0.14)",
  border: "1px solid rgba(34,197,94,0.35)",
  color: "#bbf7d0",
  fontSize: 13,
};

const errorBoxStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(239,68,68,0.14)",
  border: "1px solid rgba(239,68,68,0.35)",
  color: "#fecaca",
  fontSize: 13,
};

const signalCardStyle: React.CSSProperties = {
  background: "#0b2c63",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: 12,
  display: "grid",
  gap: 8,
};

const signalHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 10,
  flexWrap: "wrap",
};

const resultsTableWrapStyle: React.CSSProperties = {
  background: "#071731",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: 12,
};

const resultsHeaderStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1.3fr 1fr 0.8fr",
  gap: 10,
  fontSize: 12,
  opacity: 0.72,
  marginBottom: 6,
};

const resultRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1.3fr 1fr 0.8fr",
  gap: 10,
  padding: "8px 0",
  borderTop: "1px solid rgba(255,255,255,0.06)",
  fontSize: 13,
};
