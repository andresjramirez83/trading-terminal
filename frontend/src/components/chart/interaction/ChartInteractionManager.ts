// src/components/chart/interaction/ChartInteractionManager.ts

import type { IChartApi, MouseEventParams, Time } from "lightweight-charts";
import type { ChartPointerPoint } from "../ChartEngine";
import { ToolRegistry } from "./ToolRegistry";
import {
  CHART_TOOL_COMPLETED_EVENT,
  type ChartTool,
  type ChartToolCompletionEvent,
  type ChartToolId,
} from "./ChartTool";
import type {
  ChartPointBuilder,
  FocusSelection,
  ToolContext,
} from "./ToolContext";
import { createChartMouseEvent } from "./events/ChartMouseEvent";
import { SelectTool } from "./tools/SelectTool";
import { FocusBoxTool } from "./tools/FocusBoxTool";

type ChartInteractionManagerOptions = ChartPointBuilder & {
  container: HTMLDivElement;
  chart: IChartApi;
  focusSelection?: (selection: FocusSelection) => void;
  resetFocus?: () => void;
  setChartNavigationEnabled?: (enabled: boolean) => void;
};

export class ChartInteractionManager {
  readonly registry: ToolRegistry;

  private readonly container: HTMLDivElement;
  private readonly chart: IChartApi;
  private readonly buildPointFromClick: ChartPointBuilder["buildPointFromClick"];
  private readonly buildPointFromPointerEvent: ChartPointBuilder["buildPointFromPointerEvent"];
  private readonly buildFallbackPointFromMouseEvent: ChartPointBuilder["buildFallbackPointFromMouseEvent"];

  private readonly clickListeners = new Set<(point: ChartPointerPoint) => void>();
  private readonly pointerDownListeners = new Set<(point: ChartPointerPoint) => void>();
  private readonly pointerMoveListeners = new Set<(point: ChartPointerPoint) => void>();
  private readonly pointerUpListeners = new Set<(point: ChartPointerPoint) => void>();
  private readonly contextMenuListeners = new Set<(point: ChartPointerPoint) => void>();
  private readonly toolCompletedListeners = new Set<
    (event: ChartToolCompletionEvent) => void
  >();

  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly overlayContext: CanvasRenderingContext2D;
  private readonly toolContext: ToolContext;
  private readonly focusBoxTool = new FocusBoxTool();

  private lastPointerPoint: ChartPointerPoint | null = null;
  private overlayRenderFrame: number | null = null;
  private focusGestureActive = false;
  private navigationSuppressed = false;

  private readonly handleClick: (param: MouseEventParams<Time>) => void;
  private readonly handlePointerDown: (event: PointerEvent) => void;
  private readonly handlePointerMove: (event: PointerEvent) => void;
  private readonly handlePointerUp: (event: PointerEvent) => void;
  private readonly handleContextMenu: (event: MouseEvent) => void;
  private readonly handleDoubleClick: (event: MouseEvent) => void;
  private readonly handleKeyDown: (event: KeyboardEvent) => void;
  private readonly handleKeyUp: (event: KeyboardEvent) => void;
  private readonly handleResize: () => void;

