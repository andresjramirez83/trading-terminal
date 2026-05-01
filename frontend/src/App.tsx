import { Routes, Route } from "react-router-dom";
import ScannerPage from "./pages/ScannerPage";
import AlpacaPage from "./pages/AlpacaPage";
import TerminalPage from "./pages/TerminalPage";
import ExpandedChartPage from "./pages/ExpandedChartPage";

function App() {
  return (
    <Routes>
      <Route path="/" element={<AlpacaPage />} />
      <Route path="/terminal" element={<TerminalPage />} />
      <Route path="/scanner" element={<ScannerPage />} />
      <Route path="/chart" element={<ExpandedChartPage />} />
      <Route path="/alpaca" element={<AlpacaPage />} />
    </Routes>
  );
}

export default App;
