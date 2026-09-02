import { NavLink } from "react-router-dom";

const ITEMS = [
  { to: "/chart", label: "Chart", icon: "⌁" },
  { to: "/scanner", label: "Scanner", icon: "⌕" },
];

export default function MobileAppNav() {
  return (
    <nav className="mobile-app-nav" aria-label="Trading Terminal mobile navigation">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `mobile-app-nav__item${isActive ? " mobile-app-nav__item--active" : ""}`
          }
        >
          <span className="mobile-app-nav__icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
