// src/trading/engine/TradeEngineRuntime.ts

import { TradeEngine } from "./TradeEngine";
import type { TradeWorkspace } from "./TradeTypes";

let sharedTradeEngine: TradeEngine | null = null;
let activeWorkspaceKey = "";

function workspaceKey(workspace?: TradeWorkspace): string {
  const symbol = String(workspace?.symbol ?? "").trim().toUpperCase();
  const timeframe = String(workspace?.timeframe ?? "").trim().toLowerCase();
  return `${symbol}|${timeframe}`;
}

export function getSharedTradeEngine(workspace?: TradeWorkspace): TradeEngine {
  if (!sharedTradeEngine) {
    sharedTradeEngine = new TradeEngine(workspace);
    activeWorkspaceKey = workspaceKey(workspace);
    return sharedTradeEngine;
  }

  if (workspace) {
    const nextKey = workspaceKey(workspace);

    if (nextKey !== activeWorkspaceKey) {
      sharedTradeEngine.setWorkspace(workspace);
      activeWorkspaceKey = nextKey;
    }
  }

  return sharedTradeEngine;
}

export function resetSharedTradeEngine(): void {
  sharedTradeEngine?.destroy();
  sharedTradeEngine = null;
  activeWorkspaceKey = "";
}
