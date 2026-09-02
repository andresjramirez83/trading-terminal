import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import {
  disposeTradingIntelligence,
  initializeTradingIntelligence,
} from "./trading/intelligence/core/TradingIntelligenceRuntime";
import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error('Unable to start the application because the "root" element was not found.');
}

const root = ReactDOM.createRoot(rootElement);

function renderStartupFailure(error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : "An unknown intelligence startup error occurred.";

  console.error("Trading intelligence failed to initialize:", error);

  root.render(
    <React.StrictMode>
      <main
        role="alert"
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          background: "#090d14",
          color: "#f3f4f6",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <section style={{ maxWidth: "680px" }}>
          <h1 style={{ marginBottom: "12px" }}>
            Trading intelligence could not start
          </h1>
          <p style={{ margin: 0, lineHeight: 1.6, color: "#cbd5e1" }}>
            {message}
          </p>
        </section>
      </main>
    </React.StrictMode>,
  );
}

async function startApplication(): Promise<void> {
  try {
    await initializeTradingIntelligence();

    root.render(
      <React.StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </React.StrictMode>,
    );
  } catch (error) {
    renderStartupFailure(error);
  }
}

void startApplication();

// MOBILE_PWA_SERVICE_WORKER
// No asset/API caching: this only enables installed-app behavior safely.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[PWA] service worker registration failed", error);
    });
  });
}


if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disposeTradingIntelligence();
  });
}
