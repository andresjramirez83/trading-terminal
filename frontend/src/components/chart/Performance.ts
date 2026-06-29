// src/chart/Performance.ts

export class PerformanceTracker {
  private last = performance.now();
  private fps = 0;
  private frames = 0;

  beginFrame() {
    this.frames++;

    const now = performance.now();

    if (now - this.last >= 1000) {
      this.fps = this.frames;
      this.frames = 0;
      this.last = now;
    }
  }

  getFPS() {
    return this.fps;
  }
}