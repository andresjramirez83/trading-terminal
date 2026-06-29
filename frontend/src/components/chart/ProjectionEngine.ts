// src/chart/ProjectionEngine.ts

import type { UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../types/market";
import type { ProjectionModel } from "./ChartTypes";

export interface ProjectionOptions {
    minimumMove?: number;
    extendBars?: number;
}

export class ProjectionEngine {

    private projections = new Map<string, ProjectionModel>();

    private minimumMove: number;

    private extendBars: number;

    constructor(options?: ProjectionOptions) {

        this.minimumMove = options?.minimumMove ?? 0.20;

        this.extendBars = options?.extendBars ?? 20;

    }

    clear() {

        this.projections.clear();

    }

    getAll() {

        return [...this.projections.values()];

    }

    remove(id: string) {

        this.projections.delete(id);

    }

    add(model: ProjectionModel) {

        this.projections.set(model.id, model);

    }

    createFromCandle(
        candle: Candle,
        targetPrice: number,
        label: string
    ) {

        if (
            Math.abs(targetPrice - candle.close)
            < this.minimumMove
        ) {
            return;
        }

        const projection: ProjectionModel = {

            id:
                "projection-" +
                candle.time,

            fromTime:
                candle.time as UTCTimestamp,

            toTime:
                (
                    Number(candle.time) +
                    this.extendBars
                ) as UTCTimestamp,

            price:
                targetPrice,

            label,

        };

        this.add(projection);

    }

    nearest(price: number) {

        let best: ProjectionModel | null = null;

        let bestDistance = Number.MAX_VALUE;

        for (const p of this.projections.values()) {

            const d =
                Math.abs(
                    p.price - price
                );

            if (d < bestDistance) {

                bestDistance = d;

                best = p;

            }

        }

        return best;

    }

    updateLabel(
        id: string,
        label: string
    ) {

        const p =
            this.projections.get(id);

        if (!p) return;

        p.label = label;

    }

}