import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBackendAlertsStatus,
  sendBackendTestAlert,
  startBackendAlerts,
  stopBackendAlerts,
  updateBackendAlertsConfig,
  type BackendAlertsConfig,
  type BackendAlertsStatus,
  type BackendAlertResult,
  type BackendAlertSetup,
} from "../services/api";

type Props = {
  open: boolean;
  initialSymbol?: string;
  onClose: () => void;
};

const TF_OPTIONS = ["1m", "5m", "15m"];

type SetupOption = {
  key: BackendAlertSetup;
  label: string;
  description: string;
  group: "strategy" | "drawings" | "levels";
};

const SETUP_OPTIONS: SetupOption[] = [
  { key: "compression_abs_breakout", label: "Compression + ABS breakout", description: "Tight range + absorption + breakout candle.", group: "strategy" },
  { key: "failed_breakdown_reclaim", label: "Failed breakdown reclaim", description: "Flush below support then reclaim back above.", group: "strategy" },
  { key: "aggressive_buyers_reclaim", label: "Aggressive buyers reclaim", description: "Buyer dominance plus reclaim behavior.", group: "strategy" },
  { key: "bullish_structure_shift", label: "Bullish structure shift", description: "Market-structure shift with strength confirmation.", group: "strategy" },
  { key: "trendline_close_cross", label: "Trendline close/cross", description: "Saved trendline closes above/below on selected timeframe.", group: "drawings" },
  { key: "trendline_near", label: "Near trendline", description: "Price gets close to a saved trendline before the cross.", group: "drawings" },
  { key: "projection_touch_cross", label: "Saved projection touch/cross", description: "Saved support/resistance projection is touched or crossed.", group: "drawings" },
  { key: "vwap_reclaim", label: "VWAP reclaim / near VWAP", description: "Price reclaims VWAP or gets close to it.", group: "levels" },
  { key: "pmh_break", label: "Premarket high break", description: "Close breaks above PMH.", group: "levels" },
  { key: "rth_high_break", label: "RTH high break", description: "Close breaks above regular-session high.", group: "levels" },
  { key: "ah_high_break", label: "After-hours high break", description: "Close breaks above after-hours high.", group: "levels" },
];

const DEFAULT_ALERT_SETUPS: BackendAlertSetup[] = SETUP_OPTIONS.map((x) => x.key);
const STRATEGY_SETUPS = SETUP_OPTIONS.filter((x) => x.group === "strategy").map((x) => x.key);
const DRAWING_SETUPS = SETUP_OPTIONS.filter((x) => x.group === "drawings").map((x) => x.key);
const LEVEL_SETUPS = SETUP_OPTIONS.filter((x) => x.group === "levels").map((x) => x.key);

const LEGACY_DEFAULT_SYMBOLS = ["AAPL", "NVDA", "TSLA", "AMD"];

function stripLegacyDefaultSymbols(symbols: string[]): string[] {
  const cleaned = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const isOnlyLegacyDefaults =
    cleaned.length === LEGACY_DEFAULT_SYMBOLS.length &&
    LEGACY_DEFAULT_SYMBOLS.every((symbol) => cleaned.includes(symbol));

  return isOnlyLegacyDefaults ? [] : cleaned;
}

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
  alert_setups: DEFAULT_ALERT_SETUPS,
  poll_seconds: 20,
  cooldown_seconds: 300,
  lookback_bars: 6,
  notify_phone: true,
  notify_webhook: false,
  webhook_url: null,
  alert_on_prealert: false,
};

