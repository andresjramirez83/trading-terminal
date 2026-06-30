import React, { useEffect, useMemo, useRef, useState } from "react";
import { useActiveSymbol } from "./chart/ActiveSymbolContext";
import { useWatchlists } from "./watchlists/WatchlistContext";

import {
  fetchOvernightSnapshots,
  fetchScannerCache,
  fetchScannerDefinitions,
  refreshScannerCache,
  saveAfterhoursSnapshot,
  fetchSelectedAlertSymbols,
  saveSelectedAlertSymbols,
  toggleSelectedAlertSymbol,
  type ScannerCacheResponse,
} from "../services/api";

type ScannerPanelProps = {
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onWatchlistChange?: (symbols: string[]) => void;
  mode?: "sidebar" | "workspace";
};

type Workflow = "auto" | "combined" | "live";
type RunnerTypeFilter = "all" | "momentum" | "overnight";
type PresetKey = "custom" | "early" | "breakout" | "momentum" | "lowfloat";

type ScannerDefinition = {
  id: string;
  name: string;
  description?: string;
};

type ScannerMeta = {
  latest_saved_ah_date?: string | null;
  snapshot_dates?: string[];
  ah_trade_date?: string | null;
  candidate_count?: number;
  workflow_requested?: string;
  workflow_resolved?: string;
  workflow_auto_rule?: string;
  runner_type_counts?: {
    momentum?: number;
    overnight?: number;
  };
  active_filters?: Record<string, unknown>;
  combined_fallback?: boolean;
  combined_fallback_reason?: string;
};

type ScannerRow = {
  symbol: string;
  runner_type?: string;
  price?: number;
  change_pct?: number;
  volume?: number;
  range_pct?: number;
  score?: number;
  last_price?: number;
  prev_close?: number;
  ah_gap_pct?: number;
  ah_range_pct?: number;
  ah_volume?: number;
  ah_dollar_volume?: number;
  ah_score?: number;
  pm_gap_pct?: number;
  gap_pct?: number;
  pm_volume?: number;
  pm_dollar_volume?: number;
  pm_range_pct?: number;
  compression_score?: number;
  breakout_score?: number;
  volume_accel_pct?: number;
  runner_score?: number;
  pm_runner_score?: number;
  float_shares?: number | null;
  short_interest_pct?: number | null;
  short_interest_rank?: number | null;
  turnover_pct?: number | null;
  turnover_rank?: number | null;
  squeeze_rank?: number | null;
  has_saved_ah?: boolean;
  notes?: string[];
  source?: string;
};

type ScannerResponse = {
  scanner_id?: string;
  scanner_name?: string;
  description?: string;
  workflow?: string;
  trade_day?: string;
  count?: number;
  rows?: ScannerRow[];
  meta?: ScannerMeta;
};

type SnapshotResponse =
  | string[]
  | { snapshot_dates?: string[]; dates?: string[]; latest?: string | null };

