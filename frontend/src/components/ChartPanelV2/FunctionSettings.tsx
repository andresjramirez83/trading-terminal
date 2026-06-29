// src/components/ChartPanelV2/FunctionSettings.tsx

import { useEffect, useRef, type CSSProperties } from "react";
import {
  DEFAULT_FX_ANALYSIS_SETTINGS,
  type FxAnalysisSettings,
  type FxAnalysisToolId,
  type FxToolSettings,
} from "../chart/analysis";

type Props = {
  open: boolean;
  activeTool: FxAnalysisToolId;
  settings: FxAnalysisSettings;
  onChange: (settings: FxAnalysisSettings) => void;
  onClose: () => void;
  onClearFx: () => void;
  onFitFxLevels?: () => void;
};

const TOOL_LABELS: Record<Exclude<FxAnalysisToolId, "none">, string> = {
  supportPrediction: "FX Support Prediction",
  resistancePrediction: "FX Resistance Prediction",
  demandZone: "FX Demand Zone",
};

const COLORS = ["#38bdf8", "#ef4444", "#22c55e", "#4ade80", "#facc15", "#ffffff"];
const WIDTHS: Array<1 | 2 | 3 | 4> = [1, 2, 3, 4];

function getToolSettings(
  settings: FxAnalysisSettings,
  activeTool: FxAnalysisToolId,
): FxToolSettings {
  if (activeTool === "none") return DEFAULT_FX_ANALYSIS_SETTINGS.supportPrediction;
  return settings[activeTool] ?? DEFAULT_FX_ANALYSIS_SETTINGS[activeTool];
}

export default function FunctionSettings({
  open,
  activeTool,
  settings,
  onChange,
  onClose,
  onClearFx,
  onFitFxLevels,
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

  if (!open || activeTool === "none") return null;

  const toolSettings = getToolSettings(settings, activeTool);
  const title = TOOL_LABELS[activeTool];

  function updateToolSettings(patch: Partial<FxToolSettings>) {
    if (activeTool === "none") return;

    onChange({
      ...settings,
      [activeTool]: {
        ...toolSettings,
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
        width: 246,
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
          <div style={{ fontSize: 13, fontWeight: 900 }}>{title}</div>
          <div style={{ fontSize: 11, color: "rgba(229,231,235,.6)", marginTop: 2 }}>
            Function Settings
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,.12)",
            background: "#0f1115",
            color: "#e5e7eb",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={toolSettings.enabled}
          onChange={() => updateToolSettings({ enabled: !toolSettings.enabled })}
        />
        Enabled
      </label>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={toolSettings.saveWithSymbol}
          onChange={() => updateToolSettings({ saveWithSymbol: !toolSettings.saveWithSymbol })}
        />
        Save with symbol/timeframe
      </label>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={toolSettings.extendRight}
          onChange={() => updateToolSettings({ extendRight: !toolSettings.extendRight })}
        />
        Extend right
      </label>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={toolSettings.showLabels}
          onChange={() => updateToolSettings({ showLabels: !toolSettings.showLabels })}
        />
        Show labels
      </label>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={toolSettings.includeInAutoScale !== false}
          onChange={() =>
            updateToolSettings({
              includeInAutoScale: !(toolSettings.includeInAutoScale !== false),
            })
          }
        />
        Include in auto scale
      </label>

      <button
        type="button"
        onClick={onFitFxLevels}
        style={{
          width: "100%",
          height: 30,
          borderRadius: 8,
          border: "1px solid rgba(96,165,250,.35)",
          background: "rgba(30,64,175,.32)",
          color: "#bfdbfe",
          cursor: "pointer",
          fontWeight: 800,
          marginTop: 6,
          marginBottom: 8,
        }}
      >
        Fit FX levels
      </button>

      <div style={{ fontSize: 11, opacity: 0.75, marginTop: 12, marginBottom: 6 }}>Color</div>
      <div style={{ display: "flex", gap: 7, marginBottom: 12, flexWrap: "wrap" }}>
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => updateToolSettings({ color })}
            title={color}
            style={{
              width: 23,
              height: 23,
              borderRadius: 999,
              border:
                toolSettings.color.toLowerCase() === color.toLowerCase()
                  ? "2px solid white"
                  : "1px solid rgba(255,255,255,.25)",
              background: color,
              cursor: "pointer",
            }}
          />
        ))}
      </div>

      <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>Line width</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {WIDTHS.map((width) => (
          <button
            key={width}
            type="button"
            onClick={() => updateToolSettings({ lineWidth: width })}
            style={{
              height: 27,
              minWidth: 36,
              borderRadius: 7,
              border: "1px solid rgba(255,255,255,.14)",
              background: toolSettings.lineWidth === width ? "#2563eb" : "#0f1115",
              color: "white",
              cursor: "pointer",
              fontWeight: 800,
            }}
          >
            {width}
          </button>
        ))}
      </div>

      {activeTool === "demandZone" && (
        <>
          <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>
            Zone opacity: {Math.round(toolSettings.opacity * 100)}%
          </div>
          <input
            type="range"
            min={5}
            max={45}
            value={Math.round(toolSettings.opacity * 100)}
            onChange={(event) =>
              updateToolSettings({ opacity: Number(event.target.value) / 100 })
            }
            style={{ width: "100%", marginBottom: 12 }}
          />
        </>
      )}

      <button
        type="button"
        onClick={onClearFx}
        style={{
          width: "100%",
          height: 30,
          borderRadius: 8,
          border: "1px solid rgba(248,113,113,.35)",
          background: "rgba(127,29,29,.32)",
          color: "#fecaca",
          cursor: "pointer",
          fontWeight: 800,
          marginTop: 2,
        }}
      >
        Clear FX overlay
      </button>

      <div
        style={{
          marginTop: 10,
          fontSize: 11,
          lineHeight: 1.35,
          color: "rgba(229,231,235,.65)",
        }}
      >
        These settings apply to this FX function and are saved locally.
      </div>
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  cursor: "pointer",
  userSelect: "none",
  marginBottom: 8,
};
