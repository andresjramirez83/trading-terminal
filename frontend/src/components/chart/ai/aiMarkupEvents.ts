import type { AIMarkup, AIProjections, AIMultiTimeframe, AILiquiditySweepMatch } from "../../../services/aiAnalysis";

export type AIOverlayMode = "clean" | "detailed" | "hidden";
export type AIMarkupCommand =
  | { mode: "set"; symbol: string; marks: AIMarkup[]; projections?: AIProjections; multiTimeframe?: AIMultiTimeframe; patternMatch?: AILiquiditySweepMatch }
  | { mode: "view"; symbol: string; view: AIOverlayMode }
  | { mode: "toggle" | "paths" | "clear"; symbol: string };

const EVENT = "trading-terminal-ai-markups-v1";

export function sendAIMarkupCommand(command: AIMarkupCommand): void {
  window.dispatchEvent(new CustomEvent<AIMarkupCommand>(EVENT, { detail: command }));
}

export function listenAIMarkupCommands(listener: (command: AIMarkupCommand) => void): () => void {
  const handler = (event: Event) => {
    const command = (event as CustomEvent<AIMarkupCommand>).detail;
    if (command && (command.mode === "set" || command.mode === "view" || command.mode === "toggle" || command.mode === "paths" || command.mode === "clear")) listener(command);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
