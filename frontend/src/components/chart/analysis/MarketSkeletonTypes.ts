export type SkeletonPointType = "high" | "low";

export type SkeletonDirection = "up" | "down";

export interface SkeletonPoint {
    id: string;

    index: number;
    time: number;

    price: number;

    type: SkeletonPointType;

    confirmed: boolean;

    atrMove: number;
    percentMove: number;
    volumeRatio: number;

    score: number;
}

export interface SkeletonLeg {
    id: string;

    start: SkeletonPoint;
    end: SkeletonPoint;

    direction: SkeletonDirection;

    barCount: number;

    priceDistance: number;
    atrDistance: number;
    percentDistance: number;

    score: number;
}

export interface SkeletonSettings {

    atrPeriod: number;

    minimumAtrReversal: number;

    minimumPercentReversal: number;

    minimumBarsPerLeg: number;

    volumeWeight: number;

    atrWeight: number;

    distanceWeight: number;

    smoothing: number;
}

export interface MarketSkeleton {

    points: SkeletonPoint[];

    legs: SkeletonLeg[];
}

export const DefaultSkeletonSettings: SkeletonSettings = {

    atrPeriod: 14,

    minimumAtrReversal: 2.0,

    minimumPercentReversal: 0.02,

    minimumBarsPerLeg: 5,

    volumeWeight: 0.20,

    atrWeight: 0.45,

    distanceWeight: 0.35,

    smoothing: 3
};