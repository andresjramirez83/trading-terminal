// src/chart/TrendlineEngine.ts

import type {
    IChartApi,
    Logical,
    Time,
    UTCTimestamp,
} from "lightweight-charts";

import type {
    TrendlineModel,
    TrendlinePoint,
} from "./ChartTypes";

export interface TrendlineEngineOptions {
    chart: IChartApi;
}

export class TrendlineEngine {

    private chart: IChartApi;

    private lines = new Map<string, TrendlineModel>();

    private selectedId: string | null = null;

    private drawing = false;

    private firstPoint: TrendlinePoint | null = null;

    constructor(options: TrendlineEngineOptions) {
        this.chart = options.chart;
    }

    beginDraw(point: TrendlinePoint) {

        this.drawing = true;

        this.firstPoint = point;

    }

    finishDraw(point: TrendlinePoint) {

        if (!this.firstPoint) {

            this.cancelDraw();

            return;

        }

        const id = crypto.randomUUID();

        this.lines.set(id, {

            id,

            start: this.firstPoint,

            end: point,

            selected: false,

            color: "#00A3FF",

            width: 2,

            extendLeft: false,

            extendRight: true,

        });

        this.drawing = false;

        this.firstPoint = null;

    }

    cancelDraw() {

        this.drawing = false;

        this.firstPoint = null;

    }

    isDrawing() {

        return this.drawing;

    }

    getAll() {

        return [...this.lines.values()];

    }

    clear() {

        this.lines.clear();

        this.selectedId = null;

    }

    delete(id: string) {

        this.lines.delete(id);

        if (this.selectedId === id) {

            this.selectedId = null;

        }

    }

    select(id: string | null) {

        this.selectedId = id;

        for (const line of this.lines.values()) {

            line.selected =
                line.id === id;

        }

    }

    getSelected() {

        if (!this.selectedId) {

            return null;

        }

        return this.lines.get(
            this.selectedId
        ) ?? null;

    }

    updateColor(
        id: string,
        color: string
    ) {

        const line =
            this.lines.get(id);

        if (!line) return;

        line.color = color;

    }

    updateWidth(
        id: string,
        width: number
    ) {

        const line =
            this.lines.get(id);

        if (!line) return;

        line.width = width;

    }

    setExtendLeft(
        id: string,
        value: boolean
    ) {

        const line =
            this.lines.get(id);

        if (!line) return;

        line.extendLeft = value;

    }

    setExtendRight(
        id: string,
        value: boolean
    ) {

        const line =
            this.lines.get(id);

        if (!line) return;

        line.extendRight = value;

    }

    movePoint(
        id: string,
        which: "start" | "end",
        point: TrendlinePoint
    ) {

        const line =
            this.lines.get(id);

        if (!line) return;

        if (which === "start") {

            line.start = point;

        } else {

            line.end = point;

        }

    }

    hitTest(
        time: UTCTimestamp,
        price: number,
        tolerance = 0.20
    ) {

        for (const line of this.lines.values()) {

            const minTime =
                Math.min(
                    Number(line.start.time),
                    Number(line.end.time)
                );

            const maxTime =
                Math.max(
                    Number(line.start.time),
                    Number(line.end.time)
                );

            if (
                Number(time) < minTime ||
                Number(time) > maxTime
            ) {

                continue;

            }

            const minPrice =
                Math.min(
                    line.start.price,
                    line.end.price
                );

            const maxPrice =
                Math.max(
                    line.start.price,
                    line.end.price
                );

            if (
                price >= minPrice - tolerance &&
                price <= maxPrice + tolerance
            ) {

                return line;

            }

        }

        return null;

    }

    serialize() {

        return JSON.stringify(
            [...this.lines.values()]
        );

    }

    deserialize(
        json: string
    ) {

        this.lines.clear();

        const data =
            JSON.parse(json) as TrendlineModel[];

        for (const line of data) {

            this.lines.set(
                line.id,
                line
            );

        }

    }

}