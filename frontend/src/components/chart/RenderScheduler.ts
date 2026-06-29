// src/chart/RenderScheduler.ts

export type RenderCallback = () => void;

export class RenderScheduler {
  private frame = 0;
  private pending = false;
  private callback: RenderCallback | null = null;

  schedule(cb: RenderCallback) {
    this.callback = cb;

    if (this.pending) return;

    this.pending = true;

    this.frame = requestAnimationFrame(() => {
      this.pending = false;

      const fn = this.callback;
      this.callback = null;

      if (fn) {
        fn();
      }
    });
  }

  cancel() {
    if (!this.pending) return;

    cancelAnimationFrame(this.frame);

    this.pending = false;
    this.callback = null;
  }

  destroy() {
    this.cancel();
  }
}

// ADD THIS
export const renderScheduler = new RenderScheduler();