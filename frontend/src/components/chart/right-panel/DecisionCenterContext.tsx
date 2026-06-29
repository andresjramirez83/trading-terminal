import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

import type { ChartState } from "../ChartState";
import type { DecisionCenterState } from "./DecisionCenterTypes";
import { buildDecisionCenterState } from "./DecisionCenterBuilder";

const DecisionCenterContext = createContext<DecisionCenterState | null>(null);

type DecisionCenterProviderProps = {
  children: ReactNode;
  chartState?: ChartState | null;
};

export function DecisionCenterProvider({
  children,
  chartState,
}: DecisionCenterProviderProps) {
  const state = useMemo(
    () => buildDecisionCenterState(chartState),
    [chartState],
  );

  return (
    <DecisionCenterContext.Provider value={state}>
      {children}
    </DecisionCenterContext.Provider>
  );
}

export function useDecisionCenter(): DecisionCenterState & {
  state: DecisionCenterState;
} {
  const context = useContext(DecisionCenterContext);

  if (!context) {
    throw new Error(
      "useDecisionCenter must be used inside DecisionCenterProvider",
    );
  }

  return {
    ...context,
    state: context,
  };
}