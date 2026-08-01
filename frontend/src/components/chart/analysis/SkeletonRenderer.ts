// src/components/chart/analysis/SkeletonRenderer.ts

import type {
  IChartApi,
  ISeriesApi,
  Time,
} from "lightweight-charts";

import type {
  MarketSkeleton,
  SkeletonPoint,
} from "./MarketSkeletonTypes";

export interface SkeletonRendererSettings {
  enabled: boolean;
  lineColor: string;
  activeLineColor: string;
  lineWidth: number;
  activeLineWidth: number;
  showSwingPoints: boolean;
  showActiveLeg: boolean;
  highPointColor: string;
  lowPointColor: string;
  pointRadius: number;
  minimumPointScore: number;
}

export const DEFAULT_SKELETON_RENDERER_SETTINGS: SkeletonRendererSettings = {
  enabled: true,
  lineColor: "#38bdf8",
  activeLineColor: "rgba(56, 189, 248, 0.58)",
  lineWidth: 3,
  activeLineWidth: 2,
  showSwingPoints: true,
  showActiveLeg: true,
  highPointColor: "#60a5fa",
  lowPointColor: "#22d3ee",
  pointRadius: 4,
  minimumPointScore: 0,
};

type SkeletonPriceSeries = Pick<
  ISeriesApi<"Candlestick">,
  "priceToCoordinate"
>;

interface CoordinatePoint {
  point: SkeletonPoint;
  x: number;
  y: number;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function clampNumber(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeSettings(
  settings?: Partial<SkeletonRendererSettings>,
): SkeletonRendererSettings {
  return {
    ...DEFAULT_SKELETON_RENDERER_SETTINGS,
    ...(settings ?? {}),
    lineWidth: clampNumber(
      Math.round(
        settings?.lineWidth ??
          DEFAULT_SKELETON_RENDERER_SETTINGS.lineWidth,
      ),
      1,
      8,
    ),
    activeLineWidth: clampNumber(
      Math.round(
        settings?.activeLineWidth ??
          DEFAULT_SKELETON_RENDERER_SETTINGS.activeLineWidth,
      ),
      1,
      8,
    ),
    pointRadius: clampNumber(
      settings?.pointRadius ??
        DEFAULT_SKELETON_RENDERER_SETTINGS.pointRadius,
      1,
      12,
    ),
    minimumPointScore: clampNumber(
      settings?.minimumPointScore ??
        DEFAULT_SKELETON_RENDERER_SETTINGS.minimumPointScore,
      0,
      100,
    ),
  };
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tagName: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, tagName);
}

function setSvgAttributes(
  element: SVGElement,
  attributes: Record<string, string | number>,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

export class SkeletonRenderer {
  private readonly chart: IChartApi;
  private readonly priceSeries: SkeletonPriceSeries;
  private readonly overlay: SVGSVGElement;

  private skeleton: MarketSkeleton = {
    points: [],
    legs: [],
  };

  private settings: SkeletonRendererSettings;
  private renderFrame: number | null = null;
  private destroyed = false;

  private readonly handleVisibleRangeChange = (): void => {
    this.scheduleRender();
  };

  constructor(
    chart: IChartApi,
    container: HTMLDivElement,
    priceSeries: SkeletonPriceSeries,
    settings?: Partial<SkeletonRendererSettings>,
  ) {
    this.chart = chart;
    this.priceSeries = priceSeries;
    this.settings = normalizeSettings(settings);

    container.style.position =
      container.style.position || "relative";

    this.overlay = createSvgElement("svg");
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.style.position = "absolute";
    this.overlay.style.inset = "0";
    this.overlay.style.width = "100%";
    this.overlay.style.height = "100%";
    this.overlay.style.pointerEvents = "none";
    this.overlay.style.overflow = "hidden";
    this.overlay.style.zIndex = "7";

    container.appendChild(this.overlay);

    this.chart
      .timeScale()
      .subscribeVisibleLogicalRangeChange(
        this.handleVisibleRangeChange,
      );
  }

  render(
    skeleton: MarketSkeleton,
    settings?: Partial<SkeletonRendererSettings>,
  ): void {
    if (this.destroyed) {
      return;
    }

    this.skeleton = {
      points: [...skeleton.points],
      legs: [...skeleton.legs],
    };

    if (settings) {
      this.settings = normalizeSettings({
        ...this.settings,
        ...settings,
      });
    }

    this.scheduleRender();
  }

  setSettings(
    settings: Partial<SkeletonRendererSettings>,
  ): void {
    this.settings = normalizeSettings({
      ...this.settings,
      ...settings,
    });

    this.scheduleRender();
  }

  getSettings(): SkeletonRendererSettings {
    return {
      ...this.settings,
    };
  }

  scheduleRender(): void {
    if (
      this.destroyed ||
      this.renderFrame !== null
    ) {
      return;
    }

    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.renderOverlay();
    });
  }

