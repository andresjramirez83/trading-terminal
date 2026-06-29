// src/chart/SupplyZoneEngine.ts

import type { UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../types/market";
import type { RectangleModel } from "./ChartTypes";

export interface SupplyZone extends RectangleModel {
    candleTime: UTCTimestamp;
}

export interface SupplyZoneOptions {
    extendBars?: number;
    bodyOnly?: boolean;
    autoInvalidate?: boolean;
}

export class SupplyZoneEngine {

    private zones = new Map<string, SupplyZone>();

    private extendBars: number;

    private bodyOnly: boolean;

    private autoInvalidate: boolean;

    constructor(options?: SupplyZoneOptions) {

        this.extendBars = options?.extendBars ?? 500;

        this.bodyOnly = options?.bodyOnly ?? false;

        this.autoInvalidate =
            options?.autoInvalidate ?? true;

    }

    getAll() {

        return [...this.zones.values()];

    }

    clear() {

        this.zones.clear();

    }

    remove(id: string) {

        this.zones.delete(id);

    }

    createFromCandle(candle: Candle) {

        const top =
            this.bodyOnly
                ? Math.max(candle.open, candle.close)
                : candle.high;

        const bottom =
            this.bodyOnly
                ? Math.min(candle.open, candle.close)
                : candle.low;

        const zone: SupplyZone = {

            id: crypto.randomUUID(),

            candleTime:
                candle.time as UTCTimestamp,

            startTime:
                candle.time as UTCTimestamp,

            endTime:
                (
                    Number(candle.time) +
                    this.extendBars
                ) as UTCTimestamp,

            top,

            bottom,

            color: "#ff4040",

            fill: "rgba(255,0,0,.18)",

            visible: true,

        };

        this.zones.set(zone.id, zone);

        return zone;

    }

    update(id: string, top: number, bottom: number) {

        const zone = this.zones.get(id);

        if (!zone) return;

        zone.top = top;

        zone.bottom = bottom;

    }

    invalidate(currentPrice: number) {

        if (!this.autoInvalidate) return;

        for (const zone of this.zones.values()) {

            if (currentPrice > zone.top) {

                zone.visible = false;

            }

        }

    }

    find(price: number) {

        for (const zone of this.zones.values()) {

            if (
                price <= zone.top &&
                price >= zone.bottom
            ) {

                return zone;

            }

        }

        return null;

    }

    serialize() {

        return JSON.stringify(
            [...this.zones.values()]
        );

    }

    deserialize(json: string) {

        this.zones.clear();

        const zones =
            JSON.parse(json) as SupplyZone[];

        for (const zone of zones) {

            this.zones.set(zone.id, zone);

        }

    }

}