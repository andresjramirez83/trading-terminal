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
} from "../services/api";

type Props = {
  open: boolean;
  initialSymbol?: string;
  onClose: () => void;
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

const DEFAULT_CONFIG: BackendAlertsConfig = {
  symbols: [],
  timeframe: "1m",
  poll_seconds: 20,
  cooldown_seconds: 300,
  lookback_bars: 6,
  notify_phone: true,
  notify_webhook: false,
  webhook_url: null,
};

export default function QuickAlertModal({
  open,
  initialSymbol = "AAPL",
  onClose,
}: Props) {
  const [symbol, setSymbol] = useState(initialSymbol.toUpperCase());
  const [symbolsInput, setSymbolsInput] = useState(initialSymbol.toUpperCase());
  const [timeframe, setTimeframe] = useState("1m");
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

    const next = normalizeSymbol(initialSymbol || "AAPL");
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
  const currentSymbols = useMemo(
    () => normalizeSymbols(symbolsInput),
    [symbolsInput]
  );
  const isCurrentSymbolTracked = currentSymbol
    ? currentSymbols.includes(currentSymbol)
    : false;

  const loadStatus = async () => {
    setLoading(true);
    setError("");

    try {
      const next = await fetchBackendAlertsStatus();
      setStatus(next);

      const cfg: BackendAlertsConfig = {
        symbols: next.config?.symbols ?? next.symbols ?? DEFAULT_CONFIG.symbols,
        timeframe:
          next.config?.timeframe ?? next.timeframe ?? DEFAULT_CONFIG.timeframe,
        poll_seconds:
          next.config?.poll_seconds ??
          next.poll_seconds ??
          DEFAULT_CONFIG.poll_seconds,
        cooldown_seconds:
          next.config?.cooldown_seconds ??
          next.cooldown_seconds ??
          DEFAULT_CONFIG.cooldown_seconds,
        lookback_bars:
          next.config?.lookback_bars ??
          next.lookback_bars ??
          DEFAULT_CONFIG.lookback_bars,
        notify_phone:
          next.config?.notify_phone ??
          next.notify_phone ??
          DEFAULT_CONFIG.notify_phone,
        notify_webhook:
          next.config?.notify_webhook ??
          next.notify_webhook ??
          DEFAULT_CONFIG.notify_webhook,
        webhook_url:
          next.config?.webhook_url ??
          next.webhook_url ??
          DEFAULT_CONFIG.webhook_url,
      };

      setSymbolsInput((cfg.symbols ?? []).join(", "));
      setTimeframe(cfg.timeframe);
      setPollSeconds(String(cfg.poll_seconds));
      setCooldownSeconds(String(cfg.cooldown_seconds));
      setLookbackBars(String(cfg.lookback_bars));
      setNotifyPhone(Boolean(cfg.notify_phone));
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

  const buildPayload = (): BackendAlertsConfig => ({
    symbols: normalizeSymbols(symbolsInput),
    timeframe,
    poll_seconds: Math.max(5, Number(pollSeconds) || 20),
    cooldown_seconds: Math.max(30, Number(cooldownSeconds) || 300),
    lookback_bars: Math.max(5, Number(lookbackBars) || 6),
    notify_phone: notifyPhone,
    notify_webhook: false,
    webhook_url: null,
  });

  const recentResults = Array.isArray(status?.recent_results)
    ? (status?.recent_results as BackendAlertResult[])
    : [];
  const currentSymbolResult =
    recentResults.find((item) => item.symbol === currentSymbol) ?? null;

  const handleAddSymbol = () => {
    if (!currentSymbol) return;
    const next = Array.from(new Set([...currentSymbols, currentSymbol]));
    setSymbolsInput(next.join(", "));
  };

  const handleOnlyThisSymbol = () => {
    if (!currentSymbol) return;
    setSymbolsInput(currentSymbol);
  };

  const handleRemoveSymbol = () => {
    if (!currentSymbol) return;
    const next = currentSymbols.filter((item) => item !== currentSymbol);
    setSymbolsInput(next.join(", "));
  };

  const handleSave = async () => {
    setWorking(true);
    setMessage("");
    setError("");

    try {
      await updateBackendAlertsConfig(buildPayload());
      setMessage("Alert config saved.");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save alert config.");
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
      if (payload.symbols.length === 0) {
        throw new Error("Add at least one symbol first.");
      }

      await startBackendAlerts(payload);
      setMessage("Backend alerts started.");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start backend alerts.");
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
      setError(err instanceof Error ? err.message : "Failed to stop backend alerts.");
    } finally {
      setWorking(false);
    }
  };

  const handleSendTest = async () => {
    setWorking(true);
    setMessage("");
    setError("");

    try {
      await sendBackendTestAlert(
        "Backend Alert Test",
        `${currentSymbol || "SYMBOL"} test alert from trading terminal`
      );
      setMessage("Test phone alert sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send test alert.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div onMouseDown={onClose} style={overlayStyle}>
      <div onMouseDown={(e) => e.stopPropagation()} style={modalStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Quick Alert</div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>
              Alt+A opens alerts for the active symbol
            </div>
          </div>

          <div
            style={{
              ...badgeStyle,
              background:
                status?.enabled
                  ? "rgba(34,197,94,0.16)"
                  : "rgba(239,68,68,0.18)",
              border:
                status?.enabled
                  ? "1px solid rgba(34,197,94,0.45)"
                  : "1px solid rgba(239,68,68,0.45)",
            }}
          >
            {status?.enabled ? "RUNNING" : "STOPPED"}
          </div>
        </div>

        <div style={scrollBodyStyle}>
          <div style={bodyStyle}>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Current Symbol</label>
              <input
                ref={primaryInputRef}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="AAPL"
                style={fieldStyle}
              />
            </div>

            {!!currentSymbolResult && (
              <div style={signalCardStyle}>
                <div style={signalHeaderStyle}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800 }}>
                      Current Symbol Signal
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>
                      {currentSymbolResult.setup ?? "none"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <SignalBadge
                      label={String(currentSymbolResult.phase ?? "none").toUpperCase()}
                      color={
                        currentSymbolResult.phase === "confirmed"
                          ? "#22c55e"
                          : currentSymbolResult.phase === "prealert"
                          ? "#f59e0b"
                          : "#64748b"
                      }
                    />
                    <SignalBadge
                      label={`Score ${formatNumber(currentSymbolResult.score)}`}
                      color="#60a5fa"
                    />
                  </div>
                </div>

                <div style={{ fontSize: 13, lineHeight: 1.45, opacity: 0.92 }}>
                  {currentSymbolResult.reason ||
                    currentSymbolResult.message ||
                    "No signal reason available."}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={handleAddSymbol} style={secondaryButtonStyle}>
                Add Symbol
              </button>
              <button onClick={handleOnlyThisSymbol} style={secondaryButtonStyle}>
                Alert Only This Symbol
              </button>
              <button onClick={handleRemoveSymbol} style={secondaryButtonStyle}>
                Remove Symbol
              </button>
            </div>

            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Tracked Symbols</label>
              <textarea
                value={symbolsInput}
                onChange={(e) => setSymbolsInput(e.target.value.toUpperCase())}
                rows={3}
                style={textareaStyle}
                placeholder="ENVB, TSLA, KIDZ"
              />
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                background: "#0b2c63",
                border: "1px solid rgba(255,255,255,0.08)",
                fontSize: 13,
              }}
            >
              <div>
                Current Symbol Tracked:{" "}
                <strong>{isCurrentSymbolTracked ? "Yes" : "No"}</strong>
              </div>
              <div>
                Active Symbols: <strong>{currentSymbols.length}</strong>
              </div>
            </div>

            <div style={grid2Style}>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>Timeframe</label>
                <select
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value)}
                  style={fieldStyle}
                >
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                </select>
              </div>

              <div style={fieldGroupStyle}>
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

              <div style={fieldGroupStyle}>
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

              <div style={fieldGroupStyle}>
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
              Send phone alerts
            </label>

            {message ? <div style={successStyle}>{message}</div> : null}
            {error ? <div style={errorStyle}>{error}</div> : null}
          </div>
        </div>

        <div style={footerStyle}>
          <button onClick={handleSave} disabled={working || loading} style={secondaryButtonStyle}>
            Save Config
          </button>
          <button onClick={handleStart} disabled={working || loading} style={primaryButtonStyle}>
            Start Alerts
          </button>
          <button onClick={handleStop} disabled={working || loading} style={dangerButtonStyle}>
            Stop Alerts
          </button>
          <button onClick={handleSendTest} disabled={working || loading} style={secondaryButtonStyle}>
            Test
          </button>
        </div>
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
