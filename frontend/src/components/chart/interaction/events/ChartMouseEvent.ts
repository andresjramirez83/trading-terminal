// src/components/chart/interaction/events/ChartMouseEvent.ts

import type { ChartPointerPoint } from "../../ChartEngine";

export type ChartMouseEventType =
  | "click"
  | "contextmenu"
  | "pointerdown"
  | "pointermove"
  | "pointerup"
  | "doubleclick";

export type ChartMouseEvent = {
  type: ChartMouseEventType;
  point: ChartPointerPoint;
  nativeEvent?: MouseEvent | PointerEvent;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  button: number;
  buttons: number;
};

export function createChartMouseEvent(
  type: ChartMouseEventType,
  point: ChartPointerPoint,
  nativeEvent?: MouseEvent | PointerEvent,
): ChartMouseEvent {
  return {
    type,
    point,
    nativeEvent,
    shiftKey: nativeEvent?.shiftKey ?? false,
    altKey: nativeEvent?.altKey ?? false,
    ctrlKey: nativeEvent?.ctrlKey ?? false,
    metaKey: nativeEvent?.metaKey ?? false,
    button: nativeEvent?.button ?? 0,
    buttons: nativeEvent instanceof PointerEvent ? nativeEvent.buttons : 0,
  };
}
