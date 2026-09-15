import { useEffect, useMemo, useState } from "react";
import {
  createChartObjectAlert,
  deleteChartObjectAlert,
  fetchChartObjectAlerts,
  updateChartObjectAlert,
  type ChartAlertCondition,
  type ChartAlertFibMode,
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
  fibStartPrice?: number | null;
  fibEndPrice?: number | null;
  fibDefaultLevel?: number | null;
  fibDefaultZoneA?: number | null;
  fibDefaultZoneB?: number | null;
};

type Props = {
  draft: ChartAlertDraft | null;
  onClose: () => void;
};

const LINE_CONDITION_OPTIONS: Array<{ value: ChartAlertCondition; label: string }> = [
  { value: "touches", label: "Price touches" },
  { value: "crosses_above", label: "Price crosses above" },
  { value: "crosses_below", label: "Price crosses below" },
  { value: "closes_above", label: "Candle closes above" },
  { value: "closes_below", label: "Candle closes below" },
];

const ZONE_CONDITION_OPTIONS: Array<{ value: ChartAlertCondition; label: string }> = [
  { value: "enters_zone", label: "Price enters / touches zone" },
  { value: "closes_inside_zone", label: "Candle closes inside zone" },
  { value: "exits_zone", label: "Price closes outside after being inside" },
];

const CONDITION_LABELS: Record<ChartAlertCondition, string> = {
  touches: "Price touches",
  crosses_above: "Price crosses above",
  crosses_below: "Price crosses below",
  closes_above: "Candle closes above",
  closes_below: "Candle closes below",
  enters_zone: "Price enters zone",
  exits_zone: "Price exits zone",
  closes_inside_zone: "Candle closes inside zone",
  reclaims_above_zone: "Candle reclaims above zone",
};

const ALERT_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
const FIB_ZONES = FIB_LEVELS.slice(0, -1).map((ratio, index) => ({
  a: ratio,
  b: FIB_LEVELS[index + 1],
}));

function ratioText(value: number): string {
  if (value === 0 || value === 1) return value.toFixed(0);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function priceText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return value < 1 ? value.toFixed(4) : value.toFixed(2);
}

function fibPrice(draft: ChartAlertDraft, ratio: number): number | null {
  const start = Number(draft.fibStartPrice);
  const end = Number(draft.fibEndPrice);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - (end - start) * ratio;
}

function fibLevelOptionLabel(draft: ChartAlertDraft, ratio: number): string {
  const price = fibPrice(draft, ratio);
  return price == null ? ratioText(ratio) : `${ratioText(ratio)} · $${priceText(price)}`;
}

function fibZoneOptionLabel(draft: ChartAlertDraft, a: number, b: number): string {
  const pa = fibPrice(draft, a);
  const pb = fibPrice(draft, b);
  if (pa == null || pb == null) return `${ratioText(a)}–${ratioText(b)}`;
  const low = Math.min(pa, pb);
  const high = Math.max(pa, pb);
  return `${ratioText(a)}–${ratioText(b)} · $${priceText(low)}–$${priceText(high)}`;
}

function belongsToDraft(alert: ChartObjectAlert, draft: ChartAlertDraft): boolean {
  if (alert.symbol !== draft.symbol) return false;
  if (alert.source_type !== draft.sourceType) return false;
  if (draft.sourceType === "study") return alert.study === draft.study;
  return alert.source_id === draft.sourceId;
}

function defaultTriggerTimeframe(sourceTimeframe: string): string {
  return (ALERT_TIMEFRAMES as readonly string[]).includes(sourceTimeframe) ? sourceTimeframe : "5m";
}

function existingAlertTimeframeLabel(alert: ChartObjectAlert): string {
  const sourceTimeframe = String(alert.source_timeframe ?? alert.timeframe);
  if (sourceTimeframe === alert.timeframe) return `${alert.timeframe} trigger`;
  return `drawn ${sourceTimeframe} → ${alert.timeframe} trigger`;
}

function nearestZoneIndex(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null || b == null) return 3; // 0.5–0.618
  const found = FIB_ZONES.findIndex(
    (zone) => Math.abs(zone.a - a) < 1e-6 && Math.abs(zone.b - b) < 1e-6,
  );
  return found >= 0 ? found : 3;
}

