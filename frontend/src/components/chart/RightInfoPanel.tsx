import { Suspense, lazy, useState } from "react";
import type { RightPanelWorkspace } from "./right-panel/RightPanelTypes";
import type { ChartState } from "./ChartState";

const ChartWorkspacePanel = lazy(
  () => import("./right-panel/workspaces/ChartWorkspacePanel"),
);
const TradingWorkspacePanel = lazy(
  () =>
    import(
      "./right-panel/workspaces/trading/TradingWorkspacePanel"
    ),
);
const WatchlistsWorkspacePanel = lazy(
  () => import("./right-panel/workspaces/WatchlistsWorkspacePanel"),
);
const ScannerWorkspacePanel = lazy(
  () => import("./right-panel/workspaces/ScannerWorkspacePanel"),
);
const NewsWorkspacePanel = lazy(
  () => import("./right-panel/workspaces/NewsWorkspacePanel"),
);
const CoachWorkspacePanel = lazy(
  () => import("./right-panel/workspaces/CoachWorkspacePanel"),
);
const Level2WorkspacePanel = lazy(
  () => import("./right-panel/workspaces/Level2WorkspacePanel"),
);
const DecisionCenterProvider = lazy(() =>
  import("./right-panel/DecisionCenterContext").then((module) => ({
    default: module.DecisionCenterProvider,
  })),
);

type Props = {
  symbol: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  chartState?: ChartState | null;
};

const WORKSPACES: { id: RightPanelWorkspace; label: string }[] = [
  { id: "trade", label: "Trading" },
  { id: "watchlists", label: "Lists" },
  { id: "chart", label: "Chart" },
  { id: "scanner", label: "Scanner" },
  { id: "news", label: "News" },
  { id: "coach", label: "Coach" },
  { id: "level2", label: "Level 2" },
];

function WorkspaceLoading() {
  return (
    <div
      style={{
        minHeight: 92,
        display: "grid",
        placeItems: "center",
        border: "1px solid rgba(148,163,184,.14)",
        borderRadius: 10,
        background: "rgba(15,23,42,.45)",
        color: "#94a3b8",
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      Loading workspace…
    </div>
  );
}

export default function RightInfoPanel({
  symbol,
  collapsed,
  onToggleCollapsed,
  chartState,
}: Props) {
  const [workspace, setWorkspace] = useState<RightPanelWorkspace>("trade");

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
            gap: 9,
            height: 34,
            minWidth: 0,
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

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 34,
              flex: 1,
              minWidth: 0,
              overflowX: "auto",
              overflowY: "hidden",
              scrollbarWidth: "none",
            }}
          >
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
                    flexShrink: 0,
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 10,
        }}
      >
        <Suspense fallback={<WorkspaceLoading />}>
          {workspace === "chart" && (
            <DecisionCenterProvider chartState={chartState}>
              <ChartWorkspacePanel />
            </DecisionCenterProvider>
          )}

          {workspace === "trade" && (
            <TradingWorkspacePanel
              symbol={symbol}
              currentPrice={chartState?.price ?? 0}
            />
          )}

          {workspace === "watchlists" && <WatchlistsWorkspacePanel />}

          {workspace === "scanner" && <ScannerWorkspacePanel />}

          {workspace === "news" && <NewsWorkspacePanel symbol={symbol} />}

          {workspace === "coach" && <CoachWorkspacePanel symbol={symbol} />}

          {workspace === "level2" && <Level2WorkspacePanel symbol={symbol} />}
        </Suspense>
      </div>
    </aside>
  );
}
