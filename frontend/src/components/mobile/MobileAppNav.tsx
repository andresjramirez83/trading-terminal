import { NavLink, useLocation, useNavigate } from "react-router-dom";

const MOBILE_WORKSPACE_EVENT = "trading-mobile-workspace";

type WorkspaceId = "trade" | "lists" | "news" | "coach" | "level2";

function openWorkspace(workspace: WorkspaceId) {
  window.dispatchEvent(
    new CustomEvent(MOBILE_WORKSPACE_EVENT, {
      detail: { workspace, action: "toggle" },
    }),
  );
}

export default function MobileAppNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const onChart = location.pathname === "/chart";

  function handleWorkspace(workspace: WorkspaceId) {
    if (!onChart) {
      navigate("/chart");
      window.setTimeout(() => openWorkspace(workspace), 80);
      return;
    }

    openWorkspace(workspace);
  }

  return (
    <nav
      className="mobile-app-nav mobile-app-nav--desktop-tabs"
      aria-label="Trading Terminal mobile navigation"
    >
      {/* MOBILE_CHART_TRADE_PHASE18_TYPES */}
      <NavLink
        to="/chart"
        className={({ isActive }) =>
          `mobile-app-nav__item${isActive ? " mobile-app-nav__item--active" : ""}`
        }
      >
        <span>Chart</span>
      </NavLink>

      <button type="button" className="mobile-app-nav__item" onClick={() => handleWorkspace("trade")}>
        <span>Trading</span>
      </button>

      <button type="button" className="mobile-app-nav__item" onClick={() => handleWorkspace("lists")}>
        <span>Lists</span>
      </button>

      <button type="button" className="mobile-app-nav__item" onClick={() => handleWorkspace("news")}>
        <span>News</span>
      </button>

      <button type="button" className="mobile-app-nav__item" onClick={() => handleWorkspace("coach")}>
        <span>Coach</span>
      </button>

      <button type="button" className="mobile-app-nav__item" onClick={() => handleWorkspace("level2")}>
        <span>Level 2</span>
      </button>

      <NavLink
        to="/scanner"
        className={({ isActive }) =>
          `mobile-app-nav__item${isActive ? " mobile-app-nav__item--active" : ""}`
        }
      >
        <span>Scanner</span>
      </NavLink>
    </nav>
  );
}