  constructor(options: ChartInteractionManagerOptions) {
    this.container = options.container;
    this.chart = options.chart;
    this.buildPointFromClick = options.buildPointFromClick;
    this.buildPointFromPointerEvent = options.buildPointFromPointerEvent;
    this.buildFallbackPointFromMouseEvent =
      options.buildFallbackPointFromMouseEvent;

    this.overlayCanvas = document.createElement("canvas");
    this.overlayCanvas.style.position = "absolute";
    this.overlayCanvas.style.inset = "0";
    this.overlayCanvas.style.pointerEvents = "none";
    this.overlayCanvas.style.zIndex = "6";
    this.container.appendChild(this.overlayCanvas);

    const overlayContext = this.overlayCanvas.getContext("2d");
    if (!overlayContext) {
      throw new Error("Unable to create chart interaction overlay context.");
    }
    this.overlayContext = overlayContext;

    this.toolContext = {
      container: this.container,
      chart: this.chart,
      requestOverlayRender: () => this.scheduleOverlayRender(),
      clearOverlay: () => this.clearOverlay(),
      setCursor: (cursor) => {
        this.container.style.cursor = cursor ?? "";
      },
      focusSelection: options.focusSelection,
      resetFocus: options.resetFocus,
      setChartNavigationEnabled: (enabled) => {
        options.setChartNavigationEnabled?.(enabled);
      },
      onToolCompleted: (toolId, payload) => {
        this.emitToolCompleted({ toolId, payload });
      },
    };

    this.registry = new ToolRegistry(this.toolContext);
    this.registry.register(new SelectTool());
    this.registry.register(this.focusBoxTool);

    this.handleClick = (param) => this.onChartClick(param);
    this.handlePointerDown = (event) => this.onPointerDown(event);
    this.handlePointerMove = (event) => this.onPointerMove(event);
    this.handlePointerUp = (event) => this.onPointerUp(event);
    this.handleContextMenu = (event) => this.onContextMenu(event);
    this.handleDoubleClick = (event) => this.onDoubleClick(event);
    this.handleKeyDown = (event) => this.onKeyDown(event);
    this.handleKeyUp = (event) => this.onKeyUp(event);
    this.handleResize = () => this.resizeOverlay();

    this.resizeOverlay();

    this.chart.subscribeClick(this.handleClick);

    // Capture phase is intentional: Lightweight Charts attaches its own handlers
    // inside this container. Focus Box must see Shift-drag before chart panning.
    this.container.addEventListener("pointerdown", this.handlePointerDown, true);
    this.container.addEventListener("pointermove", this.handlePointerMove, true);
    window.addEventListener("pointerup", this.handlePointerUp, true);
    this.container.addEventListener("contextmenu", this.handleContextMenu, true);
    this.container.addEventListener("dblclick", this.handleDoubleClick, true);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("resize", this.handleResize);
  }

  registerTool(tool: ChartTool): void {
    this.registry.register(tool);
  }

  activateTool(toolId: ChartToolId): boolean {
    return this.registry.activate(toolId);
  }

  subscribeClick(listener: (point: ChartPointerPoint) => void): () => void {
    this.clickListeners.add(listener);
    return () => this.clickListeners.delete(listener);
  }

  subscribePointerDown(listener: (point: ChartPointerPoint) => void): () => void {
    this.pointerDownListeners.add(listener);
    return () => this.pointerDownListeners.delete(listener);
  }

  subscribePointerMove(listener: (point: ChartPointerPoint) => void): () => void {
    this.pointerMoveListeners.add(listener);
    return () => this.pointerMoveListeners.delete(listener);
  }

  subscribePointerUp(listener: (point: ChartPointerPoint) => void): () => void {
    this.pointerUpListeners.add(listener);
    return () => this.pointerUpListeners.delete(listener);
  }

  subscribeContextMenu(
    listener: (point: ChartPointerPoint) => void,
  ): () => void {
    this.contextMenuListeners.add(listener);
    return () => this.contextMenuListeners.delete(listener);
  }

  subscribeToolCompleted(
    listener: (event: ChartToolCompletionEvent) => void,
  ): () => void {
    this.toolCompletedListeners.add(listener);
    return () => this.toolCompletedListeners.delete(listener);
  }

  private onChartClick(param: MouseEventParams<Time>): void {
    const point = this.buildPointFromClick(param);
    if (!point) return;

    const event = createChartMouseEvent("click", point, point.nativeEvent);
    const handled =
      this.registry.getActiveTool()?.onClick?.(event, this.toolContext) === true;

    if (!handled) {
      for (const listener of this.clickListeners) listener(point);
    }

    this.processCompletedTool();
  }

  private onPointerDown(nativeEvent: PointerEvent): void {
    const point = this.buildPointFromPointerEvent(nativeEvent);
    if (!point) return;

    this.lastPointerPoint = point;
    const event = createChartMouseEvent("pointerdown", point, nativeEvent);

    let handled = false;
    if (nativeEvent.shiftKey) {
      this.focusGestureActive = true;
      this.setNavigationSuppressed(true);
      handled =
        this.focusBoxTool.onMouseDown?.(event, this.toolContext) === true;
    } else {
      handled =
        this.registry
          .getActiveTool()
          ?.onMouseDown?.(event, this.toolContext) === true;
    }

    if (handled) {
      this.blockNativeEvent(nativeEvent);
    } else {
      for (const listener of this.pointerDownListeners) listener(point);
    }

    this.scheduleOverlayRender();
  }

