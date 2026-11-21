import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { RightPanelWorkspace } from "./right-panel/RightPanelTypes";
import type { ChartState } from "./ChartState";
import { getSharedExecutionGateway } from "../../trading/execution/ExecutionGateway";

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
  const [panelWidth, setPanelWidth] = useState(() => {
    try { return Math.max(300, Math.min(650, Number(localStorage.getItem("chartv2.rightPanelWidth")) || 340)); }
    catch { return 340; }
  });
  const [coachZoom, setCoachZoom] = useState(() => {
    try { return Math.max(1, Math.min(1.6, Number(localStorage.getItem("chartv2.coachZoom")) || 1.2)); }
    catch { return 1.2; }
  });
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    try { localStorage.setItem("chartv2.rightPanelWidth", String(panelWidth)); } catch { /* ignored */ }
  }, [panelWidth]);
  useEffect(() => {
    try { localStorage.setItem("chartv2.coachZoom", String(coachZoom)); } catch { /* ignored */ }
  }, [coachZoom]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragStart.current) return;
      setPanelWidth(Math.max(300, Math.min(650, dragStart.current.width + dragStart.current.x - event.clientX)));
    };
    const stop = () => { dragStart.current = null; document.body.style.cursor = ""; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); document.body.style.cursor = ""; };
  }, []);
  const executionGateway = getSharedExecutionGateway();
  const [orderSummary, setOrderSummary] = useState(() => {
    const snapshot = executionGateway.getSnapshot();
    return {
      openOrders: snapshot.openOrders.length,
      positions: snapshot.positions.length,
      mode: executionGateway.getMode(),
    };
  });

  useEffect(() => {
    executionGateway.startPolling(8000);
    return executionGateway.subscribe((snapshot) => {
      setOrderSummary({
        openOrders: snapshot.openOrders.length,
        positions: snapshot.positions.length,
        mode: executionGateway.getMode(),
      });
    });
  }, [executionGateway]);

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
        // RIGHT_PANEL_SCROLL_LOCK_20260904
        width: panelWidth,
        position: "relative",
        flexShrink: 0,
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: "#0b0f14",
        borderLeft: "1px solid rgba(255,255,255,.08)",
        color: "#e5e7eb",
        display: "flex",
        flexDirection: "column",
        zIndex: 25,
      }}
    >
      <div
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragStart.current = { x: event.clientX, width: panelWidth };
          document.body.style.cursor = "col-resize";
        }}
        title="Drag to resize right panel"
        style={{ position: "absolute", width: 7, height: "100%", marginLeft: -4, cursor: "col-resize", zIndex: 30 }}
      />
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

        <button
          type="button"
          onClick={() => setWorkspace("trade")}
          title="Open global Orders Center"
          style={{
            width: "100%",
            margin: "4px 0 7px",
            border: "1px solid rgba(96,165,250,.2)",
            borderRadius: 8,
            background:
              orderSummary.openOrders > 0 || orderSummary.positions > 0
                ? "rgba(37,99,235,.12)"
                : "rgba(15,23,42,.55)",
            color: "#cbd5e1",
            padding: "5px 7px",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            cursor: "pointer",
            fontSize: 9,
            fontWeight: 800,
          }}
        >
          <span>ORDERS {orderSummary.openOrders} WORKING · {orderSummary.positions} POSITION{orderSummary.positions === 1 ? "" : "S"}</span>
          <span style={{ color: orderSummary.mode === "live" ? "#fca5a5" : "#93c5fd" }}>
            {orderSummary.mode.toUpperCase()}
          </span>
        </button>
      </div>

      {workspace === "coach" && (
        <div style={{ display: "flex", gap: 8, padding: "6px 10px", alignItems: "center", color: "#cbd5e1", fontSize: 11 }}>
          <span style={{ fontWeight: 800 }}>Coach text</span>
          <select aria-label="Coach text size" value={coachZoom} onChange={(event) => setCoachZoom(Number(event.target.value))}
            style={{ background: "#162033", color: "#fff", border: "1px solid #334155", borderRadius: 5, padding: "4px 7px" }}>
            <option value={1}>Small</option><option value={1.2}>Medium</option>
            <option value={1.4}>Large</option><option value={1.6}>XL</option>
          </select>
          <button type="button" onClick={() => setPanelWidth(520)}
            style={{ marginLeft: "auto", color: "#bfdbfe", background: "transparent", border: "none", cursor: "pointer" }}>
            Wide
          </button>
        </div>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehavior: "contain",
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

          {workspace === "news" && <NewsWorkspacePanel symbol={symbol} />}

          {workspace === "coach" && <div style={{ zoom: coachZoom }}><CoachWorkspacePanel symbol={symbol} /></div>}

          {workspace === "level2" && <Level2WorkspacePanel symbol={symbol} />}
        </Suspense>
      </div>
    </aside>
  );
}
