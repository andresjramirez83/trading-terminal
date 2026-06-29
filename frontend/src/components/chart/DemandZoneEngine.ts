// src/chart/DemandZoneEngine.ts

import type { UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../types/market";
import type { DemandZone } from "./ChartTypes";

export interface DemandZoneOptions {
    extendBars?: number;
    bodyOnly?: boolean;
}

export class DemandZoneEngine {

    private zones = new Map<string, DemandZone>();

    private extendBars: number;

    private bodyOnly: boolean;

    constructor(options?: DemandZoneOptions) {

        this.extendBars = options?.extendBars ?? 500;

        this.bodyOnly = options?.bodyOnly ?? false;

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

        const zone: DemandZone = {

            id:
                crypto.randomUUID(),

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

            color:
                "#00ff00",

            fill:
                "rgba(0,255,0,.18)",

            visible: true,

        };

        this.zones.set(
            zone.id,
            zone
        );

        return zone;

    }

    update(id: string, top: number, bottom: number) {

        const zone =
            this.zones.get(id);

        if (!zone) return;

        zone.top = top;
        zone.bottom = bottom;

    }

    setVisible(id: string, visible: boolean) {

        const zone =
            this.zones.get(id);

        if (!zone) return;

        zone.visible = visible;

    }

    setColor(id: string, border: string, fill: string) {

        const zone =
            this.zones.get(id);

        if (!zone) return;

        zone.color = border;
        zone.fill = fill;

    }

    extend(id: string, bars: number) {

        const zone =
            this.zones.get(id);

        if (!zone) return;

        zone.endTime =
            (
                Number(zone.startTime) +
                bars
            ) as UTCTimestamp;

    }

    findAtPrice(price: number) {

        for (const zone of this.zones.values()) {

            if (
                price >= zone.bottom &&
                price <= zone.top
            ) {

                return zone;

            }

        }

        return null;

    }

    invalidateBrokenZones(currentPrice: number) {

        for (const zone of this.zones.values()) {

            if (currentPrice < zone.bottom) {

                zone.visible = false;

            }

        }

    }

    serialize() {

        return JSON.stringify(
            [...this.zones.values()]
        );

    }

    deserialize(json: string) {

        this.zones.clear();

        const zones =
            JSON.parse(json) as DemandZone[];

        for (const zone of zones) {

            this.zones.set(
                zone.id,
                zone
            );

        }

    }

}