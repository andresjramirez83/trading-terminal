import { useEffect, useMemo, useState } from "react";
import {
  createChartObjectAlert,
  deleteChartObjectAlert,
  fetchChartObjectAlerts,
  updateChartObjectAlert,
  type ChartAlertCondition,
  type ChartAlertRecurrence,
  type ChartAlertSourceType,
  type ChartAlertStudy,
  type ChartObjectAlert,
} from "../../services/api";

export type ChartAlertDraft = {
  symbol: string;
  timeframe: string;
  sourceType: ChartAlertSourceType;
  sourceId?: string | null;
  sourceLabel: string;
  price?: number | null;
  study?: ChartAlertStudy | null;
};

type Props = {
  draft: ChartAlertDraft | null;
  onClose: () => void;
};

const CONDITION_OPTIONS: Array<{ value: ChartAlertCondition; label: string }> = [
  { value: "touches", label: "Price touches" },
  { value: "crosses_above", label: "Price crosses above" },
  { value: "crosses_below", label: "Price crosses below" },
  { value: "closes_above", label: "Candle closes above" },
  { value: "closes_below", label: "Candle closes below" },
];

const CONDITION_LABELS = Object.fromEntries(
  CONDITION_OPTIONS.map((option) => [option.value, option.label]),
) as Record<ChartAlertCondition, string>;

function priceText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return value < 1 ? value.toFixed(4) : value.toFixed(2);
}

function belongsToDraft(alert: ChartObjectAlert, draft: ChartAlertDraft): boolean {
  if (alert.symbol !== draft.symbol || alert.timeframe !== draft.timeframe) return false;
  if (alert.source_type !== draft.sourceType) return false;
  if (draft.sourceType === "study") return alert.study === draft.study;
  return alert.source_id === draft.sourceId;
}

