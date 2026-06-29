// src/chart/ChartStore.ts

import type {
    DemandZone,
    HoverState,
    LiveBarState,
    OverlayState,
    PriceLineModel,
    ProjectionModel,
    RectangleModel,
    TrendlineModel,
} from "./ChartTypes";

type Listener = () => void;

class ChartStore {
    private listeners = new Set<Listener>();

    hover: HoverState = {
        candle: null,
        time: null,
        x: 0,
        y: 0,
    };

    live: LiveBarState = {
        current: null,
        previous: null,
    };

    overlays: OverlayState = {
        demandZones: [],
        supplyZones: [],
        projections: [],
        trendlines: [],
        priceLines: [],
    };

    subscribe(listener: Listener) {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit() {
        for (const listener of this.listeners) {
            listener();
        }
    }

    setHover(next: Partial<HoverState>) {
        Object.assign(this.hover, next);
        this.emit();
    }

    setLive(next: Partial<LiveBarState>) {
        Object.assign(this.live, next);
        this.emit();
    }

    setDemandZones(zones: DemandZone[]) {
        this.overlays.demandZones = zones;
        this.emit();
    }

    setSupplyZones(zones: RectangleModel[]) {
        this.overlays.supplyZones = zones;
        this.emit();
    }

    setTrendlines(lines: TrendlineModel[]) {
        this.overlays.trendlines = lines;
        this.emit();
    }

    setProjections(lines: ProjectionModel[]) {
        this.overlays.projections = lines;
        this.emit();
    }

    setPriceLines(lines: PriceLineModel[]) {
        this.overlays.priceLines = lines;
        this.emit();
    }

    clear() {
        this.hover = {
            candle: null,
            time: null,
            x: 0,
            y: 0,
        };

        this.live = {
            current: null,
            previous: null,
        };

        this.overlays = {
            demandZones: [],
            supplyZones: [],
            projections: [],
            trendlines: [],
            priceLines: [],
        };

        this.emit();
    }
}

export const chartStore = new ChartStore();