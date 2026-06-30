import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { fetchSharedAlpacaState } from "../../../../services/api";
import { useActiveSymbol } from "../../ActiveSymbolContext";
import {
  useWatchlists,
  type WatchlistType,
  type WatchlistSymbolTone,
} from "../../../watchlists/WatchlistContext";

type SymbolTone = WatchlistSymbolTone;

const MANUAL_WATCHLIST_STORAGE_KEYS = [
  "watchlist", // Legacy ScannerPage source of truth
  "manualWatchlist",
  "alpacaManualWatchlist",
  "terminalManualWatchlist",
  "sharedManualWatchlist",
  "trading.manual.watchlist",
];
const MANUAL_WATCHLIST_STORAGE_KEY = "watchlist";

function normalizeWorkspaceSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "");
}

function uniqueWorkspaceSymbols(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const symbol = normalizeWorkspaceSymbol(value);

    if (!symbol || seen.has(symbol)) {
      continue;
    }

    seen.add(symbol);
    out.push(symbol);
  }

  return out;
}

function extractSymbolsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueWorkspaceSymbols(value);
  }

  if (value && typeof value === "object") {
    const data = value as Record<string, unknown>;
    const possibleLists = [
      data.manualWatchlist,
      data.symbols,
      data.watchlist,
      data.manualSymbols,
      data.selectedSymbols,
    ];

    for (const possibleList of possibleLists) {
      const symbols = extractSymbolsFromUnknown(possibleList);
      if (symbols.length) {
        return symbols;
      }
    }
  }

  if (typeof value === "string") {
    return uniqueWorkspaceSymbols(value.split(/[\s,;]+/));
  }

  return [];
}

function readLegacyManualWatchlist(): string[] | null {
  if (typeof window === "undefined") {
    return null;
  }

  for (const key of MANUAL_WATCHLIST_STORAGE_KEYS) {
    try {
      const raw = window.localStorage.getItem(key);

      if (raw === null) {
        continue;
      }

      let parsed: unknown = raw;

      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }

      return extractSymbolsFromUnknown(parsed);
    } catch {
      // Ignore individual bad legacy keys.
    }
  }

  return null;
}

function writeLegacyManualWatchlist(symbols: string[]) {
  if (typeof window === "undefined") {
    return;
  }

  const cleaned = uniqueWorkspaceSymbols(symbols);

  for (const key of MANUAL_WATCHLIST_STORAGE_KEYS) {
    try {
      window.localStorage.setItem(key, JSON.stringify(cleaned));
    } catch {
      // Local persistence should never break the panel.
    }
  }
}

function isManualWorkspaceWatchlist(watchlist: { id?: string; name?: string; type?: string } | null | undefined): boolean {
  const id = String(watchlist?.id ?? "").toLowerCase();
  const name = String(watchlist?.name ?? "").toLowerCase();
  const type = String(watchlist?.type ?? "").toLowerCase();

  return type === "manual" || id.includes("manual") || name.includes("manual");
}

const styles: Record<string, CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 10,
    color: "#e5e7eb",
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  },
  card: {
    border: "1px solid #262b33",
    background: "#0d1117",
    borderRadius: 12,
    overflow: "hidden",
  },
  cardHeader: {
    padding: "9px 10px",
    borderBottom: "1px solid #202630",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: "#8b949e",
  },
  cardBody: {
    padding: 10,
  },
  select: {
    width: "100%",
    height: 34,
    border: "1px solid #27313d",
    background: "#080b10",
    color: "#f8fafc",
    borderRadius: 8,
    padding: "0 10px",
    fontSize: 12,
    fontWeight: 800,
    outline: "none",
    cursor: "pointer",
  },
  actionRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 7,
    marginTop: 8,
  },
  actionButton: {
    height: 28,
    border: "1px solid #27313d",
    background: "#080b10",
    color: "#cbd5e1",
    borderRadius: 8,
    fontSize: 10,
    fontWeight: 900,
    cursor: "pointer",
  },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 7,
  },
  statBox: {
    border: "1px solid #252a32",
    background: "#080b10",
    borderRadius: 9,
    padding: "8px 9px",
  },
  statValue: {
    fontSize: 17,
    lineHeight: "18px",
    fontWeight: 950,
    color: "#ffffff",
  },
  statLabel: {
    marginTop: 4,
    fontSize: 9,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "#6b7280",
  },
  table: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  tableHeader: {
    display: "grid",
    gridTemplateColumns: "28px 1fr 52px 58px",
    gap: 7,
    padding: "0 8px 5px",
    fontSize: 9,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "#64748b",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "28px 1fr 52px 58px",
    gap: 7,
    alignItems: "center",
    width: "100%",
    border: "1px solid #202630",
    background: "#080b10",
    borderRadius: 9,
    padding: "8px",
    color: "#e5e7eb",
    cursor: "pointer",
    textAlign: "left",
  },
  emptyState: {
    border: "1px dashed #334155",
    background: "#080b10",
    borderRadius: 10,
    padding: 14,
    fontSize: 12,
    lineHeight: "18px",
    color: "#8b949e",
    textAlign: "center",
  },
};

