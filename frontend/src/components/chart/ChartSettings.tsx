// src/components/ChartPanelV2/ChartSettings.tsx

import { useEffect, useRef } from "react";
import type { ChartSettings } from "../../chart/ChartSettingsTypes";

type Props = {
  open: boolean;
  settings: ChartSettings;
  onChange: (settings: ChartSettings) => void;
  onClose: () => void;
};

const ATR_LENGTHS = [5, 10, 14, 20, 50];
const ATR_MULTIPLIERS = [1.2, 1.5, 2, 2.5, 3];
const ATR_COLORS = ["#f59e0b", "#facc15", "#ef4444", "#38bdf8", "#a855f7", "#ffffff"];

export default function ChartSettings({
  open,
  settings,
  onChange,
  onClose,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function handleDocumentMouseDown(event: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleDocumentMouseDown);

    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  function update(patch: Partial<ChartSettings>) {
    onChange({
      ...settings,
      ...patch,
    });
  }

  function updateSessionBands(
    patch: Partial<ChartSettings["sessionBands"]>,
  ) {
    onChange({
      ...settings,
      sessionBands: {
        ...settings.sessionBands,
        ...patch,
      },
    });
  }

  function updateAtrExpansion(
    patch: Partial<ChartSettings["atrExpansion"]>,
  ) {
    onChange({
      ...settings,
      atrExpansion: {
        ...settings.atrExpansion,
        ...patch,
      },
    });
  }

  return (
    <div
      ref={wrapperRef}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        position: "absolute",
        top: 58,
        left: 60,
        width: 260,
        padding: 12,
        borderRadius: 12,
        background: "#111827",
        border: "1px solid rgba(255,255,255,.14)",
        boxShadow: "0 18px 42px rgba(0,0,0,.55)",
        color: "#e5e7eb",
        zIndex: 90,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 900 }}>Chart Settings</div>
          <div style={{ fontSize: 11, color: "rgba(229,231,235,.6)", marginTop: 2 }}>
            Appearance and studies
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={closeButtonStyle}
        >
          ×
        </button>
      </div>

      <div style={sectionTitleStyle}>Chart</div>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={settings.gridVisible}
          onChange={() => update({ gridVisible: !settings.gridVisible })}
        />
        Grid lines
      </label>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={settings.crosshairVisible}
          onChange={() => update({ crosshairVisible: !settings.crosshairVisible })}
        />
        Crosshair lines
      </label>

      <div style={dividerStyle} />

      <div style={sectionTitleStyle}>Session Bands</div>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={settings.sessionBands.enabled}
          onChange={() => updateSessionBands({ enabled: !settings.sessionBands.enabled })}
        />
        Show session bands
      </label>

      <div style={{ paddingLeft: 20, opacity: settings.sessionBands.enabled ? 1 : 0.55 }}>
        <label style={rowStyle}>
          <input
            type="checkbox"
            disabled={!settings.sessionBands.enabled}
            checked={settings.sessionBands.premarket}
            onChange={() =>
              updateSessionBands({ premarket: !settings.sessionBands.premarket })
            }
          />
          Premarket
        </label>

        <label style={rowStyle}>
          <input
            type="checkbox"
            disabled={!settings.sessionBands.enabled}
            checked={settings.sessionBands.regular}
            onChange={() =>
              updateSessionBands({ regular: !settings.sessionBands.regular })
            }
          />
          Regular hours
        </label>

        <label style={rowStyle}>
          <input
            type="checkbox"
            disabled={!settings.sessionBands.enabled}
            checked={settings.sessionBands.afterHours}
            onChange={() =>
              updateSessionBands({ afterHours: !settings.sessionBands.afterHours })
            }
          />
          After hours
        </label>

        <div style={{ fontSize: 11, opacity: 0.75, margin: "8px 0 5px" }}>
          Opacity {Math.round(settings.sessionBands.opacity * 100)}%
        </div>
        <input
          type="range"
          min={2}
          max={20}
          step={1}
          disabled={!settings.sessionBands.enabled}
          value={Math.round(settings.sessionBands.opacity * 100)}
          onChange={(event) =>
            updateSessionBands({ opacity: Number(event.target.value) / 100 })
          }
          style={{ width: "100%" }}
        />
      </div>

      <div style={dividerStyle} />

      <div style={sectionTitleStyle}>ATR Expansion Candles</div>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={settings.atrExpansion.enabled}
          onChange={() =>
            updateAtrExpansion({ enabled: !settings.atrExpansion.enabled })
          }
        />
        Highlight ATR expansion candles
      </label>

      <div style={{ opacity: settings.atrExpansion.enabled ? 1 : 0.55 }}>
        <div style={{ fontSize: 11, opacity: 0.75, margin: "8px 0 6px" }}>
          ATR Length
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {ATR_LENGTHS.map((length) => (
            <button
              key={length}
              type="button"
              disabled={!settings.atrExpansion.enabled}
              onClick={() => updateAtrExpansion({ length })}
              style={{
                ...pillButtonStyle,
                background:
                  settings.atrExpansion.length === length ? "#2563eb" : "#0f1115",
              }}
            >
              {length}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 11, opacity: 0.75, margin: "8px 0 6px" }}>
          Multiplier
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {ATR_MULTIPLIERS.map((multiplier) => (
            <button
              key={multiplier}
              type="button"
              disabled={!settings.atrExpansion.enabled}
              onClick={() => updateAtrExpansion({ multiplier })}
              style={{
                ...pillButtonStyle,
                background:
                  settings.atrExpansion.multiplier === multiplier
                    ? "#2563eb"
                    : "#0f1115",
              }}
            >
              {multiplier}x
            </button>
          ))}
        </div>

        <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>
          Highlight Color
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          {ATR_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              disabled={!settings.atrExpansion.enabled}
              onClick={() => updateAtrExpansion({ color })}
              title={color}
              style={{
                width: 23,
                height: 23,
                borderRadius: 999,
                border:
                  settings.atrExpansion.color === color
                    ? "2px solid white"
                    : "1px solid rgba(255,255,255,.25)",
                background: color,
                cursor: settings.atrExpansion.enabled ? "pointer" : "not-allowed",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minHeight: 25,
  fontSize: 12,
  cursor: "pointer",
  userSelect: "none",
} as const;

const sectionTitleStyle = {
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  color: "rgba(229,231,235,.7)",
  marginBottom: 6,
} as const;

const dividerStyle = {
  height: 1,
  background: "rgba(255,255,255,.08)",
  margin: "11px 0",
} as const;

const closeButtonStyle = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,.12)",
  background: "#0f1115",
  color: "#e5e7eb",
  cursor: "pointer",
} as const;

const pillButtonStyle = {
  height: 27,
  minWidth: 38,
  borderRadius: 7,
  border: "1px solid rgba(255,255,255,.14)",
  color: "white",
  cursor: "pointer",
  fontWeight: 800,
} as const;
