import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import MobileAppNav from "./components/mobile/MobileAppNav";

import { ActiveSymbolProvider } from "./components/chart/ActiveSymbolContext";
import { WatchlistProvider } from "./components/watchlists/WatchlistContext";
import { WorkspaceProvider } from "./components/workspace/WorkspaceContext";

import ChartV2Page from "./pages/ChartV2Page";

const ScannerPage = lazy(() => import("./pages/ScannerPage"));

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
              <Route path="/" element={<ChartV2Page />} />
              <Route path="/chart" element={<ChartV2Page />} />
              <Route path="/scanner" element={<ScannerPage />} />

              <Route path="/chartv2" element={<Navigate to="/chart" replace />} />
              <Route path="/terminal" element={<Navigate to="/chart" replace />} />
              <Route path="/alpaca" element={<Navigate to="/chart" replace />} />
              <Route path="/expanded-chart" element={<Navigate to="/chart" replace />} />
              <Route path="*" element={<Navigate to="/chart" replace />} />
            </Routes>
          </Suspense>
          <MobileAppNav />
        </WorkspaceProvider>
      </WatchlistProvider>
    </ActiveSymbolProvider>
  );
}

export default App;