function formatVolume(value?: number | null): string {
  const safe = value ?? 0;
  if (safe >= 1_000_000_000) return `${(safe / 1_000_000_000).toFixed(2)}B`;
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(2)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}K`;
  return String(Math.round(safe));
}

function formatMaybe(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "-";
  return value.toFixed(digits);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeWatchlistId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function titleCaseWatchlistName(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "Scanner";

  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getScannerRowScore(row: ScannerRow): number {
  const score = Number(
    row.score ??
      row.ah_score ??
      row.runner_score ??
      row.pm_runner_score ??
      row.compression_score ??
      row.breakout_score ??
      row.squeeze_rank ??
      0
  );

  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function getScannerRowTone(score: number): "ready" | "watch" | "weak" {
  if (score >= 70) return "ready";
  if (score <= 45) return "weak";
  return "watch";
}

function buildWatchlistSymbol(row: ScannerRow) {
  const symbol = normalizeSymbol(row.symbol);
  const score = getScannerRowScore(row);
  const setup = titleCaseWatchlistName(row.runner_type ?? row.source ?? "Scanner");

  return {
    symbol,
    score,
    tone: getScannerRowTone(score),
    setup,
    scanner: setup,
    note: row.notes?.join(" · ") ?? "",
    lastPrice: row.last_price ?? row.price,
    percentChange: row.pm_gap_pct ?? row.gap_pct ?? row.change_pct,
    volume: row.pm_volume ?? row.ah_volume ?? row.volume,
    source: String(row.source ?? row.runner_type ?? "scanner"),
  };
}

function dedupeScannerRows(items: ScannerRow[]): ScannerRow[] {
  const seen = new Set<string>();
  const unique: ScannerRow[] = [];

  for (const item of items) {
    const symbol = normalizeSymbol(item.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push({ ...item, symbol });
  }

  return unique;
}

function normalizeSnapshotInfo(raw: SnapshotResponse): {
  dates: string[];
  latest: string;
} {
  if (Array.isArray(raw)) {
    return { dates: raw, latest: raw[0] ?? "" };
  }
  const dates = raw?.snapshot_dates ?? raw?.dates ?? [];
  const latest = raw?.latest ?? dates[0] ?? "";
  return { dates, latest };
}

const SCANNER_AUTO_REFRESH_STORAGE_KEY = "scannerPanel.autoRefresh.v1";
const SCANNER_REFRESH_SECONDS_STORAGE_KEY = "scannerPanel.refreshSeconds.v1";
const SCANNER_SELECTED_ID_STORAGE_KEY = "scannerPanel.selectedScannerId.v1";
const BACKEND_ALERT_SELECTED_SYMBOLS_STORAGE_KEY =
  "backendAlertSelectedSymbols";

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true" || raw === "1" || raw === "yes";
  } catch {
    return fallback;
  }
}

function readStoredNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  } catch {
    return fallback;
  }
}

function readStoredString(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw && raw.trim() ? raw.trim() : fallback;
  } catch {
    return fallback;
  }
}

function readStoredAlertSymbols(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(
      BACKEND_ALERT_SELECTED_SYMBOLS_STORAGE_KEY,
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(parsed.map((item) => normalizeSymbol(item)).filter(Boolean)),
    );
  } catch {
    return [];
  }
}

function writeStoredAlertSymbols(symbols: string[]) {
  if (typeof window === "undefined") return;
  const clean = Array.from(
    new Set(symbols.map((item) => normalizeSymbol(item)).filter(Boolean)),
  );
  window.localStorage.setItem(
    BACKEND_ALERT_SELECTED_SYMBOLS_STORAGE_KEY,
    JSON.stringify(clean),
  );
  window.dispatchEvent(
    new CustomEvent<string[]>("backend-alert-symbols-change", {
      detail: clean,
    }),
  );
}

export default function ScannerPanel({
  selectedSymbol,
  onSelectSymbol,
  onWatchlistChange,
  mode = "sidebar",
}: ScannerPanelProps) {
  const isWorkspace = mode === "workspace";
  const { activeSymbol, setActiveSymbol } = useActiveSymbol();
  const { replaceSymbols } = useWatchlists();
  const currentSelectedSymbol = normalizeSymbol(selectedSymbol || activeSymbol);

  const [definitions, setDefinitions] = useState<ScannerDefinition[]>([]);
  const [selectedScannerId, setSelectedScannerId] = useState(() =>
    readStoredString(SCANNER_SELECTED_ID_STORAGE_KEY, "overnight_runner"),
  );
  const [data, setData] = useState<ScannerResponse | null>(null);
  const [snapshotDates, setSnapshotDates] = useState<string[]>([]);
  const [latestSnapshot, setLatestSnapshot] = useState("");

  const [loading, setLoading] = useState(false);
  const [savingAh, setSavingAh] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [cacheStatus, setCacheStatus] = useState<ScannerCacheResponse | null>(
    null,
  );
  const [armedAlertSymbols, setArmedAlertSymbols] = useState<Set<string>>(
    () => new Set(),
  );
  const [alertSymbolsLoading, setAlertSymbolsLoading] = useState(false);

  const [autoRefresh, setAutoRefresh] = useState(() =>
    readStoredBoolean(SCANNER_AUTO_REFRESH_STORAGE_KEY, false),
  );
  const [refreshSeconds, setRefreshSeconds] = useState(() =>
    readStoredNumber(SCANNER_REFRESH_SECONDS_STORAGE_KEY, 20, 5, 300),
  );

  const [workflow, setWorkflow] = useState<Workflow>("auto");
  const [ahDate, setAhDate] = useState("");
  const [runnerTypeFilter, setRunnerTypeFilter] =
    useState<RunnerTypeFilter>("all");
  const [preset, setPreset] = useState<PresetKey>("custom");

  const [maxSymbols, setMaxSymbols] = useState(25);
  const [minPrice, setMinPrice] = useState(0.5);
  const [maxPrice, setMaxPrice] = useState(20);
  const [minVolume, setMinVolume] = useState(500_000);
  const [minGapPct, setMinGapPct] = useState(3);
  const [minPmRangePct, setMinPmRangePct] = useState(4.5);
  const [minPmDollarVolume, setMinPmDollarVolume] = useState(500_000);
  const [minAhDollarVolume, setMinAhDollarVolume] = useState(100_000);
  const [hoursBack, setHoursBack] = useState(96);
  const [minCompressionScore, setMinCompressionScore] = useState(0);
  const [minBreakoutScore, setMinBreakoutScore] = useState(0);
  const [maxFloatShares, setMaxFloatShares] = useState<string>("");
  const [lowFloatOnly, setLowFloatOnly] = useState(false);

  const [sortKey, setSortKey] = useState<keyof ScannerRow>("runner_score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const lastPushedWatchlistRef = useRef<string[]>([]);

  const selectedDefinition = useMemo(
    () => definitions.find((item) => item.id === selectedScannerId) ?? null,
    [definitions, selectedScannerId],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      SCANNER_AUTO_REFRESH_STORAGE_KEY,
      String(autoRefresh),
    );
  }, [autoRefresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      SCANNER_REFRESH_SECONDS_STORAGE_KEY,
      String(refreshSeconds),
    );
  }, [refreshSeconds]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      SCANNER_SELECTED_ID_STORAGE_KEY,
      selectedScannerId,
    );
  }, [selectedScannerId]);

  async function loadDefinitions() {
    try {
      const result = (await fetchScannerDefinitions()) as ScannerDefinition[];
      setDefinitions(result ?? []);
      if (
        result?.length &&
        !result.some((item) => item.id === selectedScannerId)
      ) {
        setSelectedScannerId(result[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scanners");
    }
  }

  async function loadSnapshots(nextScannerId?: string) {
    if (!isWorkspace) return;
    try {
      const raw = (await fetchOvernightSnapshots(
        nextScannerId ?? selectedScannerId,
      )) as SnapshotResponse;
      const info = normalizeSnapshotInfo(raw);
      setSnapshotDates(info.dates);
      setLatestSnapshot(info.latest);
      setAhDate((current) => current || info.latest || "");
    } catch {
      setSnapshotDates([]);
      setLatestSnapshot("");
    }
  }

  const refreshArmedAlertSymbols = async () => {
    setAlertSymbolsLoading(true);
    try {
      const payload = await fetchSelectedAlertSymbols();
      const remoteSymbols = Array.from(
        new Set(
          (payload.symbols || [])
            .map((item) => normalizeSymbol(item))
            .filter(Boolean),
        ),
      );
      // Backend selected-symbols endpoint is the source of truth.
      // Empty means empty. Never restore old localStorage symbols back to backend.
      setArmedAlertSymbols(new Set(remoteSymbols));
      writeStoredAlertSymbols(remoteSymbols);
    } catch (exc) {
      console.error("Failed to fetch selected alert symbols", exc);
      // Do not fall back to localStorage here; stale browser symbols were the cause
      // of unwanted alerts being resurrected. Keep current UI state until backend responds.
    } finally {
      setAlertSymbolsLoading(false);
    }
  };

  useEffect(() => {
    refreshArmedAlertSymbols();

    const handleStorage = (event: StorageEvent) => {
      if (event.key === BACKEND_ALERT_SELECTED_SYMBOLS_STORAGE_KEY)
        refreshArmedAlertSymbols();
    };

    const handleCustom = (event: Event) => {
      const detail = (event as CustomEvent<string[]>).detail;
      if (Array.isArray(detail)) {
        setArmedAlertSymbols(
          new Set(detail.map((item) => normalizeSymbol(item)).filter(Boolean)),
        );
      } else {
        refreshArmedAlertSymbols();
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("backend-alert-symbols-change", handleCustom);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("backend-alert-symbols-change", handleCustom);
    };
  }, []);

  const toggleArmedAlertSymbol = async (symbol: string) => {
    const clean = normalizeSymbol(symbol);
    if (!clean) return;

    const currentlyArmed = armedAlertSymbols.has(clean);
    const optimistic = new Set(armedAlertSymbols);
    if (currentlyArmed) optimistic.delete(clean);
    else optimistic.add(clean);
    setArmedAlertSymbols(optimistic);

    try {
      const payload = await toggleSelectedAlertSymbol(clean, !currentlyArmed);
      const nextSymbols = (payload.symbols || [])
        .map((item) => normalizeSymbol(item))
        .filter(Boolean);
      const nextSet = new Set(nextSymbols);
      setArmedAlertSymbols(nextSet);
      try {
        writeStoredAlertSymbols(nextSymbols);
      } catch {
        // localStorage is only for same-browser sync. Backend remains source of truth.
      }
    } catch (exc) {
      console.error("Failed to toggle backend alert symbol", exc);
      setArmedAlertSymbols(new Set(armedAlertSymbols));
      setError(`Could not update alert symbol ${clean}.`);
    }
  };

  const renderAlertArmButton = (symbol: string) => {
    const clean = normalizeSymbol(symbol);
    const isArmed = armedAlertSymbols.has(clean);
    const title = isArmed
      ? `Alerts armed for ${clean}. Click to disarm.`
      : `Alerts off for ${clean}. Click to arm backend alerts.`;

    return (
      <span
        role="button"
        tabIndex={0}
        title={title}
        aria-label={title}
        onClick={(event) => {
          event.stopPropagation();
          toggleArmedAlertSymbol(clean);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            toggleArmedAlertSymbol(clean);
          }
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 28,
          height: 24,
          marginRight: 8,
          borderRadius: 999,
          border: isArmed
            ? "1px solid rgba(34,197,94,0.65)"
            : "1px solid rgba(148,163,184,0.25)",
          background: isArmed ? "rgba(22,163,74,0.22)" : "rgba(15,23,42,0.65)",
          color: isArmed ? "#86efac" : "#94a3b8",
          fontSize: 13,
          cursor: alertSymbolsLoading ? "wait" : "pointer",
          userSelect: "none",
        }}
      >
        {isArmed ? "🔔" : "🔕"}
      </span>
    );
  };

  useEffect(() => {
    loadDefinitions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isWorkspace) return;
    loadSnapshots(selectedScannerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWorkspace, selectedScannerId]);

  function applyPreset(next: PresetKey) {
    setPreset(next);

    if (next === "early") {
      setMinVolume(250_000);
      setMinGapPct(2);
      setMinPmRangePct(3);
      setMinPmDollarVolume(250_000);
      setMinAhDollarVolume(75_000);
      setMinCompressionScore(0);
      setMinBreakoutScore(0);
      setMaxFloatShares("");
      setLowFloatOnly(false);
      return;
    }

    if (next === "breakout") {
      setMinVolume(500_000);
      setMinGapPct(3);
      setMinPmRangePct(4.5);
      setMinPmDollarVolume(500_000);
      setMinAhDollarVolume(100_000);
      setMinCompressionScore(60);
      setMinBreakoutScore(60);
      setMaxFloatShares("");
      setLowFloatOnly(false);
      return;
    }

    if (next === "momentum") {
      setMinVolume(750_000);
      setMinGapPct(1.5);
      setMinPmRangePct(5);
      setMinPmDollarVolume(1_000_000);
      setMinAhDollarVolume(150_000);
      setMinCompressionScore(0);
      setMinBreakoutScore(70);
      setMaxFloatShares("");
      setLowFloatOnly(false);
      return;
    }

    if (next === "lowfloat") {
      setMinVolume(500_000);
      setMinGapPct(3);
      setMinPmRangePct(4.5);
      setMinPmDollarVolume(500_000);
      setMinAhDollarVolume(100_000);
      setMinCompressionScore(0);
      setMinBreakoutScore(60);
      setMaxFloatShares("50000000");
      setLowFloatOnly(true);
      return;
    }
  }

  function scannerRequestParams() {
    return {
      scanner_id: selectedScannerId,
      workflow,
      ah_date: ahDate || undefined,
      max_symbols: maxSymbols,
      min_price: minPrice,
      max_price: maxPrice,
      min_volume: minVolume,
      min_change_pct: minGapPct,
      min_gap_pct: minGapPct,
      min_pm_range_pct: minPmRangePct,
      min_pm_dollar_volume: minPmDollarVolume,
      min_compression_score: minCompressionScore,
      min_breakout_score: minBreakoutScore,
      max_float_shares: maxFloatShares.trim()
        ? Number(maxFloatShares)
        : undefined,
      low_float_only: lowFloatOnly,
      hours_back: hoursBack,
    };
  }

  async function loadScanner(options?: { forceRefresh?: boolean }) {
    try {
      setLoading(true);
      setError("");
      setStatus("");

      const cacheResponse = options?.forceRefresh
        ? await refreshScannerCache(scannerRequestParams() as any)
        : await fetchScannerCache();

      setCacheStatus(cacheResponse);

      const cachedRows =
        (cacheResponse.data as ScannerResponse | null)?.rows ?? [];
      const cacheIsEmpty = !cacheResponse.data || cachedRows.length === 0;

      if (cacheResponse.data && !cacheIsEmpty) {
        setData(cacheResponse.data as ScannerResponse);
      } else if (!cacheResponse.last_error && options?.forceRefresh) {
        // Only run a heavy scanner refresh when the user explicitly presses refresh.
        // Page switches should read the backend cache only to avoid freezing charts.
        const seeded = await refreshScannerCache(scannerRequestParams() as any);
        setCacheStatus(seeded);
        if (seeded.data) setData(seeded.data as ScannerResponse);
      }

      const activeError = cacheResponse.last_error;
      if (activeError) {
        setError(activeError);
      }

      if (isWorkspace) {
        await loadSnapshots(selectedScannerId);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load scanner cache",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveAfterhours() {
    try {
      setSavingAh(true);
      setError("");
      setStatus("");

      const result = (await saveAfterhoursSnapshot({
        scanner_id: selectedScannerId,
        max_symbols: Math.max(maxSymbols, 40),
        min_price: minPrice,
        max_price: maxPrice,
        min_volume: Math.min(minVolume, 100_000),
        min_gap_pct: 0,
        min_dollar_volume: minAhDollarVolume,
        hours_back: hoursBack,
      } as any)) as any;

      if (!result?.saved) {
        const rejectCounts = result?.debug?.reject_counts;
        const reasonText = rejectCounts
          ? ` | Checked ${rejectCounts.checked ?? 0}: no AH bars ${rejectCounts.no_afterhours_bars ?? 0}, price ${rejectCounts.price ?? 0}, volume ${rejectCounts.ah_volume ?? 0}, gap ${rejectCounts.ah_gap_pct ?? 0}, dollar volume ${rejectCounts.ah_dollar_volume ?? 0}`
          : "";
        setStatus(
          `${result?.message ?? "No AH snapshot was saved."}${reasonText}`,
        );
      } else {
        setStatus(
          `Saved AH snapshot for ${result.trade_date} with ${result.count} rows.`,
        );
      }

      await loadSnapshots(selectedScannerId);
      if (result?.trade_date) {
        setAhDate(result.trade_date);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to save afterhours snapshot",
      );
    } finally {
      setSavingAh(false);
    }
  }

  useEffect(() => {
    loadScanner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWorkspace, selectedScannerId, workflow]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      loadScanner();
    }, refreshSeconds * 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoRefresh,
    refreshSeconds,
    isWorkspace,
    selectedScannerId,
    workflow,
    ahDate,
    maxSymbols,
    minPrice,
    maxPrice,
    minVolume,
    minGapPct,
    minPmRangePct,
    minPmDollarVolume,
    minAhDollarVolume,
    hoursBack,
    minCompressionScore,
    minBreakoutScore,
    maxFloatShares,
    lowFloatOnly,
  ]);

  const rows = useMemo(() => dedupeScannerRows(data?.rows ?? []), [data]);

  const filteredRows = useMemo(() => {
    const byRunner = rows.filter((row) => {
      if (runnerTypeFilter === "all") return true;
      return String(row.runner_type ?? "").toLowerCase() === runnerTypeFilter;
    });

    const sorted = [...byRunner].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const aNum = typeof av === "number" ? av : Number(av ?? -Infinity);
      const bNum = typeof bv === "number" ? bv : Number(bv ?? -Infinity);

      if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
        return sortDir === "asc" ? aNum - bNum : bNum - aNum;
      }

      const aStr = String(av ?? "");
      const bStr = String(bv ?? "");
      return sortDir === "asc"
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });

    return sorted;
  }, [rows, runnerTypeFilter, sortKey, sortDir]);

  const runnerCounts = useMemo(() => {
    const momentum = rows.filter(
      (row) => String(row.runner_type ?? "").toLowerCase() === "momentum",
    ).length;
    const overnight = rows.filter(
      (row) => String(row.runner_type ?? "").toLowerCase() === "overnight",
    ).length;
    return { all: rows.length, momentum, overnight };
  }, [rows]);

  useEffect(() => {
    const unique = rows
      .map((row) => normalizeSymbol(row.symbol))
      .filter((value): value is string => Boolean(value));

    const watchlistRows = rows
      .map((row) => buildWatchlistSymbol(row))
      .filter((item) => Boolean(item.symbol));

    // Push empty lists too. This prevents stale/default symbols from staying in the
    // scanner watchlist when the scanner legitimately has no rows.
    if (!arraysEqual(lastPushedWatchlistRef.current, unique)) {
      lastPushedWatchlistRef.current = unique;
      replaceSymbols("scanner", watchlistRows, {
        name: "Scanner Watchlist",
        type: "scanner",
        description: "Combined symbols currently coming from scanner output.",
      });
      onWatchlistChange?.(unique);
    }

    const selectedScannerWatchlistId = normalizeWatchlistId(
      data?.scanner_id ?? selectedScannerId
    );

    if (selectedScannerWatchlistId && selectedScannerWatchlistId !== "scanner") {
      replaceSymbols(selectedScannerWatchlistId, watchlistRows, {
        name: data?.scanner_name ?? titleCaseWatchlistName(selectedScannerId),
        type: "scanner",
        description:
          data?.description ??
          `Scanner-generated symbols for ${titleCaseWatchlistName(
            selectedScannerId
          )}.`,
      });
    }

    const grouped = new Map<string, typeof watchlistRows>();

    rows.forEach((row) => {
      const groupKey = normalizeWatchlistId(row.source ?? row.runner_type);
      if (!groupKey || groupKey === "scanner") return;

      const item = buildWatchlistSymbol(row);
      if (!item.symbol) return;

      const existing = grouped.get(groupKey) ?? [];
      grouped.set(groupKey, [...existing, item]);
    });

    grouped.forEach((items, groupKey) => {
      replaceSymbols(groupKey, items, {
        name: titleCaseWatchlistName(groupKey),
        type: "scanner",
        description: `Auto-generated ${titleCaseWatchlistName(
          groupKey
        )} scanner list.`,
      });
    });

    // Important for the new chart workspace:
    // scanner/watchlist changes update the watchlist immediately, but the chart only
    // reloads when the active symbol changes. If the current chart symbol is not in
    // the newly loaded scanner rows, select the first scanner result right away so
    // the chart updates without requiring a full page refresh.
    const current = normalizeSymbol(selectedSymbol || activeSymbol);
    const firstSymbol = unique[0] ?? "";
    const currentIsInScannerRows = current ? unique.includes(current) : false;

    if (firstSymbol && !currentIsInScannerRows) {
      setActiveSymbol(firstSymbol, "scanner");
      onSelectSymbol?.(firstSymbol);
    }
  }, [
    rows,
    data?.scanner_id,
    data?.scanner_name,
    data?.description,
    selectedScannerId,
    selectedSymbol,
    activeSymbol,
    setActiveSymbol,
    replaceSymbols,
    onSelectSymbol,
    onWatchlistChange,
  ]);

  function handleScannerSymbolSelect(symbol: string) {
    const clean = normalizeSymbol(symbol);
    if (!clean) return;

    setActiveSymbol(clean, "scanner");
    onSelectSymbol?.(clean);
  }

  function toggleSort(nextKey: keyof ScannerRow) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(nextKey);
    setSortDir("desc");
  }

  const activeFilterChips = useMemo(() => {
    const chips: string[] = [];
    if (minCompressionScore > 0)
      chips.push(`Compression ≥ ${minCompressionScore}`);
    if (minBreakoutScore > 0) chips.push(`Breakout ≥ ${minBreakoutScore}`);
    if (maxFloatShares.trim())
      chips.push(`Float ≤ ${formatVolume(Number(maxFloatShares))}`);
    if (lowFloatOnly) chips.push("Low float only");
    chips.push(`AH save $Vol ≥ ${formatVolume(minAhDollarVolume)}`);
    chips.push(`Lookback ${hoursBack}h`);
    return chips;
  }, [
    minCompressionScore,
    minBreakoutScore,
    maxFloatShares,
    lowFloatOnly,
    minAhDollarVolume,
    hoursBack,
  ]);

  const lastRunText = cacheStatus?.last_run
    ? new Date(cacheStatus.last_run).toLocaleTimeString()
    : "waiting";
  const cacheSummary = `Cache: ${cacheStatus?.status ?? "loading"} | Last: ${lastRunText} | Count: ${data?.count ?? rows.length}`;

  const summaryText = isWorkspace
    ? `Trade day: ${data?.trade_day ?? "--"} | ${cacheSummary}`
    : cacheSummary;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: isWorkspace
          ? "auto auto auto auto auto 1fr"
          : "auto auto 1fr",
        gap: 12,
        height: "100%",
        minHeight: 0,
      }}
    >
      <div style={panelStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {isWorkspace
                ? (selectedDefinition?.name ?? "Scanner Workspace")
                : "Scanner"}
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{summaryText}</div>
            {data?.meta?.combined_fallback ? (
              <div style={{ fontSize: 12, color: "#facc15", marginTop: 6 }}>
                Combined fallback → Live:{" "}
                {data.meta.combined_fallback_reason ?? "No AH snapshot"}
              </div>
            ) : null}
          </div>

          {!isWorkspace ? (
            <label style={{ ...labelStyle, minWidth: 0, flex: "1 1 100%" }}>
              <div style={labelTextStyle}>Scanner</div>
              <select
                value={selectedScannerId}
                onChange={(e) => setSelectedScannerId(e.target.value)}
                style={inputStyle}
              >
                {definitions.length === 0 ? (
                  <option value={selectedScannerId}>
                    {selectedDefinition?.name ?? selectedScannerId}
                  </option>
                ) : null}
                {definitions.map((item, index) => (
                  <option
                    key={`sidebar-scanner-${item.id}-${index}`}
                    value={item.id}
                  >
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <label
              style={{
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto
            </label>
            <input
              type="number"
              min={5}
              step={1}
              value={refreshSeconds}
              onChange={(e) => setRefreshSeconds(Number(e.target.value) || 20)}
              style={{ ...inputStyle, width: 72 }}
            />
            <button
              onClick={() => loadScanner({ forceRefresh: true })}
              disabled={loading}
              style={buttonStyle}
            >
              {loading ? "Refreshing..." : "Manual Refresh"}
            </button>
          </div>
        </div>
      </div>

      {isWorkspace ? (
        <div
          style={{
            ...panelStyle,
            display: "grid",
            gridTemplateColumns:
              "minmax(220px,300px) minmax(170px,220px) minmax(170px,220px) 1fr auto",
            gap: 12,
            alignItems: "end",
          }}
        >
          <label style={labelStyle}>
            <div style={labelTextStyle}>Scanner Module</div>
            <select
              value={selectedScannerId}
              onChange={(e) => setSelectedScannerId(e.target.value)}
              style={inputStyle}
            >
              {definitions.map((item, index) => (
                <option
                  key={`workspace-scanner-${item.id}-${index}`}
                  value={item.id}
                >
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            <div style={labelTextStyle}>Workflow</div>
            <select
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value as Workflow)}
              style={inputStyle}
            >
              <option value="auto">Auto</option>
              <option value="combined">Combined (Saved AH + PM)</option>
              <option value="live">Live PM Only</option>
            </select>
          </label>

          <label style={labelStyle}>
            <div style={labelTextStyle}>Saved AH Date</div>
            <select
              value={ahDate}
              onChange={(e) => setAhDate(e.target.value)}
              style={inputStyle}
              disabled={workflow !== "combined"}
            >
              {snapshotDates.length ? (
                snapshotDates.map((dateValue, index) => (
                  <option
                    key={`snapshot-${dateValue}-${index}`}
                    value={dateValue}
                  >
                    {dateValue}
                  </option>
                ))
              ) : (
                <option value="">No saved AH snapshot</option>
              )}
            </select>
          </label>

          <div
            style={{
              border: "1px solid #1f2631",
              borderRadius: 10,
              padding: 10,
              background: "#0b0f14",
              fontSize: 13,
              opacity: 0.95,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Overnight Workflow
            </div>
            <div>
              {selectedDefinition?.description ?? "Loading scanner module..."}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
              Latest saved AH: {latestSnapshot || "none"}
            </div>
            {data?.meta?.workflow_auto_rule ? (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                {data.meta.workflow_auto_rule}
              </div>
            ) : null}
          </div>

          <button
            onClick={handleSaveAfterhours}
            disabled={savingAh}
            style={{ ...buttonStyle, minWidth: 150 }}
          >
            {savingAh ? "Saving AH..." : "Save AH Snapshot"}
          </button>
        </div>
      ) : null}

      {isWorkspace ? (
        <div style={panelStyle}>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 10,
            }}
          >
            <button
              onClick={() => applyPreset("early")}
              style={preset === "early" ? activeButtonStyle : buttonStyle}
            >
              Early Detection
            </button>
            <button
              onClick={() => applyPreset("breakout")}
              style={preset === "breakout" ? activeButtonStyle : buttonStyle}
            >
              Clean Breakouts
            </button>
            <button
              onClick={() => applyPreset("momentum")}
              style={preset === "momentum" ? activeButtonStyle : buttonStyle}
            >
              Momentum Hunt
            </button>
            <button
              onClick={() => applyPreset("lowfloat")}
              style={preset === "lowfloat" ? activeButtonStyle : buttonStyle}
            >
              Low Float Focus
            </button>
            <button
              onClick={() => setPreset("custom")}
              style={preset === "custom" ? activeButtonStyle : buttonStyle}
            >
              Custom
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(110px, 1fr))",
              gap: 10,
            }}
          >
            <label style={labelStyle}>
              <div style={labelTextStyle}>Max Symbols</div>
              <input
                type="number"
                value={maxSymbols}
                onChange={(e) => setMaxSymbols(Number(e.target.value) || 25)}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Min Price</div>
              <input
                type="number"
                value={minPrice}
                onChange={(e) => {
                  setPreset("custom");
                  setMinPrice(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Max Price</div>
              <input
                type="number"
                value={maxPrice}
                onChange={(e) => {
                  setPreset("custom");
                  setMaxPrice(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Min PM Volume</div>
              <input
                type="number"
                value={minVolume}
                onChange={(e) => {
                  setPreset("custom");
                  setMinVolume(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Min PM Gap %</div>
              <input
                type="number"
                value={minGapPct}
                onChange={(e) => {
                  setPreset("custom");
                  setMinGapPct(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Min PM Range %</div>
              <input
                type="number"
                value={minPmRangePct}
                onChange={(e) => {
                  setPreset("custom");
                  setMinPmRangePct(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Min $ Volume</div>
              <input
                type="number"
                value={minPmDollarVolume}
                onChange={(e) => {
                  setPreset("custom");
                  setMinPmDollarVolume(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(6, minmax(140px, 1fr))",
              gap: 10,
              marginTop: 10,
            }}
          >
            <label style={labelStyle}>
              <div style={labelTextStyle}>Min Compression</div>
              <input
                type="number"
                value={minCompressionScore}
                onChange={(e) => {
                  setPreset("custom");
                  setMinCompressionScore(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Min Breakout</div>
              <input
                type="number"
                value={minBreakoutScore}
                onChange={(e) => {
                  setPreset("custom");
                  setMinBreakoutScore(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Max Float Shares</div>
              <input
                type="number"
                value={maxFloatShares}
                onChange={(e) => {
                  setPreset("custom");
                  setMaxFloatShares(e.target.value);
                }}
                style={inputStyle}
                placeholder="optional"
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>AH Save Min $Vol</div>
              <input
                type="number"
                value={minAhDollarVolume}
                onChange={(e) => {
                  setPreset("custom");
                  setMinAhDollarVolume(Number(e.target.value) || 0);
                }}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <div style={labelTextStyle}>Lookback Hours</div>
              <input
                type="number"
                min={24}
                value={hoursBack}
                onChange={(e) => {
                  setPreset("custom");
                  setHoursBack(Math.max(24, Number(e.target.value) || 96));
                }}
                style={inputStyle}
              />
            </label>
            <label style={{ ...labelStyle, justifyContent: "flex-end" }}>
              <div style={labelTextStyle}>Low Float Only</div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  height: 42,
                }}
              >
                <input
                  type="checkbox"
                  checked={lowFloatOnly}
                  onChange={(e) => {
                    setPreset("custom");
                    setLowFloatOnly(e.target.checked);
                  }}
                />
                Only ≤ 50M
              </label>
            </label>
          </div>
        </div>
      ) : null}

      {status ? (
        <div
          style={{
            ...panelStyle,
            borderColor: "#2f5c2a",
            background: "rgba(67,132,57,0.15)",
            color: "#b7f0af",
            fontSize: 13,
          }}
        >
          {status}
        </div>
      ) : null}

      {isWorkspace ? (
        <div style={panelStyle}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => setRunnerTypeFilter("all")}
                style={
                  runnerTypeFilter === "all" ? activeButtonStyle : buttonStyle
                }
              >
                All ({runnerCounts.all})
              </button>
              <button
                onClick={() => setRunnerTypeFilter("momentum")}
                style={
                  runnerTypeFilter === "momentum"
                    ? activeButtonStyle
                    : buttonStyle
                }
              >
                Momentum ({runnerCounts.momentum})
              </button>
              <button
                onClick={() => setRunnerTypeFilter("overnight")}
                style={
                  runnerTypeFilter === "overnight"
                    ? activeButtonStyle
                    : buttonStyle
                }
              >
                Overnight ({runnerCounts.overnight})
              </button>
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Sort: {String(sortKey)} ({sortDir})
            </div>
          </div>
          {activeFilterChips.length ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 10,
              }}
            >
              {activeFilterChips.map((chip, index) => (
                <div
                  key={`filter-chip-${chip}-${index}`}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    background: "#0b0f14",
                    border: "1px solid #2a2f3a",
                    fontSize: 12,
                  }}
                >
                  {chip}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          ...panelStyle,
          overflow: "auto",
          minHeight: 0,
          padding: isWorkspace ? 0 : 10,
        }}
      >
        {error ? (
          <div style={{ color: "#ff7b7b", padding: 14 }}>{error}</div>
        ) : !isWorkspace ? (
          <div style={{ display: "grid", gap: 8 }}>
            {filteredRows.length === 0 && !loading ? (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px dashed rgba(255,255,255,0.12)",
                  background: "rgba(7,23,49,0.55)",
                  color: "rgba(255,255,255,0.6)",
                  fontSize: 12,
                }}
              >
                Scanner watchlist is empty. Run or refresh the scanner.
              </div>
            ) : null}

            {filteredRows.map((row, index) => {
              const symbol = normalizeSymbol(row.symbol);
              const isSelected = symbol === currentSelectedSymbol;
              return (
                <button
                  key={`scanner-card-${symbol}-${index}`}
                  type="button"
                  onClick={() => handleScannerSymbolSelect(symbol)}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: isSelected
                      ? "1px solid #4ea1ff"
                      : "1px solid rgba(255,255,255,0.08)",
                    background: isSelected ? "#12396b" : "#071731",
                    color: "white",
                    cursor: "pointer",
                    fontWeight: isSelected ? 800 : 700,
                    letterSpacing: 0.2,
                  }}
                >
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                  >
                    {renderAlertArmButton(symbol)}
                    <span>{symbol}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
          >
            <thead
              style={{
                position: "sticky",
                top: 0,
                background: "#161d29",
                zIndex: 1,
              }}
            >
              <tr>
                {[
                  ["alert", "Alert"],
                  ["symbol", "Symbol"],
                  ["runner_type", "Type"],
                  ["last_price", "Last"],
                  ["pm_gap_pct", "Change%"],
                  ["pm_range_pct", "Range%"],
                  ["pm_volume", "Volume"],
                  ["pm_dollar_volume", "$Vol"],
                  ["compression_score", "Compression"],
                  ["breakout_score", "Breakout"],
                  ["volume_accel_pct", "Vol Accel%"],
                  ["float_shares", "Float"],
                  ["short_interest_pct", "Short %"],
                  ["short_interest_rank", "Short Rank"],
                  ["turnover_pct", "Turnover %"],
                  ["squeeze_rank", "Squeeze"],
                  ["runner_score", "Runner"],
                  ["notes", "Notes"],
                ].map(([key, header], index) => (
                  <th
                    key={`scanner-header-${String(key)}-${index}`}
                    onClick={() =>
                      key !== "notes" && key !== "alert"
                        ? toggleSort(key as keyof ScannerRow)
                        : undefined
                    }
                    style={{
                      textAlign:
                        header === "Symbol" ||
                        header === "Type" ||
                        header === "Notes" ||
                        header === "Alert"
                          ? "left"
                          : "right",
                      padding: "10px 12px",
                      borderBottom: "1px solid #2a2f3a",
                      whiteSpace: "nowrap",
                      cursor:
                        key !== "notes" && key !== "alert"
                          ? "pointer"
                          : "default",
                    }}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, index) => {
                const symbol = normalizeSymbol(row.symbol);
                const isSelected = symbol === currentSelectedSymbol;
                const squeezeValue = row.squeeze_rank ?? null;
                const squeezeColor =
                  squeezeValue != null && squeezeValue > 80
                    ? "#ff4d4f"
                    : squeezeValue != null && squeezeValue > 60
                      ? "#fa8c16"
                      : "#fff";
                return (
                  <tr
                    key={`scanner-row-${symbol}-${index}`}
                    onClick={() => handleScannerSymbolSelect(symbol)}
                    style={{
                      cursor: "pointer",
                      background: isSelected
                        ? "rgba(120, 90, 255, 0.18)"
                        : "transparent",
                    }}
                  >
                    <td style={cellLeft}>{renderAlertArmButton(symbol)}</td>
                    <td style={cellLeft}>
                      <strong>{symbol}</strong>
                    </td>
                    <td style={cellLeft}>
                      {String(row.runner_type ?? row.source ?? "scanner")}
                    </td>
                    <td style={cellRight}>
                      {formatMaybe(row.last_price ?? row.price)}
                    </td>
                    <td
                      style={{
                        ...cellRight,
                        color:
                          (row.pm_gap_pct ??
                            row.gap_pct ??
                            row.change_pct ??
                            0) >= 0
                            ? "#66d17a"
                            : "#ff7b7b",
                      }}
                    >
                      {formatMaybe(
                        row.pm_gap_pct ?? row.gap_pct ?? row.change_pct,
                      )}
                      %
                    </td>
                    <td style={cellRight}>
                      {formatMaybe(row.pm_range_pct ?? row.range_pct)}%
                    </td>
                    <td style={cellRight}>
                      {formatVolume(row.pm_volume ?? row.volume)}
                    </td>
                    <td style={cellRight}>
                      {formatVolume(
                        row.pm_dollar_volume ??
                          (row.price ?? row.last_price ?? 0) *
                            (row.volume ?? row.pm_volume ?? 0),
                      )}
                    </td>
                    <td style={cellRight}>
                      {formatMaybe(row.compression_score)}
                    </td>
                    <td style={cellRight}>{formatMaybe(row.breakout_score)}</td>
                    <td style={cellRight}>
                      {formatMaybe(row.volume_accel_pct)}%
                    </td>
                    <td style={cellRight}>
                      {row.float_shares == null
                        ? "-"
                        : formatVolume(row.float_shares)}
                    </td>
                    <td style={cellRight}>
                      {formatMaybe(row.short_interest_pct)}
                    </td>
                    <td style={cellRight}>
                      {formatMaybe(row.short_interest_rank)}
                    </td>
                    <td style={cellRight}>{formatMaybe(row.turnover_pct)}%</td>
                    <td
                      style={{
                        ...cellRight,
                        color: squeezeColor,
                        fontWeight: 700,
                      }}
                    >
                      {formatMaybe(row.squeeze_rank)}
                    </td>
                    <td
                      style={{
                        ...cellRight,
                        color: "#9dd8ff",
                        fontWeight: 700,
                      }}
                    >
                      {formatMaybe(row.runner_score ?? row.score)}
                    </td>
                    <td style={cellLeft}>
                      {(row.notes ?? []).join(", ") || "-"}
                    </td>
                  </tr>
                );
              })}
              {!loading && filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={18} style={{ padding: 16, opacity: 0.7 }}>
                    No results for the current filter set.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #2a2f3a",
  borderRadius: 12,
  padding: 12,
  background: "#11161f",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#0b0f14",
  color: "white",
  border: "1px solid #2a2f3a",
  borderRadius: 8,
  padding: "8px 10px",
  boxSizing: "border-box",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #2a2f3a",
  background: "#1a2332",
  color: "white",
  cursor: "pointer",
};

const activeButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#243b6b",
  border: "1px solid #4f7ddb",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
};

const labelTextStyle: React.CSSProperties = {
  marginBottom: 4,
};

const cellLeft: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid #1f2631",
};

const cellRight: React.CSSProperties = {
  textAlign: "right",
  padding: "10px 12px",
  borderBottom: "1px solid #1f2631",
};
