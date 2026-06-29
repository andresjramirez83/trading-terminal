// src/chart/OverlayEngine.ts

import type { LogicalRange } from "lightweight-charts";
import type {
    DemandZone,
    ProjectionModel,
    RectangleModel,
    TrendlineModel,
} from "./ChartTypes";

export interface OverlayData {

    demandZones: DemandZone[];

    supplyZones: RectangleModel[];

    trendlines: TrendlineModel[];

    projections: ProjectionModel[];

}

export class OverlayEngine {

    private visibleDemand: DemandZone[] = [];

    private visibleSupply: RectangleModel[] = [];

    private visibleTrendlines: TrendlineModel[] = [];

    private visibleProjections: ProjectionModel[] = [];

    setData(data: OverlayData) {

        this.visibleDemand = data.demandZones;

        this.visibleSupply = data.supplyZones;

        this.visibleTrendlines = data.trendlines;

        this.visibleProjections = data.projections;

    }

    updateVisibleRange(
        range: LogicalRange | null
    ) {

        if (!range) return;

        const left = Math.floor(range.from);

        const right = Math.ceil(range.to);

        this.visibleDemand = this.visibleDemand.filter(z => {

            const t = Number(z.candleTime);

            return t >= left && t <= right;

        });

        this.visibleSupply = this.visibleSupply.filter(z => {

            const t = Number(z.startTime);

            return t >= left && t <= right;

        });

        this.visibleTrendlines =
            this.visibleTrendlines.filter(line => {

                const start = Number(line.start.time);

                const end = Number(line.end.time);

                return (
                    end >= left &&
                    start <= right
                );

            });

        this.visibleProjections =
            this.visibleProjections.filter(p => {

                const t = Number(p.fromTime);

                return t >= left && t <= right;

            });

    }

    getDemandZones() {

        return this.visibleDemand;

    }

    getSupplyZones() {

        return this.visibleSupply;

    }

    getTrendlines() {

        return this.visibleTrendlines;

    }

    getProjections() {

        return this.visibleProjections;

    }

    clear() {

        this.visibleDemand = [];

        this.visibleSupply = [];

        this.visibleTrendlines = [];

        this.visibleProjections = [];

    }

}