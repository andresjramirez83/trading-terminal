import { useState } from "react";
import type { RightPanelWorkspace } from "../chart/right-panel/RightPanelTypes";
import type { ChartState } from "../chart/ChartState";
import { DecisionCenterProvider } from "../chart/right-panel/DecisionCenterContext";

import ChartWorkspacePanel from "../chart/right-panel/workspaces/ChartWorkspacePanel";
import TradeWorkspacePanel from "../chart/right-panel/workspaces/TradeWorkspacePanel";
import WatchlistsWorkspacePanel from "../chart/right-panel/workspaces/WatchlistsWorkspacePanel";
import ScannerWorkspacePanel from "../chart/right-panel/workspaces/ScannerWorkspacePanel";
import NewsWorkspacePanel from "../chart/right-panel/workspaces/NewsWorkspacePanel";

type Props = {
  symbol: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  chartState?: ChartState | null;
};

const WORKSPACES: { id: RightPanelWorkspace; label: string }[] = [
  { id: "chart", label: "Chart" },
  { id: "trade", label: "Trade" },
  { id: "watchlists", label: "Lists" },
  { id: "scanner", label: "Scanner" },
  { id: "news", label: "News" },
];

export default function RightInfoPanel({
  collapsed,
  onToggleCollapsed,
  chartState,
}: Props) {
  const [workspace, setWorkspace] = useState<RightPanelWorkspace>("chart");

  if (collapsed) {
    return (
      <aside
        style={{
          width: 38,
          flexShrink: 0,
          height: "100%",
          background: "#0b0f14",
          borderLeft: "1px solid rgba(255,255,255,.08)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: 8,
          zIndex: 25,
        }}
      >
        <button
          type="button"
          title="Open info panel"
          onClick={onToggleCollapsed}
          style={{
            width: 28,
            height: 34,
            borderRadius: 7,
            border: "1px solid rgba(255,255,255,.14)",
            background: "#111827",
            color: "white",
            cursor: "pointer",
            fontSize: 18,
            fontWeight: 800,
          }}
        >
          ‹
        </button>
      </aside>
    );
  }

  return (
    <aside
      style={{
        width: 340,
        flexShrink: 0,
        height: "100%",
        background: "#0b0f14",
        borderLeft: "1px solid rgba(255,255,255,.08)",
        color: "#e5e7eb",
        display: "flex",
        flexDirection: "column",
        zIndex: 25,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: "8px 10px 0",
          borderBottom: "1px solid rgba(255,255,255,.08)",
          background: "#111315",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            height: 34,
          }}
        >
          <button
            type="button"
            title="Collapse info panel"
            onClick={onToggleCollapsed}
            style={{
              width: 28,
              height: 30,
              borderRadius: 7,
              border: "1px solid rgba(255,255,255,.14)",
              background: "#0f1115",
              color: "white",
              cursor: "pointer",
              fontSize: 18,
              fontWeight: 800,
              flexShrink: 0,
            }}
          >
            ›
          </button>

          {WORKSPACES.map((item) => {
            const active = workspace === item.id;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setWorkspace(item.id)}
                style={{
                  height: 34,
                  padding: "0 0 7px",
                  border: "none",
                  borderBottom: active
                    ? "2px solid #2563eb"
                    : "2px solid transparent",
                  background: "transparent",
                  color: active ? "#ffffff" : "#cbd5e1",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 800,
                  whiteSpace: "nowrap",
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <DecisionCenterProvider chartState={chartState}>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: 10,
          }}
        >
          {workspace === "chart" && <ChartWorkspacePanel />}
          {workspace === "trade" && <TradeWorkspacePanel />}
          {workspace === "watchlists" && <WatchlistsWorkspacePanel />}
          {workspace === "scanner" && <ScannerWorkspacePanel />}
          {workspace === "news" && <NewsWorkspacePanel />}
        </div>
      </DecisionCenterProvider>
    </aside>
  );
}