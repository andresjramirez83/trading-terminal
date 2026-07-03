// src/components/ChartPanelV2/SettingsPanel.tsx

import ChartSettings from "./ChartSettings";
import DrawingSettings from "./DrawingSettings";
import FunctionSettings from "./FunctionSettings";
import type { DrawingStyle } from "./DrawingTypes";
import type { ChartSettings as ChartSettingsModel } from "../../chart/ChartSettingsTypes";
import type { FxAnalysisSettings, FxAnalysisToolId } from "../../chart/analysis";

export type SettingsMode = "drawing" | "function" | "chart";

type Props = {
  open: boolean;
  mode: SettingsMode;

  drawingStyle: DrawingStyle;
  onDrawingStyleChange: (style: DrawingStyle) => void;

  chartSettings: ChartSettingsModel;
  onChartSettingsChange: (settings: ChartSettingsModel) => void;

  activeFxTool: FxAnalysisToolId;
  fxSettings: FxAnalysisSettings;
  onFxSettingsChange: (settings: FxAnalysisSettings) => void;
  onClearFx: () => void;
  onFitFxLevels?: () => void;

  onClose: () => void;
};

export default function SettingsPanel({
  open,
  mode,
  drawingStyle,
  onDrawingStyleChange,
  chartSettings,
  onChartSettingsChange,
  activeFxTool,
  fxSettings,
  onFxSettingsChange,
  onClearFx,
  onFitFxLevels,
  onClose,
}: Props) {
  if (mode === "function") {
    return (
      <FunctionSettings
        open={open}
        activeTool={activeFxTool}
        settings={fxSettings}
        onChange={onFxSettingsChange}
        onClose={onClose}
        onClearFx={onClearFx}
        onFitFxLevels={onFitFxLevels}
      />
    );
  }

  if (mode === "chart") {
    return (
      <ChartSettings
        open={open}
        settings={chartSettings}
        onChange={onChartSettingsChange}
        onClose={onClose}
      />
    );
  }

  return (
    <DrawingSettings
      open={open}
      style={drawingStyle}
      onChange={onDrawingStyleChange}
      onClose={onClose}
    />
  );
}
