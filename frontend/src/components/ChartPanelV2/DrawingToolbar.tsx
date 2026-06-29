import type { DrawingTool } from "./DrawingTypes";

type Props = {
  tool: DrawingTool;
  onChange: (tool: DrawingTool) => void;
  onClear: () => void;
};

export default function DrawingToolbar({
  tool,
  onChange,
  onClear,
}: Props) {
  function button(active: boolean): React.CSSProperties {
    return {
      height: 28,
      padding: "0 10px",
      borderRadius: 6,
      border: "1px solid rgba(255,255,255,.14)",
      background: active ? "#2563eb" : "#0f1115",
      color: "white",
      cursor: "pointer",
      fontWeight: 700,
    };
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        marginLeft: 10,
      }}
    >
      <button
        style={button(tool === "horizontal")}
        onClick={() => onChange("horizontal")}
      >
        H-Line
      </button>

      <button
        style={button(tool === "trendline")}
        onClick={() => onChange("trendline")}
      >
        Trend
      </button>

      <button
        style={button(false)}
        onClick={onClear}
      >
        Clear
      </button>
    </div>
  );
}