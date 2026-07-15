// src/components/chart/interaction/ToolRegistry.ts

import type { ChartTool, ChartToolId } from "./ChartTool";
import type { ToolContext } from "./ToolContext";

export class ToolRegistry {
  private tools = new Map<ChartToolId, ChartTool>();
  private activeToolId: ChartToolId | null = null;

  constructor(private readonly context: ToolContext) {}

  register(tool: ChartTool): void {
    this.tools.set(tool.id, tool);

    if (!this.activeToolId) {
      this.activeToolId = tool.id;
      tool.activate?.(this.context);
    }
  }

  unregister(toolId: ChartToolId): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;

    if (this.activeToolId === toolId) {
      tool.deactivate?.(this.context);
      this.activeToolId = null;
    }

    this.tools.delete(toolId);
  }

  activate(toolId: ChartToolId): boolean {
    if (this.activeToolId === toolId) return true;

    const nextTool = this.tools.get(toolId);
    if (!nextTool) return false;

    const currentTool = this.getActiveTool();
    currentTool?.deactivate?.(this.context);

    this.activeToolId = toolId;
    nextTool.activate?.(this.context);
    this.context.requestOverlayRender();

    return true;
  }

  getActiveTool(): ChartTool | null {
    if (!this.activeToolId) return null;
    return this.tools.get(this.activeToolId) ?? null;
  }

  getTool(toolId: ChartToolId): ChartTool | null {
    return this.tools.get(toolId) ?? null;
  }

  getTools(): ChartTool[] {
    return Array.from(this.tools.values());
  }

  cancelActiveTool(): boolean {
    const tool = this.getActiveTool();
    if (!tool) return false;

    const handled = tool.onCancel?.(this.context) === true;
    this.context.requestOverlayRender();
    return handled;
  }
}
