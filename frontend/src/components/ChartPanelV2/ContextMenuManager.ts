// src/chart/ContextMenuManager.ts

export type ContextMenuItem = {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export class ContextMenuManager {
  private container: HTMLElement;
  private menuEl: HTMLDivElement | null = null;
  private handleWindowPointerDown: (event: PointerEvent) => void;
  private handleWindowKeyDown: (event: KeyboardEvent) => void;

  constructor(container: HTMLElement) {
    this.container = container;

    this.handleWindowPointerDown = (event) => {
      if (!this.menuEl) return;
      if (this.menuEl.contains(event.target as Node)) return;
      this.hide();
    };

    this.handleWindowKeyDown = (event) => {
      if (event.key === "Escape") this.hide();
    };
  }

  show(x: number, y: number, items: ContextMenuItem[]): void {
    this.hide();

    const menu = document.createElement("div");
    menu.style.position = "fixed";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.zIndex = "9999";
    menu.style.minWidth = "170px";
    menu.style.padding = "6px";
    menu.style.borderRadius = "10px";
    menu.style.background = "rgba(17, 19, 21, 0.98)";
    menu.style.border = "1px solid rgba(255,255,255,0.12)";
    menu.style.boxShadow = "0 18px 40px rgba(0,0,0,0.45)";
    menu.style.backdropFilter = "blur(10px)";
    menu.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    menu.style.fontSize = "13px";
    menu.style.color = "#e5e7eb";
    menu.style.userSelect = "none";

    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.disabled = Boolean(item.disabled);
      button.style.display = "block";
      button.style.width = "100%";
      button.style.padding = "8px 10px";
      button.style.border = "0";
      button.style.borderRadius = "7px";
      button.style.background = "transparent";
      button.style.color = item.danger ? "#f87171" : "#e5e7eb";
      button.style.textAlign = "left";
      button.style.cursor = item.disabled ? "not-allowed" : "pointer";
      button.style.opacity = item.disabled ? "0.45" : "1";

      button.addEventListener("mouseenter", () => {
        if (!item.disabled) button.style.background = "rgba(255,255,255,0.08)";
      });

      button.addEventListener("mouseleave", () => {
        button.style.background = "transparent";
      });

      button.addEventListener("click", () => {
        if (item.disabled) return;
        item.onClick();
        this.hide();
      });

      menu.appendChild(button);
    }

    document.body.appendChild(menu);
    this.menuEl = menu;
    this.clampToViewport();

    window.addEventListener("pointerdown", this.handleWindowPointerDown, true);
    window.addEventListener("keydown", this.handleWindowKeyDown, true);
  }

  hide(): void {
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
    }

    window.removeEventListener("pointerdown", this.handleWindowPointerDown, true);
    window.removeEventListener("keydown", this.handleWindowKeyDown, true);
  }

  destroy(): void {
    this.hide();
  }

  private clampToViewport(): void {
    if (!this.menuEl) return;

    const rect = this.menuEl.getBoundingClientRect();
    const padding = 8;
    const maxLeft = window.innerWidth - rect.width - padding;
    const maxTop = window.innerHeight - rect.height - padding;

    const left = Math.max(padding, Math.min(rect.left, maxLeft));
    const top = Math.max(padding, Math.min(rect.top, maxTop));

    this.menuEl.style.left = `${left}px`;
    this.menuEl.style.top = `${top}px`;
  }
}
