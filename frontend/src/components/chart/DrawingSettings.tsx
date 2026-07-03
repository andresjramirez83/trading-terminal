// src/components/ChartPanelV2/DrawingSettings.tsx

import { useEffect, useRef } from "react";
import type { DrawingStyle } from "./DrawingTypes";

type Props = {
  open: boolean;
  style: DrawingStyle;
  onChange: (style: DrawingStyle) => void;
  onClose: () => void;
};

const COLORS = [
  "#facc15",
  "#38bdf8",
  "#22c55e",
  "#ef4444",
  "#a855f7",
  "#ffffff",
];

const WIDTHS = [1, 2, 3, 4];

export default function DrawingSettings({ open, style, onChange, onClose }: Props) {
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

  return (
    <div
      ref={wrapperRef}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        position: "absolute",
        top: 58,
        left: 60,
        width: 220,
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
        <div style={{ fontSize: 13, fontWeight: 900 }}>Drawing Settings</div>
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

      <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>Color</div>
      <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange({ ...style, color })}
            title={color}
            style={{
              width: 23,
              height: 23,
              borderRadius: 999,
              border:
                style.color === color
                  ? "2px solid white"
                  : "1px solid rgba(255,255,255,.25)",
              background: color,
              cursor: "pointer",
            }}
          />
        ))}
      </div>

      <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>Width</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {WIDTHS.map((width) => (
          <button
            key={width}
            type="button"
            onClick={() => onChange({ ...style, width })}
            style={{
              height: 27,
              minWidth: 36,
              borderRadius: 7,
              border: "1px solid rgba(255,255,255,.14)",
              background: style.width === width ? "#2563eb" : "#0f1115",
              color: "white",
              cursor: "pointer",
              fontWeight: 800,
            }}
          >
            {width}
          </button>
        ))}
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={style.extendRight}
          onChange={() => onChange({ ...style, extendRight: !style.extendRight })}
        />
        Extend trendline right
      </label>

      <div
        style={{
          marginTop: 10,
          fontSize: 11,
          lineHeight: 1.35,
          color: "rgba(229,231,235,.65)",
        }}
      >
        These settings apply to new drawings.
      </div>
    </div>
  );
}
