// src/components/chart/DrawingRenderer.ts

import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

import type {
  ChartDrawing,
  DrawingStyle,
  HorizontalLineDrawing,
  LongPositionDrawing,
  MarketStructureDrawing,
  PriceRangeDrawing,
  RectangleDrawing,
  TrendlineDrawing,
} from "./DrawingTypes";
import { formatTickPrice, roundToTick } from "../../trading/pricing/TickSizeManager";

type LineSeriesApi = ISeriesApi<"Line">;
type BoxDrawing = RectangleDrawing | PriceRangeDrawing;

function lineWidth(width: number): 1 | 2 | 3 | 4 {
  if (width <= 1) return 1;
  if (width === 2) return 2;
  if (width === 3) return 3;
  return 4;
}

function svgNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 100) / 100);
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "--";

  const formatted = formatTickPrice(value);
  return formatted || "--";
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}%`;
}

export class DrawingRenderer {
  private chart: IChartApi;
  private priceSeries: ISeriesApi<"Candlestick">;
  private container?: HTMLDivElement;
  private drawingSeries = new Map<string, LineSeriesApi>();
  private handleSeries = new Map<string, LineSeriesApi>();
  private boxElements = new Map<string, SVGElement[]>();
  private svgOverlay: SVGSVGElement | null = null;

  constructor(
    chart: IChartApi,
    priceSeries: ISeriesApi<"Candlestick">,
    container?: HTMLDivElement,
  ) {
    this.chart = chart;
    this.priceSeries = priceSeries;
    this.container = container;

    if (container) {
      this.svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svgOverlay.style.position = "absolute";
      this.svgOverlay.style.inset = "0";
      this.svgOverlay.style.pointerEvents = "none";
      this.svgOverlay.style.overflow = "hidden";
      this.svgOverlay.style.zIndex = "7";
      container.appendChild(this.svgOverlay);
      this.resizeSvgOverlay();
    }
  }

  private ensureSvgOverlay(): SVGSVGElement | null {
    if (!this.container) return this.svgOverlay;

    if (!this.svgOverlay) {
      this.svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svgOverlay.style.position = "absolute";
      this.svgOverlay.style.inset = "0";
      this.svgOverlay.style.pointerEvents = "none";
      this.svgOverlay.style.overflow = "hidden";
      this.svgOverlay.style.zIndex = "7";
      this.container.appendChild(this.svgOverlay);
    }

    this.resizeSvgOverlay();
    return this.svgOverlay;
  }

  clear(): void {
    for (const series of this.drawingSeries.values()) {
      this.chart.removeSeries(series);
    }

    for (const series of this.handleSeries.values()) {
      this.chart.removeSeries(series);
    }

    for (const elements of this.boxElements.values()) {
      for (const element of elements) element.remove();
    }

    this.drawingSeries.clear();
    this.handleSeries.clear();
    this.boxElements.clear();
    this.svgOverlay?.remove();
    this.svgOverlay = null;
  }

  removeDrawing(id: string): void {
    const line = this.drawingSeries.get(id);
    if (line) {
      this.chart.removeSeries(line);
      this.drawingSeries.delete(id);
    }

    const handles = this.handleSeries.get(id);
    if (handles) {
      this.chart.removeSeries(handles);
      this.handleSeries.delete(id);
    }

    this.removeBox(id);
  }

  renderAll(drawings: ChartDrawing[], selectedDrawingId: string | null): void {
    this.ensureSvgOverlay();

    const activeIds = new Set(drawings.map((drawing) => drawing.id));

    for (const id of Array.from(this.drawingSeries.keys())) {
      if (!activeIds.has(id)) this.removeLine(id);
    }

    for (const id of Array.from(this.handleSeries.keys())) {
      if (!activeIds.has(id)) this.removeHandles(id);
    }

    for (const id of Array.from(this.boxElements.keys())) {
      if (!activeIds.has(id)) this.removeBox(id);
    }

    for (const drawing of drawings) {
      this.renderDrawing(drawing, selectedDrawingId);
    }
  }

  renderDrawing(drawing: ChartDrawing, selectedDrawingId: string | null): void {
    if (drawing.type === "horizontal") {
      this.removeBox(drawing.id);
      this.renderHorizontalLine(drawing);
      this.renderHandlesForDrawing(drawing, selectedDrawingId);
      return;
    }

    if (drawing.type === "trendline") {
      this.removeBox(drawing.id);
      this.renderTrendline(drawing);
      this.renderHandlesForDrawing(drawing, selectedDrawingId);
      return;
    }

    if (drawing.type === "marketStructure") {
      this.removeBox(drawing.id);
      this.renderMarketStructure(drawing);
      this.renderHandlesForDrawing(drawing, selectedDrawingId);
      return;
    }

    this.removeLine(drawing.id);
    this.removeHandles(drawing.id);

    if (drawing.type === "rectangle" || drawing.type === "priceRange") {
      this.renderBox(drawing, selectedDrawingId);
      return;
    }

    if (drawing.type === "longPosition") {
      this.renderLongPosition(drawing, selectedDrawingId);
    }
  }

  private removeLine(id: string): void {
    const existing = this.drawingSeries.get(id);
    if (existing) {
      this.chart.removeSeries(existing);
      this.drawingSeries.delete(id);
    }
  }

  private removeHandles(id: string): void {
    const existing = this.handleSeries.get(id);
    if (existing) {
      this.chart.removeSeries(existing);
      this.handleSeries.delete(id);
    }
  }

  private removeBox(id: string): void {
    const elements = this.boxElements.get(id);
    if (!elements) return;

    for (const element of elements) element.remove();
    this.boxElements.delete(id);
  }

  private baseLineOptions(style: DrawingStyle) {
    return {
      priceScaleId: "right",
      color: style.color,
      lineWidth: lineWidth(style.width),
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
    };
  }

  private handleLineOptions(style: DrawingStyle) {
    return {
      priceScaleId: "right",
      color: style.color,
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 5,
    } as any;
  }

  private renderHorizontalLine(drawing: HorizontalLineDrawing): void {
    let series = this.drawingSeries.get(drawing.id);

    if (!series) {
      series = this.chart.addSeries(
        LineSeries,
        this.baseLineOptions(drawing.style),
      );
      this.drawingSeries.set(drawing.id, series);
    } else {
      series.applyOptions(this.baseLineOptions(drawing.style));
    }

    const range = this.chart.timeScale().getVisibleRange();
    const from = Number(range?.from ?? Math.floor(Date.now() / 1000) - 86400);
    const to = Number(range?.to ?? Math.floor(Date.now() / 1000) + 86400);

    series.setData([
      { time: from as Time, value: drawing.price },
      { time: to as Time, value: drawing.price },
    ]);
  }

  private renderTrendline(drawing: TrendlineDrawing): void {
    const { p1Time, p1Price, p2Time, p2Price } =
      this.getRenderedTrendlinePoints(drawing);

    if (p1Time === p2Time) {
      this.removeLine(drawing.id);
      return;
    }

    let series = this.drawingSeries.get(drawing.id);

    if (!series) {
      series = this.chart.addSeries(
        LineSeries,
        this.baseLineOptions(drawing.style),
      );
      this.drawingSeries.set(drawing.id, series);
    } else {
      series.applyOptions(this.baseLineOptions(drawing.style));
    }

    series.setData([
      { time: p1Time as Time, value: p1Price },
      { time: p2Time as Time, value: p2Price },
    ]);
  }

  private renderMarketStructure(drawing: MarketStructureDrawing): void {
    const points = drawing.nodes
      .map((node) => ({
        time: Number(node.time),
        price: Number(node.price),
      }))
      .filter(
        (node) =>
          Number.isFinite(node.time) &&
          Number.isFinite(node.price),
      )
      .sort((a, b) => a.time - b.time);

    if (points.length < 2) {
      this.removeLine(drawing.id);
      return;
    }

    let series = this.drawingSeries.get(drawing.id);

    if (!series) {
      series = this.chart.addSeries(
        LineSeries,
        this.baseLineOptions(drawing.style),
      );
      this.drawingSeries.set(drawing.id, series);
    } else {
      series.applyOptions(this.baseLineOptions(drawing.style));
    }

    series.setData(
      points.map((point) => ({
        time: point.time as Time,
        value: point.price,
      })),
    );
  }

  private renderBox(
    drawing: BoxDrawing,
    selectedDrawingId: string | null,
  ): void {
    const overlay = this.ensureSvgOverlay();
    if (!overlay) return;

    const p1x =
      this.chart.timeScale().timeToCoordinate(Number(drawing.p1.time) as Time) ??
      drawing.p1.x ??
      null;
    const p2x =
      this.chart.timeScale().timeToCoordinate(Number(drawing.p2.time) as Time) ??
      drawing.p2.x ??
      null;
    const p1y =
      this.priceSeries.priceToCoordinate(Number(drawing.p1.price)) ??
      drawing.p1.y ??
      null;
    const p2y =
      this.priceSeries.priceToCoordinate(Number(drawing.p2.price)) ??
      drawing.p2.y ??
      null;

    if (p1x == null || p2x == null || p1y == null || p2y == null) return;

    const left = Math.min(p1x, p2x);
    const right = Math.max(p1x, p2x);
    const top = Math.min(p1y, p2y);
    const bottom = Math.max(p1y, p2y);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const elements: SVGElement[] = [];

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", svgNumber(left));
    rect.setAttribute("y", svgNumber(top));
    rect.setAttribute("width", svgNumber(width));
    rect.setAttribute("height", svgNumber(height));
    rect.setAttribute("fill", drawing.style.color);
    rect.setAttribute("fill-opacity", drawing.type === "priceRange" ? "0.10" : "0.14");
    rect.setAttribute("stroke", drawing.style.color);
    rect.setAttribute("stroke-width", String(lineWidth(drawing.style.width)));
    rect.setAttribute("vector-effect", "non-scaling-stroke");
    overlay.appendChild(rect);
    elements.push(rect);

    if (drawing.type === "priceRange") {
      this.renderPriceRangeLabels(drawing, left, right, top, bottom, elements, overlay);
    }

    if (drawing.id === selectedDrawingId) {
      const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      outline.setAttribute("x", svgNumber(left));
      outline.setAttribute("y", svgNumber(top));
      outline.setAttribute("width", svgNumber(width));
      outline.setAttribute("height", svgNumber(height));
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", "#ffffff");
      outline.setAttribute("stroke-width", "1");
      outline.setAttribute("stroke-dasharray", "4 4");
      outline.setAttribute("vector-effect", "non-scaling-stroke");
      overlay.appendChild(outline);
      elements.push(outline);

      const midX = (left + right) / 2;
      const midY = (top + bottom) / 2;

      for (const [cx, cy] of [
        [left, top],
        [midX, top],
        [right, top],
        [right, midY],
        [right, bottom],
        [midX, bottom],
        [left, bottom],
        [left, midY],
      ]) {
        const handle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        handle.setAttribute("x", svgNumber(cx - 4));
        handle.setAttribute("y", svgNumber(cy - 4));
        handle.setAttribute("width", "8");
        handle.setAttribute("height", "8");
        handle.setAttribute("rx", "1.5");
        handle.setAttribute("fill", drawing.style.color);
        handle.setAttribute("stroke", "#ffffff");
        handle.setAttribute("stroke-width", "1");
        handle.setAttribute("vector-effect", "non-scaling-stroke");
        overlay.appendChild(handle);
        elements.push(handle);
      }
    }

    this.boxElements.set(drawing.id, elements);
  }

  private renderPriceRangeLabels(
    drawing: PriceRangeDrawing,
    left: number,
    right: number,
    top: number,
    bottom: number,
    elements: SVGElement[],
    overlay: SVGSVGElement,
  ): void {
    const high = Math.max(Number(drawing.p1.price), Number(drawing.p2.price));
    const low = Math.min(Number(drawing.p1.price), Number(drawing.p2.price));
    const entry = Number(drawing.p1.price);
    const range = high - low;
    const percent = Math.abs(entry) > 0 ? (range / Math.abs(entry)) * 100 : 0;
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;

    this.appendLabel(
      overlay,
      elements,
      right + 6,
      top + 12,
      `High ${formatPrice(high)}`,
      drawing.style.color,
    );
    this.appendLabel(
      overlay,
      elements,
      right + 6,
      bottom - 4,
      `Low ${formatPrice(low)}`,
      drawing.style.color,
    );
    this.appendLabel(
      overlay,
      elements,
      midX + 6,
      midY,
      `Range ${formatPrice(range)} / ${formatPercent(percent)}`,
      drawing.style.color,
    );
  }

  private appendLabel(
    overlay: SVGSVGElement,
    elements: SVGElement[],
    x: number,
    y: number,
    textValue: string,
    color: string,
  ): void {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", svgNumber(x));
    text.setAttribute("y", svgNumber(y));
    text.setAttribute("fill", color);
    text.setAttribute("font-size", "11");
    text.setAttribute("font-weight", "700");
    text.setAttribute("font-family", "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif");
    text.setAttribute("paint-order", "stroke");
    text.setAttribute("stroke", "rgba(17,19,21,.92)");
    text.setAttribute("stroke-width", "3");
    text.textContent = textValue;
    overlay.appendChild(text);
    elements.push(text);
  }

  private renderLongPosition(
    drawing: LongPositionDrawing,
    selectedDrawingId: string | null,
  ): void {
    const overlay = this.ensureSvgOverlay();
    if (!overlay) return;

    const entryX =
      this.chart.timeScale().timeToCoordinate(Number(drawing.entry.time) as Time) ??
      drawing.entry.x ??
      null;
    const stopX =
      this.chart.timeScale().timeToCoordinate(Number(drawing.stop.time) as Time) ??
      drawing.stop.x ??
      null;
    const targetX =
      this.chart.timeScale().timeToCoordinate(Number(drawing.target.time) as Time) ??
      drawing.target.x ??
      null;
    const entryY =
      this.priceSeries.priceToCoordinate(Number(drawing.entry.price)) ??
      drawing.entry.y ??
      null;
    const stopY =
      this.priceSeries.priceToCoordinate(Number(drawing.stop.price)) ??
      drawing.stop.y ??
      null;
    const targetY =
      this.priceSeries.priceToCoordinate(Number(drawing.target.price)) ??
      drawing.target.y ??
      null;

    if (
      entryX == null ||
      stopX == null ||
      targetX == null ||
      entryY == null ||
      stopY == null ||
      targetY == null
    ) {
      return;
    }

    const left = Math.min(entryX, stopX, targetX);
    const right = Math.max(entryX, stopX, targetX);
    const width = Math.max(1, right - left);
    const rewardTop = Math.min(entryY, targetY);
    const rewardBottom = Math.max(entryY, targetY);
    const riskTop = Math.min(entryY, stopY);
    const riskBottom = Math.max(entryY, stopY);
    const elements: SVGElement[] = [];

    const rewardRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rewardRect.setAttribute("x", svgNumber(left));
    rewardRect.setAttribute("y", svgNumber(rewardTop));
    rewardRect.setAttribute("width", svgNumber(width));
    rewardRect.setAttribute("height", svgNumber(Math.max(1, rewardBottom - rewardTop)));
    rewardRect.setAttribute("fill", "#22c55e");
    rewardRect.setAttribute("fill-opacity", "0.16");
    rewardRect.setAttribute("stroke", "#22c55e");
    rewardRect.setAttribute("stroke-width", "1");
    rewardRect.setAttribute("vector-effect", "non-scaling-stroke");
    overlay.appendChild(rewardRect);
    elements.push(rewardRect);

    const riskRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    riskRect.setAttribute("x", svgNumber(left));
    riskRect.setAttribute("y", svgNumber(riskTop));
    riskRect.setAttribute("width", svgNumber(width));
    riskRect.setAttribute("height", svgNumber(Math.max(1, riskBottom - riskTop)));
    riskRect.setAttribute("fill", "#ef4444");
    riskRect.setAttribute("fill-opacity", "0.16");
    riskRect.setAttribute("stroke", "#ef4444");
    riskRect.setAttribute("stroke-width", "1");
    riskRect.setAttribute("vector-effect", "non-scaling-stroke");
    overlay.appendChild(riskRect);
    elements.push(riskRect);

    for (const [y, color, label] of [
      [targetY, "#22c55e", "Target"],
      [entryY, drawing.style.color, "Entry"],
      [stopY, "#ef4444", "Stop"],
    ] as Array<[number, string, string]>) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", svgNumber(left));
      line.setAttribute("y1", svgNumber(y));
      line.setAttribute("x2", svgNumber(right));
      line.setAttribute("y2", svgNumber(y));
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", String(lineWidth(drawing.style.width)));
      line.setAttribute("vector-effect", "non-scaling-stroke");
      overlay.appendChild(line);
      elements.push(line);

      const price =
        label === "Target"
          ? Number(drawing.target.price)
          : label === "Stop"
            ? Number(drawing.stop.price)
            : Number(drawing.entry.price);
      this.appendLabel(overlay, elements, right + 6, y + 4, `${label} ${formatPrice(price)}`, color);
    }

    const entryPrice = roundToTick(Number(drawing.entry.price));
    const stopPrice = roundToTick(Number(drawing.stop.price));
    const targetPrice = roundToTick(Number(drawing.target.price));
    const risk = Math.abs(entryPrice - stopPrice);
    const reward = Math.abs(targetPrice - entryPrice);
    const rr = risk > 0 ? reward / risk : 0;
    const riskPercent = Math.abs(entryPrice) > 0 ? (risk / Math.abs(entryPrice)) * 100 : 0;
    const rewardPercent = Math.abs(entryPrice) > 0 ? (reward / Math.abs(entryPrice)) * 100 : 0;

    this.appendLabel(
      overlay,
      elements,
      left + 6,
      Math.min(entryY, targetY) + 14,
      `Reward ${formatPrice(reward)} / ${formatPercent(rewardPercent)}`,
      "#22c55e",
    );
    this.appendLabel(
      overlay,
      elements,
      left + 6,
      Math.max(entryY, stopY) - 6,
      `Risk ${formatPrice(risk)} / ${formatPercent(riskPercent)} | R:R ${rr.toFixed(2)}`,
      "#ef4444",
    );

    if (drawing.id === selectedDrawingId) {
      const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const top = Math.min(entryY, stopY, targetY);
      const bottom = Math.max(entryY, stopY, targetY);
      outline.setAttribute("x", svgNumber(left));
      outline.setAttribute("y", svgNumber(top));
      outline.setAttribute("width", svgNumber(width));
      outline.setAttribute("height", svgNumber(Math.max(1, bottom - top)));
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", "#ffffff");
      outline.setAttribute("stroke-width", "1");
      outline.setAttribute("stroke-dasharray", "4 4");
      outline.setAttribute("vector-effect", "non-scaling-stroke");
      overlay.appendChild(outline);
      elements.push(outline);

      for (const [cx, cy, color] of [
        [entryX, entryY, drawing.style.color],
        [stopX, stopY, "#ef4444"],
        [targetX, targetY, "#22c55e"],
      ] as Array<[number, number, string]>) {
        const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        handle.setAttribute("cx", svgNumber(cx));
        handle.setAttribute("cy", svgNumber(cy));
        handle.setAttribute("r", "5");
        handle.setAttribute("fill", color);
        handle.setAttribute("stroke", "#ffffff");
        handle.setAttribute("stroke-width", "1");
        handle.setAttribute("vector-effect", "non-scaling-stroke");
        overlay.appendChild(handle);
        elements.push(handle);
      }
    }

    this.boxElements.set(drawing.id, elements);
  }

  private renderHandlesForDrawing(
    drawing: ChartDrawing,
    selectedDrawingId: string | null,
  ): void {
    if (
      drawing.id !== selectedDrawingId ||
      (drawing.type !== "trendline" && drawing.type !== "marketStructure")
    ) {
      this.removeHandles(drawing.id);
      return;
    }

    let series = this.handleSeries.get(drawing.id);

    if (!series) {
      series = this.chart.addSeries(
        LineSeries,
        this.handleLineOptions(drawing.style),
      );
      this.handleSeries.set(drawing.id, series);
    } else {
      series.applyOptions(this.handleLineOptions(drawing.style));
    }

    if (drawing.type === "trendline") {
      series.setData([
        {
          time: Number(drawing.p1.time) as Time,
          value: Number(drawing.p1.price),
        },
        {
          time: Number(drawing.p2.time) as Time,
          value: Number(drawing.p2.price),
        },
      ]);
    } else {
      series.setData(
        drawing.nodes
          .map((node) => ({
            time: Number(node.time) as Time,
            value: Number(node.price),
          }))
          .filter(
            (node) =>
              Number.isFinite(Number(node.time)) &&
              Number.isFinite(node.value),
          )
          .sort((a, b) => Number(a.time) - Number(b.time)),
      );
    }
  }

  private resizeSvgOverlay(): void {
    if (!this.svgOverlay || !this.container) return;

    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    this.svgOverlay.setAttribute("width", String(width));
    this.svgOverlay.setAttribute("height", String(height));
    this.svgOverlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  private getRenderedTrendlinePoints(drawing: TrendlineDrawing): {
    p1Time: number;
    p1Price: number;
    p2Time: number;
    p2Price: number;
  } {
    const p1Time = Number(drawing.p1.time);
    const p2ActualTime = Number(drawing.p2.time);
    const p1Price = Number(drawing.p1.price);
    const p2ActualPrice = Number(drawing.p2.price);

    if (!drawing.style.extendRight || p1Time === p2ActualTime) {
      return {
        p1Time,
        p1Price,
        p2Time: p2ActualTime,
        p2Price: p2ActualPrice,
      };
    }

    const visibleRange = this.chart.timeScale().getVisibleRange();
    const visibleTo = Number(visibleRange?.to ?? p2ActualTime);
    const finalTime = Math.max(p2ActualTime, visibleTo);

    const p1X = this.chart.timeScale().timeToCoordinate(p1Time as Time);
    const p2X = this.chart.timeScale().timeToCoordinate(p2ActualTime as Time);
    const finalX = this.chart.timeScale().timeToCoordinate(finalTime as Time);
    const p1Y = this.priceSeries.priceToCoordinate(p1Price);
    const p2Y = this.priceSeries.priceToCoordinate(p2ActualPrice);

    if (
      p1X == null ||
      p2X == null ||
      finalX == null ||
      p1Y == null ||
      p2Y == null ||
      p1X === p2X
    ) {
      return {
        p1Time,
        p1Price,
        p2Time: p2ActualTime,
        p2Price: p2ActualPrice,
      };
    }

    const pixelSlope = (p2Y - p1Y) / (p2X - p1X);
    const finalY = p1Y + pixelSlope * (finalX - p1X);
    const finalPrice =
      this.priceSeries.coordinateToPrice(finalY) ?? p2ActualPrice;

    return {
      p1Time,
      p1Price,
      p2Time: finalTime,
      p2Price: finalPrice,
    };
  }
}