  clear(): void {
    this.overlay.replaceChildren();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    this.chart
      .timeScale()
      .unsubscribeVisibleLogicalRangeChange(
        this.handleVisibleRangeChange,
      );

    if (this.renderFrame !== null) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }

    this.clear();
    this.overlay.remove();

    this.skeleton = {
      points: [],
      legs: [],
    };
  }

  private renderOverlay(): void {
    this.clear();

    if (
      !this.settings.enabled ||
      this.skeleton.points.length < 2
    ) {
      return;
    }

    const width = Math.max(
      1,
      this.overlay.clientWidth,
      this.overlay.parentElement?.clientWidth ?? 0,
    );

    const height = Math.max(
      1,
      this.overlay.clientHeight,
      this.overlay.parentElement?.clientHeight ?? 0,
    );

    this.overlay.setAttribute(
      "viewBox",
      `0 0 ${width} ${height}`,
    );

    const coordinates = this.buildCoordinatePoints();

    if (coordinates.length < 2) {
      return;
    }

    const fragment = document.createDocumentFragment();

    for (
      let index = 1;
      index < coordinates.length;
      index += 1
    ) {
      const start = coordinates[index - 1];
      const end = coordinates[index];

      const isActiveLeg =
        !end.point.confirmed ||
        index === coordinates.length - 1 &&
          !this.isPointConfirmedByLeg(end.point);

      if (
        isActiveLeg &&
        !this.settings.showActiveLeg
      ) {
        continue;
      }

      fragment.appendChild(
        this.createLegLine(
          start,
          end,
          isActiveLeg,
        ),
      );
    }

    if (this.settings.showSwingPoints) {
      for (const coordinate of coordinates) {
        if (
          coordinate.point.score <
          this.settings.minimumPointScore
        ) {
          continue;
        }

        fragment.appendChild(
          this.createSwingPoint(coordinate),
        );
      }
    }

    this.overlay.appendChild(fragment);
  }

  private buildCoordinatePoints(): CoordinatePoint[] {
    const coordinates: CoordinatePoint[] = [];
    const timeScale = this.chart.timeScale();

    const points = [...this.skeleton.points]
      .filter((point) => {
        return (
          Number.isFinite(point.time) &&
          Number.isFinite(point.price) &&
          point.score >=
            this.settings.minimumPointScore
        );
      })
      .sort((left, right) => {
        if (left.index !== right.index) {
          return left.index - right.index;
        }

        return left.time - right.time;
      });

    for (const point of points) {
      const x = timeScale.timeToCoordinate(
        point.time as Time,
      );

      const y = this.priceSeries.priceToCoordinate(
        point.price,
      );

      if (
        x === null ||
        y === null ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        continue;
      }

      coordinates.push({
        point,
        x,
        y,
      });
    }

    return coordinates;
  }

  private createLegLine(
    start: CoordinatePoint,
    end: CoordinatePoint,
    active: boolean,
  ): SVGLineElement {
    const line = createSvgElement("line");

    const color = active
      ? this.settings.activeLineColor
      : this.settings.lineColor;

    const width = active
      ? this.settings.activeLineWidth
      : this.settings.lineWidth;

    setSvgAttributes(line, {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      stroke: color,
      "stroke-width": width,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
    });

    if (active) {
      line.setAttribute(
        "stroke-dasharray",
        "7 5",
      );
    }

    return line;
  }

  private createSwingPoint(
    coordinate: CoordinatePoint,
  ): SVGGElement {
    const group = createSvgElement("g");
    const circle = createSvgElement("circle");
    const point = coordinate.point;

    const fill =
      point.type === "high"
        ? this.settings.highPointColor
        : this.settings.lowPointColor;

    const radius =
      this.settings.pointRadius +
      clampNumber(point.score / 100, 0, 1) * 1.5;

    setSvgAttributes(circle, {
      cx: coordinate.x,
      cy: coordinate.y,
      r: radius,
      fill,
      stroke: "rgba(15, 23, 42, 0.95)",
      "stroke-width": 1.5,
      "vector-effect": "non-scaling-stroke",
    });

    if (!point.confirmed) {
      circle.setAttribute(
        "stroke-dasharray",
        "3 2",
      );
      circle.setAttribute(
        "fill-opacity",
        "0.68",
      );
    }

    const title = createSvgElement("title");
    title.textContent =
      `${point.type === "high" ? "Swing high" : "Swing low"} ` +
      `${point.price.toFixed(4)} | Score ${Math.round(point.score)}`;

    group.appendChild(circle);
    group.appendChild(title);

    return group;
  }

  private isPointConfirmedByLeg(
    point: SkeletonPoint,
  ): boolean {
    const matchingLeg = this.skeleton.legs.find(
      (leg) => leg.end.id === point.id,
    );

    return matchingLeg
      ? matchingLeg.end.confirmed
      : point.confirmed;
  }
}

export default SkeletonRenderer;