export default function QuickAlertModal({ open, initialSymbol = "", onClose }: Props) {
  const [symbol, setSymbol] = useState(initialSymbol.toUpperCase());
  const [symbolsInput, setSymbolsInput] = useState("");
  const [timeframes, setTimeframes] = useState<string[]>(["1m"]);
  const [confluenceMode, setConfluenceMode] = useState<"any" | "all">("any");
  const [alertSetups, setAlertSetups] = useState<BackendAlertSetup[]>(DEFAULT_ALERT_SETUPS);
  const [alertOnPrealert, setAlertOnPrealert] = useState(false);
  const [pollSeconds, setPollSeconds] = useState("20");
  const [cooldownSeconds, setCooldownSeconds] = useState("300");
  const [lookbackBars, setLookbackBars] = useState("6");
  const [notifyPhone, setNotifyPhone] = useState(true);

  const [status, setStatus] = useState<BackendAlertsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const primaryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const next = normalizeSymbol(initialSymbol || "");
    setSymbol(next);
    setMessage("");
    setError("");
    const timer = window.setTimeout(() => {
      primaryInputRef.current?.focus();
      primaryInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, initialSymbol]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const currentSymbol = useMemo(() => normalizeSymbol(symbol), [symbol]);
  const currentSymbols = useMemo(() => normalizeSymbols(symbolsInput), [symbolsInput]);
  const isCurrentSymbolTracked = currentSymbol ? currentSymbols.includes(currentSymbol) : false;

  const loadStatus = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchBackendAlertsStatus();
      setStatus(next);
      const cfg = next.config ?? next;
      const restoredTimeframes = normalizeTimeframes(
        cfg.timeframes ?? cfg.timeframe ?? next.timeframes ?? next.timeframe,
        DEFAULT_CONFIG.timeframes
      );
      const restoredSymbols = stripLegacyDefaultSymbols(cfg.symbols ?? next.symbols ?? DEFAULT_CONFIG.symbols);
      setSymbolsInput(restoredSymbols.join(", "));
      setTimeframes(restoredTimeframes);
      setConfluenceMode((cfg.confluence_mode ?? next.confluence_mode) === "all" ? "all" : "any");
      setAlertSetups(normalizeSetups(cfg.alert_setups ?? next.alert_setups));
      setAlertOnPrealert(Boolean(cfg.alert_on_prealert ?? next.alert_on_prealert ?? false));
      setPollSeconds(String(cfg.poll_seconds ?? next.poll_seconds ?? DEFAULT_CONFIG.poll_seconds));
      setCooldownSeconds(String(cfg.cooldown_seconds ?? next.cooldown_seconds ?? DEFAULT_CONFIG.cooldown_seconds));
      setLookbackBars(String(cfg.lookback_bars ?? next.lookback_bars ?? DEFAULT_CONFIG.lookback_bars));
      setNotifyPhone(Boolean(cfg.notify_phone ?? next.notify_phone ?? DEFAULT_CONFIG.notify_phone));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alert status.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadStatus();
  }, [open]);

  if (!open) return null;

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

  const setPreset = (items: BackendAlertSetup[]) => {
    const clean = normalizeSetups(items);
    setAlertSetups(clean.length ? clean : DEFAULT_ALERT_SETUPS);
  };

  const toggleGroup = (items: BackendAlertSetup[]) => {
    setAlertSetups((prev) => {
      const allOn = items.every((item) => prev.includes(item));
      const next = allOn
        ? prev.filter((item) => !items.includes(item))
        : Array.from(new Set([...prev, ...items]));
      return next.length ? next : prev;
    });
  };

  const buildPayload = (): BackendAlertsConfig => {
    const tfs = normalizeTimeframes(timeframes);
    return {
      symbols: normalizeSymbols(symbolsInput),
      timeframe: tfs[0],
      timeframes: tfs,
      confluence_mode: confluenceMode,
      alert_setups: normalizeSetups(alertSetups),
      poll_seconds: Math.max(5, Number(pollSeconds) || 20),
      cooldown_seconds: Math.max(30, Number(cooldownSeconds) || 300),
      lookback_bars: Math.max(5, Number(lookbackBars) || 6),
      notify_phone: notifyPhone,
      notify_webhook: false,
      webhook_url: null,
      alert_on_prealert: alertOnPrealert,
    };
  };

  const recentResults = Array.isArray(status?.recent_results)
    ? (status?.recent_results as BackendAlertResult[])
    : [];
  const currentSymbolResult =
    recentResults.find((item) => item.symbol === currentSymbol && item.triggered) ??
    recentResults.find((item) => item.symbol === currentSymbol) ??
    null;

  const handleAddSymbol = () => {
    if (!currentSymbol) return;
    setSymbolsInput(Array.from(new Set([...currentSymbols, currentSymbol])).join(", "));
  };
  const handleOnlyThisSymbol = () => currentSymbol && setSymbolsInput(currentSymbol);
  const handleRemoveSymbol = () => currentSymbol && setSymbolsInput(currentSymbols.filter((item) => item !== currentSymbol).join(", "));

  const handleSave = async () => {
    setWorking(true); setMessage(""); setError("");
    try {
      await updateBackendAlertsConfig(buildPayload());
      setMessage("Alert config saved.");
      await loadStatus();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to save alert config."); }
    finally { setWorking(false); }
  };

  const handleStart = async () => {
    setWorking(true); setMessage(""); setError("");
    try {
      const payload = buildPayload();
      if (payload.symbols.length === 0) throw new Error("Add at least one symbol first.");
      if (!payload.timeframes || payload.timeframes.length === 0) throw new Error("Select at least one timeframe.");
      if (!payload.alert_setups || payload.alert_setups.length === 0) throw new Error("Select at least one alert type.");
      await startBackendAlerts(payload);
      setMessage("Backend alerts started.");
      await loadStatus();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to start backend alerts."); }
    finally { setWorking(false); }
  };

  const handleStop = async () => {
    setWorking(true); setMessage(""); setError("");
    try { await stopBackendAlerts(); setMessage("Backend alerts stopped."); await loadStatus(); }
    catch (err) { setError(err instanceof Error ? err.message : "Failed to stop backend alerts."); }
    finally { setWorking(false); }
  };

  const handleSendTest = async () => {
    setWorking(true); setMessage(""); setError("");
    try {
      await sendBackendTestAlert("Backend Alert Test", `${currentSymbol || "SYMBOL"} test alert from trading terminal`);
      setMessage("Test phone alert sent.");
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to send test alert."); }
    finally { setWorking(false); }
  };

  return (
    <div onMouseDown={onClose} style={overlayStyle}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ ...modalStyle, maxWidth: 520 }}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Quick Alert</div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>Multi-timeframe backend alerts for the active symbol</div>
          </div>
          <div style={{ ...badgeStyle, background: status?.enabled ? "rgba(34,197,94,0.16)" : "rgba(239,68,68,0.18)", border: status?.enabled ? "1px solid rgba(34,197,94,0.45)" : "1px solid rgba(239,68,68,0.45)" }}>
            {status?.enabled ? "RUNNING" : "STOPPED"}
          </div>
        </div>

        <div style={scrollBodyStyle}>
          <div style={bodyStyle}>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Current Symbol</label>
              <input ref={primaryInputRef} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="CERS" style={fieldStyle} />
            </div>

            {!!currentSymbolResult && (
              <div style={signalCardStyle}>
                <div style={signalHeaderStyle}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800 }}>Current Symbol Signal</div>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>{currentSymbolResult.setup ?? "none"} · {currentSymbolResult.timeframe ?? "—"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <SignalBadge label={String(currentSymbolResult.phase ?? "none").toUpperCase()} color={currentSymbolResult.phase === "confirmed" ? "#22c55e" : currentSymbolResult.phase === "prealert" ? "#f59e0b" : "#64748b"} />
                    <SignalBadge label={`Score ${formatNumber(currentSymbolResult.score)}`} color="#60a5fa" />
                  </div>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.45, opacity: 0.92 }}>{currentSymbolResult.reason || currentSymbolResult.message || "No signal reason available."}</div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={handleAddSymbol} style={secondaryButtonStyle}>Add Symbol</button>
              <button onClick={handleOnlyThisSymbol} style={secondaryButtonStyle}>Alert Only This Symbol</button>
              <button onClick={handleRemoveSymbol} style={secondaryButtonStyle}>Remove Symbol</button>
            </div>

            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Tracked Symbols</label>
              <textarea value={symbolsInput} onChange={(e) => setSymbolsInput(e.target.value.toUpperCase())} rows={3} style={textareaStyle} placeholder="CERS, SOBR, HCAI" />
            </div>

            <div style={{ padding: "10px 12px", borderRadius: 10, background: "#0b2c63", border: "1px solid rgba(255,255,255,0.08)", fontSize: 13 }}>
              <div>Current Symbol Tracked: <strong>{isCurrentSymbolTracked ? "Yes" : "No"}</strong></div>
              <div>Active Symbols: <strong>{currentSymbols.length}</strong></div>
              <div>Mode: <strong>{confluenceMode === "all" ? "All timeframes must agree" : "Any selected timeframe can alert"}</strong></div>
            </div>

            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Timeframes</label>
              <div style={chipGridStyle}>
                {TF_OPTIONS.map((tf) => (
                  <label key={tf} style={chipStyle(timeframes.includes(tf))}>
                    <input type="checkbox" checked={timeframes.includes(tf)} onChange={() => toggleTimeframe(tf)} /> {tf}
                  </label>
                ))}
              </div>
            </div>

            <div style={grid2Style}>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Alert Mode</label>
                <select value={confluenceMode} onChange={(e) => setConfluenceMode(e.target.value === "all" ? "all" : "any")} style={fieldStyle}>
                  <option value="any">Any timeframe triggers</option>
                  <option value="all">All selected timeframes agree</option>
                </select>
              </div>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Poll Seconds</label>
                <input type="number" min="5" step="1" value={pollSeconds} onChange={(e) => setPollSeconds(e.target.value)} style={fieldStyle} />
              </div>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Cooldown Seconds</label>
                <input type="number" min="30" step="1" value={cooldownSeconds} onChange={(e) => setCooldownSeconds(e.target.value)} style={fieldStyle} />
              </div>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Lookback Bars</label>
                <input type="number" min="5" step="1" value={lookbackBars} onChange={(e) => setLookbackBars(e.target.value)} style={fieldStyle} />
              </div>
            </div>

            <div style={proPanelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 900 }}>Alert Playbook</div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>Pick the exact alerts you want the backend to watch.</div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => setPreset(DEFAULT_ALERT_SETUPS)} style={miniButtonStyle}>All</button>
                  <button type="button" onClick={() => setPreset([...STRATEGY_SETUPS, ...DRAWING_SETUPS])} style={miniButtonStyle}>Scalp</button>
                  <button type="button" onClick={() => setPreset(DRAWING_SETUPS)} style={miniButtonStyle}>Drawings</button>
                  <button type="button" onClick={() => setPreset(LEVEL_SETUPS)} style={miniButtonStyle}>Levels</button>
                </div>
              </div>

              <SetupGroup
                title="Strategy Signals"
                subtitle="Backend signal-engine setups from candle/volume structure."
                options={SETUP_OPTIONS.filter((x) => x.group === "strategy")}
                selected={alertSetups}
                onToggle={toggleSetup}
                onToggleGroup={() => toggleGroup(STRATEGY_SETUPS)}
              />
              <SetupGroup
                title="Chart Drawings"
                subtitle="Alerts from saved trendlines and saved projection levels."
                options={SETUP_OPTIONS.filter((x) => x.group === "drawings")}
                selected={alertSetups}
                onToggle={toggleSetup}
                onToggleGroup={() => toggleGroup(DRAWING_SETUPS)}
              />
              <SetupGroup
                title="Key Levels"
                subtitle="VWAP, PMH, RTH high, and after-hours high alerts."
                options={SETUP_OPTIONS.filter((x) => x.group === "levels")}
                selected={alertSetups}
                onToggle={toggleSetup}
                onToggleGroup={() => toggleGroup(LEVEL_SETUPS)}
              />
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
              <input type="checkbox" checked={alertOnPrealert} onChange={(e) => setAlertOnPrealert(e.target.checked)} />
              Include pre-alerts (earlier, more noise)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
              <input type="checkbox" checked={notifyPhone} onChange={(e) => setNotifyPhone(e.target.checked)} />
              Send phone alerts
            </label>

            {message ? <div style={successStyle}>{message}</div> : null}
            {error ? <div style={errorStyle}>{error}</div> : null}
          </div>
        </div>

        <div style={footerStyle}>
          <button onClick={handleSave} disabled={working || loading} style={secondaryButtonStyle}>Save Config</button>
          <button onClick={handleStart} disabled={working || loading} style={primaryButtonStyle}>Start Alerts</button>
          <button onClick={handleStop} disabled={working || loading} style={dangerButtonStyle}>Stop Alerts</button>
          <button onClick={handleSendTest} disabled={working || loading} style={secondaryButtonStyle}>Test</button>
        </div>
      </div>
    </div>
  );
}

const chipGridStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

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

function setupRowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 9,
    padding: "9px 10px",
    borderRadius: 11,
    background: active ? "rgba(37,99,235,0.20)" : "rgba(255,255,255,0.04)",
    border: active ? "1px solid rgba(96,165,250,0.50)" : "1px solid rgba(255,255,255,0.08)",
    fontSize: 13,
    cursor: "pointer",
  };
}

const proPanelStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  padding: 12,
  borderRadius: 14,
  background: "rgba(3,12,30,0.35)",
  border: "1px solid rgba(148,163,184,0.18)",
};

const setupGroupStyle: React.CSSProperties = {
  display: "grid",
  gap: 8,
  padding: 10,
  borderRadius: 12,
  background: "rgba(255,255,255,0.035)",
  border: "1px solid rgba(255,255,255,0.07)",
};

const miniButtonStyle: React.CSSProperties = {
  padding: "6px 9px",
  borderRadius: 999,
  border: "1px solid rgba(96,165,250,0.35)",
  background: "rgba(15,23,42,0.92)",
  color: "#dbeafe",
  fontSize: 11,
  fontWeight: 850,
  cursor: "pointer",
};

function SetupGroup({
  title,
  subtitle,
  options,
  selected,
  onToggle,
  onToggleGroup,
}: {
  title: string;
  subtitle: string;
  options: SetupOption[];
  selected: BackendAlertSetup[];
  onToggle: (setup: BackendAlertSetup) => void;
  onToggleGroup: () => void;
}) {
  const activeCount = options.filter((item) => selected.includes(item.key)).length;
  return (
    <div style={setupGroupStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 900 }}>{title}</div>
          <div style={{ fontSize: 11, opacity: 0.68, marginTop: 2 }}>{subtitle}</div>
        </div>
        <button type="button" onClick={onToggleGroup} style={miniButtonStyle}>
          {activeCount}/{options.length}
        </button>
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        {options.map((setup) => {
          const active = selected.includes(setup.key);
          return (
            <label key={setup.key} style={setupRowStyle(active)}>
              <input type="checkbox" checked={active} onChange={() => onToggle(setup.key)} />
              <span>
                <span style={{ display: "block", fontWeight: 850 }}>{setup.label}</span>
                <span style={{ display: "block", fontSize: 11, opacity: 0.68, marginTop: 1 }}>{setup.description}</span>
              </span>
            </label>
          );
        })}
      </div>
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

function formatNumber(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : "—";
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.58)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 99999,
  padding: 12,
};

const modalStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 460,
  maxHeight: "calc(100vh - 24px)",
  display: "flex",
  flexDirection: "column",
  background: "#082250",
  color: "#ffffff",
  borderRadius: 18,
  boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
  border: "1px solid rgba(255,255,255,0.08)",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "16px 16px 10px 16px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  flexShrink: 0,
};

const badgeStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
};

const scrollBodyStyle: React.CSSProperties = {
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

const bodyStyle: React.CSSProperties = {
  padding: "0 16px 12px 16px",
  display: "grid",
  gap: 10,
};

const fieldGroupStyle: React.CSSProperties = {
  display: "grid",
  gap: 5,
};

const grid2Style: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
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

const footerStyle: React.CSSProperties = {
  padding: 16,
  display: "flex",
  gap: 10,
  flexShrink: 0,
  background: "#082250",
  borderTop: "1px solid rgba(255,255,255,0.06)",
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

const successStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(34,197,94,0.14)",
  border: "1px solid rgba(34,197,94,0.35)",
  color: "#bbf7d0",
  fontSize: 13,
};

const errorStyle: React.CSSProperties = {
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