export default function ChartAlertDialog({ draft, onClose }: Props) {
  const [condition, setCondition] = useState<ChartAlertCondition>("touches");
  const [recurrence, setRecurrence] = useState<ChartAlertRecurrence>("once");
  const [notifyPhone, setNotifyPhone] = useState(true);
  const [working, setWorking] = useState(false);
  const [existing, setExisting] = useState<ChartObjectAlert[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refreshExisting = async (nextDraft: ChartAlertDraft) => {
    try {
      const response = await fetchChartObjectAlerts(nextDraft.symbol);
      setExisting(response.alerts.filter((alert) => belongsToDraft(alert, nextDraft)));
    } catch {
      setExisting([]);
    }
  };

  useEffect(() => {
    if (!draft) return;
    setCondition(draft.sourceType === "study" ? "crosses_above" : "touches");
    setRecurrence("once");
    setNotifyPhone(true);
    setMessage("");
    setError("");
    void refreshExisting(draft);
  }, [draft]);

  const subtitle = useMemo(() => {
    if (!draft) return "";
    const price = priceText(draft.price);
    return price ? `${draft.symbol} · ${draft.timeframe} · $${price}` : `${draft.symbol} · ${draft.timeframe}`;
  }, [draft]);

  if (!draft) return null;

  const save = async () => {
    setWorking(true);
    setMessage("");
    setError("");
    try {
      const response = await createChartObjectAlert({
        symbol: draft.symbol,
        timeframe: draft.timeframe,
        source_type: draft.sourceType,
        source_id: draft.sourceId ?? null,
        source_label: draft.sourceLabel,
        price: draft.price ?? null,
        study: draft.study ?? null,
        condition,
        recurrence,
        notify_phone: notifyPhone,
      });

      if (notifyPhone && !response.phone_configured) {
        setMessage("Alert saved, but phone push is not configured on the backend.");
      } else {
        setMessage("Alert created. It will keep working even when this chart is closed.");
      }
      await refreshExisting(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create alert");
    } finally {
      setWorking(false);
    }
  };

  const toggleExisting = async (alert: ChartObjectAlert) => {
    setWorking(true);
    setError("");
    try {
      await updateChartObjectAlert(alert.id, { active: !alert.active });
      await refreshExisting(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update alert");
    } finally {
      setWorking(false);
    }
  };

  const removeExisting = async (alert: ChartObjectAlert) => {
    setWorking(true);
    setError("");
    try {
      await deleteChartObjectAlert(alert.id);
      await refreshExisting(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete alert");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create chart alert"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 12000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.52)",
        backdropFilter: "blur(3px)",
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(440px, calc(100vw - 24px))",
          maxHeight: "min(720px, calc(100vh - 24px))",
          overflowY: "auto",
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.13)",
          background: "#15191d",
          color: "#e5e7eb",
          boxShadow: "0 24px 70px rgba(0,0,0,0.55)",
          padding: 18,
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#7dd3fc", fontWeight: 700, letterSpacing: 0.5 }}>
              CREATE ALERT
            </div>
            <div style={{ marginTop: 4, fontSize: 18, fontWeight: 700 }}>{draft.sourceLabel}</div>
            <div style={{ marginTop: 3, fontSize: 12, color: "#9ca3af" }}>{subtitle}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close alert dialog"
            style={{ alignSelf: "flex-start", border: 0, background: "transparent", color: "#9ca3af", fontSize: 22, cursor: "pointer" }}
          >
            ×
          </button>
        </div>

        <label style={{ display: "block", marginTop: 18, fontSize: 12, color: "#9ca3af" }}>
          Condition
          <select
            value={condition}
            onChange={(event) => setCondition(event.target.value as ChartAlertCondition)}
            style={{ marginTop: 6, width: "100%", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "#0f1317", color: "#f3f4f6", padding: "10px 11px" }}
          >
            {CONDITION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "block", marginTop: 14, fontSize: 12, color: "#9ca3af" }}>
          Trigger
          <select
            value={recurrence}
            onChange={(event) => setRecurrence(event.target.value as ChartAlertRecurrence)}
            style={{ marginTop: 6, width: "100%", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "#0f1317", color: "#f3f4f6", padding: "10px 11px" }}
          >
            <option value="once">Once, then disable</option>
            <option value="once_per_bar">Once per candle</option>
          </select>
        </label>

        <label style={{ marginTop: 15, display: "flex", alignItems: "center", gap: 9, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={notifyPhone} onChange={(event) => setNotifyPhone(event.target.checked)} />
          Send phone push notification
        </label>

        {draft.sourceType !== "study" && (
          <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.45, color: "#6b7280" }}>
            This alert stays attached to the drawing. If you move the line later, the alert follows it. Deleting the drawing disables the alert.
          </div>
        )}

        {message && (
          <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: "rgba(34,197,94,0.10)", color: "#86efac", fontSize: 12 }}>{message}</div>
        )}
        {error && (
          <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: "rgba(239,68,68,0.10)", color: "#fca5a5", fontSize: 12 }}>{error}</div>
        )}

        {existing.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.09)" }}>
            <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 700, letterSpacing: 0.4 }}>EXISTING ALERTS</div>
            <div style={{ display: "grid", gap: 8, marginTop: 9 }}>
              {existing.map((alert) => (
                <div key={alert.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: 9, borderRadius: 9, background: "#101419", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, color: alert.active ? "#86efac" : "#9ca3af", fontWeight: 650 }}>
                      {CONDITION_LABELS[alert.condition] ?? alert.condition}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 10, color: "#6b7280" }}>
                      {alert.recurrence === "once" ? "Once" : "Once per candle"} · {alert.status ?? (alert.active ? "armed" : "disabled")}
                    </div>
                  </div>
                  <button type="button" disabled={working} onClick={() => void toggleExisting(alert)} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 7, background: "transparent", color: "#d1d5db", padding: "6px 8px", fontSize: 11, cursor: "pointer" }}>
                    {alert.active ? "Disable" : "Enable"}
                  </button>
                  <button type="button" disabled={working} onClick={() => void removeExisting(alert)} style={{ border: "1px solid rgba(248,113,113,0.30)", borderRadius: 7, background: "transparent", color: "#f87171", padding: "6px 8px", fontSize: 11, cursor: "pointer" }}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 18 }}>
          <button type="button" onClick={onClose} style={{ borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "transparent", color: "#d1d5db", padding: "9px 13px", cursor: "pointer" }}>
            Close
          </button>
          <button type="button" onClick={() => void save()} disabled={working} style={{ borderRadius: 8, border: "1px solid #0ea5e9", background: working ? "#164e63" : "#0369a1", color: "white", padding: "9px 14px", fontWeight: 700, cursor: working ? "wait" : "pointer" }}>
            {working ? "Working…" : "Create Alert"}
          </button>
        </div>
      </div>
    </div>
  );
}
