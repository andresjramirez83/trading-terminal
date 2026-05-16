import { Suspense, lazy } from "react";
import { Routes, Route } from "react-router-dom";

const ScannerPage = lazy(() => import("./pages/ScannerPage"));
const AlpacaPage = lazy(() => import("./pages/AlpacaPage"));
const TerminalPage = lazy(() => import("./pages/TerminalPage"));
const ExpandedChartPage = lazy(() => import("./pages/ExpandedChartPage"));

function App() {
  return (
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
      </Routes>
    </Suspense>
  );
}

export default App;