  private onPointerMove(nativeEvent: PointerEvent): void {
    const point = this.buildPointFromPointerEvent(nativeEvent);
    if (!point) return;

    this.lastPointerPoint = point;
    const event = createChartMouseEvent("pointermove", point, nativeEvent);

    let handled = false;
    if (this.focusGestureActive || nativeEvent.shiftKey) {
      if (nativeEvent.shiftKey) this.setNavigationSuppressed(true);
      handled =
        this.focusBoxTool.onMouseMove?.(event, this.toolContext) === true;
    } else {
      handled =
        this.registry
          .getActiveTool()
          ?.onMouseMove?.(event, this.toolContext) === true;
    }

    if (handled) {
      this.blockNativeEvent(nativeEvent);
    } else {
      for (const listener of this.pointerMoveListeners) listener(point);
    }

    this.scheduleOverlayRender();
  }

  private onPointerUp(nativeEvent: PointerEvent): void {
    const point =
      this.buildPointFromPointerEvent(nativeEvent) ??
      this.lastPointerPoint ??
      this.buildFallbackPointFromMouseEvent(nativeEvent);

    if (!point) return;

    this.lastPointerPoint = null;
    const event = createChartMouseEvent("pointerup", point, nativeEvent);

    let handled = false;
    if (this.focusGestureActive || nativeEvent.shiftKey) {
      handled = this.focusBoxTool.onMouseUp?.(event, this.toolContext) === true;
      this.focusGestureActive = false;
      this.setNavigationSuppressed(false);
    } else {
      handled =
        this.registry.getActiveTool()?.onMouseUp?.(event, this.toolContext) ===
        true;
    }

    if (handled) {
      this.blockNativeEvent(nativeEvent);
    } else {
      for (const listener of this.pointerUpListeners) listener(point);
    }

    this.processCompletedTool();
    this.scheduleOverlayRender();
  }

  private onContextMenu(nativeEvent: MouseEvent): void {
    if (nativeEvent.shiftKey || this.focusGestureActive) {
      this.blockNativeEvent(nativeEvent);
      return;
    }

    const point = this.buildFallbackPointFromMouseEvent(nativeEvent);
    if (!point) return;

    const event = createChartMouseEvent("contextmenu", point, nativeEvent);
    const handled =
      this.registry
        .getActiveTool()
        ?.onContextMenu?.(event, this.toolContext) === true;

    if (handled) {
      this.blockNativeEvent(nativeEvent);
      this.processCompletedTool();
      this.scheduleOverlayRender();
      return;
    }

    for (const listener of this.contextMenuListeners) listener(point);
  }

  private onDoubleClick(nativeEvent: MouseEvent): void {
    const point = this.buildFallbackPointFromMouseEvent(nativeEvent);
    if (!point) return;

    const event = createChartMouseEvent("doubleclick", point, nativeEvent);

    let handled = false;

    if (nativeEvent.shiftKey) {
      handled =
        this.focusBoxTool.onDoubleClick?.(event, this.toolContext) === true;
    } else {
      handled =
        this.registry
          .getActiveTool()
          ?.onDoubleClick?.(event, this.toolContext) === true;
    }

    if (handled) {
      this.blockNativeEvent(nativeEvent);
      this.processCompletedTool();
    }

    this.scheduleOverlayRender();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Shift") {
      this.setNavigationSuppressed(true);
      this.container.style.cursor = "crosshair";
      return;
    }

