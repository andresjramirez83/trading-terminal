import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { AIMarkup, AIProjections, AIMultiTimeframe, AILiquiditySweepMatch } from "../../../services/aiAnalysis";
import { selectCleanAIView } from "./aiCleanViewModel";
import type { AIMarkupCommand, AIOverlayMode } from "./aiMarkupEvents";

const TONES: Record<AIMarkup["tone"], { stroke: string; fill: string }> = {
  confirmed: { stroke: "#34d399", fill: "rgba(52,211,153,0.14)" },
  watch: { stroke: "#facc15", fill: "rgba(250,204,21,0.10)" },
  risk: { stroke: "#fb7185", fill: "rgba(251,113,133,0.12)" },
  context: { stroke: "#60a5fa", fill: "rgba(96,165,250,0.12)" },
};

function usablePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Independently rendered, read-only overlay. Never enters DrawingStore. */
export class AIMarkupLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private frame: number | null = null;
  private marks: AIMarkup[] = [];
  private projections: AIProjections | null = null;
  private multiTimeframe: AIMultiTimeframe | null = null;
  private patternMatch: AILiquiditySweepMatch | null = null;
  private viewMode: AIOverlayMode = "clean";
  private symbol = "";
  private timeframe = "5m";
  private visible = true;
  private pathsVisible = true;
  private resizeObserver: ResizeObserver | null = null;

  private readonly onViewportChange = () => this.schedule();
  private readonly onPointerRefresh = () => this.schedule();

  constructor(private chart: IChartApi, private series: ISeriesApi<"Candlestick">, private host: HTMLDivElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-label", "Read-only AI chart research marks");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:8;";
    this.host.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("AI overlays require a 2D canvas");
    this.ctx = ctx;
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onViewportChange);
    this.host.addEventListener("wheel", this.onPointerRefresh, { passive: true });
    this.host.addEventListener("pointerup", this.onPointerRefresh);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onViewportChange);
      this.resizeObserver.observe(this.host);
    }
    this.schedule();
  }

  setContext(symbol: string, timeframe: string): void {
    const next = symbol.trim().toUpperCase();
    if (next !== this.symbol) { this.marks = []; this.projections = null; this.multiTimeframe = null; this.patternMatch = null; this.visible = true; this.pathsVisible = true; }
    this.symbol = next;
    this.timeframe = String(timeframe).toLowerCase();
    this.schedule();
  }

  command(message: AIMarkupCommand): void {
    if (message.symbol.trim().toUpperCase() !== this.symbol) return;
    if (message.mode === "set") {
      this.marks = message.marks.filter((m) =>
        !!m && m.source === "closed_bars" &&
        (m.kind === "marker" || m.kind === "zone" || m.kind === "level" || m.kind === "projection") &&
        (m.tone in TONES) && typeof m.label === "string").slice(0, 36);
      this.projections = message.projections ?? null;
      this.multiTimeframe = message.multiTimeframe ?? null;
      this.patternMatch = message.patternMatch ?? null;
      this.visible = true;
      this.pathsVisible = true;
    } else if (message.mode === "view") {
      this.viewMode = message.view;
      this.visible = message.view !== "hidden";
    } else if (message.mode === "toggle") this.visible = !this.visible;
    else if (message.mode === "paths") this.pathsVisible = !this.pathsVisible;
    else if (message.mode === "clear") { this.marks = []; this.projections = null; this.multiTimeframe = null; this.patternMatch = null; }
    this.schedule();
  }

  schedule(): void {
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => { this.frame = null; this.render(); });
  }

  private render(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const physicalWidth = Math.round(width * dpr), physicalHeight = Math.round(height * dpr);
    if (this.canvas.width !== physicalWidth || this.canvas.height !== physicalHeight) {
      this.canvas.width = physicalWidth;
      this.canvas.height = physicalHeight;
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    if (!this.visible || this.viewMode === "hidden") return;
    if (this.viewMode === "clean") {
      if (this.patternMatch && this.patternMatch.timeframe === this.timeframe) {
        this.renderSavedPattern(width, height);
        return;
      }
      this.renderClean(width, height); return;
    }
    if (!this.marks.length) return;
    const plotWidth = Math.min(width, this.chart.timeScale().width());
    if (!Number.isFinite(plotWidth) || plotWidth < 20) return;
    g.save();
    g.beginPath(); g.rect(0, 0, plotWidth, height); g.clip();
    g.font = "11px system-ui, sans-serif";
    for (const mark of this.marks) {
      if (mark.timeframe !== "all" && mark.timeframe !== this.timeframe) continue;
      if (mark.kind === "projection" && !this.pathsVisible) continue;
      const colors = TONES[mark.tone];
      const boundedLabel = mark.label.slice(0, 70);
      const drawLabel = (x: number, y: number) => {
        g.save();
        const labelWidth = Math.min(240, g.measureText(boundedLabel).width + 12);
        const lx = Math.max(3, Math.min(plotWidth - labelWidth - 4, x));
        const ly = Math.max(3, Math.min(height - 18, y - 14));
        g.fillStyle = "rgba(9,16,29,.86)";
        g.fillRect(lx, ly, labelWidth, 16);
        g.fillStyle = colors.stroke;
        g.fillText(boundedLabel, lx + 6, ly + 12);
        g.restore();
      };
      if (mark.kind === "zone") {
        if (!usablePrice(mark.high) || !usablePrice(mark.low) || mark.high < mark.low) continue;
        const y1 = this.series.priceToCoordinate(mark.high);
        const y2 = this.series.priceToCoordinate(mark.low);
        if (y1 == null || y2 == null) continue;
        const top = Math.min(y1, y2), thickness = Math.max(2, Math.abs(y2-y1));
        g.fillStyle = colors.fill;
        g.fillRect(0, top, plotWidth, thickness);
        g.strokeStyle = colors.stroke;
        g.setLineDash([4,4]); g.strokeRect(.5, top+.5, plotWidth-1, thickness); g.setLineDash([]);
        drawLabel(plotWidth-245, top-1);
      } else if (mark.kind === "level") {
        if (!usablePrice(mark.price)) continue;
        const y = this.series.priceToCoordinate(mark.price);
        if (y == null || !Number.isFinite(y)) continue;
        g.strokeStyle = colors.stroke;
        g.lineWidth = 1;
        g.setLineDash([6,4]);
        g.beginPath(); g.moveTo(1,y+.5); g.lineTo(plotWidth,y+.5); g.stroke(); g.setLineDash([]);
        drawLabel(plotWidth-245, y-2);
      } else if (mark.kind === "projection") {
        // Position paths in FUTURE chart slots; never add synthetic OHLCV bars.
        // Only future screen space currently visible on the right is drawn.
        if (!usablePrice(mark.price) || !Number.isFinite(mark.time_ms) || !mark.time_ms || mark.time_ms <= 0) continue;
        const valid = mark.points?.filter((point) =>
          Number.isInteger(point.step) && point.step >= 0 && point.step <= 20 && usablePrice(point.price));
        if (!valid || valid.length < 2 || valid.length > 8 || valid[0].step !== 0 ||
            valid[0].price !== mark.price || valid.some((p, i) => i > 0 && p.step <= valid[i - 1].step)) continue;
        const anchorX = this.chart.timeScale().timeToCoordinate(Math.floor(mark.time_ms / 1000) as Time);
        if (anchorX == null || !Number.isFinite(anchorX) || anchorX >= plotWidth || anchorX < -10) continue;
        const barSpacing = Math.max(2, Math.min(30, this.chart.timeScale().options().barSpacing || 6));
        let count = 0;
        let endX: number = anchorX, endY = 0;
        g.save();
        g.globalAlpha = mark.stale ? .35 : .95;
        g.lineWidth = mark.scenario === "base" ? 2.5 : 1.8;
        g.strokeStyle = colors.stroke;
        g.setLineDash(mark.scenario === "base" ? [7, 3] : [3, 5]);
        g.beginPath();
        for (const point of valid) {
          const x = anchorX + point.step * barSpacing;
          const y = this.series.priceToCoordinate(point.price);
          if (y == null || !Number.isFinite(y)) continue;
          if (count === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
          count++;
          endX = x; endY = y;
        }
        if (count >= 2) g.stroke();
        g.setLineDash([]);
        if (count >= 2 && endX < plotWidth - 12 && endY >= 0 && endY <= height) {
          // Short arrowhead pointing along the last segment; no entry signal.
          const prev = valid[valid.length - 2];
          const prevY = this.series.priceToCoordinate(prev.price);
          const prevX = anchorX + prev.step * barSpacing;
          if (prevY != null) {
            const angle = Math.atan2(endY - prevY, endX - prevX);
            g.fillStyle = colors.stroke;
            g.beginPath(); g.moveTo(endX, endY);
            g.lineTo(endX - 8 * Math.cos(angle - .55), endY - 8 * Math.sin(angle - .55));
            g.lineTo(endX - 8 * Math.cos(angle + .55), endY - 8 * Math.sin(angle + .55));
            g.closePath(); g.fill();
          }
          drawLabel(Math.max(anchorX + 5, endX - 130), endY - (mark.scenario === "bull" ? 13 : mark.scenario === "bear" ? -18 : 0));
        }
        g.restore();
      } else if (mark.kind === "marker") {
        if (!usablePrice(mark.price) || !Number.isFinite(mark.time_ms) || !mark.time_ms || mark.time_ms <= 0) continue;
        const x = this.chart.timeScale().timeToCoordinate(Math.floor(mark.time_ms/1000) as Time);
        const y = this.series.priceToCoordinate(mark.price);
        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        g.fillStyle = colors.stroke; g.strokeStyle = "#0b1220"; g.lineWidth = 2;
        g.beginPath(); g.arc(x,y,5.5,0,2*Math.PI); g.fill(); g.stroke();
        drawLabel(x+9,y-6);
      }
    }
    g.restore();
    if (this.patternMatch && this.patternMatch.timeframe === this.timeframe) this.renderSavedPattern(width, height, true);
  }

  /**
   * Default read-only overlay: at most one conditional path, one local reaction
   * band, one target and one invalidation. No full-width fib ladder or captions.
   * This consumes the measured scenario already returned by the backend; it
   * never fabricates future OHLCV or writes into chart/manual drawing state.
   */
  private renderClean(width: number, height: number): void {
    const view = selectCleanAIView(this.timeframe, this.projections, this.marks, this.multiTimeframe);
    if (!view) return;
    const plotWidth = Math.min(width, this.chart.timeScale().width());
    if (!Number.isFinite(plotWidth) || plotWidth < 120) return;
    const anchor = this.chart.timeScale().timeToCoordinate(Math.floor(view.anchorTimeMs / 1000) as Time);
    if (anchor == null || !Number.isFinite(anchor) || anchor < -10 || anchor >= plotWidth) return;
    const xAnchor = Number(anchor);
    const spacing = Math.max(3, Math.min(24, this.chart.timeScale().options().barSpacing || 7));
    const g = this.ctx;
    const rgba = view.stale ? .4 : 1;

    g.save();
    g.beginPath(); g.rect(0, 0, plotWidth, height); g.clip();
    g.globalAlpha = rgba;

    // Small price reaction zone near recent candles, not a screen-wide band.
    const yTop = this.series.priceToCoordinate(view.reaction.high);
    const yLow = this.series.priceToCoordinate(view.reaction.low);
    if (yTop != null && yLow != null) {
      const left = Math.max(3, xAnchor - Math.min(105, spacing * 17));
      const right = Math.min(plotWidth - 8, xAnchor + spacing * 4);
      const top = Math.min(yTop, yLow);
      const boxHeight = Math.max(5, Math.abs(yLow - yTop));
      if (right > left + 10 && top < height && top + boxHeight > 0) {
        g.fillStyle = "rgba(56,189,248,.13)";
        g.strokeStyle = "rgba(56,189,248,.5)";
        g.lineWidth = 1;
        g.fillRect(left, top, right - left, boxHeight);
        g.strokeRect(left + .5, top + .5, right - left - 1, boxHeight);
        this.smallTag(g, left + 5, Math.max(13, top - 5), view.reaction.label, "#7dd3fc", plotWidth, height);
      }
    }

    // Short, localized watch levels. Keep text out of the candlestick bodies.
    const levelStart = Math.max(5, xAnchor + spacing * 1.3);
    const levelEnd = Math.min(plotWidth - 12, xAnchor + spacing * 12);
    if (levelEnd - levelStart > 42 && view.bias !== "range") {
      const drawLevel = (price: number | null, color: string, label: string) => {
        if (price == null) return;
        const y = this.series.priceToCoordinate(price);
        if (y == null || y < 8 || y > height - 8) return;
        g.save();
        g.strokeStyle = color; g.lineWidth = 1.4; g.setLineDash([4, 5]);
        g.beginPath(); g.moveTo(levelStart, y); g.lineTo(levelEnd, y); g.stroke();
        g.restore();
        this.smallTag(g, levelEnd + 4, y - 4, label, color, plotWidth, height);
      };
      drawLevel(view.target, "#4ade80", view.targetLabel);
      drawLevel(view.invalidation, "#fb7185", "Invalid");
    }

    // If the evidence is range-bound or stale, do not pretend there is a
    // reliable directional prediction to draw.
    if (view.bias === "range") {
      this.smallTag(g, Math.max(7, xAnchor + spacing), 22, "Range / wait", "#facc15", plotWidth, height);
    } else if (view.stale) {
      this.smallTag(g, Math.max(7, xAnchor + spacing), 22, "Historical only", "#facc15", plotWidth, height);
    } else if (this.pathsVisible && view.path) {
      const points: { x: number; y: number }[] = [];
      for (const point of view.path) {
        const y = this.series.priceToCoordinate(point.price);
        const x = xAnchor + point.step * spacing;
        if (y != null && Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y: Number(y) });
      }
      if (points.length >= 2) {
        g.save();
        g.strokeStyle = "#3b82f6"; g.fillStyle = "#3b82f6";
        g.lineWidth = 3; g.lineCap = "round"; g.lineJoin = "round";
        // Dashed so the path cannot be mistaken for actual historical candles.
        g.setLineDash([9, 5]);
        g.beginPath();
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          const previous = points[i - 1], current = points[i];
          // Rounded path segments, tied to the actual supplied prices.
          const midX = (previous.x + current.x) / 2;
          const midY = (previous.y + current.y) / 2;
          if (i === 1) g.lineTo(midX, midY);
          else g.quadraticCurveTo(previous.x, previous.y, midX, midY);
        }
        const tail = points[points.length - 1];
        g.lineTo(tail.x, tail.y);
        g.stroke(); g.setLineDash([]);
        const before = points[points.length - 2];
        const angle = Math.atan2(tail.y - before.y, tail.x - before.x);
        if (tail.x >= 0 && tail.x < plotWidth - 10 && tail.y >= 0 && tail.y < height) {
          g.beginPath(); g.moveTo(tail.x, tail.y);
          g.lineTo(tail.x - 9 * Math.cos(angle - .5), tail.y - 9 * Math.sin(angle - .5));
          g.lineTo(tail.x - 9 * Math.cos(angle + .5), tail.y - 9 * Math.sin(angle + .5));
          g.closePath(); g.fill();
        }
        g.restore();
      }
    }

    // One unlabeled ring for the newest confirmed candle, never a string of
    // overlapping annotations. Keep the full narrative in the Coach panel.
    if (view.marker) {
      const x = this.chart.timeScale().timeToCoordinate(Math.floor(view.marker.time_ms / 1000) as Time);
      const y = this.series.priceToCoordinate(view.marker.price);
      if (x != null && y != null && x >= 10 && x < plotWidth - 10 && y >= 10 && y < height - 10) {
        g.save(); g.strokeStyle = "#34d399"; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, 9, 0, 2 * Math.PI); g.stroke(); g.restore();
      }
    }
    g.restore();
  }

  /** Label only observed sweep/reclaim/retest candles. Not an AI-predicted path. */
  private renderSavedPattern(width: number, height: number, detailed = false): void {
    const match = this.patternMatch;
    if (!match) return;
    const plotWidth = Math.min(width, this.chart.timeScale().width());
    if (!Number.isFinite(plotWidth) || plotWidth < 120) return;
    const g = this.ctx;
    const timeX = (ms: number): number | null => {
      if (!Number.isSafeInteger(ms) || ms <= 0) return null;
      const coord = this.chart.timeScale().timeToCoordinate(Math.floor(ms/1000) as Time);
      return coord === null || !Number.isFinite(coord) ? null : Number(coord);
    };
    g.save();
    g.beginPath(); g.rect(0,0,plotWidth,height); g.clip();
    // No highlight/targets when the historical pattern isn't fully supported.
    if (match.status === "unsupported" || match.status === "not_found" || match.status === "insufficient_data") {
      const note = match.status === "unsupported" ? "Pattern rule not supported"
        : match.status === "insufficient_data" ? "Not enough closed candles"
        : "No confirmed sweep/reclaim";
      this.smallTag(g, Math.max(8, plotWidth - 190), 24, note, "#facc15", plotWidth, height);
      g.restore(); return;
    }
    if (!match.zone || !Number.isFinite(match.zone.low) || !Number.isFinite(match.zone.high) ||
        match.zone.low <= 0 || match.zone.high <= match.zone.low) { g.restore(); return; }
    const start = timeX(match.zone.start_time_ms);
    const end = timeX(match.zone.end_time_ms);
    const topY = this.series.priceToCoordinate(match.zone.high);
    const bottomY = this.series.priceToCoordinate(match.zone.low);
    if (start !== null && end !== null && topY !== null && bottomY !== null) {
      const left = Math.max(0, Math.min(start, end));
      const right = Math.min(plotWidth, Math.max(start, end) + (detailed ? 20 : 50));
      const top = Math.min(topY,bottomY), band = Math.max(4,Math.abs(bottomY-topY));
      if (right > left + 8 && top < height && top + band > 0) {
        g.fillStyle = "rgba(96,165,250,.12)";
        g.strokeStyle = "rgba(96,165,250,.7)";
        g.fillRect(left,top,right-left,band);
        g.strokeRect(left+.5,top+.5,right-left-1,band);
        this.smallTag(g,left+5,Math.max(14,top-3),"Liquidity zone","#7dd3fc",plotWidth,height);
      }
    }
    const colors: Record<string,string> = {
      liquidity: "#93c5fd", sweep: "#fb7185", reclaim: "#34d399", hold: "#34d399", breakout: "#a78bfa",
    };
    const labels: Record<string,string> = {
      liquidity: "Liquidity", sweep: "Sweep", reclaim: "Reclaim", hold: "Hold", breakout: "Break",
    };
    // Show only 3–4 distinct labels even for a completed pattern. The liquidity
    // area has its own box, so there is no extra pivot label.
    for (const stage of match.stages.filter((s) => s.stage !== "liquidity")) {
      const x = timeX(stage.time_ms), y = this.series.priceToCoordinate(stage.price);
      if (x === null || y === null || !Number.isFinite(y) || x < 4 || x > plotWidth-4 || y < 9 || y > height-9) continue;
      g.save(); g.strokeStyle = colors[stage.stage] ?? "#facc15"; g.lineWidth = 2;
      g.beginPath(); g.arc(x,y,7,0,Math.PI*2); g.stroke();
      g.restore();
      this.smallTag(g,x+10,Math.max(15,y-10),labels[stage.stage] || stage.stage,"#e5e7eb",plotWidth,height);
    }
    if (match.status === "invalidated") this.smallTag(g,8,20,"Historical setup invalidated","#fb7185",plotWidth,height);
    else if (match.historical_only) this.smallTag(g,8,20,"Historical pattern · not live","#facc15",plotWidth,height);
    g.restore();
  }

  private smallTag(g: CanvasRenderingContext2D, x: number, y: number, label: string, color: string,
                   plotWidth: number, height: number): void {
    g.save();
    g.font = "600 10px system-ui, sans-serif";
    const labelWidth = g.measureText(label).width + 12;
    const lx = Math.max(3, Math.min(plotWidth - labelWidth - 3, x));
    const ly = Math.max(15, Math.min(height - 5, y));
    g.fillStyle = "rgba(9,16,29,.86)";
    g.fillRect(lx, ly - 13, labelWidth, 16);
    g.fillStyle = color;
    g.fillText(label, lx + 6, ly - 2);
    g.restore();
  }

  destroy(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.onViewportChange);
    this.host.removeEventListener("wheel", this.onPointerRefresh);
    this.host.removeEventListener("pointerup", this.onPointerRefresh);
    this.resizeObserver?.disconnect();
    this.canvas.remove();
  }
}