function fibExistingLabel(alert: ChartObjectAlert): string {
  if (alert.source_type !== "fibonacci") return CONDITION_LABELS[alert.condition] ?? alert.condition;
  const mode = alert.fib_mode ?? "level";
  if (mode === "level") {
    const ratio = Number(alert.fib_level_ratio ?? 0.5);
    return `Fib ${ratioText(ratio)} · ${CONDITION_LABELS[alert.condition] ?? alert.condition}`;
  }
  const a = Number(alert.fib_zone_ratio_a ?? 0.5);
  const b = Number(alert.fib_zone_ratio_b ?? 0.618);
  const zone = `${ratioText(a)}–${ratioText(b)}`;
  if (mode === "reclaim") return `Fib ${zone} · Reclaim above zone`;
  return `Fib ${zone} · ${CONDITION_LABELS[alert.condition] ?? alert.condition}`;
}

export default function ChartAlertDialog({ draft, onClose }: Props) {
  const [condition, setCondition] = useState<ChartAlertCondition>("touches");
  const [triggerTimeframe, setTriggerTimeframe] = useState("5m");
  const [recurrence, setRecurrence] = useState<ChartAlertRecurrence>("once");
  const [notifyPhone, setNotifyPhone] = useState(true);
  const [fibMode, setFibMode] = useState<ChartAlertFibMode>("zone");
  const [fibLevel, setFibLevel] = useState(0.618);
  const [fibZoneIndex, setFibZoneIndex] = useState(3);
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
    setTriggerTimeframe(defaultTriggerTimeframe(draft.timeframe));
    setRecurrence("once");
    setNotifyPhone(true);
    setMessage("");
    setError("");
    if (draft.sourceType === "study") {
      setCondition("crosses_above");
    } else if (draft.sourceType === "fibonacci") {
      setFibMode("zone");
      setFibLevel(Number(draft.fibDefaultLevel ?? 0.618));
      setFibZoneIndex(nearestZoneIndex(draft.fibDefaultZoneA, draft.fibDefaultZoneB));
      setCondition("enters_zone");
    } else {
      setCondition("touches");
    }
    void refreshExisting(draft);
  }, [draft]);

  const subtitle = useMemo(() => {
    if (!draft) return "";
    const price = priceText(draft.price);
    return price ? `${draft.symbol} · drawn on ${draft.timeframe} · $${price}` : `${draft.symbol} · drawn on ${draft.timeframe}`;
  }, [draft]);

  if (!draft) return null;

  const isFib = draft.sourceType === "fibonacci";
  const activeZone = FIB_ZONES[Math.min(Math.max(fibZoneIndex, 0), FIB_ZONES.length - 1)];
  const conditionOptions = isFib && fibMode === "zone" ? ZONE_CONDITION_OPTIONS : LINE_CONDITION_OPTIONS;

  const setNextFibMode = (mode: ChartAlertFibMode) => {
    setFibMode(mode);
    if (mode === "level") setCondition("touches");
    else if (mode === "zone") setCondition("enters_zone");
    else setCondition("reclaims_above_zone");
  };

  const save = async () => {
    setWorking(true);
    setMessage("");
    setError("");
    try {
      let sourceLabel = draft.sourceLabel;
      let nextCondition = condition;
      let fibLevelRatio: number | null = null;
      let fibZoneRatioA: number | null = null;
      let fibZoneRatioB: number | null = null;

      if (isFib) {
        if (fibMode === "level") {
          fibLevelRatio = fibLevel;
          sourceLabel = `Fib ${ratioText(fibLevel)}`;
        } else {
          fibZoneRatioA = activeZone.a;
          fibZoneRatioB = activeZone.b;
          sourceLabel = `Fib ${ratioText(activeZone.a)}–${ratioText(activeZone.b)} Zone`;
          if (fibMode === "reclaim") nextCondition = "reclaims_above_zone";
        }
      }

      const response = await createChartObjectAlert({
        symbol: draft.symbol,
        timeframe: triggerTimeframe,
        source_timeframe: draft.timeframe,
        source_type: draft.sourceType,
        source_id: draft.sourceId ?? null,
        source_label: sourceLabel,
        price: isFib ? null : (draft.price ?? null),
        study: draft.study ?? null,
        fib_mode: isFib ? fibMode : null,
        fib_level_ratio: fibLevelRatio,
        fib_zone_ratio_a: fibZoneRatioA,
        fib_zone_ratio_b: fibZoneRatioB,
        condition: nextCondition,
        recurrence,
        notify_phone: notifyPhone,
      });

      if (notifyPhone && !response.phone_configured) {
        setMessage("Alert saved, but phone push is not configured on the backend.");
      } else {
        setMessage(`Alert created on the ${triggerTimeframe} trigger timeframe. It will keep working even when this chart is closed.`);
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
          width: "min(460px, calc(100vw - 24px))",
          maxHeight: "min(760px, calc(100vh - 24px))",
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
              {isFib ? "CREATE FIB ALERT" : "CREATE ALERT"}
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

        {isFib && (
          <>
            <label style={{ display: "block", marginTop: 18, fontSize: 12, color: "#9ca3af" }}>
              Fib alert type
              <select
                value={fibMode}
                onChange={(event) => setNextFibMode(event.target.value as ChartAlertFibMode)}
                style={{ marginTop: 6, width: "100%", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "#0f1317", color: "#f3f4f6", padding: "10px 11px" }}
              >
                <option value="level">Level</option>
                <option value="zone">Zone</option>
                <option value="reclaim">Zone reclaim</option>
              </select>
            </label>

            {fibMode === "level" ? (
              <label style={{ display: "block", marginTop: 14, fontSize: 12, color: "#9ca3af" }}>
                Fib level
                <select
                  value={String(fibLevel)}
                  onChange={(event) => setFibLevel(Number(event.target.value))}
                  style={{ marginTop: 6, width: "100%", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "#0f1317", color: "#f3f4f6", padding: "10px 11px" }}
                >
                  {FIB_LEVELS.map((ratio) => (
                    <option key={ratio} value={ratio}>{fibLevelOptionLabel(draft, ratio)}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label style={{ display: "block", marginTop: 14, fontSize: 12, color: "#9ca3af" }}>
                Fib zone
                <select
                  value={String(fibZoneIndex)}
                  onChange={(event) => setFibZoneIndex(Number(event.target.value))}
                  style={{ marginTop: 6, width: "100%", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "#0f1317", color: "#f3f4f6", padding: "10px 11px" }}
                >
                  {FIB_ZONES.map((zone, index) => (
                    <option key={`${zone.a}-${zone.b}`} value={index}>{fibZoneOptionLabel(draft, zone.a, zone.b)}</option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        <label style={{ display: "block", marginTop: isFib ? 14 : 18, fontSize: 12, color: "#9ca3af" }}>
          Trigger timeframe
          <select
            value={triggerTimeframe}
            onChange={(event) => setTriggerTimeframe(event.target.value)}
            style={{ marginTop: 6, width: "100%", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "#0f1317", color: "#f3f4f6", padding: "10px 11px" }}
          >
            {ALERT_TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}{tf === draft.timeframe ? " · same as chart" : ""}
              </option>
            ))}
          </select>
          <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.4, color: "#6b7280" }}>
            Drawing timeframe: {draft.timeframe}. The alert condition is evaluated using {triggerTimeframe} price candles.
          </div>
        </label>

        {(!isFib || fibMode !== "reclaim") && (
          <label style={{ display: "block", marginTop: 14, fontSize: 12, color: "#9ca3af" }}>
            Condition
            <select
              value={condition}
              onChange={(event) => setCondition(event.target.value as ChartAlertCondition)}
              style={{ marginTop: 6, width: "100%", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)", background: "#0f1317", color: "#f3f4f6", padding: "10px 11px" }}
            >
              {conditionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}

        {isFib && fibMode === "reclaim" && (
          <div style={{ marginTop: 14, padding: 10, borderRadius: 9, background: "rgba(250,204,21,0.08)", border: "1px solid rgba(250,204,21,0.16)", color: "#fde68a", fontSize: 12, lineHeight: 1.45 }}>
            Reclaim alert: price trades into or below the selected Fib zone, then a {triggerTimeframe} candle closes back above the zone's upper price boundary.
          </div>
        )}

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
            This alert stays attached to the drawing. If you move {isFib ? "either Fib anchor" : "the line"} later, the alert follows it and recalculates automatically. Deleting the drawing disables the alert.
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
                      {fibExistingLabel(alert)}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 10, color: "#6b7280" }}>
                      {existingAlertTimeframeLabel(alert)} · {alert.recurrence === "once" ? "Once" : `Once per ${alert.timeframe} candle`} · {alert.status ?? (alert.active ? "armed" : "disabled")}
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