    if (event.key === "Escape") {
      const activeTool = this.registry.getActiveTool();
      const toolHandled =
        activeTool?.onKeyDown?.(event, this.toolContext) === true;

      if (toolHandled) {
        this.focusGestureActive = false;
        this.setNavigationSuppressed(false);
        this.processCompletedTool();
        this.scheduleOverlayRender();
        return;
      }

      const focusHandled =
        this.focusBoxTool.onCancel?.(this.toolContext) === true;

      this.focusGestureActive = false;
      this.setNavigationSuppressed(false);
      this.clearOverlay();

      if (!focusHandled) {
        this.registry.cancelActiveTool();
      }

      this.scheduleOverlayRender();
      return;
    }

    const handled =
      this.registry.getActiveTool()?.onKeyDown?.(event, this.toolContext) ===
      true;

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      this.processCompletedTool();
      this.scheduleOverlayRender();
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (event.key !== "Shift") return;
    if (this.focusGestureActive) return;

    this.setNavigationSuppressed(false);
    this.container.style.cursor = "";
  }

  private processCompletedTool(): void {
    const tool = this.registry.getActiveTool();
    if (!tool?.isComplete?.()) return;

    const completion: ChartToolCompletionEvent = {
      toolId: tool.id,
      payload: tool.getCompletionPayload?.() ?? null,
    };

    tool.resetCompletion?.();
    this.registry.activate("select");
    this.toolContext.onToolCompleted?.(
      completion.toolId,
      completion.payload,
    );
    this.scheduleOverlayRender();
  }

  private emitToolCompleted(event: ChartToolCompletionEvent): void {
    for (const listener of this.toolCompletedListeners) {
      listener(event);
    }

    window.dispatchEvent(
      new CustomEvent<ChartToolCompletionEvent>(
        CHART_TOOL_COMPLETED_EVENT,
        { detail: event },
      ),
    );
  }

  private setNavigationSuppressed(suppressed: boolean): void {
    if (this.navigationSuppressed === suppressed) return;

    this.navigationSuppressed = suppressed;
    this.toolContext.setChartNavigationEnabled?.(!suppressed);
  }

  private blockNativeEvent(event: MouseEvent | PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  private resizeOverlay(): void {
    const rect = this.container.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    this.overlayCanvas.style.width = `${width}px`;
    this.overlayCanvas.style.height = `${height}px`;
    this.overlayCanvas.width = Math.max(1, Math.floor(width * pixelRatio));
    this.overlayCanvas.height = Math.max(1, Math.floor(height * pixelRatio));
    this.overlayContext.setTransform(
      pixelRatio,
      0,
      0,
      pixelRatio,
      0,
      0,
    );
    this.scheduleOverlayRender();
  }

  private scheduleOverlayRender(): void {
    if (this.overlayRenderFrame != null) return;

    this.overlayRenderFrame = window.requestAnimationFrame(() => {
      this.overlayRenderFrame = null;
      this.drawOverlay();
    });
  }

  private clearOverlay(): void {
    const rect = this.container.getBoundingClientRect();
    this.overlayContext.clearRect(0, 0, rect.width, rect.height);
  }

  private drawOverlay(): void {
    this.clearOverlay();

    for (const tool of this.registry.getTools()) {
      tool.drawOverlay?.(this.overlayContext, this.toolContext);
    }
  }

  destroy(): void {
    this.chart.unsubscribeClick(this.handleClick);
    this.container.removeEventListener(
      "pointerdown",
      this.handlePointerDown,
      true,
    );
    this.container.removeEventListener(
      "pointermove",
      this.handlePointerMove,
      true,
    );
    window.removeEventListener("pointerup", this.handlePointerUp, true);
    this.container.removeEventListener(
      "contextmenu",
      this.handleContextMenu,
      true,
    );
    this.container.removeEventListener(
      "dblclick",
      this.handleDoubleClick,
      true,
    );
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("resize", this.handleResize);

    if (this.overlayRenderFrame != null) {
      window.cancelAnimationFrame(this.overlayRenderFrame);
      this.overlayRenderFrame = null;
    }

    this.clickListeners.clear();
    this.pointerDownListeners.clear();
    this.pointerMoveListeners.clear();
    this.pointerUpListeners.clear();
    this.contextMenuListeners.clear();
    this.toolCompletedListeners.clear();

    this.clearOverlay();
    this.overlayCanvas.remove();
    this.container.style.cursor = "";
    this.setNavigationSuppressed(false);
  }
}