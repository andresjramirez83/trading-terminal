// src/chart/MouseEngine.ts

import type {
    MouseEventParams,
    Time,
} from "lightweight-charts";

import { chartStore } from "./ChartStore";
import type { Candle } from "../types/market";

export interface MouseEngineOptions {
    bars: () => Candle[];
    normalizeTime: (time: Time | undefined) => number | null;
    findBar: (bars: Candle[], time: number) => Candle | null;
}

export class MouseEngine {

    private bars: () => Candle[];
    private normalizeTime: (time: Time | undefined) => number | null;
    private findBar: (bars: Candle[], time: number) => Candle | null;

    private raf = 0;

    private pending: MouseEventParams<Time> | null = null;

    constructor(options: MouseEngineOptions) {
        this.bars = options.bars;
        this.normalizeTime = options.normalizeTime;
        this.findBar = options.findBar;
    }

    onCrosshairMove = (param: MouseEventParams<Time>) => {

        this.pending = param;

        if (this.raf) return;

        this.raf = requestAnimationFrame(this.flush);
    };

    private flush = () => {

        this.raf = 0;

        const param = this.pending;

        this.pending = null;

        if (!param) return;

        const point = param.point;

        if (!point) return;

        const bars = this.bars();

        if (!bars.length) return;

        const normalized = this.normalizeTime(param.time);

        let candle: Candle | null = null;

        if (normalized != null) {

            candle = this.findBar(
                bars,
                normalized
            );

        } else {

            candle = bars[bars.length - 1];
        }

        chartStore.setHover({

            candle,

            time: param.time ?? null,

            x: point.x,

            y: point.y,
        });
    };

    destroy() {

        if (this.raf) {

            cancelAnimationFrame(this.raf);

            this.raf = 0;
        }

        this.pending = null;
    }
}