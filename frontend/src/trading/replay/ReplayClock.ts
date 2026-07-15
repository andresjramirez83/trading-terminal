// src/trading/replay/ReplayClock.ts

import type { ReplaySpeed } from "./ReplayTypes";

type TickListener = () => void;

const BASE_INTERVAL_MS = 1000;

export class ReplayClock {
  private listeners = new Set<TickListener>();
  private timer: number | null = null;
  private speed: ReplaySpeed = 1;
  private running = false;

  subscribe(listener: TickListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;

    if (this.running) {
      this.restartTimer();
    }
  }

  getSpeed(): ReplaySpeed {
    return this.speed;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.restartTimer();
  }

  pause(): void {
    this.running = false;
    this.clearTimer();
  }

  resume(): void {
    this.start();
  }

  isRunning(): boolean {
    return this.running;
  }

  step(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  destroy(): void {
    this.pause();
    this.listeners.clear();
  }

  private restartTimer(): void {
    this.clearTimer();

    const interval = Math.max(
      10,
      Math.round(BASE_INTERVAL_MS / this.speed),
    );

    this.timer = window.setInterval(() => {
      this.step();
    }, interval);
  }

  private clearTimer(): void {
    if (this.timer == null) return;

    window.clearInterval(this.timer);
    this.timer = null;
  }
}