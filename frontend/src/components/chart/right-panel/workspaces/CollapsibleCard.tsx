import { useState, type ReactNode } from "react";

type Props = {
  workspace: string;
  id: string;
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
};

/** Hides content without unmounting it, preserving live subscriptions and local form state. */
export default function CollapsibleCard({ workspace, id, title, children, defaultOpen = true }: Props) {
  const key = `trading-terminal.card.${workspace}.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = window.localStorage.getItem(key);
      return saved === null ? defaultOpen : saved === "true";
    } catch { return defaultOpen; }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { window.localStorage.setItem(key, String(next)); } catch { /* storage disabled */ }
  };
  return (
    <section style={{ border: "1px solid rgba(148,163,184,.22)", borderRadius: 11, overflow: "hidden", minWidth: 0 }}>
      <button type="button" aria-expanded={open} onClick={toggle}
        title={`${open ? "Hide" : "Show"} ${title}`}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 9,
          background: "#151d2a", border: 0, color: "#e2e8f0", padding: "9px 11px",
          cursor: "pointer", fontSize: 12, fontWeight: 800, textAlign: "left" }}>
        <span style={{ color: "#93c5fd", fontSize: 15, width: 15, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <span style={{ flex: 1 }}>{title}</span>
      </button>
      <div style={{ display: open ? "block" : "none", minWidth: 0 }} aria-hidden={!open}>
        {children}
      </div>
    </section>
  );
}
