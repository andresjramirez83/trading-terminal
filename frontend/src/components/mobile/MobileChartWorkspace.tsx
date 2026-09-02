import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { StudyVisibility } from "../chart/ChartTypes";
import ChartStudyToggles from "../chart/ChartStudyToggles";

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

export const MOBILE_WORKSPACE_EVENT = "trading-mobile-workspace";

export type MobileWorkspaceId = "studies" | "lists" | "trade";

type Props = {
  symbol: string;
  currentPrice: number;
  studyVisibility: StudyVisibility;
  onStudyVisibilityChange: (visibility: StudyVisibility) => void;
};

type MobileWorkspaceEventDetail = {
  workspace?: MobileWorkspaceId;
  action?: "open" | "close" | "toggle";
};

function LoadingCard() {
  return <div className="mobile-workspace-loading">Loading...</div>;
}

export default function MobileChartWorkspace({
  symbol,
  currentPrice,
  studyVisibility,
  onStudyVisibilityChange,
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
      case "studies":
        return "Studies";
      case "lists":
        return "Watchlists";
      case "trade":
        return `Trade - ${symbol || "-"}`;
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
            {workspace === "studies" && (
              <div className="mobile-studies-shell">
                <div className="mobile-studies-copy">
                  Same chart studies as desktop. Changes apply immediately.
                </div>
                <ChartStudyToggles
                  visibility={studyVisibility}
                  onChange={onStudyVisibilityChange}
                />
              </div>
            )}

            {workspace === "lists" && <WatchlistsWorkspacePanel />}

            {workspace === "trade" && (
              <TradingWorkspacePanel
                symbol={symbol}
                currentPrice={currentPrice}
              />
            )}
          </Suspense>
        </div>
      </section>
    </div>
  );
}
