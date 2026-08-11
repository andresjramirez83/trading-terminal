import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  fetchAutoTradeStatus,
  queueOvernightProtectedOrder,
  updateAutoTradeConfig,
  type AlpacaMode,
  type AutoTradeSizingMode,
  type AutoTradeStatus,
} from "../../../../../services/api";

type AutoTradeWidgetProps = {
  symbol: string;
  currentPrice: number;
  mode: AlpacaMode;
};

function normalizeSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "");
}

function positiveNumber(value: string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatPrice(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  return `$${number.toFixed(number >= 1 ? 2 : 4)}`;
}

function inputPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(value >= 1 ? 2 : 4);
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "entry_submitted":
      return "Waiting for entry fill";
    case "entry_cancel_requested":
      return "Canceling invalidated entry";
    case "active_synthetic":
      return "Server protection active";
    case "exit_submitted":
      return "Protective exit submitted";
    default:
      return phase ? phase.split("_").join(" ") : "Ready";
  }
}

export default function AutoTradeWidget({
  symbol,
  currentPrice,
  mode,
}: AutoTradeWidgetProps) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const previousSymbolRef = useRef("");

  const [sizingMode, setSizingMode] =
    useState<AutoTradeSizingMode>("shares");
  const [entryPrice, setEntryPrice] = useState(() => inputPrice(currentPrice));
  const [stopPrice, setStopPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [shares, setShares] = useState("100");
  const [dollars, setDollars] = useState("500");
  const [status, setStatus] = useState<AutoTradeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (previousSymbolRef.current === normalizedSymbol) return;
    previousSymbolRef.current = normalizedSymbol;
    setEntryPrice(inputPrice(currentPrice));
    setStopPrice("");
    setTargetPrice("");
    setMessage("");
    setError("");
  }, [currentPrice, normalizedSymbol]);

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      try {
        const next = await fetchAutoTradeStatus();
        if (active) setStatus(next);
      } catch {
        // Keep the last known state during a temporary refresh failure.
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const runnerState = useMemo(() => {
    if (!normalizedSymbol) return null;
    return status?.runner_states?.[normalizedSymbol] ?? null;
  }, [normalizedSymbol, status]);

  const queuedPlan = useMemo(() => {
    const plans = status?.queued_manual_plans ?? status?.manual_trade_plans ?? [];
    return (
      plans.find((item: any) => {
        const payload = item?.payload ?? item ?? {};
        const planSymbol = normalizeSymbol(item?.symbol ?? payload.symbol);
        const strategyId = String(
          item?.strategy_id ?? payload.strategy_id ?? "",
        );
        return (
          planSymbol === normalizedSymbol &&
          ["overnight_protected_order", "overnite_hail_mary"].includes(
            strategyId,
          )
        );
      }) ?? null
    );
  }, [normalizedSymbol, status]);

  const workerOnline = Boolean(status?.running);
  const serverError = String(status?.last_error ?? status?.worker?.last_error ?? "").trim();
  const serverBlockedReason = String(status?.last_skip?.reason ?? "").trim();
  const currentPhase = String(runnerState?.phase ?? "");
  const currentStatus = runnerState
    ? phaseLabel(currentPhase)
    : queuedPlan
      ? "Queued for server worker"
      : "Ready";

  const submit = async () => {
    setMessage("");
    setError("");

    const entry = positiveNumber(entryPrice);
    const stop = positiveNumber(stopPrice);
    const target = positiveNumber(targetPrice);
    const qty = Math.floor(positiveNumber(shares));
    const amount = positiveNumber(dollars);

    if (!normalizedSymbol) {
      setError("Select a valid symbol first.");
      return;
    }
    if (!workerOnline) {
      setError("The auto-trade worker is offline. Start it before placing this order.");
      return;
    }
    if (!(stop < entry && entry < target)) {
      setError("For a long order, prices must be Stop < Entry < Target.");
      return;
    }
    if (sizingMode === "shares" && qty <= 0) {
      setError("Enter a valid share quantity.");
      return;
    }
    if (sizingMode === "dollars" && amount <= 0) {
      setError("Enter a valid dollar amount.");
      return;
    }

    if (
      mode === "live" &&
      !window.confirm(
        `Place a LIVE protected overnight order for ${normalizedSymbol}? The server will manage the stop and target.`,
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      if (mode === "live" && !status?.config?.allow_live) {
        await updateAutoTradeConfig({ allow_live: true });
      }

      const next = await queueOvernightProtectedOrder({
        symbol: normalizedSymbol,
        entry_price: entry,
        stop_price: stop,
        target_price: target,
        mode,
        sizing_mode: sizingMode,
        qty: sizingMode === "shares" ? qty : undefined,
        fixed_shares: sizingMode === "shares" ? qty : 0,
        trade_amount: sizingMode === "shares" ? entry * qty : amount,
        extended_hours: true,
      });
      setStatus(next);
      setMessage(
        `${normalizedSymbol} was queued. The server will submit the limit entry and activate protection after it fills.`,
      );
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Unable to place the protected overnight order.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Extended Hours</div>
          <div style={styles.title}>Overnight Protected Order</div>
          <div style={styles.subtitle}>
            Limit entry with server-managed stop and target
          </div>
        </div>

        <div
          style={{
            ...styles.statusBadge,
            color: workerOnline ? "#bbf7d0" : "#fecaca",
            borderColor: workerOnline
              ? "rgba(34,197,94,.45)"
              : "rgba(248,113,113,.45)",
            background: workerOnline
              ? "rgba(22,101,52,.18)"
              : "rgba(127,29,29,.18)",
          }}
        >
          {workerOnline ? "WORKER ONLINE" : "WORKER OFFLINE"}
        </div>
      </div>

      <div style={styles.symbolStrip}>
        <span>Order</span>
        <strong>{normalizedSymbol || "—"}</strong>
        <span style={mode === "live" ? styles.liveMode : styles.paperMode}>
          {mode.toUpperCase()}
        </span>
      </div>

      <div style={styles.statusPanel}>
        <div>
          <span style={styles.statusLabel}>Status</span>
          <strong style={styles.statusValue}>{currentStatus}</strong>
        </div>
        <div>
          <span style={styles.statusLabel}>Poll</span>
          <strong style={styles.statusValue}>
            {status?.config?.poll_seconds ?? 10}s
          </strong>
        </div>
      </div>

      <div style={styles.grid3}>
        <Field label="Entry Limit">
          <input
            value={entryPrice}
            onChange={(event) => setEntryPrice(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            style={styles.input}
          />
        </Field>
        <Field label="Stop Price">
          <input
            value={stopPrice}
            onChange={(event) => setStopPrice(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            style={styles.input}
          />
        </Field>
        <Field label="Target Price">
          <input
            value={targetPrice}
            onChange={(event) => setTargetPrice(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            style={styles.input}
          />
        </Field>
      </div>

      <div style={styles.sizingRow}>
        <button
          type="button"
          onClick={() => setSizingMode("shares")}
          style={{
            ...styles.modeButton,
            ...(sizingMode === "shares" ? styles.modeButtonActive : {}),
          }}
        >
          Shares
        </button>
        <button
          type="button"
          onClick={() => setSizingMode("dollars")}
          style={{
            ...styles.modeButton,
            ...(sizingMode === "dollars" ? styles.modeButtonActive : {}),
          }}
        >
          Dollars
        </button>
      </div>

      {sizingMode === "shares" ? (
        <Field label="Share Quantity">
          <input
            value={shares}
            onChange={(event) => setShares(event.target.value)}
            inputMode="numeric"
            placeholder="100"
            style={styles.input}
          />
        </Field>
      ) : (
        <Field label="Dollar Amount">
          <input
            value={dollars}
            onChange={(event) => setDollars(event.target.value)}
            inputMode="decimal"
            placeholder="500"
            style={styles.input}
          />
        </Field>
      )}

      {runnerState && (
        <div style={styles.protectionGrid}>
          <Metric label="Qty" value={String(runnerState.filled_qty ?? runnerState.qty ?? "—")} />
          <Metric label="Entry" value={formatPrice(runnerState.entry_price)} />
          <Metric label="Stop" value={formatPrice(runnerState.stop_price)} />
          <Metric label="Target" value={formatPrice(runnerState.target_price)} />
        </div>
      )}

      {!workerOnline && (
        <div style={styles.warning}>
          No order will be accepted while the protection worker is offline.
        </div>
      )}
      {message && <div style={styles.success}>{message}</div>}
      {error && <div style={styles.error}>{error}</div>}
      {queuedPlan && serverError && (
        <div style={styles.error}>Server: {serverError}</div>
      )}
      {queuedPlan && !serverError && serverBlockedReason && (
        <div style={styles.warning}>Server: {serverBlockedReason}</div>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !workerOnline}
        style={{
          ...styles.submitButton,
          opacity: busy || !workerOnline ? 0.5 : 1,
          cursor: busy || !workerOnline ? "not-allowed" : "pointer",
        }}
      >
        {busy ? "Queuing Order…" : "Place Protected Overnight Order"}
      </button>

      <div style={styles.safetyPanel}>
        <strong>Pre-entry protection</strong>
        <span>Cancel if the target is reached before fill.</span>
        <span>Cancel if the stop is reached before fill.</span>
        <span>Partial fill: cancel the remainder and protect filled shares.</span>
      </div>

      <div style={styles.footnote}>
        Pending entries and protected positions are checked by the server about
        every 2 seconds. Overnight exits are limit orders and are not guaranteed
        to fill at the exact trigger price.
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label style={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid rgba(96,165,250,.26)",
    borderRadius: 16,
    background:
      "linear-gradient(180deg, rgba(15,23,42,.98), rgba(2,6,23,.98))",
    padding: 14,
    display: "grid",
    gap: 11,
  },
  top: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  kicker: {
    color: "#60a5fa",
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: 0.9,
    textTransform: "uppercase",
  },
  title: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: 950,
    marginTop: 2,
  },
  subtitle: {
    color: "#94a3b8",
    fontSize: 11,
    marginTop: 3,
  },
  statusBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 8px",
    fontSize: 9,
    fontWeight: 950,
    whiteSpace: "nowrap",
  },
  symbolStrip: {
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    gap: 8,
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(2,6,23,.65)",
    borderRadius: 10,
    padding: "8px 10px",
    color: "#94a3b8",
    fontSize: 11,
  },
  paperMode: {
    color: "#bfdbfe",
    fontSize: 10,
    fontWeight: 950,
  },
  liveMode: {
    color: "#fecaca",
    fontSize: 10,
    fontWeight: 950,
  },
  statusPanel: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 10,
    border: "1px solid rgba(34,197,94,.18)",
    background: "rgba(20,83,45,.10)",
    borderRadius: 10,
    padding: "9px 10px",
  },
  statusLabel: {
    display: "block",
    color: "#94a3b8",
    fontSize: 9,
    fontWeight: 900,
    textTransform: "uppercase",
  },
  statusValue: {
    color: "#e2e8f0",
    fontSize: 11,
  },
  grid3: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 7,
  },
  field: {
    display: "grid",
    gap: 5,
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: 850,
  },
  input: {
    width: "100%",
    height: 34,
    boxSizing: "border-box",
    border: "1px solid rgba(148,163,184,.24)",
    background: "rgba(2,6,23,.9)",
    color: "#f8fafc",
    borderRadius: 9,
    padding: "0 9px",
    outline: "none",
    fontSize: 12,
    fontWeight: 850,
  },
  sizingRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 7,
  },
  modeButton: {
    height: 31,
    border: "1px solid rgba(148,163,184,.18)",
    background: "rgba(15,23,42,.72)",
    color: "#94a3b8",
    borderRadius: 9,
    fontSize: 10,
    fontWeight: 900,
    cursor: "pointer",
  },
  modeButtonActive: {
    borderColor: "rgba(96,165,250,.55)",
    background: "rgba(37,99,235,.20)",
    color: "#dbeafe",
  },
  protectionGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 6,
  },
  metric: {
    display: "grid",
    gap: 2,
    border: "1px solid rgba(148,163,184,.14)",
    borderRadius: 9,
    padding: "7px 8px",
    color: "#94a3b8",
    fontSize: 9,
  },
  warning: {
    border: "1px solid rgba(250,204,21,.30)",
    background: "rgba(113,63,18,.18)",
    color: "#fde68a",
    borderRadius: 9,
    padding: 9,
    fontSize: 10,
    fontWeight: 800,
  },
  success: {
    border: "1px solid rgba(34,197,94,.28)",
    background: "rgba(20,83,45,.18)",
    color: "#bbf7d0",
    borderRadius: 9,
    padding: 9,
    fontSize: 10,
    fontWeight: 800,
  },
  error: {
    border: "1px solid rgba(248,113,113,.32)",
    background: "rgba(127,29,29,.20)",
    color: "#fecaca",
    borderRadius: 9,
    padding: 9,
    fontSize: 10,
    fontWeight: 800,
  },
  submitButton: {
    height: 38,
    border: "1px solid rgba(34,197,94,.45)",
    background: "rgba(22,101,52,.92)",
    color: "#ffffff",
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 950,
  },
  safetyPanel: {
    display: "grid",
    gap: 3,
    border: "1px solid rgba(96,165,250,.22)",
    background: "rgba(30,64,175,.10)",
    color: "#bfdbfe",
    borderRadius: 9,
    padding: 9,
    fontSize: 9,
    lineHeight: 1.4,
  },
  footnote: {
    color: "#64748b",
    fontSize: 9,
    lineHeight: 1.45,
  },
};
