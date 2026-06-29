import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const SYMBOL_STORAGE_KEY = "chartv2.symbol";

type SymbolSelectionSource =
  | "chart"
  | "toolbar"
  | "watchlist"
  | "scanner"
  | "trading"
  | "positions"
  | "orders"
  | "system";

interface ActiveSymbolContextValue {
  activeSymbol: string;
  selectionSource: SymbolSelectionSource;
  setActiveSymbol: (
    symbol: string,
    source?: SymbolSelectionSource
  ) => void;
}

const ActiveSymbolContext = createContext<ActiveSymbolContextValue | null>(
  null
);

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function loadInitialSymbol(fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }

  const saved = window.localStorage.getItem(SYMBOL_STORAGE_KEY);
  const normalized = normalizeSymbol(saved || fallback);

  return normalized || fallback;
}

export function ActiveSymbolProvider({
  initialSymbol = "SPY",
  children,
}: {
  initialSymbol?: string;
  children: ReactNode;
}) {
  const [activeSymbol, setActiveSymbolState] = useState(() =>
    loadInitialSymbol(initialSymbol)
  );

  const [selectionSource, setSelectionSource] =
    useState<SymbolSelectionSource>("system");

  function setActiveSymbol(
    nextSymbol: string,
    source: SymbolSelectionSource = "system"
  ) {
    const normalized = normalizeSymbol(nextSymbol);

    if (!normalized) {
      return;
    }

    setActiveSymbolState(normalized);
    setSelectionSource(source);

    if (typeof window !== "undefined") {
      window.localStorage.setItem(SYMBOL_STORAGE_KEY, normalized);
    }
  }

  const value = useMemo<ActiveSymbolContextValue>(
    () => ({
      activeSymbol,
      selectionSource,
      setActiveSymbol,
    }),
    [activeSymbol, selectionSource]
  );

  return (
    <ActiveSymbolContext.Provider value={value}>
      {children}
    </ActiveSymbolContext.Provider>
  );
}

export function useActiveSymbol() {
  const context = useContext(ActiveSymbolContext);

  if (!context) {
    throw new Error("useActiveSymbol must be used inside ActiveSymbolProvider");
  }

  return context;
}