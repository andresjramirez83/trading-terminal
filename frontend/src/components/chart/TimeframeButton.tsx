// src/components/ChartPanelV2/TimeframeButton.tsx

import type { CSSProperties } from "react";

type Props = {
  label: string;
  active?: boolean;
  title?: string;
  onClick: () => void;
};

export default function TimeframeButton({ label, active = false, title, onClick }: Props) {
  const style: CSSProperties = {
    height: 28,
    padding: "0 10px",
    borderRadius: 7,
    border: active ? "1px solid rgba(96,165,250,.85)" : "1px solid rgba(255,255,255,.11)",
    background: active ? "linear-gradient(180deg, #3b82f6 0%, #1d4ed8 100%)" : "#080c13",
    color: "white",
    cursor: "pointer",
    fontWeight: 900,
    flexShrink: 0,
    boxShadow: active ? "0 0 16px rgba(59,130,246,.22)" : "none",
    lineHeight: 1,
  };

  return (
    <button type="button" title={title} onClick={onClick} style={style}>
      {label}
    </button>
  );
}