function getToneColors(tone: SymbolTone): {
  color: string;
  background: string;
  border: string;
} {
  if (tone === "ready") {
    return {
      color: "#6ee7b7",
      background: "rgba(6, 78, 59, 0.35)",
      border: "#047857",
    };
  }

  if (tone === "weak") {
    return {
      color: "#fca5a5",
      background: "rgba(69, 10, 10, 0.35)",
      border: "#991b1b",
    };
  }

  return {
    color: "#fcd34d",
    background: "rgba(69, 26, 3, 0.35)",
    border: "#b45309",
  };
}

function getTypeLabel(type: WatchlistType): string {
  if (type === "scanner") return "Scanner";
  if (type === "manual") return "Manual";
  return "Custom";
}


export default function WatchlistsWorkspacePanel() {
  const { activeSymbol, setActiveSymbol } = useActiveSymbol();
  const {
    watchlists,
    activeWatchlist,
    activeWatchlistId,
    setActiveWatchlist,
    createWatchlist,
    renameWatchlist,
    deleteWatchlist,
  } = useWatchlists();

  const [legacyManualSymbols, setLegacyManualSymbols] = useState<string[] | null>(() =>
    readLegacyManualWatchlist()
  );

  const selectedWatchlist = activeWatchlist ?? watchlists[0];
  const selectedIsManual = isManualWorkspaceWatchlist(selectedWatchlist);

  const syncLegacyManualSymbols = useCallback((nextSymbols?: unknown) => {
    const incoming =
      nextSymbols === undefined
        ? readLegacyManualWatchlist()
        : extractSymbolsFromUnknown(nextSymbols);

    if (incoming === null) {
      return;
    }

    const next = uniqueWorkspaceSymbols(incoming);

    setLegacyManualSymbols((prev) => {
      if (
        prev !== null &&
        prev.length === next.length &&
        prev.every((item, index) => item === next[index])
      ) {
        return prev;
      }

      writeLegacyManualWatchlist(next);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshRemoteManualSymbols() {
      try {
        const remote = await fetchSharedAlpacaState();
        if (cancelled || !remote) {
          return;
        }

        if (Object.prototype.hasOwnProperty.call(remote as any, "manualWatchlist")) {
          syncLegacyManualSymbols((remote as any).manualWatchlist);
        }
      } catch {
        // Remote sync should never break the watchlist panel.
      }
    }

    function refreshAllManualSymbols() {
      syncLegacyManualSymbols();
      void refreshRemoteManualSymbols();
    }

    function handleManualWatchlistEvent(event: Event) {
      syncLegacyManualSymbols((event as CustomEvent<unknown>).detail);
    }

    function handleStorage(event: StorageEvent) {
      if (event.key && !MANUAL_WATCHLIST_STORAGE_KEYS.includes(event.key)) {
        return;
      }

      if (event.newValue) {
        try {
          syncLegacyManualSymbols(JSON.parse(event.newValue));
          return;
        } catch {
          syncLegacyManualSymbols(event.newValue);
          return;
        }
      }

      syncLegacyManualSymbols();
    }

    window.addEventListener("manual-watchlist-change", handleManualWatchlistEvent);
    window.addEventListener("scanner-watchlist-change", handleManualWatchlistEvent);
    window.addEventListener("alpaca-manual-watchlist-change", handleManualWatchlistEvent);
    window.addEventListener("shared-manual-watchlist-change", handleManualWatchlistEvent);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", refreshAllManualSymbols);
    document.addEventListener("visibilitychange", refreshAllManualSymbols);

    refreshAllManualSymbols();

    const intervalId = window.setInterval(refreshAllManualSymbols, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("manual-watchlist-change", handleManualWatchlistEvent);
      window.removeEventListener("scanner-watchlist-change", handleManualWatchlistEvent);
      window.removeEventListener("alpaca-manual-watchlist-change", handleManualWatchlistEvent);
      window.removeEventListener("shared-manual-watchlist-change", handleManualWatchlistEvent);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", refreshAllManualSymbols);
      document.removeEventListener("visibilitychange", refreshAllManualSymbols);
    };
  }, [syncLegacyManualSymbols]);

  const displaySymbols = useMemo(() => {
    const baseSymbols = selectedWatchlist?.symbols ?? [];

    if (!selectedIsManual) {
      return baseSymbols;
    }

    if (legacyManualSymbols === null) {
      return baseSymbols;
    }

    return legacyManualSymbols.map((symbol) => ({
      symbol,
      score: 0,
      tone: "watch" as SymbolTone,
      setup: "Manual",
      note: "Legacy manual watchlist",
    }));
  }, [legacyManualSymbols, selectedIsManual, selectedWatchlist?.symbols]);

  const sortedSymbols = useMemo(() => {
    return [...displaySymbols].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0)
    );
  }, [displaySymbols]);

  const readyCount = displaySymbols.filter(
    (item) => item.tone === "ready"
  ).length;

  const weakCount = displaySymbols.filter(
    (item) => item.tone === "weak"
  ).length;

  const averageScore =
    displaySymbols.length === 0
      ? 0
      : Math.round(
          displaySymbols.reduce(
            (total, item) => total + (item.score ?? 0),
            0
          ) / displaySymbols.length
        );

  function handleCreateWatchlist() {
    const name = window.prompt("New watchlist name:");

    if (!name?.trim()) {
      return;
    }

    createWatchlist(name.trim(), "custom");
  }

  function handleRenameWatchlist() {
    if (!selectedWatchlist) return;

    const name = window.prompt("Rename watchlist:", selectedWatchlist.name);

    if (!name?.trim()) {
      return;
    }

    renameWatchlist(selectedWatchlist.id, name.trim());
  }

  function handleDeleteWatchlist() {
    if (!selectedWatchlist) return;

    if (watchlists.length <= 1) {
      window.alert("You need at least one watchlist.");
      return;
    }

    const confirmed = window.confirm(
      `Delete "${selectedWatchlist.name}"? This will remove the watchlist from this workspace.`
    );

    if (!confirmed) {
      return;
    }

    deleteWatchlist(selectedWatchlist.id);
  }

  function handleSymbolSelect(symbol: string) {
    setActiveSymbol(symbol, "watchlist");
  }

  return (
    <div style={styles.panel}>
      <Card
        title="Watchlist"
        right={
          <Badge
            color="#67e8f9"
            background="rgba(8, 47, 73, 0.45)"
            border="#0891b2"
          >
            {getTypeLabel(selectedWatchlist?.type ?? "custom")}
          </Badge>
        }
      >
        <select
          value={selectedWatchlist?.id ?? activeWatchlistId}
          onChange={(event) => setActiveWatchlist(event.target.value)}
          style={styles.select}
        >
          {watchlists.map((watchlist) => (
            <option key={watchlist.id} value={watchlist.id}>
              {watchlist.name}
            </option>
          ))}
        </select>

        <div style={styles.actionRow}>
          <button
            type="button"
            onClick={handleCreateWatchlist}
            style={{
              ...styles.actionButton,
              borderColor: "#047857",
              color: "#6ee7b7",
            }}
          >
            + New
          </button>

          <button
            type="button"
            onClick={handleRenameWatchlist}
            style={styles.actionButton}
          >
            Rename
          </button>

          <button
            type="button"
            onClick={handleDeleteWatchlist}
            style={{
              ...styles.actionButton,
              borderColor: "#7f1d1d",
              color: "#fca5a5",
            }}
          >
            Delete
          </button>
        </div>
      </Card>

      <Card title="Opportunity Summary">
        <div style={styles.statGrid}>
          <Stat label="Symbols" value={displaySymbols.length} />
          <Stat label="Ready" value={readyCount} good />
          <Stat label="Avg" value={averageScore} />
        </div>

        <div
          style={{
            marginTop: 8,
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            fontSize: 11,
            color: "#8b949e",
          }}
        >
          <span>{selectedWatchlist?.description ?? ""}</span>
          <span style={{ color: weakCount > 0 ? "#fca5a5" : "#6b7280" }}>
            Weak {weakCount}
          </span>
        </div>
      </Card>

      <Card
        title="Ranked Opportunities"
        right={
          <span
            style={{
              fontSize: 10,
              fontWeight: 900,
              color: "#6ee7b7",
              textTransform: "uppercase",
              letterSpacing: 0.6,
            }}
          >
            Live Link
          </span>
        }
      >
        {sortedSymbols.length === 0 ? (
          <div style={styles.emptyState}>
            This watchlist is empty. Scanner-generated lists and manual symbols will populate here automatically.
          </div>
        ) : (
          <div style={styles.table}>
            <div style={styles.tableHeader}>
              <div>#</div>
              <div>Symbol</div>
              <div>Score</div>
              <div>Status</div>
            </div>

            {sortedSymbols.map((item, index) => {
              const selected =
                activeSymbol.toUpperCase() === item.symbol.toUpperCase();
              const tone = getToneColors(item.tone);

              return (
                <button
                  key={item.symbol}
                  type="button"
                  onClick={() => handleSymbolSelect(item.symbol)}
                  style={{
                    ...styles.row,
                    border: selected
                      ? "1px solid #22d3ee"
                      : styles.row.border,
                    background: selected
                      ? "rgba(8, 47, 73, 0.55)"
                      : styles.row.background,
                    boxShadow: selected
                      ? "0 0 0 1px rgba(34, 211, 238, 0.12) inset"
                      : "none",
                  }}
                >
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 999,
                      border: "1px solid #27313d",
                      background: selected ? "#083344" : "#111827",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      fontWeight: 950,
                      color: selected ? "#67e8f9" : "#9ca3af",
                    }}
                  >
                    {index + 1}
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 950,
                          color: "#fff",
                          letterSpacing: 0.2,
                        }}
                      >
                        {item.symbol}
                      </span>

                      {selected ? (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 900,
                            color: "#67e8f9",
                          }}
                        >
                          ACTIVE
                        </span>
                      ) : null}
                    </div>

                    <div
                      style={{
                        marginTop: 2,
                        fontSize: 10,
                        color: "#8b949e",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.setup ?? "Watchlist"} · {item.note ?? ""}
                    </div>
                  </div>

                  <div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 950,
                        color:
                          (item.score ?? 0) >= 70
                            ? "#6ee7b7"
                            : (item.score ?? 0) <= 45
                              ? "#fca5a5"
                              : "#e5e7eb",
                        textAlign: "right",
                      }}
                    >
                      {item.score ?? 0}
                    </div>
                    <div
                      style={{
                        marginTop: 3,
                        height: 4,
                        borderRadius: 999,
                        overflow: "hidden",
                        background: "#252a32",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.max(0, Math.min(100, item.score ?? 0))}%`,
                          borderRadius: 999,
                          background:
                            (item.score ?? 0) >= 70
                              ? "#22c55e"
                              : (item.score ?? 0) <= 45
                                ? "#ef4444"
                                : "#22d3ee",
                        }}
                      />
                    </div>
                  </div>

                  <Badge
                    color={tone.color}
                    background={tone.background}
                    border={tone.border}
                  >
                    {item.tone}
                  </Badge>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Routing">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 7,
          }}
        >
          <RoutePill label="Chart" value={activeSymbol} good />
          <RoutePill label="Decision" value="Linked" good />
          <RoutePill label="Scanner" value="Ready" good />
          <RoutePill label="Trading" value="Next" />
        </div>
      </Card>
    </div>
  );
}

function Card({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={styles.cardTitle}>{title}</div>
        {right}
      </div>

      <div style={styles.cardBody}>{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  good = false,
}: {
  label: string;
  value: number | string;
  good?: boolean;
}) {
  return (
    <div style={styles.statBox}>
      <div
        style={{
          ...styles.statValue,
          color: good ? "#6ee7b7" : styles.statValue.color,
        }}
      >
        {value}
      </div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

function Badge({
  color,
  background,
  border,
  children,
}: {
  color: string;
  background: string;
  border: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${border}`,
        background,
        color,
        borderRadius: 999,
        padding: "3px 7px",
        fontSize: 8,
        fontWeight: 950,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

function RoutePill({
  label,
  value,
  good = false,
}: {
  label: string;
  value: number | string;
  good?: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid #252a32",
        background: "#080b10",
        borderRadius: 9,
        padding: 9,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          color: "#6b7280",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 12,
          fontWeight: 950,
          color: good ? "#6ee7b7" : "#e5e7eb",
        }}
      >
        {value}
      </div>
    </div>
  );
}