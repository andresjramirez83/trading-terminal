import { NavLink, useLocation, useNavigate } from "react-router-dom";

const MOBILE_WORKSPACE_EVENT = "trading-mobile-workspace";

type WorkspaceId = "studies" | "lists" | "trade";

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
    <nav className="mobile-app-nav" aria-label="Trading Terminal mobile navigation">
      <NavLink
        to="/chart"
        className={({ isActive }) =>
          `mobile-app-nav__item${isActive ? " mobile-app-nav__item--active" : ""}`
        }
      >
        <span className="mobile-app-nav__icon" aria-hidden="true">C</span>
        <span>Chart</span>
      </NavLink>

      <button
        type="button"
        className="mobile-app-nav__item"
        onClick={() => handleWorkspace("studies")}
      >
        <span className="mobile-app-nav__icon" aria-hidden="true">S</span>
        <span>Studies</span>
      </button>

      <button
        type="button"
        className="mobile-app-nav__item"
        onClick={() => handleWorkspace("lists")}
      >
        <span className="mobile-app-nav__icon" aria-hidden="true">L</span>
        <span>Lists</span>
      </button>

      <button
        type="button"
        className="mobile-app-nav__item mobile-app-nav__item--trade"
        onClick={() => handleWorkspace("trade")}
      >
        <span className="mobile-app-nav__icon" aria-hidden="true">T</span>
        <span>Trade</span>
      </button>

      <NavLink
        to="/scanner"
        className={({ isActive }) =>
          `mobile-app-nav__item${isActive ? " mobile-app-nav__item--active" : ""}`
        }
      >
        <span className="mobile-app-nav__icon" aria-hidden="true">Q</span>
        <span>Scanner</span>
      </NavLink>
    </nav>
  );
}
