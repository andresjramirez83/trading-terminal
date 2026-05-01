import { useEffect } from "react";
import type { OrderTemplate } from "./QuickOrderModal";

type Props = {
  onOpenTemplate: (template: OrderTemplate) => void;
  onOpenQuickAlert: () => void;
  onToggleTrendline?: () => void;
  onResetCharts?: () => void;
  onEscape?: () => void;
};

export default function GlobalHotkeys({
  onOpenTemplate,
  onOpenQuickAlert,
  onToggleTrendline,
  onResetCharts,
  onEscape,
}: Props) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;

      const isTyping =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.tagName === "SELECT");

      if (e.key === "Escape") {
        onEscape?.();
        return;
      }

      if (isTyping) return;

      const key = e.key.toLowerCase();

      if (e.altKey) {
        if (key === "b") {
          e.preventDefault();
          onOpenTemplate("buy_only");
          return;
        }

        if (key === "t") {
          e.preventDefault();
          onOpenTemplate("buy_target");
          return;
        }

        if (key === "l") {
          e.preventDefault();
          onOpenTemplate("buy_stop");
          return;
        }

        if (key === "r") {
          e.preventDefault();
          onOpenTemplate("bracket");
          return;
        }

        if (key === "s") {
          e.preventDefault();
          onOpenTemplate("sell_close");
          return;
        }

        if (key === "x") {
          e.preventDefault();
          onOpenTemplate("flatten");
          return;
        }

        if (key === "a") {
          e.preventDefault();
          onOpenQuickAlert();
          return;
        }
      }

      if (key === "b") {
        e.preventDefault();
        onOpenTemplate("buy_only");
        return;
      }

      if (key === "s") {
        e.preventDefault();
        onOpenTemplate("sell_close");
        return;
      }

      if (key === "a") {
        e.preventDefault();
        onOpenQuickAlert();
        return;
      }

      if (key === "t") {
        e.preventDefault();
        onToggleTrendline?.();
        return;
      }

      if (key === "r") {
        e.preventDefault();
        onResetCharts?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenTemplate, onOpenQuickAlert, onToggleTrendline, onResetCharts, onEscape]);

  return null;
}
