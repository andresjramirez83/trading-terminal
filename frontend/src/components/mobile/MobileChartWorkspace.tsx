import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useState,
} from "react";

const TradingWorkspacePanel = lazy(
  () =>
    import(
      "../chart/right-panel/workspaces/trading/TradingWorkspacePanel"
    ),
);

const WatchlistsWorkspacePanel = lazy(
  () =>
    import(
      "../chart/right-panel/workspaces/WatchlistsWorkspacePanel"
    ),
);

const NewsWorkspacePanel = lazy(
  () => import("../chart/right-panel/workspaces/NewsWorkspacePanel"),
);

const CoachWorkspacePanel = lazy(
  () => import("../chart/right-panel/workspaces/CoachWorkspacePanel"),
);

const Level2WorkspacePanel = lazy(
  () => import("../chart/right-panel/workspaces/Level2WorkspacePanel"),
);

export const MOBILE_WORKSPACE_EVENT = "trading-mobile-workspace";

export type MobileWorkspaceId = "trade" | "lists" | "news" | "coach" | "level2";

type Props = {
  symbol: string;
  currentPrice: number;
};

type MobileWorkspaceEventDetail = {
  workspace?: MobileWorkspaceId;
  action?: "open" | "close" | "toggle";
};

function LoadingCard() {
  return <div className="mobile-workspace-loading">Loading...</div>;
}

// MOBILE_BOTTOM_TABS_PHASE17
export default function MobileChartWorkspace({
  symbol,
  currentPrice,
}: Props) {
  const [workspace, setWorkspace] =
    useState<MobileWorkspaceId | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<MobileWorkspaceEventDetail>).detail;
      const target = detail?.workspace;
      const action = detail?.action ?? "toggle";

      if (action === "close" || !target) {
        setWorkspace(null);
        return;
      }

      if (action === "open") {
        setWorkspace(target);
        return;
      }

      setWorkspace((current) => (current === target ? null : target));
    };

    window.addEventListener(MOBILE_WORKSPACE_EVENT, handler);
    return () => window.removeEventListener(MOBILE_WORKSPACE_EVENT, handler);
  }, []);

  const title = useMemo(() => {
    switch (workspace) {
      case "trade":
        return `Trading - ${symbol || "-"}`;
      case "lists":
        return "Lists";
      case "news":
        return `News - ${symbol || "-"}`;
      case "coach":
        return `Coach - ${symbol || "-"}`;
      case "level2":
        return `Level 2 - ${symbol || "-"}`;
      default:
        return "";
    }
  }, [workspace, symbol]);

  if (!workspace) return null;

  return (
    <div className="mobile-workspace-layer" role="presentation">
      <button
        type="button"
        className="mobile-workspace-backdrop"
        aria-label="Close mobile workspace"
        onClick={() => setWorkspace(null)}
      />

      <section
        className={`mobile-workspace-sheet mobile-workspace-sheet--${workspace}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="mobile-workspace-header">
          <div>
            <div className="mobile-workspace-kicker">Trading Terminal</div>
            <div className="mobile-workspace-title">{title}</div>
          </div>

          <button
            type="button"
            className="mobile-workspace-close"
            onClick={() => setWorkspace(null)}
            aria-label="Close"
          >
            x
          </button>
        </header>

        <div className="mobile-workspace-body">
          <Suspense fallback={<LoadingCard />}>

            {workspace === "lists" && <WatchlistsWorkspacePanel />}

            {workspace === "news" && <NewsWorkspacePanel symbol={symbol} />}

            {workspace === "coach" && <CoachWorkspacePanel symbol={symbol} />}

            {workspace === "level2" && <Level2WorkspacePanel symbol={symbol} />}

            {workspace === "trade" && (
              <>
                <button
                  type="button"
                  className="mobile-chart-trade-launch"
                  onClick={() => {
                    setWorkspace(null);
                    window.setTimeout(() => {
                      window.dispatchEvent(
                        new CustomEvent("trading-mobile-chart-trade", {
                          detail: { action: "start" },
                        }),
                      );
                    }, 40);
                  }}
                >
                  <span className="mobile-chart-trade-launch__title">
                    Chart Trade
                  </span>
                  <span className="mobile-chart-trade-launch__copy">
                    Set entry, stop and target with the chart crosshair.
                  </span>
                </button>

                <TradingWorkspacePanel
                  symbol={symbol}
                  currentPrice={currentPrice}
                />
              </>
            )}
          </Suspense>
        </div>
      </section>
    </div>
  );
}
