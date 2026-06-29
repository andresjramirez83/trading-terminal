// src/chart/ToolEngine.ts

export type ToolMode =
    | "cursor"
    | "trendline"
    | "flat-price"
    | "demand-zone"
    | "supply-zone"
    | "order-block"
    | "projection"
    | "fib"
    | "measure"
    | "erase";

type Listener = (tool: ToolMode) => void;

export class ToolEngine {

    private active: ToolMode = "cursor";

    private listeners = new Set<Listener>();

    getActive() {
        return this.active;
    }

    is(tool: ToolMode) {
        return this.active === tool;
    }

    set(tool: ToolMode) {

        if (this.active === tool)
            return;

        this.active = tool;

        this.emit();

    }

    toggle(tool: ToolMode) {

        if (this.active === tool) {

            this.active = "cursor";

        } else {

            this.active = tool;

        }

        this.emit();

    }

    clear() {

        this.active = "cursor";

        this.emit();

    }

    subscribe(listener: Listener) {

        this.listeners.add(listener);

        return () => {

            this.listeners.delete(listener);

        };

    }

    private emit() {

        for (const listener of this.listeners) {

            listener(this.active);

        }

    }

}

export const toolEngine = new ToolEngine();