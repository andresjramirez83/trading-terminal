import { Suspense, lazy } from "react";
import { Routes, Route } from "react-router-dom";

import { ActiveSymbolProvider } from "./components/chart/ActiveSymbolContext";
import { WatchlistProvider } from "./components/watchlists/WatchlistContext";
import { WorkspaceProvider } from "./components/workspace/WorkspaceContext";

import ChartV2Page from "./pages/ChartV2Page";

const ScannerPage = lazy(() => import("./pages/ScannerPage"));
const AlpacaPage = lazy(() => import("./pages/AlpacaPage"));
const TerminalPage = lazy(() => import("./pages/TerminalPage"));
const ExpandedChartPage = lazy(() => import("./pages/ExpandedChartPage"));

function App() {
  return (
    <ActiveSymbolProvider initialSymbol="SPY">
      <WatchlistProvider>
        <WorkspaceProvider>
          <Suspense
            fallback={
              <div
                style={{
                  minHeight: "100vh",
                  display: "grid",
                  placeItems: "center",
                  background: "#03152f",
                  color: "#e5e7eb",
                  fontFamily: "Arial, sans-serif",
                }}
              >
                Loading…
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<AlpacaPage />} />
              <Route path="/terminal" element={<TerminalPage />} />
              <Route path="/scanner" element={<ScannerPage />} />
              <Route path="/chart" element={<ExpandedChartPage />} />
              <Route path="/alpaca" element={<AlpacaPage />} />
              <Route path="/chartv2" element={<ChartV2Page />} />
            </Routes>
          </Suspense>
        </WorkspaceProvider>
      </WatchlistProvider>
    </ActiveSymbolProvider>
  );
}

export default App;