// src/components/ChartPanelV2/LeftDrawingBar.tsx

import type { ReactNode } from "react";
import type { DrawingTool } from "./DrawingTypes";
import type { FxAnalysisToolId } from "../../chart/analysis";
import {
  CursorIcon,
  DateRangeIcon,
  EraserIcon,
  HorizontalLineIcon,
  MagnetIcon,
  PriceRangeIcon,
  RayIcon,
  RectangleIcon,
  SettingsIcon,
  TextIcon,
  TrashIcon,
  TrendlineIcon,
} from "./DrawingIcons";

type ToolItem = {
  key: DrawingTool;
  label: string;
  shortcut?: string;
  icon: ReactNode;
  disabled?: boolean;
};

type FxAnalysisItem = {
  key: FxAnalysisToolId;
  label: string;
  letter: string;
};

type Props = {
  activeTool: DrawingTool;
  activeAnalysisTool?: FxAnalysisToolId;
  settingsOpen?: boolean;
  onToolChange: (tool: DrawingTool) => void;
  onAnalysisToolChange?: (tool: FxAnalysisToolId) => void;
  onClear: () => void;
  onToggleSettings: () => void;
};

const FX_ANALYSIS_TOOLS: FxAnalysisItem[] = [
  { key: "supportPrediction", label: "FX Support Prediction", letter: "S" },
  { key: "resistancePrediction", label: "FX Resistance Prediction", letter: "R" },
  { key: "demandZone", label: "FX Demand Zone", letter: "D" },
];

const TOOLS: ToolItem[] = [
  { key: "cursor", label: "Cursor", shortcut: "Esc", icon: <CursorIcon /> },
  { key: "trendline", label: "Trendline", shortcut: "T", icon: <TrendlineIcon /> },
  { key: "horizontal", label: "Horizontal Line", shortcut: "H", icon: <HorizontalLineIcon /> },
  { key: "ray", label: "Ray", icon: <RayIcon />, disabled: true },
  { key: "rectangle", label: "Rectangle", icon: <RectangleIcon />, disabled: true },
  { key: "priceRange", label: "Price Range", icon: <PriceRangeIcon />, disabled: true },
  { key: "dateRange", label: "Date Range", icon: <DateRangeIcon />, disabled: true },
  { key: "text", label: "Text", icon: <TextIcon />, disabled: true },
  { key: "magnet", label: "Magnet", icon: <MagnetIcon />, disabled: true },
  { key: "eraser", label: "Eraser", icon: <EraserIcon />, disabled: true },
];

function tooltip(label: string, shortcut?: string, disabled?: boolean): string {
  if (disabled) return `${label} — coming soon`;
  return shortcut ? `${label} — ${shortcut}` : label;
}

export default function LeftDrawingBar({
  activeTool,
  activeAnalysisTool = "none",
  settingsOpen = false,
  onToolChange,
  onAnalysisToolChange,
  onClear,
  onToggleSettings,
}: Props) {
  const buttonStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    width: 38,
    height: 38,
    borderRadius: 9,
    border: active ? "1px solid rgba(96,165,250,.75)" : "1px solid transparent",
    background: active ? "rgba(37,99,235,.95)" : "transparent",
    color: disabled ? "rgba(209,213,219,.28)" : active ? "white" : "#d1d5db",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: disabled ? 0.55 : 1,
  });

  return (
    <aside
      style={{
        width: 52,
        flexShrink: 0,
        height: "100%",
        background: "#0b0f14",
        borderRight: "1px solid rgba(255,255,255,.08)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "8px 0",
        gap: 5,
        zIndex: 50,
      }}
    >
      {TOOLS.map((tool) => {
        const active = activeTool === tool.key;

        return (
          <button
            key={tool.key}
            type="button"
            title={tooltip(tool.label, tool.shortcut, tool.disabled)}
            disabled={tool.disabled}
            onClick={() => {
              if (!tool.disabled) onToolChange(tool.key);
            }}
            style={buttonStyle(active, tool.disabled)}
          >
            {tool.icon}
          </button>
        );
      })}

      <div
        style={{
          width: 28,
          height: 1,
          background: "rgba(255,255,255,.12)",
          margin: "6px 0",
        }}
      />

      {FX_ANALYSIS_TOOLS.map((tool) => {
        const active = activeAnalysisTool === tool.key;

        return (
          <button
            key={tool.key}
            type="button"
            title={tool.label}
            onClick={() => onAnalysisToolChange?.(tool.key)}
            style={{
              ...buttonStyle(active),
              width: 44,
              height: 32,
              gap: 3,
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 0.1,
            }}
          >
            <span
              style={{
                fontStyle: "italic",
                fontWeight: 800,
                fontSize: 11,
                lineHeight: 1,
                opacity: active ? 1 : 0.75,
              }}
            >
              fx
            </span>
            <span
              style={{
                fontWeight: 900,
                color: active ? "#fff" : "#93c5fd",
              }}
            >
              {tool.letter}
            </span>
          </button>
        );
      })}

      <div
        style={{
          width: 28,
          height: 1,
          background: "rgba(255,255,255,.12)",
          margin: "6px 0",
        }}
      />

      <div style={{ flex: 1 }} />

      <button
        type="button"
        title="Settings"
        onClick={onToggleSettings}
        style={buttonStyle(settingsOpen)}
      >
        <SettingsIcon />
      </button>

      <button
        type="button"
        title="Clear drawings"
        onClick={onClear}
        style={{
          ...buttonStyle(false),
          color: "#fca5a5",
        }}
      >
        <TrashIcon />
      </button>
    </aside>
  );
}
