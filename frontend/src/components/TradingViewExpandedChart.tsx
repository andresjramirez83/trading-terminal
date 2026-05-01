import { useEffect, useMemo, useRef } from "react";

declare global {
  interface Window {
    TradingView?: any;
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

function TradingViewExpandedChart({ symbol, timeframe }: Props) {
  const containerId = useMemo(
    () => `tv-expanded-chart-${symbol}-${timeframe}`.replace(/[^a-zA-Z0-9-_]/g, ""),
    [symbol, timeframe]
  );

  const scriptLoadedRef = useRef(false);

  useEffect(() => {
    const createWidget = () => {
      if (!window.TradingView) return;

      const interval = intervalMap[timeframe] || "1";

      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = "";

      new window.TradingView.widget({
        autosize: true,
        symbol: `NASDAQ:${symbol}`,
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
    };

    if (window.TradingView) {
      createWidget();
      return;
    }

    if (!scriptLoadedRef.current) {
      scriptLoadedRef.current = true;

      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/tv.js";
      script.async = true;
      script.onload = createWidget;
      document.body.appendChild(script);
    } else {
      const waitForTv = window.setInterval(() => {
        if (window.TradingView) {
          window.clearInterval(waitForTv);
          createWidget();
        }
      }, 150);

      return () => window.clearInterval(waitForTv);
    }
  }, [containerId, symbol, timeframe]);

  return <div id={containerId} style={containerStyle} />;
}

export default TradingViewExpandedChart;