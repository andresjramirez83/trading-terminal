import { memo, useEffect, useMemo, useRef } from "react";

declare global {
  interface Window {
    TradingView?: any;
    __tradingViewWidgetScriptPromise?: Promise<void>;
  }
}

type Props = {
  symbol: string;
  timeframe: string;
};

const intervalMap: Record<string, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "1d": "D",
};

const containerStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
};

function loadTradingViewScript(): Promise<void> {
  if (window.TradingView) return Promise.resolve();

  if (window.__tradingViewWidgetScriptPromise) {
    return window.__tradingViewWidgetScriptPromise;
  }

  window.__tradingViewWidgetScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://s3.tradingview.com/tv.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("TradingView script failed to load")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("TradingView script failed to load"));
    document.body.appendChild(script);
  });

  return window.__tradingViewWidgetScriptPromise;
}

function TradingViewExpandedChart({ symbol, timeframe }: Props) {
  const safeSymbol = symbol.trim().toUpperCase() || "AAPL";
  const interval = intervalMap[timeframe] || "1";
  const widgetRef = useRef<any>(null);

  const containerId = useMemo(
    () => `tv-expanded-chart-${safeSymbol}-${timeframe}`.replace(/[^a-zA-Z0-9-_]/g, ""),
    [safeSymbol, timeframe]
  );

  useEffect(() => {
    let cancelled = false;

    async function createWidget() {
      await loadTradingViewScript();
      if (cancelled || !window.TradingView) return;

      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = "";

      widgetRef.current = new window.TradingView.widget({
        autosize: true,
        symbol: `NASDAQ:${safeSymbol}`,
        interval,
        timezone: "America/New_York",
        theme: "dark",
        style: "1",
        locale: "en",
        enable_publishing: false,
        allow_symbol_change: true,
        withdateranges: true,
        hide_side_toolbar: false,
        details: true,
        hotlist: false,
        calendar: false,
        studies: ["Volume@tv-basicstudies"],
        container_id: containerId,
      });
    }

    void createWidget().catch((err) => console.error("TradingView widget error:", err));

    return () => {
      cancelled = true;
      widgetRef.current = null;
      const container = document.getElementById(containerId);
      if (container) container.innerHTML = "";
    };
  }, [containerId, safeSymbol, interval]);

  return <div id={containerId} style={containerStyle} />;
}

export default memo(TradingViewExpandedChart);
